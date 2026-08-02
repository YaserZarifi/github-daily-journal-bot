/**
 * @file cron.ts
 * @description The three scheduled (Cron Trigger) tasks: daily quote, weekly summary,
 * and the random journaling nudge.
 */

import type { Env } from "./types";
import { sendTelegramMessage, logEvent } from "./telegram";
import { commitToGitHub, updateWeekReadme } from "./github";
import { getWeeklyEntries, clearWeeklyEntries } from "./kv";
import { generateQuoteWithAI, summarizeWeekWithAI } from "./ai";
import { getRepoPaths, getWeekFolder } from "./utils";

export async function runDailyQuoteTask(env: Env): Promise<void> {
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
        console.error("runDailyQuoteTask crashed:", err);
        await logEvent(env, "error", `Daily quote task crashed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

export async function runWeeklySummaryTask(env: Env): Promise<void> {
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
            return;
        }

        await clearWeeklyEntries(env.JOURNAL_KV, weekFolder);
        await updateWeekReadme(env, weekFolder);
        await logEvent(env, "success", `Weekly summary posted for ${weekFolder} (${entries.length} entries).`);
    } catch (err) {
        console.error("runWeeklySummaryTask crashed:", err);
        await logEvent(env, "error", `Weekly summary task crashed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

export async function runRandomPromptTask(env: Env): Promise<void> {
    const probability = Math.random();
    if (probability > 0.35) return;

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
