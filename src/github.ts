/**
 * @file github.ts
 * @description Commits files to the daily-dev-journal GitHub repo via the Contents API,
 * and regenerates the weekly README index.
 */

import type { Env } from "./types";
import { getWeeklyEntries } from "./kv";
import { logEvent } from "./telegram";

/**
 * Commits text (or base64) content as a file to the GitHub repository.
 */
export async function commitToGitHub(token: string, folderName: string, fileName: string, message: string, content: string, isBase64: boolean = false): Promise<{ success: boolean, error?: string }> {
    const filePath = folderName ? `${folderName}/${fileName}` : fileName;
    const encodedPath = filePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
    const repoUrl = `https://api.github.com/repos/YaserZarifi/daily-dev-journal/contents/${encodedPath}`;

    const headers = {
        "Authorization": `Bearer ${token}`,
        "User-Agent": "Cloudflare-Worker",
        "Accept": "application/vnd.github.v3+json"
    };

    let existingSha: string | undefined;
    const getResponse = await fetch(repoUrl, { method: "GET", headers });
    if (getResponse.ok) {
        const existing: any = await getResponse.json();
        existingSha = existing.sha;
    } else if (getResponse.status !== 404) {
        const errBody = await getResponse.text();
        return { success: false, error: `GitHub GET failed (${getResponse.status}): ${errBody}` };
    }

    const finalContent = isBase64 ? content : btoa(unescape(encodeURIComponent(content)));

    const putBody: any = {
        message: message,
        content: finalContent
    };
    if (existingSha) {
        putBody.sha = existingSha;
    }

    const putResponse = await fetch(repoUrl, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(putBody)
    });

    if (!putResponse.ok) {
        const errBody = await putResponse.text();
        return { success: false, error: `GitHub PUT failed (${putResponse.status}): ${errBody}` };
    }

    return { success: true };
}

/**
 * Regenerates the README.md index for a given week folder, listing each day's
 * entry count so the week is browsable on GitHub without opening every file.
 */
export async function updateWeekReadme(env: Env, weekFolder: string): Promise<void> {
    const entries = await getWeeklyEntries(env.JOURNAL_KV, weekFolder);

    const countsByDate = new Map<string, number>();
    for (const entry of entries) {
        countsByDate.set(entry.date, (countsByDate.get(entry.date) || 0) + 1);
    }

    const sortedDates = Array.from(countsByDate.keys()).sort();

    let content = `# ${weekFolder}\n\n`;
    if (sortedDates.length === 0) {
        content += "_No entries yet this week._\n";
    } else {
        content += "| Date | Entries |\n|------|---------|\n";
        for (const date of sortedDates) {
            content += `| ${date} | ${countsByDate.get(date)} |\n`;
        }
        content += `\n**Total this week:** ${entries.length}\n`;
    }

    const result = await commitToGitHub(env.GITHUB_TOKEN, "", "README.md", `Update README for ${weekFolder}`, content);

    if (!result.success) {
        console.error(`Failed to update README for ${weekFolder}:`, result.error);
        await logEvent(env, "error", `Failed to update the weekly README for ${weekFolder}: ${result.error}`);
    }
}
