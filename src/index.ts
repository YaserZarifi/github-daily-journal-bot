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
}

/**
 * ==========================================
 * MODULE: UTILITIES
 * ==========================================
 */



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
 * Generates standardized folder and file names based on the current date to prevent repetition.
 *
 * @param {Date} date - The current date object.
 * @param {string} prefix - The prefix for the filename (e.g., 'Journal' or 'Daily-Quote').
 * @param {number|string} [count] - Optional daily count to append to the filename.
 * @returns {Object} Structured paths containing folderName, fileName, formattedDate, and fileDate.
 */

function getRepoPaths(date: Date, prefix: string, count: number | string = ""): { folderName: string, fileName: string, formattedDate: string, fileDate: string } {
    const timeZone = 'Asia/Kabul';
    const dateOptions: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', timeZone };
    const formattedDate = new Intl.DateTimeFormat('en-GB', dateOptions).format(date);

    // YYYY-MM-DD in Kabul local time
    const fileDate = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    const [yearStr, monthStr, dayStr] = fileDate.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const day = parseInt(dayStr, 10);

    const weekDayName = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone }).format(date);

    // Week / Day folder structure: e.g. "2026-W31/Saturday-2026-08-01"
    const { isoYear, weekNo } = getISOWeek(year, month, day);
    const weekFolder = `${isoYear}-W${weekNo.toString().padStart(2, '0')}`;
    const dayFolder = `${weekDayName}-${fileDate}`;
    const folderName = `${weekFolder}/${dayFolder}`;

    // Generate File Name (e.g., "Journal-Saturday1August-8.txt")
    const suffix = count !== "" ? `-${count}` : "";
    const fileName = `${prefix}-${formattedDate.replace(/ /g, '')}${suffix}.txt`;

    return { folderName, fileName, formattedDate, fileDate };
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

async function sendTelegramMessage(token: string, chatId: string, text: string, replyMarkup: any = null): Promise<number | null> {
    const body: any = { chat_id: chatId, text: text };
    if (replyMarkup) {
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
    return result.result?.message_id ?? null;
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
async function commitToGitHub(token: string, folderName: string, fileName: string, message: string, content: string): Promise<boolean> {
    const filePath = `${folderName}/${fileName}`;
    const repoUrl = `https://api.github.com/repos/YaserZarifi/daily-dev-journal/contents/${encodeURIComponent(filePath)}`;

    const response = await fetch(repoUrl, {
        method: "PUT",
        headers: {
            "Authorization": `Bearer ${token}`,
            "User-Agent": "Cloudflare-Worker",
            "Accept": "application/vnd.github.v3+json"
        },
        body: JSON.stringify({
            message: message,
            content: btoa(unescape(encodeURIComponent(content)))
        })
    });

    return response.ok;
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
async function refineTextWithAI(ai: any, text: string): Promise<string> {
    const response: any = await ai.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
        messages: [
            {
                role: "system",
                content: `You are an expert English editor and writer. Your task is to improve the user's text while preserving its original meaning, intent, and tone.
Instructions:
- Correct all grammar, spelling, punctuation, and wording errors.
- Rewrite awkward or unnatural sentences to sound fluent and natural.
- Preserve the user's voice instead of replacing it with a generic writing style.
- Return ONLY the improved text with no explanations, quotation marks, or conversational filler.`
            },
            { role: "user", content: text }
        ]
    });
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
 * ==========================================
 * MODULE: WEBHOOK HANDLERS
 * ==========================================
 */

/**
 * Handles incoming text messages and commands from Telegram.
 *
 * @param {string} originalText - The raw text sent by the user.
 * @param {string} chatId - The ID of the Telegram chat.
 * @param {Env} env - Environment variables.
 */
async function handleIncomingMessage(originalText: string, chatId: string, env: Env): Promise<void> {
    // Handle /stats command
    if (originalText === "/stats") {
        const paths = getRepoPaths(new Date(), "");
        const count = await getDailyCount(env.JOURNAL_KV, paths.fileDate);
        await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, `📊 You have committed ${count} journal entries today!`);
        return;
    }

    // Handle /quote command
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

    // Handle Standard Journal Entry
//     const refinedText = await refineTextWithAI(env.AI, originalText);
//     const messageToSend = `Original:\n${originalText}\n\nRefined:\n${refinedText}`;

//     await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageToSend, {
//         inline_keyboard: [
//             [
//                 { text: "Accept", callback_data: "commit_refined" },
//                 { text: "Commit Original", callback_data: "commit_original" }
//             ],
//             [{ text: "Reject", callback_data: "reject" }]
//         ]
//     });
// }
// Handle Standard Journal Entry
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
            JSON.stringify({ original: originalText, refined: refinedText }),
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

    let textToCommit = "";
    if (data === "commit_refined") {
        textToCommit = draft.refined;
    } else if (data === "commit_original") {
        textToCommit = draft.original;
    }

    // Prepare GitHub Commit parameters using Utilities
    const now = new Date();
    const paths = getRepoPaths(now, "Journal"); // Temporary call to get fileDate

    // Increment daily count and generate definitive paths
    const nextCount = await incrementAndGetDailyCount(env.JOURNAL_KV, paths.fileDate);
    const finalPaths = getRepoPaths(now, "Journal", `${nextCount}-${messageId}`);

    const success = await commitToGitHub(
        env.GITHUB_TOKEN,
        finalPaths.folderName,
        finalPaths.fileName,
        `Journal Entry: ${finalPaths.formattedDate}`,
        textToCommit
    );

    if (success) {
        await editTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId, `Successfully committed to ${finalPaths.folderName}/${finalPaths.fileName}!`);
    } else {
        await editTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId, `Failed to commit! GitHub responded with an error.`);
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
    const quoteContent = await generateQuoteWithAI(env.AI);
    const paths = getRepoPaths(new Date(), "Daily-Quote");

    await commitToGitHub(
        env.GITHUB_TOKEN,
        paths.folderName,
        paths.fileName,
        `Daily Quote: ${paths.formattedDate}`,
        quoteContent
    );
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

        let payload: any;
        try {
            payload = await request.json();
        } catch (err) {
            console.error("Invalid JSON payload:", err);
            return new Response("OK"); // ack anyway so Telegram doesn't retry
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
            return new Response("OK");
        }

        // Route to the appropriate handler
        if (payload.message && payload.message.text) {
            try {
                await handleIncomingMessage(payload.message.text.trim(), currentChatId, env);
            } catch (err) {
                console.error("handleIncomingMessage error:", err);
                await sendTelegramMessage(env.TELEGRAM_TOKEN, currentChatId, "Something went wrong processing that — try again.");
            }
        } else if (payload.callback_query) {
            try {
                await handleCallbackQuery(payload.callback_query, currentChatId, env);
            } catch (err) {
                console.error("handleCallbackQuery error:", err);
            }
        }

        return new Response("OK");
    },

    /**
     * Entry point for scheduled Cron Triggers.
     */
    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        const is11PMTrigger = event.cron === "30 18 * * *"; // 6:30 PM UTC = 11:00 PM Kabul

        if (is11PMTrigger) {
            await runDailyQuoteTask(env);
        } else {
            await runRandomPromptTask(env);
        }
    }
};
