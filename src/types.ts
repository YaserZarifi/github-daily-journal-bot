/**
 * @file types.ts
 * @description Shared type definitions for the Telegram Journal Bot Worker.
 */

export interface Env {
    TELEGRAM_TOKEN: string;
    GITHUB_TOKEN: string;
    JOURNAL_KV: KVNamespace;
    AI: any;
    ALLOWED_CHAT_IDS: string;
    TELEGRAM_WEBHOOK_SECRET: string;
}
