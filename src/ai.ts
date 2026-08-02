/**
 * @file ai.ts
 * @description All Cloudflare Workers AI calls: journal entry refinement/translation,
 * quote generation, and weekly summary writing.
 */

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
