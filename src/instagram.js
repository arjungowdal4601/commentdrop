import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { q, one } from './db.js';
import { appUrl } from './auth.js';

// Instagram API with Instagram Login (graph.instagram.com). Each creator connects
// their own Business or Creator account; we keep a 60-day token per creator and
// refresh it from the scheduler.
const GRAPH = 'https://graph.instagram.com/v23.0';
const SCOPES = ['instagram_business_basic', 'instagram_business_manage_comments', 'instagram_business_manage_messages'];
const DAY = 86_400_000;

export const igConfigured = () => Boolean(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET);
const redirectUri = () => `${appUrl()}/api/auth/instagram/callback`;
const secure = () => appUrl().startsWith('https://');

async function ig(token, method, path, { params = {}, body } = {}) {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error?.message || `Instagram API ${res.status}`);
  return data;
}

// ---- Creator connect ("Connect Instagram") ----------------------------------------
export function startInstagram(req, res) {
  if (!igConfigured()) return res.redirect(`/dashboard?instagram_error=${encodeURIComponent("Instagram isn't set up on this server yet")}`);
  const state = randomBytes(16).toString('base64url');
  res.append('Set-Cookie', `cd_ig_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure() ? '; Secure' : ''}`);
  const u = new URL('https://www.instagram.com/oauth/authorize');
  u.search = new URLSearchParams({
    enable_fb_login: '0',
    client_id: process.env.INSTAGRAM_APP_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(','),
    state,
  });
  res.redirect(u.toString());
}

// Code -> short-lived token (1 h) -> long-lived token (60 days), then saves the
// account on the creator and subscribes the app to its comment webhooks.
export async function finishInstagram(req, res) {
  const back = (qs) => res.redirect(`/dashboard?${qs}`);
  if (req.query.error) return back(`instagram_error=${encodeURIComponent(req.query.error_description || req.query.error)}`);
  const cookie = (req.headers.cookie || '').match(/(?:^|;\s*)cd_ig_state=([^;]+)/)?.[1];
  if (!req.query.state || req.query.state !== cookie) return back('instagram_error=state_mismatch');

  const code = String(req.query.code || '').replace(/#_$/, '');
  const r = await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: process.env.INSTAGRAM_APP_ID, client_secret: process.env.INSTAGRAM_APP_SECRET,
      grant_type: 'authorization_code', redirect_uri: redirectUri(), code,
    }),
  });
  const short = await r.json();
  if (!r.ok || !short.access_token) throw new Error(short.error_message || short.error?.message || 'Instagram sign-in failed');

  const long = await ig(short.access_token, 'GET', 'access_token', {
    params: { grant_type: 'ig_exchange_token', client_secret: process.env.INSTAGRAM_APP_SECRET },
  }).catch(() => ({ access_token: short.access_token, expires_in: 3600 }));
  const token = long.access_token;
  const me = await ig(token, 'GET', 'me', { params: { fields: 'user_id,username,account_type,profile_picture_url' } });

  // One Instagram account belongs to one creator at a time.
  await q('update creators set ig_user_id = null, ig_username = null, ig_avatar = null, ig_token = null, ig_token_expires = null where ig_user_id = $1 and id <> $2', [String(me.user_id), req.creator.id]);
  await q(`update creators set ig_user_id = $2, ig_username = $3, ig_avatar = $4, ig_token = $5, ig_token_expires = $6 where id = $1`,
    [req.creator.id, String(me.user_id), me.username, me.profile_picture_url || null, token, new Date(Date.now() + (long.expires_in || 3600) * 1000)]);
  await ig(token, 'POST', 'me/subscribed_apps', { params: { subscribed_fields: 'comments' } }).catch((err) => {
    console.warn(`⚠️  Instagram webhook subscription failed for @${me.username}: ${err.message}`);
  });
  res.append('Set-Cookie', 'cd_ig_state=; Path=/; Max-Age=0');
  console.log(`📸 ${req.creator.email} connected Instagram @${me.username} (${me.account_type})`);
  back('instagram=connected');
}

export async function disconnectInstagram(creator) {
  await q('update creators set ig_user_id = null, ig_username = null, ig_avatar = null, ig_token = null, ig_token_expires = null where id = $1', [creator.id]);
  mediaCache.delete(creator.id);
}

export const igStatus = (c) => ({
  configured: igConfigured(), connected: Boolean(c.ig_token), username: c.ig_username || null, avatar: c.ig_avatar || null,
});

// Long-lived tokens can be refreshed once they're a day old and must be before
// 60 days, so the scheduler refreshes anything expiring within 10 days.
export async function refreshInstagramTokens() {
  const due = await q(`select id, ig_username, ig_token from creators where ig_token is not null and ig_token_expires < now() + interval '10 days'`);
  for (const c of due) {
    try {
      const t = await ig(c.ig_token, 'GET', 'refresh_access_token', { params: { grant_type: 'ig_refresh_token' } });
      await q('update creators set ig_token = $2, ig_token_expires = $3 where id = $1', [c.id, t.access_token, new Date(Date.now() + t.expires_in * 1000)]);
    } catch (err) {
      console.error(`✗ Instagram token refresh failed for @${c.ig_username}: ${err.message}`);
    }
  }
  return due.length;
}

// ---- Posts ----------------------------------------------------------------------
const caption = (m) => (m.caption || '(no caption)').split('\n')[0].slice(0, 90);
const mediaRow = (m) => ({
  id: m.id,
  title: caption(m),
  thumb: m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url,
  permalink: m.permalink,
  type: m.media_product_type || m.media_type,
  comments: m.comments_count ?? 0,
  publishedAt: m.timestamp,
});

// Latest 50 posts and reels, cached 10 minutes per creator like the YouTube overview.
const mediaCache = new Map(); // creator id -> { at, data }
export async function listMedia(creator, refresh = false) {
  if (!creator.ig_token) throw new Error('Connect Instagram first');
  const hit = mediaCache.get(creator.id);
  if (hit && !refresh && Date.now() - hit.at < 600_000) return hit.data;
  const { data = [] } = await ig(creator.ig_token, 'GET', 'me/media', {
    params: { fields: 'id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,comments_count', limit: '50' },
  });
  const rows = data.map(mediaRow);
  mediaCache.set(creator.id, { at: Date.now(), data: rows });
  return rows;
}

export async function getMedia(creator, mediaId) {
  if (!/^\d+$/.test(String(mediaId))) throw new Error('Pick an Instagram post');
  const m = await ig(creator.ig_token, 'GET', mediaId, {
    params: { fields: 'id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,comments_count,owner' },
  });
  if (m.owner?.id && String(m.owner.id) !== String(creator.ig_user_id)) throw new Error('That post belongs to another account');
  return mediaRow(m);
}

// Newest top-level comments on a post (one page of 50), shaped like webhook values.
export async function mediaComments(creator, mediaId) {
  const { data = [] } = await ig(creator.ig_token, 'GET', `${mediaId}/comments`, {
    params: { fields: 'id,text,username,timestamp,from', limit: '50' },
  });
  return data.map((c) => ({ id: c.id, text: c.text, timestamp: c.timestamp, media: { id: mediaId }, from: c.from || { username: c.username } }));
}

// ---- Replies ----------------------------------------------------------------------
// Public reply under the comment ("Sent you a DM 📩").
export const replyPublic = (creator, commentId, text) =>
  ig(creator.ig_token, 'POST', `${commentId}/replies`, { params: { message: text } });

// Private reply: Meta allows one DM per comment, within 7 days of it.
export const privateReply = (creator, commentId, text) =>
  ig(creator.ig_token, 'POST', `${creator.ig_user_id}/messages`, { body: { recipient: { comment_id: commentId }, message: { text } } });

// ---- Webhooks ---------------------------------------------------------------------
// X-Hub-Signature-256 = sha256 HMAC of the raw body with the app secret.
export function validSignature(rawBody, header) {
  const secret = process.env.INSTAGRAM_APP_SECRET;
  if (!secret || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

// ---- One-time sign-in links (sent by DM) ------------------------------------------
export async function createLink(creatorId, igUserId, igUsername, commentId) {
  const token = randomBytes(18).toString('base64url');
  await q(`insert into ig_links (token, creator_id, ig_user_id, ig_username, comment_id, expires_at) values ($1, $2, $3, $4, $5, $6)`,
    [token, creatorId, igUserId, igUsername, commentId, new Date(Date.now() + 7 * DAY)]);
  return `${appUrl()}/join?ig=${token}`;
}

// What the /join page shows for a link, and whether it can still be used.
export async function linkInfo(token) {
  const l = /^[\w-]{10,64}$/.test(String(token)) && (await one(`
    select l.*, c.channel_title, c.name, c.ig_username as creator_ig, cp.material_name
    from ig_links l join creators c on c.id = l.creator_id
    left join deliveries d on d.comment_id = l.comment_id left join campaigns cp on cp.id = d.campaign_id
    where l.token = $1`, [token]));
  if (!l) return { valid: false, reason: 'not_found' };
  const reason = l.used_at ? 'used' : new Date(l.expires_at) < new Date() ? 'expired' : null;
  return {
    valid: !reason, reason, link: l,
    username: l.ig_username, creator: l.creator_ig ? `@${l.creator_ig}` : l.channel_title || l.name, materialName: l.material_name,
  };
}
