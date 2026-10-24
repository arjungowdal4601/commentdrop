# Studio (parked 2026-10-24)

Removed from CommentDrop so the product stays focused on Automations and Comments.
Nothing here is deployed (`parked` is in `.vercelignore`) or imported by the app.

What it was: one video per project. Inspiration videos (transcripts from the Mac
service in `~/.local/share/commentdrop-transcripts`), Claude clarifying questions,
then a storyboard shown as an editor-style blueprint (shots, camera, set).

To bring it back:
1. Move `src/*` back to `src/` and `public/*` back to `public/`.
2. Append `public/studio.css` to `public/styles.css` and `schema-studio.sql` to `src/schema.sql`.
3. In `src/app.js`: `import { studioRouter } from './studio.js';` and, before the comments router,
   `app.use('/api/studio', express.json({ limit: '512kb' })); app.use(studioRouter);`
4. Add the Studio link back to the nav in `public/dashboard.html` and `public/comments.html`.
5. Restart the transcript service: move `ai.commentdrop.transcripts.plist` from
   `~/.local/share/commentdrop-transcripts/` to `~/Library/LaunchAgents/`, then
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.commentdrop.transcripts.plist`.

The Supabase tables (`studio_*`) and their data were left in place.
