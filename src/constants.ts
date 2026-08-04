/**
 * @file constants.ts
 * @description Fixed vocab shared across the bot: the mood options shown on the
 * mood-select keyboard, and the fixed tag list the AI is constrained to when
 * tagging entries (kept fixed on purpose so tag data stays graph/filter-friendly
 * instead of growing unbounded).
 */

export const MOODS: { emoji: string, label: string }[] = [
    { emoji: "😄", label: "Happy" },
    { emoji: "😊", label: "Content" },
    { emoji: "😐", label: "Neutral" },
    { emoji: "😔", label: "Down" },
    { emoji: "😤", label: "Frustrated" },
    { emoji: "😰", label: "Anxious" },
    { emoji: "🥱", label: "Tired" },
    { emoji: "🔥", label: "Motivated" },
    { emoji: "🤔", label: "Reflective" },
    { emoji: "😢", label: "Sad" }
];

export const TAGS: string[] = [
    // Dev / work
    "coding", "learning", "project", "bug-fix", "milestone", "planning", "idea",
    // Personal / reflective
    "reflection", "frustration", "gratitude",
    // Daily life
    "family", "health", "social", "travel", "routine"
];



export const TEMPLATES: Record<string, string> = {
    gratitude: "🙏 Gratitude Journal\n\n1. Today I am grateful for:\n- \n\n2. What went well today:\n- \n\n3. One thing I could have done better:\n- ",
    retro: "🔄 Weekly Retro\n\n- What went well:\n- \n- What didn't go well:\n- \n- What I learned:\n- \n- Action items for next week:\n- ",
    standup: "🧍 Daily Standup\n\n- What I did yesterday:\n- \n- What I will do today:\n- \n- Blockers:\n- "
};
