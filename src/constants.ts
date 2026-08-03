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
