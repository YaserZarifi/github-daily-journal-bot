export interface Env {
    TELEGRAM_TOKEN: string;
    GITHUB_TOKEN: string;
    JOURNAL_KV: KVNamespace;
    AI: any;
    ALLOWED_CHAT_IDS: string;
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        if (request.method === "POST") {
            const payload: any = await request.json();
            const allowedIds = env.ALLOWED_CHAT_IDS.split(",").map(id => id.trim());
            const botToken = env.TELEGRAM_TOKEN;
            let currentChatId = null;

            if (payload.message && payload.message.chat) {
                currentChatId = payload.message.chat.id.toString();
            } else if (payload.callback_query && payload.callback_query.message.chat) {
                currentChatId = payload.callback_query.message.chat.id.toString();
            }

            if (!currentChatId) {
                return new Response("OK");
            }

            if (!allowedIds.includes(currentChatId)) {
                if (payload.message) {
                    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            chat_id: currentChatId,
                            text: "You are not authorized to use this bot."
                        })
                    });
                }
                return new Response("OK");
            }

            if (payload.message && payload.message.text) {
                const originalText = payload.message.text;

                if (originalText.trim() === "/stats") {
                    const fileDate = new Date().toISOString().split("T")[0];
                    const count = (await env.JOURNAL_KV.get(fileDate)) || "0";

                    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            chat_id: currentChatId,
                            text: `📊 You have committed ${count} journal entries today!`
                        })
                    });
                    return new Response("OK");
                }

                if (originalText.trim() === "/quote") {
                    const aiResponse: any = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
                        messages: [
                            { role: "system", content: "You are an assistant. Provide a single, inspiring, profound quote about perseverance, philosophy, or software engineering. Only return the quote and the author. No introductory text." }
                        ]
                    });

                    const quoteText = aiResponse.response;
                    const messageToSend = `Original:\n/quote\n\nRefined:\n${quoteText}`;

                    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            chat_id: currentChatId,
                            text: messageToSend,
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        { text: "Accept", callback_data: "commit_refined" },
                                    ],
                                    [
                                        { text: "Reject", callback_data: "reject" }
                                    ]
                                ]
                            }
                        })
                    });
                    return new Response("OK");
                }

                const aiResponse: any = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
                    messages: [
                        {
                            role: "system",
                            content: `You are an expert English editor and writer.

Your task is to improve the user's text while preserving its original meaning, intent, and tone.

Instructions:
- Correct all grammar, spelling, punctuation, and wording errors.
- Rewrite awkward or unnatural sentences to sound fluent and natural.
- Enrich the writing with better vocabulary and smoother sentence flow where appropriate.
- Improve clarity, readability, and coherence.
- Keep the text concise unless expansion genuinely improves quality.
- Preserve the user's voice instead of replacing it with a generic writing style.
- Make the writing sound as if it were written by a proficient native English speaker.
- Humanize the text. Avoid stereotypical AI writing patterns.
- NEVER use em dashes (—) or en dashes (–). Use commas or separate sentences instead.
- Avoid repetitive sentence structures.
- Avoid cliché AI phrases, excessive transitions, and predictable compare-and-contrast constructions (such as "not only... but also", "it's not X, it's Y", "whether... or...", "more than just...", "rather than...").
- Vary sentence lengths naturally.
- Do not exaggerate or invent information that was not present in the original text.
- Return ONLY the improved text with no explanations, quotation marks, or conversational filler.`
                        },
                        {
                            role: "user",
                            content: originalText
                        }
                    ]
                });

                const refinedText = aiResponse.response;
                const messageToSend = `Original:\n${originalText}\n\nRefined:\n${refinedText}`;

                await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        chat_id: currentChatId,
                        text: messageToSend,
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: "Accept", callback_data: "commit_refined" },
                                    { text: "Commit Original", callback_data: "commit_original" }
                                ],
                                [
                                    { text: "Reject", callback_data: "reject" }
                                ]
                            ]
                        }
                    })
                });
            }

            if (payload.callback_query) {
                const messageId = payload.callback_query.message.message_id;
                const data = payload.callback_query.data;
                const textContent = payload.callback_query.message.text;

                if (data === "reject") {
                    await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            chat_id: currentChatId,
                            message_id: messageId,
                            text: "Entry rejected and discarded."
                        })
                    });
                    return new Response("OK");
                }

                let textToCommit = "";
                const parts = textContent.split("Refined:\n");

                if (data === "commit_refined") {
                    textToCommit = parts[1];
                } else if (data === "commit_original") {
                    textToCommit = parts[0].replace("Original:\n", "").trim();
                }

                const dateOptions: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' };
                const formattedDate = new Intl.DateTimeFormat('en-GB', dateOptions).format(new Date());
                const fileDate = new Date().toISOString().split("T")[0];

                const count = (await env.JOURNAL_KV.get(fileDate)) || "0";
                const nextCount = parseInt(count) + 1;
                await env.JOURNAL_KV.put(fileDate, nextCount.toString());

                // FIX 1: Removed the '#' to prevent URL fragment truncation
                const fileName = `Journal-${formattedDate.replace(/ /g, '')}-${nextCount}.txt`;
                const githubToken = env.GITHUB_TOKEN;

                // FIX 2: Added encodeURIComponent to safely handle any weird characters in the filename
                const repoUrl = `https://api.github.com/repos/YaserZarifi/daily-dev-journal/contents/${encodeURIComponent(fileName)}`;

                // FIX 3: Capture the GitHub response
                const githubResponse = await fetch(repoUrl, {
                    method: "PUT",
                    headers: {
                        "Authorization": `Bearer ${githubToken}`,
                        "User-Agent": "Cloudflare-Worker",
                        "Accept": "application/vnd.github.v3+json"
                    },
                    body: JSON.stringify({
                        message: `Journal Entry: ${formattedDate}`,
                        content: btoa(unescape(encodeURIComponent(textToCommit)))
                    })
                });

                // FIX 4: Only say success if GitHub actually returns an OK status (200 or 201)
                if (githubResponse.ok) {
                    await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            chat_id: currentChatId,
                            message_id: messageId,
                            text: `Successfully committed ${fileName} to GitHub!`
                        })
                    });
                } else {
                    const errorData = await githubResponse.text();
                    await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            chat_id: currentChatId,
                            message_id: messageId,
                            text: `Failed to commit! GitHub responded with an error.`
                        })
                    });
                }
            }

            // This return successfully closes the POST request block!
            return new Response("OK");
        }

        return new Response("Webhook is active");
    },

    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        const is11PMTrigger = event.cron === "30 18 * * *";

        if (is11PMTrigger) {
            const aiResponse: any = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
                messages: [
                    { role: "system", content: "You are an assistant. Provide a single, inspiring, profound quote about perseverance, philosophy, or software engineering. Only return the quote and the author. No introductory text." }
                ]
            });

            const quoteContent = aiResponse.response;
            const dateOptions: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' };
            const formattedDate = new Intl.DateTimeFormat('en-GB', dateOptions).format(new Date());

            const fileName = `Daily-Quote-${formattedDate.replace(/ /g, '')}.txt`;
            const githubToken = env.GITHUB_TOKEN;
            const repoUrl = `https://api.github.com/repos/YaserZarifi/daily-dev-journal/contents/${fileName}`;

            await fetch(repoUrl, {
                method: "PUT",
                headers: {
                    "Authorization": `Bearer ${githubToken}`,
                    "User-Agent": "Cloudflare-Worker",
                    "Accept": "application/vnd.github.v3+json"
                },
                body: JSON.stringify({
                    message: `Daily Quote: ${formattedDate}`,
                    content: btoa(unescape(encodeURIComponent(quoteContent)))
                })
            });

        } else {
            const probability = Math.random();

            if (probability <= 0.35) {
                const botToken = env.TELEGRAM_TOKEN;
                const allowedIds = env.ALLOWED_CHAT_IDS.split(",").map(id => id.trim());

                const prompts = [
                    "Time for a quick journal update! What is on your mind?",
                    "Keep the GitHub streak alive! What are you working on right now?",
                    "Checking in! Drop a quick update for the journal.",
                    "Any new ideas or code you want to document?",
                    "How is the progress going today? Send a quick journal entry!"
                ];

                const randomPrompt = prompts[Math.floor(Math.random() * prompts.length)];

                for (const targetChatId of allowedIds) {
                    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            chat_id: targetChatId,
                            text: randomPrompt
                        })
                    });
                }
            }
        }
    }
};
