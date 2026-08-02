/**
 * @file index.ts
 * @description Cloudflare Worker entry point for the Telegram Journal Bot.
 * Routes incoming webhooks and scheduled triggers to their handlers.
 * All actual logic lives in telegram.ts / github.ts / ai.ts / kv.ts / handlers.ts / cron.ts.
 */

import type { Env } from "./types";
import { timingSafeEqual } from "./utils";
import { sendTelegramMessage, editTelegramMessage, logEvent } from "./telegram";
import { handleIncomingMessage, handleCallbackQuery } from "./handlers";
import { runDailyQuoteTask, runWeeklySummaryTask, runRandomPromptTask } from "./cron";

export type { Env };

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        if (request.method !== "POST") {
            return new Response("Webhook is active");
        }

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

        if (payload.update_id !== undefined) {
            const dedupeKey = `seen-update:${payload.update_id}`;
            const alreadySeen = await env.JOURNAL_KV.get(dedupeKey);
            if (alreadySeen) {
                await logEvent(env, "info", `Ignored a duplicate delivery of update ${payload.update_id} (Telegram retried it).`);
                return new Response("OK");
            }
            await env.JOURNAL_KV.put(dedupeKey, "1", { expirationTtl: 300 });
        }

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

        if (payload.message && payload.message.chat) {
            currentChatId = payload.message.chat.id.toString();
        } else if (payload.callback_query && payload.callback_query.message.chat) {
            currentChatId = payload.callback_query.message.chat.id.toString();
        }

        if (!currentChatId) return new Response("OK");

        if (!allowedIds.includes(currentChatId)) {
            if (payload.message) {
                await sendTelegramMessage(env.TELEGRAM_TOKEN, currentChatId, "You are not authorized to use this bot.");
            }
            await logEvent(env, "warn", `Blocked a message from an unauthorized chat (ID: ${currentChatId}).`);
            return new Response("OK");
        }

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

    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        const is11PMTrigger = event.cron === "30 18 * * *";
        const isWeeklySummaryTrigger = event.cron === "30 18 * * 7";

        if (isWeeklySummaryTrigger) {
            await runWeeklySummaryTask(env);
        } else if (is11PMTrigger) {
            await runDailyQuoteTask(env);
        } else {
            await runRandomPromptTask(env);
        }
    }
};
