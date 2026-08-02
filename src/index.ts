/**
 * @file index.ts
 * @description Cloudflare Worker for a Telegram Journal Bot. Handles incoming text,
 * refines it via AI, and commits the entries to a GitHub repository. Includes scheduled tasks.
 */

export interface Env {
    TELEGRAM_TOKEN: string;
    GITHUB_TOKEN: string;
    JOURNAL_KV: KVNamespace;
    AI: any;
    ALLOWED_CHAT_IDS: string;
    TELEGRAM_WEBHOOK_SECRET: string;
}

/**
 * ==========================================
 * MODULE: UTILITIES
 * ==========================================
 */

/**
 * Constant-time string comparison, used for the webhook secret check so response timing
 * can't be used to guess the secret one character at a time.
 */
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
        mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
}

/**
 * Caps how much upstream error text gets relayed back to Telegram, so a verbose
 * GitHub/Telegram API error body doesn't turn into a wall of text in chat.
 */
function truncateForTelegram(text: string, maxLength: number = 300): string {
    return text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
}



/**
 * Computes the ISO 8601 week number and week-year for a given calendar date.
 * Handles year-boundary weeks correctly (e.g. late-Dec dates can belong to week 1 of next year).
 */
function getISOWeek(year: number, month: number, day: number): { isoYear: number, weekNo: number } {
    const date = new Date(Date.UTC(year, month - 1, day));
    const dayNum = date.getUTCDay() || 7; // Mon=1 ... Sun=7
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return { isoYear: date.getUTCFullYear(), weekNo };
}

/**
 * Returns the ISO week folder name (e.g., "2026-W31") for a given date, in Kabul local time.
 */
function getWeekFolder(date: Date): string {
    const fileDate = getKabulDateString(date);
    const [yearStr, monthStr, dayStr] = fileDate.split('-');
    const { isoYear, weekNo } = getISOWeek(parseInt(yearStr, 10), parseInt(monthStr, 10), parseInt(dayStr, 10));
    return `${isoYear}-W${weekNo.toString().padStart(2, '0')}`;
}

/**
 * Returns a YYYY-MM-DD date string for the given date, computed in Kabul local time.
 */
function getKabulDateString(date: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kabul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
}

/**
 * Generates standardized folder and file names based on the current date to prevent repetition.
 *
 * @param {Date} date - The current date object.
 * @param {string} prefix - The prefix for the filename (e.g., 'Journal' or 'Daily-Quote').
 * @param {number|string} [count] - Optional daily count to append to the filename.
 * @returns {Object} Structured paths containing folderName, fileName, formattedDate, and fileDate.
 */


function getRepoPaths(date: Date, prefix: string, count: number | string = ""): { folderName: string, fileName: string, formattedDate: string, fileDate: string, weekFolder: string } {
    const timeZone = 'Asia/Kabul';
    const dateOptions: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', timeZone };
    const formattedDate = new Intl.DateTimeFormat('en-GB', dateOptions).format(date);

    const fileDate = getKabulDateString(date);
    const weekDayName = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone }).format(date);

    // Week / Day folder structure: e.g. "2026-W31/Saturday-2026-08-01"
    const weekFolder = getWeekFolder(date);
    const dayFolder = `${weekDayName}-${fileDate}`;
    const folderName = `${weekFolder}/${dayFolder}`;

    // Generate File Name (e.g., "Journal-Saturday1August-8.txt")
    const suffix = count !== "" ? `-${count}` : "";
    const fileName = `${prefix}-${formattedDate.replace(/ /g, '')}${suffix}.txt`;

    return { folderName, fileName, formattedDate, fileDate, weekFolder };
}



/**
 * ==========================================
 * MODULE: TELEGRAM SERVICES
 * ==========================================
 */

/**
 * Sends a message to a specific Telegram chat.
 *
 * @param {string} token - Telegram Bot API Token.
 * @param {string} chatId - The ID of the chat to send the message to.
 * @param {string} text - The content of the message.
 * @param {any} [replyMarkup=null] - Optional inline keyboard markup.
 */
// async function sendTelegramMessage(token: string, chatId: string, text: string, replyMarkup: any = null): Promise<void> {
//     const body: any = { chat_id: chatId, text: text };
//     if (replyMarkup) {
//         body.reply_markup = replyMarkup;
//     }

//     await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify(body)
//     });
// }

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * Splits text into chunks that fit within Telegram's message length limit,
 * breaking on newlines where possible to avoid cutting mid-sentence.
 */
function splitForTelegram(text: string, maxLength: number = TELEGRAM_MAX_MESSAGE_LENGTH): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLength) {
        let splitAt = remaining.lastIndexOf("\n", maxLength);
        if (splitAt <= 0) splitAt = maxLength; // no good newline, hard-cut
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).replace(/^\n/, "");
    }
    if (remaining.length > 0) chunks.push(remaining);

    return chunks;
}

/**
 * Sends a message to a specific Telegram chat. Automatically splits messages
 * exceeding Telegram's 4096-character limit into multiple sends.
 * The reply_markup (inline keyboard), if provided, is only attached to the LAST chunk,
 * since that's the message the user will actually interact with.
 *
 * @returns The message_id of the LAST chunk sent (the one carrying the buttons), or null on failure.
 */
async function sendTelegramMessage(token: string, chatId: string, text: string, replyMarkup: any = null): Promise<number | null> {
    const chunks = splitForTelegram(text);
    let lastMessageId: number | null = null;

    for (let i = 0; i < chunks.length; i++) {
        const isLastChunk = i === chunks.length - 1;
        const body: any = { chat_id: chatId, text: chunks[i] };
        if (isLastChunk && replyMarkup) {
            body.reply_markup = replyMarkup;
        }

        const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            console.error("sendMessage failed:", await response.text());
            return null;
        }

        const result: any = await response.json();
        lastMessageId = result.result?.message_id ?? null;
    }

    return lastMessageId;
}

/**
 * Edits an existing message in a Telegram chat (usually used after inline button clicks).
 *
 * @param {string} token - Telegram Bot API Token.
 * @param {string} chatId - The ID of the chat.
 * @param {string} messageId - The ID of the message to edit.
 * @param {string} text - The new text for the message.
 */
async function editTelegramMessage(token: string, chatId: string, messageId: string, text: string): Promise<void> {
    await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: text
        })
    });
}

async function answerCallbackQuery(token: string, callbackQueryId: string): Promise<void> {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callbackQueryId })
    });
}

/**
 * Best-effort broadcast to every allowed chat. Used for background events (cron jobs,
 * webhook-level events) that don't have a single "requesting" chat to reply to. Failures
 * here are only logged to console, never thrown, so a Telegram hiccup can't mask the
 * original event that triggered the notification.
 */
async function notifyAllowedChats(env: Env, text: string): Promise<void> {
    const allowedIds = env.ALLOWED_CHAT_IDS.split(",").map(id => id.trim()).filter(Boolean);
    for (const chatId of allowedIds) {
        try {
            await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, text);
        } catch (err) {
            console.error(`Failed to notify chat ${chatId}:`, err);
        }
    }
}

/**
 * ==========================================
 * MODULE: HUMAN-READABLE ACTIVITY LOG
 * ==========================================
 * A plain-English activity feed sent straight to Telegram, distinct from console.error/
 * wrangler tail (which stay as-is for technical debugging). Every notable event — success,
 * failure, or a quiet background thing you'd otherwise never see (a duplicate delivery
 * getting dropped, an album being consolidated, an unauthorized request being blocked) —
 * gets its own short message here so you have a readable trail of what the bot has been
 * doing, without digging through logs.
 */
async function logEvent(env: Env, level: "success" | "info" | "warn" | "error", text: string): Promise<void> {
    const icons: Record<typeof level, string> = {
        success: "✅",
        info: "ℹ️",
        warn: "⚠️",
        error: "❌"
    };
    await notifyAllowedChats(env, `${icons[level]} ${truncateForTelegram(text)}`);
}

/**
 * ==========================================
 * MODULE: GITHUB SERVICES
 * ==========================================
 */

/**
 * Commits text content as a file to a specified GitHub repository.
 *
 * @param {string} token - GitHub Personal Access Token.
 * @param {string} folderName - The destination folder path in the repo.
 * @param {string} fileName - The destination filename.
 * @param {string} message - The commit message.
 * @param {string} content - The plain text content to commit (will be Base64 encoded).
 * @returns {Promise<boolean>} True if the commit was successful, false otherwise.
 */
// async function commitToGitHub(token: string, folderName: string, fileName: string, message: string, content: string): Promise<{ success: boolean, error?: string }> {
//     // const filePath = `${folderName}/${fileName}`;
//     // const repoUrl = `https://api.github.com/repos/YaserZarifi/daily-dev-journal/contents/${encodeURIComponent(filePath)}`;

//     const filePath = folderName ? `${folderName}/${fileName}` : fileName;
//     const encodedPath = filePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
//     const repoUrl = `https://api.github.com/repos/YaserZarifi/daily-dev-journal/contents/${encodedPath}`;

//     const headers = {
//         "Authorization": `Bearer ${token}`,
//         "User-Agent": "Cloudflare-Worker",
//         "Accept": "application/vnd.github.v3+json"
//     };

//     // Check if the file already exists, so we can pass its sha for an update
//     // instead of colliding on a create.
//     let existingSha: string | undefined;
//     const getResponse = await fetch(repoUrl, { method: "GET", headers });
//     if (getResponse.ok) {
//         const existing: any = await getResponse.json();
//         existingSha = existing.sha;
//     } else if (getResponse.status !== 404) {
//         // Something other than "doesn't exist yet" went wrong (auth, rate limit, etc.)
//         const errBody = await getResponse.text();
//         return { success: false, error: `GitHub GET failed (${getResponse.status}): ${errBody}` };
//     }

//     const putBody: any = {
//         message: message,
//         content: btoa(unescape(encodeURIComponent(content)))
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



async function commitToGitHub(token: string, folderName: string, fileName: string, message: string, content: string, isBase64: boolean = false): Promise<{ success: boolean, error?: string }> {
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
async function updateWeekReadme(env: Env, weekFolder: string): Promise<void> {
    const entries = await getWeeklyEntries(env.JOURNAL_KV, weekFolder);

    // Group entry counts by date
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

    // Passing an empty string "" places the README at the root of your repo
    const result = await commitToGitHub(env.GITHUB_TOKEN, "", "README.md", `Update README for ${weekFolder}`, content);

    if (!result.success) {
        console.error(`Failed to update README for ${weekFolder}:`, result.error);
        await logEvent(env, "error", `Failed to update the weekly README for ${weekFolder}: ${result.error}`);
    }
}

/**
 * ==========================================
 * MODULE: STORAGE SERVICES (KV)
 * ==========================================
 */

/**
 * Retrieves the number of journal entries made on a specific date.
 *
 * @param {KVNamespace} kv - The Cloudflare KV namespace binding.
 * @param {string} dateStr - The date string key (YYYY-MM-DD).
 * @returns {Promise<string>} The count as a string.
 */
async function getDailyCount(kv: KVNamespace, dateStr: string): Promise<string> {
    return (await kv.get(dateStr)) || "0";
}

/**
 * Increments the daily journal entry count and returns the new value.
 *
 * @param {KVNamespace} kv - The Cloudflare KV namespace binding.
 * @param {string} dateStr - The date string key (YYYY-MM-DD).
 * @returns {Promise<number>} The newly incremented count.
 */
async function incrementAndGetDailyCount(kv: KVNamespace, dateStr: string): Promise<number> {
    const currentCount = await getDailyCount(kv, dateStr);
    const nextCount = parseInt(currentCount) + 1;
    await kv.put(dateStr, nextCount.toString());
    return nextCount;

}

/**
 * Calculates the current consecutive-day journaling streak, walking backward
 * from today (Kabul local time). If today has no entries yet, that's not
 * counted as a break (the day isn't over) — the streak is based on the last
 * fully-completed run of days with at least one entry.
 *
 * @param {KVNamespace} kv - The Cloudflare KV namespace binding.
 * @param {Date} now - The reference "current" date/time.
 * @returns {Promise<number>} The streak length in days.
 */
async function calculateStreak(kv: KVNamespace, now: Date): Promise<number> {
    const MAX_LOOKBACK_DAYS = 3650; // safety cap, ~10 years
    let streak = 0;
    let cursor = new Date(now);

    // Today counts toward the streak only if there's already an entry for it.
    const todayCount = parseInt(await getDailyCount(kv, getKabulDateString(cursor)));
    if (todayCount > 0) {
        streak = 1;
    }

    // Step backward day by day (24h shifts are safe: Kabul doesn't observe DST).
    cursor = new Date(cursor.getTime() - 86400000);

    for (let i = 0; i < MAX_LOOKBACK_DAYS; i++) {
        const count = parseInt(await getDailyCount(kv, getKabulDateString(cursor)));
        if (count > 0) {
            streak++;
            cursor = new Date(cursor.getTime() - 86400000);
        } else {
            break;
        }
    }

    return streak;
}

/**
 * Appends a committed journal entry to the running list for its week,
 * used later to build a weekly summary.
 */
async function appendWeeklyEntry(kv: KVNamespace, weekFolder: string, dateStr: string, text: string): Promise<void> {
    const key = `week-entries:${weekFolder}`;
    const existingRaw = await kv.get(key);
    const entries: { date: string, text: string }[] = existingRaw ? JSON.parse(existingRaw) : [];
    entries.push({ date: dateStr, text });
    await kv.put(key, JSON.stringify(entries), { expirationTtl: 1209600 }); // 14-day safety net
}

/**
 * Retrieves all accumulated entries for a given week.
 */
async function getWeeklyEntries(kv: KVNamespace, weekFolder: string): Promise<{ date: string, text: string }[]> {
    const raw = await kv.get(`week-entries:${weekFolder}`);
    return raw ? JSON.parse(raw) : [];
}

/**
 * Clears accumulated entries for a week, called after the weekly summary is committed.
 */
async function clearWeeklyEntries(kv: KVNamespace, weekFolder: string): Promise<void> {
    await kv.delete(`week-entries:${weekFolder}`);
}

/**
 * Tracks the last 10 successfully committed entries (journal or quote), so /recent can
 * link straight back to them without leaving Telegram to dig through GitHub.
 */
async function appendRecentEntry(kv: KVNamespace, entry: { date: string, path: string }): Promise<void> {
    const key = "recent-entries";
    const raw = await kv.get(key);
    const list: { date: string, path: string }[] = raw ? JSON.parse(raw) : [];
    list.unshift(entry);
    await kv.put(key, JSON.stringify(list.slice(0, 10)));
}

async function getRecentEntries(kv: KVNamespace): Promise<{ date: string, path: string }[]> {
    const raw = await kv.get("recent-entries");
    return raw ? JSON.parse(raw) : [];
}





/**
 * ==========================================
 * MODULE: AI SERVICES
 * ==========================================
 */

/**
 * Uses Cloudflare AI to refine, spell-check, and improve grammar of the provided text.
 *
 * @param {any} ai - The Cloudflare AI binding.
 * @param {string} text - The raw journal entry text.
 * @returns {Promise<string>} The refined text.
 */
// async function refineTextWithAI(ai: any, text: string): Promise<string> {
//     const response: any = await ai.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
//         messages: [
//             {
//     role: "system",
//     content: `You are an expert English editor, writer, and translator.

// Your task is to transform the user's text into polished, natural English while preserving the original meaning, intent, personality, and tone.

// Instructions:
// - Automatically detect the language of the user's input.
// - If the input is not in English, translate it into fluent, natural English first.
// - Do not translate word by word. Preserve the intended meaning, emotions, and context.
// - After translation, improve the text like a professional English editor.
// - Correct all grammar, spelling, punctuation, and wording errors.
// - Rewrite awkward or unnatural sentences to sound fluent and natural.
// - Enrich the writing with better vocabulary and smoother sentence flow where appropriate.
// - Improve clarity, readability, and coherence.
// - Preserve the user's original voice instead of replacing it with a generic writing style.
// - Make the final text sound like it was written by a proficient native English speaker.
// - Humanize the text. Avoid stereotypical AI-generated writing patterns.
// - NEVER use em dashes (—) or en dashes (–). Use commas, parentheses, or separate sentences instead.
// - Avoid repetitive sentence structures.
// - Avoid cliché AI phrases and overly polished corporate language.
// - Avoid predictable compare-and-contrast patterns such as "not only... but also", "it's not X, it's Y", "whether... or...", "more than just...", and similar formulas.
// - Use natural sentence variation and authentic human expression.
// - Do not add new information, assumptions, or ideas that were not present in the original text.
// - Keep the original length unless expanding is necessary to improve clarity or readability.
// - Return ONLY the final improved English text. Do not include explanations, notes, translation labels, quotation marks, or conversational filler.`
//   },
//             { role: "user", content: text }
//         ]
//     });
//     return response.response;
// }


async function refineTextWithAI(ai: any, text: string): Promise<string> {
    const response: any = await ai.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
        messages: [
            {
                role: "system",
                content: `You are an expert English editor, translator, and visionary Markdown designer.

Your task is to transform the user's raw journal text into a beautifully written and structured Markdown journal entry.

Follow these instructions strictly:

LANGUAGE & TRANSLATION:
- Automatically detect the language of the user's input.
- If the input is not English, translate it into natural, fluent English first.
- Do not translate word by word. Preserve the original meaning, emotions, personality, and context.
- After translation, refine the text as a professional English writer.

WRITING IMPROVEMENT:
- Correct all grammar, spelling, punctuation, and phrasing issues.
- Rewrite awkward sentences to sound natural and human.
- Improve readability, flow, and emotional impact.
- Preserve the user's original voice and intention.
- Make the writing feel personal and authentic, not like generic AI-generated content.
- Do not invent new facts, experiences, or ideas that are not present in the original text.

MARKDOWN FORMATTING:
- The final output MUST be pure Markdown format only.
- Do not include explanations, comments, introductions, or closing messages.
- Do not wrap the output inside markdown code blocks.
- Start with a meaningful H3 heading (###) that captures the essence of the journal entry.
- Use proper Markdown structure with headings, paragraphs, lists, bold, italics, and blockquotes when appropriate.
- Use **bold** for important insights, achievements, or key concepts.
- Use *italics* for emotions, reflections, or subtle thoughts.
- Use blockquotes (>) only for deep realizations, memorable thoughts, or philosophical reflections.
- Keep the structure clean and suitable for a personal GitHub journal.

STYLE RULES:
- NEVER use em dashes (—) or en dashes (–). Use commas, periods, parentheses, or separate sentences instead.
- Avoid cliché AI phrases and robotic wording.
- Avoid repetitive sentence patterns.
- Avoid common AI writing formulas such as:
  - "Not only... but also..."
  - "It's not X, it's Y"
  - "More than just..."
  - "Whether... or..."
- Avoid excessive motivational language or corporate-style writing.
- Make the final result feel like it was written by a thoughtful human developer documenting their journey.

OUTPUT REQUIREMENT:
Return ONLY the final Markdown journal entry.
The first character of your response must be '#'.`
            },
            { role: "user", content: text }
        ]
    });

    if (!response?.response || typeof response.response !== "string") {
        // Guards against a transient Workers AI failure (rate limit, model error) or an
        // unexpected response shape silently propagating `undefined` into the commit.
        throw new Error(`refineTextWithAI got an unexpected AI response: ${JSON.stringify(response)}`);
    }

    return response.response;
}




/**
 * Generates an inspiring quote on a randomized topic using AI.
 *
 * @param {any} ai - The Cloudflare AI binding.
 * @returns {Promise<string>} The generated quote.
 */
async function generateQuoteWithAI(ai: any): Promise<string> {
    const topics = ["perseverance", "philosophy", "software engineering", "resilience", "stoicism", "innovation", "creativity", "hard work"];
    const randomTopic = topics[Math.floor(Math.random() * topics.length)];
    const randomSeed = Math.floor(Math.random() * 10000);

    const response: any = await ai.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
        messages: [
            { role: "system", content: `You are an assistant. Provide a single, inspiring, profound quote about ${randomTopic}. Only return the quote and the author. No introductory text. (Seed: ${randomSeed})` }
        ]
    });
    return response.response;




}




/**
 * Generates a narrative summary of a week's journal entries.
 */
async function summarizeWeekWithAI(ai: any, entries: { date: string, text: string }[]): Promise<string> {
    const combined = entries.map(e => `[${e.date}]\n${e.text}`).join("\n\n---\n\n");

    const response: any = await ai.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
        messages: [
            {
                role: "system",
                content: `You are a thoughtful journal assistant. You will be given a series of dated journal entries from one week.
Write a warm, reflective summary of the week: identify key themes, progress, recurring topics, and notable moments.
Keep it concise (roughly 150-250 words). Return ONLY the summary, no headers, no preamble.`
            },
            { role: "user", content: combined }
        ]
    });
    return response.response;
}






/**
 * ==========================================
 * MODULE: WEBHOOK HANDLERS
 * ==========================================
 */



async function getTelegramFileUrl(token: string, fileId: string): Promise<string> {
    const response = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Telegram getFile failed (${response.status}): ${errBody}`);
    }
    const data: any = await response.json();
    if (!data?.result?.file_path) {
        // Common causes: file_id expired, or the file exceeds the 20MB Bot API download limit.
        throw new Error(`Telegram getFile returned no file_path (fileId=${fileId}): ${JSON.stringify(data)}`);
    }
    return `https://api.telegram.org/file/bot${token}/${data.result.file_path}`;
}

async function downloadTelegramFileAsBase64(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Telegram file download failed (${response.status}): ${errBody}`);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) {
        throw new Error("Telegram file download returned an empty body.");
    }
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return btoa(binary);
}





/**
 * Handles incoming text messages and commands from Telegram.
 *
 * @param {string} originalText - The raw text sent by the user.
 * @param {string} chatId - The ID of the Telegram chat.
 * @param {Env} env - Environment variables.
 */
// async function handleIncomingMessage(originalText: string, chatId: string, env: Env): Promise<void> {
//     // Handle /stats command
//     if (originalText === "/stats") {
//         const paths = getRepoPaths(new Date(), "");
//         const count = await getDailyCount(env.JOURNAL_KV, paths.fileDate);
//         await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, `📊 You have committed ${count} journal entries today!`);
//         return;
//     }

//     // Handle /quote command
//     if (originalText === "/quote") {
//         const quoteText = await generateQuoteWithAI(env.AI);
//         const messageToSend = `Original:\n/quote\n\nRefined:\n${quoteText}`;

//         const messageId = await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageToSend, {
//             inline_keyboard: [
//                 [{ text: "Accept", callback_data: "commit_refined" }],
//                 [{ text: "Reject", callback_data: "reject" }]
//             ]
//         });

//         if (messageId) {
//             await env.JOURNAL_KV.put(
//                 `draft:${chatId}:${messageId}`,
//                 JSON.stringify({ original: "/quote", refined: quoteText }),
//                 { expirationTtl: 86400 }
//             );
//         }
//         return;
//     }

//     // Handle /streak command
//     if (originalText === "/streak") {
//         const streak = await calculateStreak(env.JOURNAL_KV, new Date());
//         const emoji = streak > 0 ? "🔥" : "💤";
//         const dayWord = streak === 1 ? "day" : "days";
//         await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, `${emoji} Current streak: ${streak} ${dayWord}`);
//         return;
//     }

//     // Handle Standard Journal Entry
//     const refinedText = await refineTextWithAI(env.AI, originalText);
//     const messageToSend = `Original:\n${originalText}\n\nRefined:\n${refinedText}`;

//     const messageId = await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageToSend, {
//         inline_keyboard: [
//             [
//                 { text: "Accept", callback_data: "commit_refined" },
//                 { text: "Commit Original", callback_data: "commit_original" }
//             ],
//             [{ text: "Reject", callback_data: "reject" }]
//         ]
//     });

//     if (messageId) {
//         await env.JOURNAL_KV.put(
//             `draft:${chatId}:${messageId}`,
//             JSON.stringify({ original: originalText, refined: refinedText }),
//             { expirationTtl: 86400 }
//         );
//     }
// }



async function handleIncomingMessage(payloadMessage: any, chatId: string, env: Env): Promise<void> {
    const originalText = payloadMessage.text || payloadMessage.caption || "A visual moment captured.";

    if (originalText === "/stats") {
        const paths = getRepoPaths(new Date(), "");
        const count = await getDailyCount(env.JOURNAL_KV, paths.fileDate);
        await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, `📊 You have committed ${count} journal entries today!`);
        return;
    }

    if (originalText === "/quote") {
        const quoteText = await generateQuoteWithAI(env.AI);
        const messageToSend = `Original:\n/quote\n\nRefined:\n${quoteText}`;

        const messageId = await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageToSend, {
            inline_keyboard: [
                [{ text: "Accept", callback_data: "commit_refined" }],
                [{ text: "Reject", callback_data: "reject" }]
            ]
        });

        if (messageId) {
            await env.JOURNAL_KV.put(
                `draft:${chatId}:${messageId}`,
                JSON.stringify({ original: "/quote", refined: quoteText }),
                { expirationTtl: 86400 }
            );
        }
        return;
    }

    if (originalText === "/streak") {
        const streak = await calculateStreak(env.JOURNAL_KV, new Date());
        const emoji = streak > 0 ? "🔥" : "💤";
        const dayWord = streak === 1 ? "day" : "days";
        await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, `${emoji} Current streak: ${streak} ${dayWord}`);
        return;
    }

    if (originalText === "/help") {
        await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId,
            "📖 Commands:\n" +
            "/stats — today's entry count\n" +
            "/streak — current journaling streak\n" +
            "/quote — generate a quote to commit\n" +
            "/recent — links to your last 10 committed entries\n" +
            "/cancel — discard any pending drafts\n" +
            "/help — show this message\n\n" +
            "Or just send text, or a photo with an optional caption, to draft a new journal entry."
        );
        return;
    }

    if (originalText === "/recent") {
        const entries = await getRecentEntries(env.JOURNAL_KV);
        if (entries.length === 0) {
            await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, "No entries committed yet.");
            return;
        }
        const branch = "main";
        const lines = entries.map(e => `• ${e.date}: https://github.com/YaserZarifi/daily-dev-journal/blob/${branch}/${e.path}`);
        await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, `📚 Last ${entries.length} entries:\n\n${lines.join("\n")}`);
        return;
    }

    if (originalText === "/cancel") {
        const prefix = `draft:${chatId}:`;
        const list = await env.JOURNAL_KV.list({ prefix });
        for (const key of list.keys) {
            await env.JOURNAL_KV.delete(key.name);
        }
        await sendTelegramMessage(
            env.TELEGRAM_TOKEN,
            chatId,
            list.keys.length > 0 ? `Cancelled ${list.keys.length} pending draft(s).` : "No pending drafts to cancel."
        );
        return;
    }

    let fileId = null;
    if (payloadMessage.photo && payloadMessage.photo.length > 0) {
        fileId = payloadMessage.photo[payloadMessage.photo.length - 1].file_id;
    }

    const refinedText = await refineTextWithAI(env.AI, originalText);
    const messageToSend = `Original:\n${originalText}\n\nRefined:\n${refinedText}`;

    const messageId = await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageToSend, {
        inline_keyboard: [
            [
                { text: "Accept", callback_data: "commit_refined" },
                { text: "Commit Original", callback_data: "commit_original" }
            ],
            [{ text: "Reject", callback_data: "reject" }]
        ]
    });

    if (messageId) {
        await env.JOURNAL_KV.put(
            `draft:${chatId}:${messageId}`,
            JSON.stringify({ original: originalText, refined: refinedText, fileId: fileId }),
            { expirationTtl: 86400 }
        );
    }
}

/**
 * Handles inline keyboard button clicks (callback queries).
 *
 * @param {any} callbackQuery - The callback query payload from Telegram.
 * @param {string} chatId - The ID of the Telegram chat.
 * @param {Env} env - Environment variables.
 */
// async function handleCallbackQuery(callbackQuery: any, chatId: string, env: Env): Promise<void> {
//     const messageId = callbackQuery.message.message_id;
//     const data = callbackQuery.data;
//     const draftKey = `draft:${chatId}:${messageId}`;

//     await answerCallbackQuery(env.TELEGRAM_TOKEN, callbackQuery.id);

//     if (data === "reject") {
//         await editTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId, "Entry rejected and discarded.");
//         await env.JOURNAL_KV.delete(draftKey);
//         return;
//     }

//     const draftRaw = await env.JOURNAL_KV.get(draftKey);
//     if (!draftRaw) {
//         await editTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId, "This entry expired or was already processed.");
//         return;
//     }
//     const draft = JSON.parse(draftRaw);

//     let textToCommit = "";
//     if (data === "commit_refined") {
//         textToCommit = draft.refined;
//     } else if (data === "commit_original") {
//         textToCommit = draft.original;
//     }

//     // Prepare GitHub Commit parameters using Utilities
//     const now = new Date();
//     const paths = getRepoPaths(now, "Journal"); // Temporary call to get fileDate

//     // Increment daily count and generate definitive paths
//     const nextCount = await incrementAndGetDailyCount(env.JOURNAL_KV, paths.fileDate);
//     const finalPaths = getRepoPaths(now, "Journal", `${nextCount}-${messageId}`);

//     const result = await commitToGitHub(
//         env.GITHUB_TOKEN,
//         finalPaths.folderName,
//         finalPaths.fileName,
//         `Journal Entry: ${finalPaths.formattedDate}`,
//         textToCommit
//     );

//     if (result.success) {
//         await editTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId, `Successfully committed to ${finalPaths.folderName}/${finalPaths.fileName}!`);
//         // Only real journal entries feed the weekly summary — not accepted /quote commits
//         if (draft.original !== "/quote") {
//             await appendWeeklyEntry(env.JOURNAL_KV, finalPaths.weekFolder, finalPaths.fileDate, textToCommit);
//             await updateWeekReadme(env.GITHUB_TOKEN, env.JOURNAL_KV, finalPaths.weekFolder);
//         }
//     } else {
//         console.error("GitHub commit error:", result.error);
//         await editTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId, `Failed to commit! ${result.error ?? "GitHub responded with an error."}`);
//     }
//     await env.JOURNAL_KV.delete(draftKey);
// }


async function handleCallbackQuery(callbackQuery: any, chatId: string, env: Env): Promise<void> {
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;
    const draftKey = `draft:${chatId}:${messageId}`;

    await answerCallbackQuery(env.TELEGRAM_TOKEN, callbackQuery.id);

    if (data === "reject") {
        await editTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId, "Entry rejected and discarded.");
        await env.JOURNAL_KV.delete(draftKey);
        return;
    }

    const draftRaw = await env.JOURNAL_KV.get(draftKey);
    if (!draftRaw) {
        await editTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId, "This entry expired or was already processed.");
        return;
    }
    const draft = JSON.parse(draftRaw);

    // The full commit flow below can involve several sequential GitHub API calls (plus an
    // image upload), which can take a few seconds. Give immediate feedback so it doesn't look
    // like nothing happened after tapping the button.
    await editTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId, "⏳ Committing your entry...");

    let textToCommit = "";
    if (data === "commit_refined") {
        textToCommit = draft.refined;
    } else if (data === "commit_original") {
        textToCommit = draft.original;
    }

    const now = new Date();
    const paths = getRepoPaths(now, "Journal");

    const nextCount = await incrementAndGetDailyCount(env.JOURNAL_KV, paths.fileDate);
    const finalPaths = getRepoPaths(now, "Journal", `${nextCount}-${messageId}`);

    finalPaths.fileName = finalPaths.fileName.replace('.txt', '.md');

    if (draft.fileId) {
        const fileUrl = await getTelegramFileUrl(env.TELEGRAM_TOKEN, draft.fileId);
        const base64Image = await downloadTelegramFileAsBase64(fileUrl);
        const imageFileName = `img-${finalPaths.fileDate}-${messageId}.jpg`;
        const imagePath = `${finalPaths.weekFolder}/assets`;

        await commitToGitHub(
            env.GITHUB_TOKEN,
            imagePath,
            imageFileName,
            `Upload asset: ${imageFileName}`,
            base64Image,
            true
        );

        // Images live under the WEEK folder (`${weekFolder}/assets/...`), but this markdown
        // file lives one level deeper, inside the DAY folder (`${weekFolder}/${dayFolder}/...`).
        // So the link must go up one level before descending into assets/, otherwise GitHub
        // resolves it relative to the day folder and 404s.
        textToCommit += `\n\n![Visual Context](../assets/${imageFileName})`;
    }

    const result = await commitToGitHub(
        env.GITHUB_TOKEN,
        finalPaths.folderName,
        finalPaths.fileName,
        `Journal Entry: ${finalPaths.formattedDate}`,
        textToCommit,
        false
    );

    if (result.success) {
        await editTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId, `Successfully committed to ${finalPaths.folderName}/${finalPaths.fileName}!`);
        await appendRecentEntry(env.JOURNAL_KV, { date: finalPaths.fileDate, path: `${finalPaths.folderName}/${finalPaths.fileName}` });
        await logEvent(env, "success", `Committed "${finalPaths.fileName}" to ${finalPaths.folderName}${draft.fileId ? " (with photo)" : ""}.`);
        if (draft.original !== "/quote") {
            await appendWeeklyEntry(env.JOURNAL_KV, finalPaths.weekFolder, finalPaths.fileDate, textToCommit);
            await updateWeekReadme(env, finalPaths.weekFolder);
        }
    } else {
        await editTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId, `Failed to commit! ${truncateForTelegram(result.error ?? "GitHub responded with an error.")}`);
        await logEvent(env, "error", `Failed to commit "${finalPaths.fileName}": ${result.error ?? "GitHub responded with an error."}`);
    }
    await env.JOURNAL_KV.delete(draftKey);
}

/**
 * ==========================================
 * MODULE: CRON JOB HANDLERS
 * ==========================================
 */

/**
 * Executes the daily quote generation and commits it directly to GitHub.
 *
 * @param {Env} env - Environment variables.
 */
async function runDailyQuoteTask(env: Env): Promise<void> {
    try {
        const quoteContent = await generateQuoteWithAI(env.AI);
        const paths = getRepoPaths(new Date(), "Daily-Quote");

        const result = await commitToGitHub(
            env.GITHUB_TOKEN,
            paths.folderName,
            paths.fileName,
            `Daily Quote: ${paths.formattedDate}`,
            quoteContent
        );

        if (result.success) {
            await logEvent(env, "success", `Daily quote posted for ${paths.formattedDate}.`);
        } else {
            console.error("Daily quote commit failed:", result.error);
            await logEvent(env, "error", `Daily quote commit failed: ${result.error ?? "unknown error"}`);
        }
    } catch (err) {
        // Previously unguarded — an AI or network failure here would kill the whole
        // scheduled() invocation with no retry and no record that the day was missed.
        console.error("runDailyQuoteTask crashed:", err);
        await logEvent(env, "error", `Daily quote task crashed: ${err instanceof Error ? err.message : String(err)}`);
    }
}




/**
 * Builds and commits a narrative summary of the past week's journal entries.
 * Runs once a week; clears the accumulated entries afterward so next week starts fresh.
 * If the commit fails, entries are left in KV so the next run can retry.
 */
async function runWeeklySummaryTask(env: Env): Promise<void> {
    try {
        const now = new Date();
        const weekFolder = getWeekFolder(now);
        const entries = await getWeeklyEntries(env.JOURNAL_KV, weekFolder);

        if (entries.length === 0) {
            console.log(`No entries to summarize for week ${weekFolder}, skipping.`);
            await logEvent(env, "info", `No journal entries this week — skipped the weekly summary for ${weekFolder}.`);
            return;
        }

        const summary = await summarizeWeekWithAI(env.AI, entries);

        const result = await commitToGitHub(
            env.GITHUB_TOKEN,
            weekFolder,
            "Weekly-Summary.txt",
            `Weekly Summary: ${weekFolder}`,
            summary
        );

        if (!result.success) {
            console.error("Weekly summary commit failed:", result.error);
            await logEvent(env, "error", `Weekly summary commit failed: ${result.error ?? "unknown error"}`);
            return; // entries stay in KV so the next run can retry, as before
        }

        await clearWeeklyEntries(env.JOURNAL_KV, weekFolder);
        await updateWeekReadme(env, weekFolder); // reflects cleared count, since a new week's tracking starts fresh
        await logEvent(env, "success", `Weekly summary posted for ${weekFolder} (${entries.length} entries).`);
    } catch (err) {
        // Previously unguarded. Note entries are deliberately NOT cleared here (that only
        // happens after a confirmed successful commit above), so a crash mid-task still
        // leaves the week's entries intact for the next scheduled retry.
        console.error("runWeeklySummaryTask crashed:", err);
        await logEvent(env, "error", `Weekly summary task crashed: ${err instanceof Error ? err.message : String(err)}`);
    }
}




/**
 * Periodically prompts authorized users on Telegram with random journal nudges.
 *
 * @param {Env} env - Environment variables.
 */
async function runRandomPromptTask(env: Env): Promise<void> {
    const probability = Math.random();
    if (probability > 0.35) return; // 35% chance to trigger

    const allowedIds = env.ALLOWED_CHAT_IDS.split(",").map(id => id.trim());
    const prompts = [
        "Time for a quick journal update! What is on your mind?",
        "Keep the GitHub streak alive! What are you working on right now?",
        "Checking in! Drop a quick update for the journal.",
        "Any new ideas or code you want to document?",
        "How is the progress going today? Send a quick journal entry!"
    ];
    const randomPrompt = prompts[Math.floor(Math.random() * prompts.length)];

    for (const targetChatId of allowedIds) {
        await sendTelegramMessage(env.TELEGRAM_TOKEN, targetChatId, randomPrompt);
    }
}

/**
 * ==========================================
 * MAIN WORKER EXPORT
 * ==========================================
 */
export default {
    /**
     * Entry point for standard HTTP webhooks (Telegram messages & callbacks).
     */
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        if (request.method !== "POST") {
            return new Response("Webhook is active");
        }

        // Reject any request that doesn't carry Telegram's secret token header
        const incomingSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (!incomingSecret || !timingSafeEqual(incomingSecret, env.TELEGRAM_WEBHOOK_SECRET)) {
            await logEvent(env, "warn", "Blocked a webhook request with a missing or invalid secret token (possible unauthorized probe).");
            return new Response("Unauthorized", { status: 401 });
        }

        let payload: any;
        try {
            payload = await request.json();
        } catch (err) {
            console.error("Invalid JSON payload:", err);
            await logEvent(env, "error", "Received a webhook request with invalid JSON — ignored it.");
            return new Response("OK");
        }

        // Guard against Telegram retrying a webhook delivery (same update_id twice)
        if (payload.update_id !== undefined) {
            const dedupeKey = `seen-update:${payload.update_id}`;
            const alreadySeen = await env.JOURNAL_KV.get(dedupeKey);
            if (alreadySeen) {
                await logEvent(env, "info", `Ignored a duplicate delivery of update ${payload.update_id} (Telegram retried it).`);
                return new Response("OK");
            }
            // Short TTL is enough — Telegram retries happen within seconds/minutes, not days
            await env.JOURNAL_KV.put(dedupeKey, "1", { expirationTtl: 300 });
        }

        // Telegram sends each photo in an album as a separate update sharing a media_group_id,
        // usually with only the first carrying the caption. Without this guard, a 3-photo album
        // would spawn three separate drafts with three separate Accept/Reject prompts. We only
        // process the first update of a group and silently ack the rest.
        if (payload.message?.media_group_id) {
            const groupKey = `seen-media-group:${payload.message.media_group_id}`;
            const alreadySeenGroup = await env.JOURNAL_KV.get(groupKey);
            if (alreadySeenGroup) {
                await logEvent(env, "info", "Received another photo from the same album — only processing the first one to avoid duplicate drafts.");
                return new Response("OK");
            }
            await env.JOURNAL_KV.put(groupKey, "1", { expirationTtl: 300 });
        }

        const allowedIds = env.ALLOWED_CHAT_IDS.split(",").map(id => id.trim());
        let currentChatId = null;

        // Determine chat ID from either message or callback query
        if (payload.message && payload.message.chat) {
            currentChatId = payload.message.chat.id.toString();
        } else if (payload.callback_query && payload.callback_query.message.chat) {
            currentChatId = payload.callback_query.message.chat.id.toString();
        }

        if (!currentChatId) return new Response("OK");

        // Validate Authorization
        if (!allowedIds.includes(currentChatId)) {
            if (payload.message) {
                await sendTelegramMessage(env.TELEGRAM_TOKEN, currentChatId, "You are not authorized to use this bot.");
            }
            await logEvent(env, "warn", `Blocked a message from an unauthorized chat (ID: ${currentChatId}).`);
            return new Response("OK");
        }

        // Route to the appropriate handler.
        // IMPORTANT: Telegram never sets `message.text` on a photo message, even when it has
        // a caption — captions live in `message.caption`, and a bare photo has neither.
        // Gating on `.text` alone means photo/caption updates matched no branch at all and
        // fell through to `return new Response("OK")` with no reply and no error (silent bug).
        if (payload.message && (payload.message.text || payload.message.caption || payload.message.photo)) {
            try {
                await handleIncomingMessage(payload.message, currentChatId, env);
            } catch (err) {
                console.error("handleIncomingMessage error:", err);
                await sendTelegramMessage(env.TELEGRAM_TOKEN, currentChatId, "Something went wrong processing that — try again.");
                await logEvent(env, "error", `Failed to process an incoming message: ${err instanceof Error ? err.message : String(err)}`);
            }
        } else if (payload.callback_query) {
            try {
                await handleCallbackQuery(payload.callback_query, currentChatId, env);
            } catch (err) {
                console.error("handleCallbackQuery error:", err);
                await logEvent(env, "error", `Failed to process a button action: ${err instanceof Error ? err.message : String(err)}`);
                // Previously this only logged, leaving the user staring at a message whose
                // Accept/Reject buttons had already fired with no visible outcome. Now we at
                // least try to tell them it failed instead of going silent on this path too.
                try {
                    const failedMessageId = payload.callback_query?.message?.message_id;
                    if (failedMessageId) {
                        await editTelegramMessage(
                            env.TELEGRAM_TOKEN,
                            currentChatId,
                            failedMessageId,
                            `Failed to process that action: ${err instanceof Error ? err.message : "unknown error"}. The draft may still be saved — try the button again.`
                        );
                    }
                } catch (notifyErr) {
                    console.error("Failed to notify user of callback_query error:", notifyErr);
                }
            }
        }

        return new Response("OK");
    },

    /**
     * Entry point for scheduled Cron Triggers.
     */
    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        const is11PMTrigger = event.cron === "30 18 * * *"; // 6:30 PM UTC daily = 11:00 PM Kabul
        const isWeeklySummaryTrigger = event.cron === "30 18 * * 7"; // Sunday only (Cloudflare uses 7 for Sunday, not 0), same local time

        if (isWeeklySummaryTrigger) {
            await runWeeklySummaryTask(env);
        } else if (is11PMTrigger) {
            await runDailyQuoteTask(env);
        } else {
            await runRandomPromptTask(env);
        }
    }
};
