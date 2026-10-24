# CommentDrop

Comment-to-get for YouTube. A viewer comments a keyword on a creator's video, and CommentDrop emails them the creator's file (a PDF, a template, a guide) from the creator's own Gmail account.

Live: https://commentdrop-app.vercel.app

## Features

- **Dashboard**: connected channel, deliveries and activity at a glance.
- **Automations**: pick a video, set the keyword and the file, and CommentDrop watches the comments and sends the file.
- **AI Comments inbox** (Claude Haiku 5.5):
  - an overview of what viewers are saying on each video
  - reply-to-all groups that cluster similar comments so one reply covers many
  - human review for anything the model is unsure about
  - spam and threat detection, with hide and ban

## Stack

- Node.js / Express, deployed on Vercel (static site in `public/`, API in `api/index.js`)
- Supabase Postgres, with pg_cron for scheduled polling
- YouTube Data API v3
- Gmail API (mail goes out from the creator's own Gmail)
- Google OAuth for sign-in
- Anthropic SDK for the comments inbox

## Run locally

```bash
npm install
cp .env.example .env   # then fill in the values
LOCAL_PGLITE=memory npm run dev
```

`LOCAL_PGLITE=memory` runs Postgres in-process with PGlite, so no database is needed. Set `LOCAL_PGLITE` to a folder path to keep the data between runs, or leave it unset and set `DATABASE_URL` to use a real Postgres. The server listens on `PORT` (3100 if unset).

Environment variables in `.env.example`:

- `YOUTUBE_API_KEY`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `SMTP_USER`, `SMTP_PASS`
- `CREATOR_NAME`, `CREATOR_CHANNEL_ID`
- `APP_URL`, `PORT`, `POLL_SECONDS`
- `ANTHROPIC_API_KEY`

The code also reads `DATABASE_URL`, `SESSION_SECRET`, `CRON_SECRET` and `LOCAL_PGLITE`.

## Project layout

```
api/            Vercel serverless entry (api/index.js)
src/            Express app: auth, YouTube, Gmail mailer, comment watcher, AI analysis, schema.sql
public/         Static site: landing, dashboard, automations, comments inbox
parked/studio/  Parked feature, not deployed or imported by the app
dev.js          Local server: API plus the static site
vercel.json     Rewrites /api/* to the function
```
