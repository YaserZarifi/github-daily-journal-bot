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


export interface UserStats {
  totalEntries: number;
  longestStreak: number;
  currentStreak: number;
  lastEntryDate: string; // Format: YYYY-MM-DD
  wordsThisMonth: number;
  wordsLastMonth: number;
  currentMonth: string;  // Format: YYYY-MM
  wordsThisWeek: number;
  wordsLastWeek: number;
  currentWeek: string;   // Format: YYYY-Wxx
  activeWeekdays: Record<string, number>; // Maps "0" (Sunday) through "6" (Saturday) to counts
}
