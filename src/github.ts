/**
 * @file github.ts
 * @description Commits files to the daily-dev-journal GitHub repo via the Contents API,
 * and regenerates the weekly README index.
 */

import type { Env } from "./types";
import { getWeeklyEntries } from "./kv";
import { logEvent } from "./telegram";

// /**
//  * Commits text (or base64) content as a file to the GitHub repository.
//  */
// export async function commitToGitHub(token: string, folderName: string, fileName: string, message: string, content: string, isBase64: boolean = false): Promise<{ success: boolean, error?: string }> {
//     const filePath = folderName ? `${folderName}/${fileName}` : fileName;
//     const encodedPath = filePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
//     const repoUrl = `https://api.github.com/repos/YaserZarifi/daily-dev-journal/contents/${encodedPath}`;

//     const headers = {
//         "Authorization": `Bearer ${token}`,
//         "User-Agent": "Cloudflare-Worker",
//         "Accept": "application/vnd.github.v3+json"
//     };

//     let existingSha: string | undefined;
//     const getResponse = await fetch(repoUrl, { method: "GET", headers });
//     if (getResponse.ok) {
//         const existing: any = await getResponse.json();
//         existingSha = existing.sha;
//     } else if (getResponse.status !== 404) {
//         const errBody = await getResponse.text();
//         return { success: false, error: `GitHub GET failed (${getResponse.status}): ${errBody}` };
//     }

//     const finalContent = isBase64 ? content : btoa(unescape(encodeURIComponent(content)));

//     const putBody: any = {
//         message: message,
//         content: finalContent
//     };
//     if (existingSha) {
//         putBody.sha = existingSha;
//     }

//     const putResponse = await fetch(repoUrl, {
//         method: "PUT",
//         headers: { ...headers, "Content-Type": "application/json" },
//         body: JSON.stringify(putBody)
//     });

//     if (!putResponse.ok) {
//         const errBody = await putResponse.text();
//         return { success: false, error: `GitHub PUT failed (${putResponse.status}): ${errBody}` };
//     }

//     return { success: true };
// }

// /**
//  * Regenerates the README.md index for a given week folder, listing each day's
//  * entry count so the week is browsable on GitHub without opening every file.
//  */
// export async function updateWeekReadme(env: Env, weekFolder: string): Promise<void> {
//     const entries = await getWeeklyEntries(env.JOURNAL_KV, weekFolder);

//     const countsByDate = new Map<string, number>();
//     for (const entry of entries) {
//         countsByDate.set(entry.date, (countsByDate.get(entry.date) || 0) + 1);
//     }

//     const sortedDates = Array.from(countsByDate.keys()).sort();

//     let content = `# ${weekFolder}\n\n`;
//     if (sortedDates.length === 0) {
//         content += "_No entries yet this week._\n";
//     } else {
//         content += "| Date | Entries |\n|------|---------|\n";
//         for (const date of sortedDates) {
//             content += `| ${date} | ${countsByDate.get(date)} |\n`;
//         }
//         content += `\n**Total this week:** ${entries.length}\n`;
//     }

//     const result = await commitToGitHub(env.GITHUB_TOKEN, "", "README.md", `Update README for ${weekFolder}`, content);

//     if (!result.success) {
//         console.error(`Failed to update README for ${weekFolder}:`, result.error);
//         await logEvent(env, "error", `Failed to update the weekly README for ${weekFolder}: ${result.error}`);
//     }
// }




// const REPO_OWNER = "YaserZarifi";
// const REPO_NAME = "daily-dev-journal";
// const API_BASE = `[https://api.github.com/repos/$](https://api.github.com/repos/$){REPO_OWNER}/${REPO_NAME}`;


/**
 * Commits text (or base64) content as a file to the GitHub repository.
 */
export async function commitToGitHub(token: string, folderName: string, fileName: string, message: string, content: string, isBase64: boolean = false, branchName: string = "main"): Promise<{ success: boolean, error?: string }> {
    await ensureBranchExists(token, branchName);

    const filePath = folderName ? `${folderName}/${fileName}` : fileName;
    const encodedPath = filePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
    const repoUrl = `https://api.github.com/repos/YaserZarifi/daily-dev-journal/contents/${encodedPath}`;

    const headers = {
        "Authorization": `Bearer ${token}`,
        "User-Agent": "Cloudflare-Worker",
        "Accept": "application/vnd.github.v3+json"
    };

    let existingSha: string | undefined;
    const getResponse = await fetch(`${repoUrl}?ref=${branchName}`, { method: "GET", headers });
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
        content: finalContent,
        branch: branchName
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

    // Commits directly to main so the README is always updated
    const result = await commitToGitHub(env.GITHUB_TOKEN, "", "README.md", `Update README for ${weekFolder}`, content, false, "main");

    if (!result.success) {
        console.error(`Failed to update README for ${weekFolder}:`, result.error);
        await logEvent(env, "error", `Failed to update the weekly README for ${weekFolder}: ${result.error}`);
    }
}

const REPO_OWNER = "YaserZarifi";
const REPO_NAME = "daily-dev-journal";
const API_BASE = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;


async function githubFetch(url: string, token: string, method: string = "GET", body?: any) {
    return fetch(url, {
        method,
        headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "Cloudflare-Worker"
        },
        body: body ? JSON.stringify(body) : undefined
    });
}

export async function ensureBranchExists(token: string, branchName: string): Promise<boolean> {
    if (branchName === "main") return true;

    const refRes = await githubFetch(`${API_BASE}/git/ref/heads/${branchName}`, token);
    if (refRes.ok) return true;

    const mainRes = await githubFetch(`${API_BASE}/git/ref/heads/main`, token);
    if (!mainRes.ok) return false;
    const mainData = await mainRes.json() as any;

    const createRes = await githubFetch(`${API_BASE}/git/refs`, token, "POST", {
        ref: `refs/heads/${branchName}`,
        sha: mainData.object.sha
    });

    return createRes.ok;
}

// export async function mergePendingPullRequests(token: string, currentWeekFolder: string): Promise<string> {
//     const results: string[] = [];
//     const branchName = `week/${currentWeekFolder}`;

//     await githubFetch(`${API_BASE}/pulls`, token, "POST", {
//         title: `Journal Entries: ${currentWeekFolder}`,
//         body: `Automated merge of journal entries for ${currentWeekFolder}.`,
//         head: branchName,
//         base: "main"
//     });

//     const openPrsRes = await githubFetch(`${API_BASE}/pulls?state=open`, token);
//     if (!openPrsRes.ok) {
//         return "❌ Failed to fetch open Pull Requests from GitHub.";
//     }

//     const openPrs = await openPrsRes.json() as any[];

//     if (openPrs.length === 0) {
//         return "✅ Everything is up to date! No pending PRs or unmerged commits.";
//     }

//     for (const pr of openPrs) {
//         const mergeRes = await githubFetch(`${API_BASE}/pulls/${pr.number}/merge`, token, "PUT", {
//             merge_method: "squash"
//         });

//         if (mergeRes.ok) {
//             results.push(`✅ Merged: ${pr.title}`);
//         } else {
//             results.push(`❌ Failed to merge: ${pr.title}`);
//         }
//     }

//     return results.join("\n");
// }


export async function mergePendingPullRequests(token: string, currentWeekFolder: string): Promise<string> {
    const results: string[] = [];
    const branchName = `week/${currentWeekFolder}`;

    const createPrRes = await githubFetch(`${API_BASE}/pulls`, token, "POST", {
        title: `Journal Entries: ${currentWeekFolder}`,
        body: `Automated merge of journal entries for ${currentWeekFolder}.`,
        head: branchName,
        base: "main"
    });

    if (!createPrRes.ok) {
        const errData = await createPrRes.json() as any;
        if (errData.errors && errData.errors[0]?.message?.includes("No commits between")) {
            return "✅ Main is already up to date with your latest entries!";
        }
    }

    const openPrsRes = await githubFetch(`${API_BASE}/pulls?state=open`, token);
    if (!openPrsRes.ok) {
        return "❌ Failed to fetch open Pull Requests from GitHub.";
    }

    const openPrs = await openPrsRes.json() as any[];

    if (openPrs.length === 0) {
        return "✅ Everything is up to date! No pending PRs to merge.";
    }

    for (const pr of openPrs) {
        const mergeRes = await githubFetch(`${API_BASE}/pulls/${pr.number}/merge`, token, "PUT", {
            merge_method: "merge"
        });

        if (mergeRes.ok) {
            results.push(`✅ Merged PR #${pr.number}: ${pr.title}`);
        } else {
            results.push(`❌ Failed to merge PR #${pr.number}: ${pr.title}`);
        }
    }

    return results.join("\n");
}
