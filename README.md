# Telegram GitHub Journal Bot 

An intelligent, AI-powered personal journaling bot built on **Cloudflare Workers**.

This bot connects **Telegram** and **GitHub**, allowing you to maintain a daily coding and personal journal directly from your chat app. Write your thoughts, ideas, progress updates, or reflections in any language, and the bot automatically transforms them into polished, structured Markdown entries.

It uses AI to translate, refine, and humanize your writing, creates visual journal canvases with photo support, sends daily motivation, and tracks your consistency through journaling streaks.

---

##  Key Features

###  Telegram-to-GitHub Integration

- Send text entries or photos with captions directly to your Telegram bot.
- Review AI-refined drafts before publishing.
- Accept or reject generated journal entries using interactive buttons.
- Automatically commits approved entries to your GitHub repository.

---

###  Markdown Canvas & Visual Journaling

- Converts raw thoughts into beautifully structured Markdown (`.md`) journal entries.
- Generates clean headings, formatting, highlights, and reflections.
- Automatically stores uploaded photos inside organized weekly `assets` folders.
- Embeds images directly into journal entries for a rich visual experience.

Example structure:

    2026/
    └── 2026-W31/
        ├── journal-entry.md
        └── assets/
            └── image.png

- Generates and updates a dynamic repository `README.md` index.
- Makes browsing your personal history simple and organized.

---

###  AI-Powered Editing & Translation

Powered by Cloudflare Workers AI:

    @cf/meta/llama-4-scout-17b-16e-instruct

The AI automatically:

- Detects the input language.
- Translates non-English thoughts into natural English.
- Fixes grammar and spelling mistakes.
- Improves sentence flow and readability.
- Humanizes the writing while preserving the original personality and meaning.
- Converts raw notes into professional Markdown journal entries.

---

###  AI Quotes & Daily Motivation

Generate instant quotes using:

    /quote

Receive AI-generated thoughts about:

- Software engineering
- Programming
- Learning
- Philosophy
- Personal growth

A scheduled daily quote system helps maintain your GitHub contribution streak.

---

###  Streak & Statistics Tracking

Available commands:

    /stats

Shows your daily journal activity and committed entry count.

    /streak

Displays your current journaling consistency streak.

---

###  Smart Journaling Nudges

- Sends occasional reminders and thoughtful check-ins.
- Encourages consistent reflection and documentation.
- Helps transform journaling into a daily habit.

---

#  Architecture & Tech Stack

## Runtime

- Cloudflare Workers
- TypeScript
- Serverless edge execution

## Artificial Intelligence

- Cloudflare Workers AI
- Model:

    @cf/meta/llama-4-scout-17b-16e-instruct

## Storage & State Management

Cloudflare KV is used for:

- Daily journal statistics
- User streak tracking
- Temporary draft storage
- Interaction states

## External APIs

- Telegram Bot API
- GitHub Contents API

---

#  Setup & Deployment

## 1. Clone the Repository

    git clone https://github.com/YaserZarifi/github-daily-journal-bot.git

    cd github-daily-journal-bot

    npm install

---

## 2. Configure Cloudflare Secrets

Add required environment secrets:

    npx wrangler secret put TELEGRAM_TOKEN

    npx wrangler secret put GITHUB_TOKEN

    npx wrangler secret put ALLOWED_CHAT_IDS

    npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

---

## 3. Deploy to Cloudflare Workers

    npx wrangler deploy

---

#  Bot Commands

| Command | Description |
|---------|-------------|
| `/stats` | View today's committed journal entry count |
| `/quote` | Generate an AI-powered technical or philosophical quote |
| `/streak` | Check your current journaling streak |

You can also send:

-  Text messages
-  Photos with captions

The bot processes them, refines the content using AI, and provides an interactive preview before committing the final Markdown entry to GitHub.

---

#  Project Vision

Developers often document their code, but forget to document their own journey.

This project combines:

- AI writing assistance
- GitHub version control
- Personal knowledge management
- Automated journaling

to create a living archive of your learning process, ideas, achievements, and growth.

---

#  Author

**Yaser Zarifi**

Computer Engineer | Software Developer | AI Enthusiast

GitHub:
https://github.com/YaserZarifi
