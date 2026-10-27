# CommentDrop

Comment-to-get for YouTube and Instagram. A viewer comments a keyword on a creator's video or post, and CommentDrop emails them the creator's file (a PDF, a template, a guide) from the creator's own Gmail account.

Live: https://commentdrop-app.vercel.app

## How it works

- **YouTube**: the scheduler (Supabase pg_cron → `/api/cron/poll`, every minute) makes one channel-level YouTube call per creator and matches new comments to that creator's automations. A viewer links their email once on `/join` with Google.
- **Instagram**: the creator connects a Business or Creator account with Instagram Login. Meta's comment webhook (`/api/webhooks/instagram`) tells us about each comment straight away. A first-time commenter gets one DM with a one-time Google sign-in link (plus a public "Sent you a DM 📩" reply); after that, files are emailed automatically.
- **Stored data**: delivery records only (who asked, for which video or post, sent or waiting, when). No comment text.

The AI Comments inbox from the hackathon version lives on the `prototype` branch; its files are kept in `parked/inbox/`.

## Stack

- Node.js / Express, deployed on Vercel (static site in `public/`, API in `api/index.js`)
- Supabase Postgres, with pg_cron for scheduled polling
- YouTube Data API v3
- Instagram API with Instagram Login (graph.instagram.com)
- Gmail API (mail goes out from the creator's own Gmail)
- Google OAuth for sign-in

## Run locally

```bash
npm install
cp .env.example .env   # then fill in the values
LOCAL_PGLITE=memory npm run dev
```

`LOCAL_PGLITE=memory` runs Postgres in-process with PGlite, so no database is needed. Set `LOCAL_PGLITE` to a folder path to keep the data between runs, or leave it unset and set `DATABASE_URL` to use a real Postgres. The server listens on `PORT` (3100 if unset).

Environment variables are listed in `.env.example`. The code also reads `LOCAL_PGLITE`. Instagram needs `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` and `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` from a Meta app with the Instagram product (API setup with Instagram login); set its redirect URL to `<APP_URL>/api/auth/instagram/callback` and its webhook to `<APP_URL>/api/webhooks/instagram` (field: `comments`).

## Project layout

```
api/            Vercel serverless entry (api/index.js)
src/            Express app: auth, YouTube, Instagram, Gmail mailer, comment watcher, schema.sql
public/         Static site: landing, dashboard, automations, viewer join page
parked/         Parked features (studio, AI comments inbox), not deployed or imported by the app
dev.js          Local server: API plus the static site
vercel.json     Rewrites /api/* to the function
```
