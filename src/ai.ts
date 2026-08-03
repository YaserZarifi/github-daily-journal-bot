/**
 * @file ai.ts
 * @description All Cloudflare Workers AI calls: journal entry refinement/translation,
 * grammar correction, tag suggestion, quote generation, and weekly summary writing.
 */

import { TAGS } from "./constants";

export async function refineTextWithAI(ai: any, text: string): Promise<string> {
    const response: any = await ai.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
        messages: [
            {
                role: "system",
                content: `You are an expert English editor, translator, and visionary Markdown designer.

Your task is to transform the user's raw journal text into a beautifully written and structured Markdown journal entry.

Follow these instructions strictly:

LANGUAGE & TRANSLATION:
- Automatically detect the language of the user's input.
- If the input is not English, translate it into natural, fluent English first.
- Do not translate word by word. Preserve the original meaning, emotions, personality, and context.
- After translation, refine the text as a professional English writer.

WRITING IMPROVEMENT:
- Correct all grammar, spelling, punctuation, and phrasing issues.
- Rewrite awkward sentences to sound natural and human.
- Improve readability, flow, and emotional impact.
- Preserve the user's original voice and intention.
- Make the writing feel personal and authentic, not like generic AI-generated content.
- Do not invent new facts, experiences, or ideas that are not present in the original text.

MARKDOWN FORMATTING:
- The final output MUST be pure Markdown format only.
- Do not include explanations, comments, introductions, or closing messages.
- Do not wrap the output inside markdown code blocks.
- Start with a meaningful H3 heading (###) that captures the essence of the journal entry.
- Use proper Markdown structure with headings, paragraphs, lists, bold, italics, and blockquotes when appropriate.
- Use **bold** for important insights, achievements, or key concepts.
- Use *italics* for emotions, reflections, or subtle thoughts.
- Use blockquotes (>) only for deep realizations, memorable thoughts, or philosophical reflections.
- Keep the structure clean and suitable for a personal GitHub journal.

STYLE RULES:
- NEVER use em dashes (—) or en dashes (–). Use commas, periods, parentheses, or separate sentences instead.
- Avoid cliché AI phrases and robotic wording.
- Avoid repetitive sentence patterns.
- Avoid common AI writing formulas such as:
  - "Not only... but also..."
  - "It's not X, it's Y"
  - "More than just..."
  - "Whether... or..."
- Avoid excessive motivational language or corporate-style writing.
- Make the final result feel like it was written by a thoughtful human developer documenting their journey.

OUTPUT REQUIREMENT:
Return ONLY the final Markdown journal entry.
The first character of your response must be '#'.`
            },
            { role: "user", content: text }
        ]
    });

    if (!response?.response || typeof response.response !== "string") {
        throw new Error(`refineTextWithAI got an unexpected AI response: ${JSON.stringify(response)}`);
    }

    return response.response;
}

/**
 * Produces a grammar-only corrected version of the text, distinct from refineTextWithAI's
 * creative rewrite. If the input isn't English, the source is left untouched (never
 * AI-edited) and only a faithful, grammar-corrected English translation is produced.
 */
export async function correctTextWithAI(ai: any, text: string): Promise<{ language: "en" | "other", correctedEnglish: string }> {
    const response: any = await ai.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
        messages: [
            {
                role: "system",
                content: `You are a precise grammar corrector, not a creative editor.

Task:
1. Detect whether the input text is written in English or another language.
2. Produce a grammatically corrected English version of the text:
   - If the input is English: fix grammar, spelling, and punctuation ONLY. Do not add, remove, or embellish content. Do not change tone or style.
   - If the input is not English: translate it into English as faithfully and literally as possible, then apply the same grammar/spelling/punctuation-only correction. Do not add content, opinions, or interpretation.

Return ONLY a JSON object in exactly this shape, nothing else, no markdown code fences:
{"language": "en", "corrected_english": "..."}`
            },
            { role: "user", content: text }
        ]
    });

    try {
        const raw = typeof response?.response === "string" ? response.response : "";
        const parsed = JSON.parse(raw.trim());
        const language = parsed.language === "en" ? "en" : "other";
        const correctedEnglish = typeof parsed.corrected_english === "string" ? parsed.corrected_english : text;
        return { language, correctedEnglish };
    } catch (err) {
        // If the model didn't return valid JSON, fall back to the raw text rather than
        // losing the entry — better an uncorrected commit than a crashed one.
        return { language: "en", correctedEnglish: text };
    }
}

/**
 * Picks 1-3 tags for the entry from the fixed TAGS list only. Never invents new tags,
 * so tag data stays bounded and filterable (e.g. for a future contribution-style graph).
 */
export async function suggestTagsWithAI(ai: any, text: string): Promise<string[]> {
    const response: any = await ai.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
        messages: [
            {
                role: "system",
                content: `You are a tagging assistant for a personal dev/life journal.
Pick between 1 and 3 tags that best describe the entry below, choosing ONLY from this fixed list:
${TAGS.join(", ")}

Rules:
- Only use tags from the list above, spelled exactly as shown. Never invent new tags.
- Return ONLY a JSON array of strings, nothing else, no markdown code fences. Example: ["coding", "milestone"]`
            },
            { role: "user", content: text }
        ]
    });

    try {
        const raw = typeof response?.response === "string" ? response.response : "";
        const parsed = JSON.parse(raw.trim());
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((t: any) => typeof t === "string" && TAGS.includes(t)).slice(0, 3);
    } catch (err) {
        return [];
    }
}

export async function generateQuoteWithAI(ai: any): Promise<string> {
    const topics = ["perseverance", "philosophy", "software engineering", "resilience", "stoicism", "innovation", "creativity", "hard work"];
    const randomTopic = topics[Math.floor(Math.random() * topics.length)];
    const randomSeed = Math.floor(Math.random() * 10000);

    const response: any = await ai.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
        messages: [
            { role: "system", content: `You are an assistant. Provide a single, inspiring, profound quote about ${randomTopic}. Only return the quote and the author. No introductory text. (Seed: ${randomSeed})` }
        ]
    });
    return response.response;
}

export async function summarizeWeekWithAI(ai: any, entries: { date: string, text: string }[]): Promise<string> {
    const combined = entries.map(e => `[${e.date}]\n${e.text}`).join("\n\n---\n\n");

    const response: any = await ai.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
        messages: [
            {
                role: "system",
                content: `You are a thoughtful journal assistant. You will be given a series of dated journal entries from one week.
Write a warm, reflective summary of the week: identify key themes, progress, recurring topics, and notable moments.
Keep it concise (roughly 150-250 words). Return ONLY the summary, no headers, no preamble.`
            },
            { role: "user", content: combined }
        ]
    });
    return response.response;
}
