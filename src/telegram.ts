/**
 * @file telegram.ts
 * @description All direct Telegram Bot API interactions: sending/editing messages,
 * answering callback queries, downloading files, and the human-readable activity log.
 */

import type { Env } from "./types";
import { truncateForTelegram } from "./utils";

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
export async function sendTelegramMessage(token: string, chatId: string, text: string, replyMarkup: any = null): Promise<number | null> {
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
 */
export async function editTelegramMessage(token: string, chatId: string, messageId: string, text: string): Promise<void> {
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

export async function answerCallbackQuery(token: string, callbackQueryId: string): Promise<void> {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callbackQueryId })
    });
}

export async function getTelegramFileUrl(token: string, fileId: string): Promise<string> {
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

export async function downloadTelegramFileAsBase64(url: string): Promise<string> {
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
 * Best-effort broadcast to every allowed chat. Used for background events (cron jobs,
 * webhook-level events) that don't have a single "requesting" chat to reply to. Failures
 * here are only logged to console, never thrown, so a Telegram hiccup can't mask the
 * original event that triggered the notification.
 */
export async function notifyAllowedChats(env: Env, text: string): Promise<void> {
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
 * A plain-English activity feed sent straight to Telegram, distinct from console.error/
 * wrangler tail (which stay for technical debugging). Every notable event — success,
 * failure, or a quiet background thing you'd otherwise never see — gets its own short
 * message here so you have a readable trail of what the bot has been doing.
 */
export async function logEvent(env: Env, level: "success" | "info" | "warn" | "error", text: string): Promise<void> {
    const icons: Record<typeof level, string> = {
        success: "✅",
        info: "ℹ️",
        warn: "⚠️",
        error: "❌"
    };
    await notifyAllowedChats(env, `${icons[level]} ${truncateForTelegram(text)}`);
}
