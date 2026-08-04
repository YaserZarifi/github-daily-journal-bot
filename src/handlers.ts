/**
 * @file handlers.ts
 * @description The two core webhook handlers: incoming messages/commands, and
 * inline-keyboard button clicks (Accept/Reject on drafts).
 */

import type { Env } from "./types";
import { sendTelegramMessage, editTelegramMessage, answerCallbackQuery, getTelegramFileUrl, downloadTelegramFileAsBase64, logEvent } from "./telegram";
import { commitToGitHub, updateWeekReadme } from "./github";

import {
    getDailyCount, incrementAndGetDailyCount, calculateStreak, appendWeeklyEntry, appendRecentEntry, getRecentEntries,
    setPendingEntry, getPendingEntry, clearPendingEntry,
    setAwaitingCustomMood, isAwaitingCustomMood, clearAwaitingCustomMood, getUserStats, updateUserStats
} from "./kv";
import { refineTextWithAI, generateQuoteWithAI, correctTextWithAI, suggestTagsWithAI } from "./ai";
import { getRepoPaths, truncateForTelegram, buildCorrectedBlock } from "./utils";
import { MOODS, TEMPLATES } from "./constants";

export async function handleIncomingMessage(payloadMessage: any, chatId: string, env: Env): Promise<void> {
    const originalText = payloadMessage.text || payloadMessage.caption || "A visual moment captured.";

    if (await isAwaitingCustomMood(env.JOURNAL_KV, chatId)) {
        await clearAwaitingCustomMood(env.JOURNAL_KV, chatId);
        const pending = await getPendingEntry(env.JOURNAL_KV, chatId);
        if (!pending) {
            await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, "That entry expired — send it again.");
            return;
        }
        await clearPendingEntry(env.JOURNAL_KV, chatId);
        await processEntryWithMood(env, chatId, pending.text, pending.fileId, originalText.trim());
        return;
    }

    // if (originalText === "/stats") {
    //     const paths = getRepoPaths(new Date(), "");
    //     const count = await getDailyCount(env.JOURNAL_KV, paths.fileDate);
    //     await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, `📊 You have committed ${count} journal entries today!`);
    //     return;
    // }
    if (originalText === "/stats") {
        const paths = getRepoPaths(new Date(), "");
        const count = await getDailyCount(env.JOURNAL_KV, paths.fileDate);
        const stats = await getUserStats(env, chatId);
        const message = `📊 Your Journal Stats\n\n📝 Today's Entries: ${count}\n🔥 Current Streak: ${stats.currentStreak} days\n🏆 Longest Streak: ${stats.longestStreak} days\n📚 Total Entries: ${stats.totalEntries}\n\n📈 Words this week: ${stats.wordsThisWeek}\n📅 Words this month: ${stats.wordsThisMonth}`;
        await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, message);
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

    // if (originalText === "/help") {
    //     await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId,
    //         "📖 Commands:\n" +
    //         "/stats — today's entry count\n" +
    //         "/streak — current journaling streak\n" +
    //         "/quote — generate a quote to commit\n" +
    //         "/template — choose a structured journaling prompt\n" +
    //         "/recent — links to your last 10 committed entries\n" +
    //         "/cancel — discard any pending drafts\n" +
    //         "/help — show this message\n\n" +
    //         "Or just send text, or a photo with an optional caption, to draft a new journal entry."
    //     );
    //     return;
    // }


    if (originalText === "/help") {
        await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId,
            "📖 Commands:\n" +
            "/stats — view your full stats and word counts\n" +
            "/streak — current journaling streak\n" +
            "/quote — generate a quote to commit\n" +
            "/template — choose a structured journaling prompt\n" +
            "/recent — links to your last 10 committed entries\n" +
            "/cancel — discard any pending drafts\n" +
            "/help — show this message\n\n" +
            "Or just send text, or a photo with an optional caption, to draft a new journal entry."
        );
        return;
    }

    if (originalText.startsWith("/template")) {
        const parts = originalText.split(" ");
        const requested = parts[1]?.toLowerCase();

        if (requested && TEMPLATES[requested]) {
            const msg = `Here is your *${requested}* template. Tap the box below to copy it, then paste and fill it out:\n\n\`\`\`\n${TEMPLATES[requested]}\n\`\`\``;
            await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, msg, "Markdown");
            return;
        }

        const buttons = Object.keys(TEMPLATES).map(key => ([{
            text: `📝 ${key.charAt(0).toUpperCase() + key.slice(1)}`,
            callback_data: `template:${key}`
        }]));

        await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, "Choose a journaling template:", {
            inline_keyboard: buttons
        });
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
        await clearPendingEntry(env.JOURNAL_KV, chatId);
        await clearAwaitingCustomMood(env.JOURNAL_KV, chatId);
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

    await setPendingEntry(env.JOURNAL_KV, chatId, { text: originalText, fileId });

    const moodButtons: any[] = [];
    for (let i = 0; i < MOODS.length; i += 2) {
        const row = [{ text: `${MOODS[i].emoji} ${MOODS[i].label}`, callback_data: `mood:${i}` }];
        if (MOODS[i + 1]) {
            row.push({ text: `${MOODS[i + 1].emoji} ${MOODS[i + 1].label}`, callback_data: `mood:${i + 1}` });
        }
        moodButtons.push(row);
    }
    moodButtons.push([{ text: "✏️ Other (type your own)", callback_data: "mood:other" }]);

    await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, "How are you feeling right now?", {
        inline_keyboard: moodButtons
    });
}

/**
 * Runs the refine / grammar-correct / tag-suggest AI calls for a pending entry once its
 * mood is known, then sends the three-way (Refined / Corrected / Original) draft message
 * with commit buttons.
 */
async function processEntryWithMood(env: Env, chatId: string, originalText: string, fileId: string | null, mood: string): Promise<void> {
    const [corrected, tags] = await Promise.all([
        correctTextWithAI(env.AI, originalText),
        suggestTagsWithAI(env.AI, originalText)
    ]);

    // Refine always runs on guaranteed-English text: the original if it's already English,
    // or correctTextWithAI's translation if not. This is deliberately sequential (rather than
    // parallel with correctTextWithAI) so "Refined" can never come back in the source language.
    const refinedText = await refineTextWithAI(env.AI, corrected.language === "en" ? originalText : corrected.correctedEnglish);

    const correctedBlock = buildCorrectedBlock(originalText, corrected.language, corrected.correctedEnglish);
    const correctedLabel = corrected.language === "en" ? "Corrected" : "Translated";
    const messageToSend = `Original:\n${originalText}\n\n${correctedLabel}:\n${corrected.correctedEnglish}\n\nRefined:\n${refinedText}`;

    const messageId = await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageToSend, {
        inline_keyboard: [
            [
                { text: "Accept Refined", callback_data: "commit_refined" },
                { text: corrected.language === "en" ? "Commit Corrected" : "Commit Translated", callback_data: "commit_corrected" }
            ],
            [{ text: "Commit Original", callback_data: "commit_original" }],
            [{ text: "Reject", callback_data: "reject" }]
        ]
    });

    if (messageId) {
        await env.JOURNAL_KV.put(
            `draft:${chatId}:${messageId}`,
            JSON.stringify({ original: originalText, refined: refinedText, corrected: correctedBlock, mood, tags, fileId }),
            { expirationTtl: 86400 }
        );
    }
}

export async function handleCallbackQuery(callbackQuery: any, chatId: string, env: Env): Promise<void> {
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;

    await answerCallbackQuery(env.TELEGRAM_TOKEN, callbackQuery.id);

    if (typeof data === "string" && data.startsWith("template:")) {
        const templateKey = data.split(":")[1];
        const templateText = TEMPLATES[templateKey];

        if (templateText) {
            const msg = `Here is your *${templateKey}* template. Tap the box below to copy it, then paste and fill it out:\n\n\`\`\`\n${templateText}\n\`\`\``;
            await editTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId, "Template selected!");
            await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, msg, "Markdown");
        }
        return;
    }

    if (typeof data === "string" && data.startsWith("mood:")) {
        const pending = await getPendingEntry(env.JOURNAL_KV, chatId);
        if (!pending) {
            await editTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId, "This entry expired — send it again.");
            return;
        }

        if (data === "mood:other") {
            await setAwaitingCustomMood(env.JOURNAL_KV, chatId);
            await editTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId, "Type your mood as a quick word or two:");
            return;
        }

        const moodIndex = parseInt(data.split(":")[1], 10);
        const mood = MOODS[moodIndex];
        if (!mood) {
            await editTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId, "Unrecognized mood — send the entry again.");
            return;
        }

        await clearPendingEntry(env.JOURNAL_KV, chatId);
        await editTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId, `Mood: ${mood.emoji} ${mood.label}. Refining your entry...`);
        await processEntryWithMood(env, chatId, pending.text, pending.fileId, `${mood.emoji} ${mood.label}`);
        return;
    }

    const draftKey = `draft:${chatId}:${messageId}`;

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
    } else if (data === "commit_corrected") {
        textToCommit = draft.corrected;
    } else if (data === "commit_original") {
        textToCommit = draft.original;
    } else {
        await editTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId, "Unrecognized action — try the button again.");
        return;
    }

    await editTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId, "⏳ Committing your entry...");

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

    let commitMessage = `journal: ${finalPaths.formattedDate}`;

    if (draft.original === "/quote") {
        commitMessage = `quote: ${finalPaths.formattedDate}`;
    } else if (draft.tags && draft.tags.length > 0) {
        commitMessage = `journal(${draft.tags[0]}): ${finalPaths.formattedDate}`;
    }

    if (draft.mood) {
        const frontmatter = [
            "---",
            `date: ${finalPaths.fileDate}`,
            `mood: "${draft.mood}"`,
            `tags: [${(draft.tags || []).join(", ")}]`,
            "---",
            ""
        ].join("\n");
        textToCommit = frontmatter + "\n" + textToCommit;
    }

    const result = await commitToGitHub(
        env.GITHUB_TOKEN,
        finalPaths.folderName,
        finalPaths.fileName,
        commitMessage,
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

        const wordCount = textToCommit.trim().split(/\s+/).length;
        const { stats, isNewMilestone } = await updateUserStats(env, chatId, wordCount);

        if (isNewMilestone) {
            await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, `🎉 *Milestone Unlocked!* You've hit a ${stats.currentStreak}-day journaling streak! Keep up the amazing work!`, "Markdown");
        } else if (stats.wordsThisWeek > stats.wordsLastWeek && stats.wordsLastWeek > 0) {
            await sendTelegramMessage(env.TELEGRAM_TOKEN, chatId, `🚀 Nice! You've already written more words this week (${stats.wordsThisWeek}) than last week (${stats.wordsLastWeek}).`);
        }
    } else {
        await editTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId, `Failed to commit! ${truncateForTelegram(result.error ?? "GitHub responded with an error.")}`);
        await logEvent(env, "error", `Failed to commit "${finalPaths.fileName}": ${result.error ?? "GitHub responded with an error."}`);
    }
    await env.JOURNAL_KV.delete(draftKey);
}
