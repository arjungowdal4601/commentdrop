import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { q, one } from './db.js';

// "Continue with Google": one consent covers sign-in, posting YouTube replies
// as the creator's channel, and sending material emails from their Gmail.
const SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/gmail.send',
];
const YT_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const COOKIE = 'cd_session';
const MAX_AGE = 30 * 24 * 3600; // 30 days

export const appUrl = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const redirectUri = () => `${appUrl()}/api/auth/google/callback`;
const secret = () => process.env.SESSION_SECRET || 'dev-only-secret';
const sign = (v) => createHmac('sha256', secret()).update(v).digest('base64url');

const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
const secure = () => appUrl().startsWith('https://');
const setCookie = (res, name, value, maxAge) => res.append('Set-Cookie',
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure() ? '; Secure' : ''}`);

export function startGoogle(req, res) {
  const state = randomBytes(16).toString('base64url');
  setCookie(res, 'cd_oauth_state', state, 600);
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  res.redirect(u.toString());
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description || body.error || 'Google token request failed');
  return body;
}

// Exchanges the code, finds the creator's YouTube channel and saves the creator.
export async function finishGoogle(req, res) {
  if (req.query.error) return res.redirect(`/?error=${encodeURIComponent(req.query.error)}`);
  if (!req.query.state || req.query.state !== cookies(req).cd_oauth_state) return res.redirect('/?error=state_mismatch');
  const t = await tokenRequest({ code: req.query.code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  const claims = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString());

  let channel = null;
  if (t.scope?.includes(YT_SCOPE)) {
    const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${t.access_token}` } });
    channel = (await r.json()).items?.[0] || null; // 1 quota unit
  }

  const creator = await one(`
    insert into creators (google_sub, email, name, channel_id, channel_title, channel_handle, channel_avatar, refresh_token, scope)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    on conflict (google_sub) do update set email = excluded.email, name = excluded.name,
      channel_id = coalesce(excluded.channel_id, creators.channel_id),
      channel_title = coalesce(excluded.channel_title, creators.channel_title),
      channel_handle = coalesce(excluded.channel_handle, creators.channel_handle),
      channel_avatar = coalesce(excluded.channel_avatar, creators.channel_avatar),
      refresh_token = coalesce(excluded.refresh_token, creators.refresh_token),
      scope = excluded.scope
    returning id`,
  [claims.sub, claims.email, claims.name || null, channel?.id || null, channel?.snippet?.title || null,
    channel?.snippet?.customUrl || null, channel?.snippet?.thumbnails?.default?.url || null, t.refresh_token || null, t.scope || '']);

  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const value = `${creator.id}.${exp}`;
  setCookie(res, COOKIE, `${value}.${sign(value)}`, MAX_AGE);
  setCookie(res, 'cd_oauth_state', '', 0);
  console.log(`👤 Creator signed in: ${claims.email} (${channel?.snippet?.title || 'no channel'})`);
  res.redirect('/dashboard');
}

export function signOut(req, res) {
  setCookie(res, COOKIE, '', 0);
  res.json({ ok: true });
}

function sessionCreatorId(req) {
  const raw = cookies(req)[COOKIE];
  if (!raw) return null;
  const [id, exp, sig] = raw.split('.');
  if (!id || !exp || !sig) return null;
  const expected = Buffer.from(sign(`${id}.${exp}`));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  return id;
}

// Express middleware: loads req.creator or answers 401.
export async function requireCreator(req, res, next) {
  try {
    const id = sessionCreatorId(req);
    const creator = id && (await one('select * from creators where id = $1', [id]));
    if (!creator) return res.status(401).json({ error: 'Sign in with Google first' });
    req.creator = creator;
    next();
  } catch (err) {
    next(err);
  }
}

export const canReply = (creator) => Boolean(creator.refresh_token && creator.scope?.includes(YT_SCOPE));
export const canEmail = (creator) => Boolean(creator.refresh_token && creator.scope?.includes(GMAIL_SCOPE));

// Short-lived Google access token for one creator (cached per warm function).
const tokens = new Map();
export async function accessToken(creator) {
  const hit = tokens.get(creator.id);
  if (hit && Date.now() < hit.expires) return hit.token;
  if (!creator.refresh_token) throw new Error('This creator needs to sign in with Google again');
  const t = await tokenRequest({ refresh_token: creator.refresh_token, grant_type: 'refresh_token' });
  tokens.set(creator.id, { token: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 });
  return t.access_token;
}

export const publicCreator = (c) => ({
  id: c.id, email: c.email, name: c.name, channelId: c.channel_id, channelTitle: c.channel_title,
  channelHandle: c.channel_handle, channelAvatar: c.channel_avatar, canReply: canReply(c), canEmail: canEmail(c),
});

export { q };
