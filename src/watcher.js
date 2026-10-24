import { q, one } from './db.js';
import { latestComments } from './youtube.js';
import { sendMaterial } from './mailer.js';

// Runs once a minute (Supabase pg_cron calls /api/cron/poll): checks every
// live automation for keyword comments and emails signed-up commenters.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const matchesKeyword = (keyword, text) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(keyword)}($|[^\\p{L}\\p{N}])`, 'iu').test(text || '');

// Sends the material for one delivery row if its commenter has signed up.
export async function deliver(commentId) {
  const d = await one('select * from deliveries where comment_id = $1', [commentId]);
  if (!d || d.status === 'sent') return d;
  const viewer = d.author_channel_id && (await one('select * from viewers where youtube_channel_id = $1', [d.author_channel_id]));
  if (!viewer) return d; // stays 'waiting' until they sign up
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

// Called right after a viewer signs up: anything they already asked for goes out now.
export async function catchUp(channelId) {
  const rows = await q(`select comment_id from deliveries where author_channel_id = $1 and status in ('waiting', 'failed')`, [channelId]);
  for (const r of rows) await deliver(r.comment_id);
  return rows.length;
}

export async function pollCampaign(c) {
  const comments = await latestComments(c.video_id); // 1 quota unit
  let found = 0;
  for (const cm of comments) {
    if (!matchesKeyword(c.keyword, cm.text)) continue;
    const inserted = await one(`insert into deliveries
      (comment_id, campaign_id, creator_id, author_channel_id, author_name, author_avatar, comment_text, commented_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (comment_id) do nothing returning comment_id`,
    [cm.id, c.id, c.creator_id, cm.authorChannelId ?? null, cm.authorName, cm.authorAvatar ?? null, cm.text, cm.publishedAt]);
    if (!inserted) continue; // already handled
    found++;
    console.log(`💬 ${cm.authorName} commented "${cm.text}" on ${c.video_id}`);
    await deliver(cm.id);
  }
  return found;
}

export async function pollAll() {
  const campaigns = await q('select * from campaigns where active order by id');
  const results = [];
  for (const c of campaigns) {
    try {
      results.push({ id: c.id, found: await pollCampaign(c) });
    } catch (err) {
      results.push({ id: c.id, error: err.message });
      console.error(`✗ Poll failed for ${c.video_id}: ${err.message}`);
    }
  }
  return results;
}
