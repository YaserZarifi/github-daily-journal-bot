/**
 * @file kv.ts
 * @description All Cloudflare KV reads/writes: daily counts, streaks, weekly entry
 * accumulation, and the recent-entries list used by /recent.
 */

import { getKabulDateString } from "./utils";

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
