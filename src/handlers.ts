/**
 * @file handlers.ts
 * @description The two core webhook handlers: incoming messages/commands, and
 * inline-keyboard button clicks (Accept/Reject on drafts).
 */

import type { Env } from "./types";
import { sendTelegramMessage, editTelegramMessage, answerCallbackQuery, getTelegramFileUrl, downloadTelegramFileAsBase64, logEvent } from "./telegram";
import { commitToGitHub, updateWeekReadme } from "./github";
import { getDailyCount, incrementAndGetDailyCount, calculateStreak, appendWeeklyEntry, appendRecentEntry, getRecentEntries } from "./kv";
import { refineTextWithAI, generateQuoteWithAI } from "./ai";
import { getRepoPaths, truncateForTelegram } from "./utils";

export async function handleIncomingMessage(payloadMessage: any, chatId: string, env: Env): Promise<void> {
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

export async function handleCallbackQuery(callbackQuery: any, chatId: string, env: Env): Promise<void> {
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
