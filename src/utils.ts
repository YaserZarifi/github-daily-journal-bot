/**
 * @file utils.ts
 * @description Pure helper functions: date/week folder math, path generation,
 * and small string utilities. No I/O, no Env dependency — easy to unit test.
 */

/**
 * Constant-time string comparison, used for the webhook secret check so response timing
 * can't be used to guess the secret one character at a time.
 */
export function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
        mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
}

/**
 * Caps how much upstream error text gets relayed back to Telegram, so a verbose
 * GitHub/Telegram API error body doesn't turn into a wall of text in chat.
 */
export function truncateForTelegram(text: string, maxLength: number = 300): string {
    return text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
}

/**
 * Builds the "Corrected" text block. English input: just the corrected text. Non-English
 * input: the original is left untouched (never AI-edited) followed by a separator and the
 * corrected English translation.
 */
export function buildCorrectedBlock(originalText: string, language: "en" | "other", correctedEnglish: string): string {
    if (language === "en") {
        return correctedEnglish;
    }
    return `${originalText}\n\n---\n\n${correctedEnglish}`;
}

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
 * Returns a YYYY-MM-DD date string for the given date, computed in Kabul local time.
 */
export function getKabulDateString(date: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kabul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
}

/**
 * Returns the ISO week folder name (e.g., "2026-W31") for a given date, in Kabul local time.
 */
export function getWeekFolder(date: Date): string {
    const fileDate = getKabulDateString(date);
    const [yearStr, monthStr, dayStr] = fileDate.split('-');
    const { isoYear, weekNo } = getISOWeek(parseInt(yearStr, 10), parseInt(monthStr, 10), parseInt(dayStr, 10));
    return `${isoYear}-W${weekNo.toString().padStart(2, '0')}`;
}

/**
 * Generates standardized folder and file names based on the current date to prevent repetition.
 *
 * @param {Date} date - The current date object.
 * @param {string} prefix - The prefix for the filename (e.g., 'Journal' or 'Daily-Quote').
 * @param {number|string} [count] - Optional daily count to append to the filename.
 * @returns {Object} Structured paths containing folderName, fileName, formattedDate, and fileDate.
 */
export function getRepoPaths(date: Date, prefix: string, count: number | string = ""): { folderName: string, fileName: string, formattedDate: string, fileDate: string, weekFolder: string } {
    const timeZone = 'Asia/Kabul';
    const dateOptions: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', timeZone };
    const formattedDate = new Intl.DateTimeFormat('en-GB', dateOptions).format(date);

    const fileDate = getKabulDateString(date);
    const weekDayName = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone }).format(date);

    // Week / Day folder structure: e.g. "2026-W31/Saturday-2026-08-01"
    const weekFolder = getWeekFolder(date);
    const dayFolder = `${weekDayName}-${fileDate}`;
    const folderName = `${weekFolder}/${dayFolder}`;

    // Generate File Name (e.g., "Journal-Saturday1August-8.txt")
    const suffix = count !== "" ? `-${count}` : "";
    const fileName = `${prefix}-${formattedDate.replace(/ /g, '')}${suffix}.txt`;

    return { folderName, fileName, formattedDate, fileDate, weekFolder };
}
