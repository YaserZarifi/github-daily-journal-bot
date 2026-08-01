export interface Env {
  TELEGRAM_TOKEN: string;
  GITHUB_TOKEN: string;
  JOURNAL_KV: KVNamespace;
  AI: any;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise {
    if (request.method === "POST") {
      const payload: any = await request.json();

      if (payload.message && payload.message.text) {
        const chatId = payload.message.chat.id;
        const originalText = payload.message.text;
        const botToken = env.TELEGRAM_TOKEN;

        const aiResponse: any = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
          messages: [
            { role: "system", content: "You are an English teacher. Fix any grammatical errors in the user's text. Keep the original tone. Return ONLY the corrected text. Do not add conversational filler." },
            { role: "user", content: originalText }
          ]
        });

        const refinedText = aiResponse.response;
        const messageToSend = `Original:\n${originalText}\n\nRefined:\n${refinedText}`;
        const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

        await fetch(telegramUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
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
        const chatId = payload.callback_query.message.chat.id;
        const messageId = payload.callback_query.message.message_id;
        const data = payload.callback_query.data;
        const textContent = payload.callback_query.message.text;
        const botToken = env.TELEGRAM_TOKEN;

        if (data === "reject") {
          await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
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

        const fileName = `Journal-${formattedDate.replace(/ /g, '')}-#${nextCount}.txt`;
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
            message: `Journal Entry: ${formattedDate}`,
            content: btoa(unescape(encodeURIComponent(textToCommit)))
          })
        });

        await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: `Successfully committed ${fileName} to GitHub!`
          })
        });
      }

      return new Response("OK");
    }

    return new Response("Webhook is active");
  }
};
