import { q, one } from './db.js';
import { latestComments, channelComments } from './youtube.js';
import { sendMaterial } from './mailer.js';
import { mediaComments, privateReply, replyPublic, createLink, refreshInstagramTokens } from './instagram.js';

// YouTube: the scheduler (Supabase pg_cron -> /api/cron/poll, every minute) makes
// one channel-level call per creator and matches keyword comments to automations.
// Instagram: Meta's comment webhook calls handleInstagramComment straight away.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const matchesKeyword = (keyword, text) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(keyword)}($|[^\\p{L}\\p{N}])`, 'iu').test(text || '');

const viewerFor = (d) => (d.platform === 'instagram'
  ? one('select * from viewers where instagram_user_id = $1', [d.author_channel_id])
  : one('select * from viewers where youtube_channel_id = $1', [d.author_channel_id]));

// Sends the material for one delivery row if its commenter has linked an email.
export async function deliver(commentId) {
  const d = await one('select * from deliveries where comment_id = $1', [commentId]);
  if (!d || d.status === 'sent') return d;
  const viewer = d.author_channel_id && (await viewerFor(d));
  if (!viewer) return d; // stays 'waiting' (or 'dm_sent') until they link an email
  const campaign = await one('select * from campaigns where id = $1', [d.campaign_id]);
  const creator = await one('select * from creators where id = $1', [d.creator_id]);

  try {
    await sendMaterial({ creator, campaign, delivery: d, viewer });
    await q(`update deliveries set status = 'sent', viewer_id = $2, error = null, delivered_via = 'email', delivered_at = now() where comment_id = $1`, [commentId, viewer.id]);
    console.log(`📨 Emailed "${campaign.material_name}" to ${viewer.email} for ${creator.email}`);
  } catch (err) {
    await q(`update deliveries set status = 'failed', viewer_id = $2, error = $3 where comment_id = $1`, [commentId, viewer.id, err.message]);
    console.error(`✗ Email to ${viewer.email} failed: ${err.message}`);
  }
  return one('select * from deliveries where comment_id = $1', [commentId]);
}

// Called right after a viewer links their email: anything they already asked for goes out now.
export async function catchUp(platform, authorId) {
  const rows = await q(`select comment_id from deliveries where platform = $1 and author_channel_id = $2 and status in ('waiting', 'dm_sent', 'failed')`, [platform, authorId]);
  let sent = 0;
  for (const r of rows) if ((await deliver(r.comment_id))?.status === 'sent') sent++;
  return sent;
}

// Records a keyword comment once (the comment id is the key). Returns false if already seen.
const record = async (platform, campaign, cm) => Boolean(await one(`insert into deliveries
  (comment_id, platform, campaign_id, creator_id, author_channel_id, author_name, commented_at)
  values ($1, $2, $3, $4, $5, $6, $7) on conflict (comment_id) do nothing returning comment_id`,
[cm.id, platform, campaign.id, campaign.creator_id, cm.authorId ?? null, cm.authorName, cm.publishedAt ?? new Date()]));

// ---- YouTube ------------------------------------------------------------------------
async function handleYouTubeComment(campaign, cm) {
  if (!matchesKeyword(campaign.keyword, cm.text)) return false;
  if (!(await record('youtube', campaign, { ...cm, authorId: cm.authorChannelId }))) return false;
  console.log(`💬 ${cm.authorName} asked for ${campaign.keyword} on ${campaign.video_id}`);
  await deliver(cm.id);
  return true;
}

// One call covers every video on the channel (1 quota unit per page of 100).
export async function pollCreator(creator) {
  const campaigns = await q(`select * from campaigns where creator_id = $1 and platform = 'youtube' and active`, [creator.id]);
  if (!campaigns.length || !creator.channel_id) return 0;
  const byVideo = Map.groupBy(campaigns, (c) => c.video_id);
  const comments = await channelComments(creator.channel_id, creator.yt_checked_at);
  let found = 0;
  for (const cm of comments) {
    for (const c of byVideo.get(cm.videoId) || []) if (await handleYouTubeComment(c, cm)) { found++; break; }
  }
  const newest = comments[0]?.publishedAt;
  if (newest) await q('update creators set yt_checked_at = greatest(coalesce(yt_checked_at, $2), $2) where id = $1', [creator.id, newest]);
  return found;
}

// ---- Instagram ----------------------------------------------------------------------
const maskEmail = (e) => e.replace(/^(.)[^@]*(@.*)$/, (_, a, b) => `${a}***${b}`);

// One webhook comment value: { id, text, parent_id?, from: { id, username }, media: { id } }.
export async function handleInstagramComment(creator, v) {
  if (!v?.id || v.parent_id || !v.media?.id || !v.from?.id) return false; // replies, or no commenter
  if (String(v.from.id) === String(creator.ig_user_id)) return false; // the creator's own comments and our replies
  const campaigns = await q(`select * from campaigns where creator_id = $1 and platform = 'instagram' and active and video_id = $2 order by id desc`, [creator.id, v.media.id]);
  const campaign = campaigns.find((c) => matchesKeyword(c.keyword, v.text));
  if (!campaign) return false;
  const username = v.from.username || 'instagram_user';
  if (!(await record('instagram', campaign, { id: v.id, authorId: String(v.from.id), authorName: `@${username}`, publishedAt: v.timestamp }))) return false;
  console.log(`💬 @${username} asked for ${campaign.keyword} on Instagram ${v.media.id}`);

  try {
    const viewer = await one('select * from viewers where instagram_user_id = $1', [String(v.from.id)]);
    if (viewer) {
      // Known viewer: straight to email; the one DM Meta allows just confirms it.
      const d = await deliver(v.id);
      if (d?.status === 'sent') await privateReply(creator, v.id, `Sent! ${campaign.material_name} is on its way to ${maskEmail(viewer.email)} ✓`).catch(() => {});
      return true;
    }
    // First time: one DM with a one-time Google sign-in link, plus a public nudge.
    const link = await createLink(creator.id, String(v.from.id), username, v.id);
    await privateReply(creator, v.id, `Hi @${username}! Want the ${campaign.material_name} by email? Sign in with Google here and it's sent right away: ${link}\n\nThe link is just for you and works once. After that, every file you ask for arrives automatically.`);
    await q(`update deliveries set status = 'dm_sent' where comment_id = $1`, [v.id]);
    await replyPublic(creator, v.id, 'Sent you a DM 📩').catch((err) => console.warn(`⚠️  Public reply failed: ${err.message}`));
  } catch (err) {
    await q(`update deliveries set status = 'failed', error = $2 where comment_id = $1`, [v.id, err.message]);
    console.error(`✗ Instagram DM to @${username} failed: ${err.message}`);
  }
  return true;
}

// Webhook body: { object: 'instagram', entry: [{ id: <account id>, changes: [{ field: 'comments', value }] }] }.
export async function handleInstagramWebhook(payload) {
  let handled = 0;
  for (const entry of payload?.entry || []) {
    const creator = await one('select * from creators where ig_user_id = $1 and ig_token is not null', [String(entry.id)]);
    if (!creator) continue;
    for (const change of entry.changes || []) {
      if (change.field === 'comments' && (await handleInstagramComment(creator, change.value))) handled++;
    }
  }
  return handled;
}

// ---- New automation: pick up comments that already exist ------------------------------
export async function backfillCampaign(c) {
  if (c.platform === 'instagram') {
    const creator = await one('select * from creators where id = $1', [c.creator_id]);
    const week = Date.now() - 7 * 86_400_000; // Meta only allows a DM within 7 days of the comment
    const comments = (await mediaComments(creator, c.video_id)).filter((v) => !v.timestamp || new Date(v.timestamp) > week);
    for (const v of comments) await handleInstagramComment(creator, v);
    return;
  }
  for (const cm of await latestComments(c.video_id)) await handleYouTubeComment(c, cm); // 1 quota unit
}

export async function pollAll() {
  const creators = await q(`select distinct cr.* from creators cr join campaigns c on c.creator_id = cr.id where c.active and c.platform = 'youtube'`);
  const results = [];
  for (const cr of creators) {
    try {
      results.push({ creator: cr.id, found: await pollCreator(cr) });
    } catch (err) {
      results.push({ creator: cr.id, error: err.message });
      console.error(`✗ Poll failed for ${cr.channel_title || cr.email}: ${err.message}`);
    }
  }
  await refreshInstagramTokens().catch((err) => console.error(`✗ Instagram token refresh: ${err.message}`));
  return results;
}
