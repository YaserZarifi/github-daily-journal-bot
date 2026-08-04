/**
 * @file kv.ts
 * @description All Cloudflare KV reads/writes: daily counts, streaks, weekly entry
 * accumulation, and the recent-entries list used by /recent.
 */

import { getKabulDateString } from "./utils";

import { Env, UserStats } from "./types";

// --- ADD THESE TO THE BOTTOM OF src/kv.ts ---

export async function getUserStats(env: Env, chatId: number): Promise<UserStats> {
  const stats = await env.JOURNAL_KV.get(`user-stats:${chatId}`, "json");
  if (stats) return stats as UserStats;

  // Default fresh stats
  return {
    totalEntries: 0,
    longestStreak: 0,
    currentStreak: 0,
    lastEntryDate: "",
    wordsThisMonth: 0,
    wordsLastMonth: 0,
    currentMonth: "",
    wordsThisWeek: 0,
    wordsLastWeek: 0,
    currentWeek: "",
    activeWeekdays: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0 }
  };
}

// Helper to get ISO week string (e.g., "2026-W32")
function getWeekString(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${weekNo.toString().padStart(2, '0')}`;
}

export async function updateUserStats(
  env: Env,
  chatId: number,
  wordCount: number,
  dateObj: Date = new Date()
): Promise<{ stats: UserStats, isNewMilestone: boolean }> {

  const stats = await getUserStats(env, chatId);

  const dateStr = dateObj.toISOString().split("T")[0]; // YYYY-MM-DD
  const monthStr = dateStr.substring(0, 7);            // YYYY-MM
  const weekStr = getWeekString(dateObj);
  const dayOfWeek = dateObj.getDay().toString();       // "0" to "6"

  let isNewMilestone = false;
  const milestones = [7, 30, 100, 365];

  stats.totalEntries += 1;
  stats.activeWeekdays[dayOfWeek] += 1;

  // Month rollover
  if (stats.currentMonth !== monthStr) {
    stats.wordsLastMonth = stats.currentMonth ? stats.wordsThisMonth : 0;
    stats.wordsThisMonth = 0;
    stats.currentMonth = monthStr;
  }
  stats.wordsThisMonth += wordCount;

  // Week rollover
  if (stats.currentWeek !== weekStr) {
    stats.wordsLastWeek = stats.currentWeek ? stats.wordsThisWeek : 0;
    stats.wordsThisWeek = 0;
    stats.currentWeek = weekStr;
  }
  stats.wordsThisWeek += wordCount;

  // Streak calculation
  if (stats.lastEntryDate !== dateStr) {
    if (stats.lastEntryDate) {
      const lastDate = new Date(stats.lastEntryDate);
      const diffTime = Math.abs(dateObj.getTime() - lastDate.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays === 1) {
        stats.currentStreak += 1;
      } else {
        stats.currentStreak = 1; // Streak broken
      }
    } else {
      stats.currentStreak = 1; // First ever entry
    }

    stats.lastEntryDate = dateStr;

    if (stats.currentStreak > stats.longestStreak) {
      stats.longestStreak = stats.currentStreak;
    }

    if (milestones.includes(stats.currentStreak)) {
      isNewMilestone = true;
    }
  }

  await env.JOURNAL_KV.put(`user-stats:${chatId}`, JSON.stringify(stats));

  return { stats, isNewMilestone };
}

/**
 * Retrieves the number of journal entries made on a specific date.
 */
export async function getDailyCount(kv: KVNamespace, dateStr: string): Promise<string> {
    return (await kv.get(dateStr)) || "0";
}

/**
 * Increments the daily journal entry count and returns the new value.
 */
export async function incrementAndGetDailyCount(kv: KVNamespace, dateStr: string): Promise<number> {
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
 */
export async function calculateStreak(kv: KVNamespace, now: Date): Promise<number> {
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
export async function appendWeeklyEntry(kv: KVNamespace, weekFolder: string, dateStr: string, text: string): Promise<void> {
    const key = `week-entries:${weekFolder}`;
    const existingRaw = await kv.get(key);
    const entries: { date: string, text: string }[] = existingRaw ? JSON.parse(existingRaw) : [];
    entries.push({ date: dateStr, text });
    await kv.put(key, JSON.stringify(entries), { expirationTtl: 1209600 }); // 14-day safety net
}

/**
 * Retrieves all accumulated entries for a given week.
 */
export async function getWeeklyEntries(kv: KVNamespace, weekFolder: string): Promise<{ date: string, text: string }[]> {
    const raw = await kv.get(`week-entries:${weekFolder}`);
    return raw ? JSON.parse(raw) : [];
}

/**
 * Clears accumulated entries for a week, called after the weekly summary is committed.
 */
export async function clearWeeklyEntries(kv: KVNamespace, weekFolder: string): Promise<void> {
    await kv.delete(`week-entries:${weekFolder}`);
}

/**
 * Tracks the last 10 successfully committed entries (journal or quote), so /recent can
 * link straight back to them without leaving Telegram to dig through GitHub.
 */
export async function appendRecentEntry(kv: KVNamespace, entry: { date: string, path: string }): Promise<void> {
    const key = "recent-entries";
    const raw = await kv.get(key);
    const list: { date: string, path: string }[] = raw ? JSON.parse(raw) : [];
    list.unshift(entry);
    await kv.put(key, JSON.stringify(list.slice(0, 10)));
}

export async function getRecentEntries(kv: KVNamespace): Promise<{ date: string, path: string }[]> {
    const raw = await kv.get("recent-entries");
    return raw ? JSON.parse(raw) : [];
}

/**
 * Holds a journal entry's raw text/photo while the user is picking a mood for it,
 * before any AI processing happens. One pending entry per chat at a time.
 */
export async function setPendingEntry(kv: KVNamespace, chatId: string, entry: { text: string, fileId: string | null }): Promise<void> {
    await kv.put(`pending-entry:${chatId}`, JSON.stringify(entry), { expirationTtl: 3600 });
}

export async function getPendingEntry(kv: KVNamespace, chatId: string): Promise<{ text: string, fileId: string | null } | null> {
    const raw = await kv.get(`pending-entry:${chatId}`);
    return raw ? JSON.parse(raw) : null;
}

export async function clearPendingEntry(kv: KVNamespace, chatId: string): Promise<void> {
    await kv.delete(`pending-entry:${chatId}`);
}

/**
 * Flags that the next plain-text message from this chat is a custom mood name
 * (typed after tapping "Other" on the mood keyboard), not a new journal entry.
 */
export async function setAwaitingCustomMood(kv: KVNamespace, chatId: string): Promise<void> {
    await kv.put(`awaiting-custom-mood:${chatId}`, "1", { expirationTtl: 3600 });
}

export async function isAwaitingCustomMood(kv: KVNamespace, chatId: string): Promise<boolean> {
    return (await kv.get(`awaiting-custom-mood:${chatId}`)) !== null;
}

export async function clearAwaitingCustomMood(kv: KVNamespace, chatId: string): Promise<void> {
    await kv.delete(`awaiting-custom-mood:${chatId}`);
}
