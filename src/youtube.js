const API = 'https://www.googleapis.com/youtube/v3';
const key = () => process.env.YOUTUBE_API_KEY?.trim();

// Quota units spent since the server started (every read here costs 1, a reply or moderation call 50).
export const quota = { used: 0 };

async function yt(path, params) {
  quota.used += 1;
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries({ ...params, key: key() })) url.searchParams.set(k, v);
  // One retry on network blips ("fetch failed") so a flaky Wi-Fi moment doesn't drop a poll.
  const res = await fetch(url).catch(() => new Promise((r) => setTimeout(r, 800)).then(() => fetch(url)));
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message || `YouTube API ${res.status}`);
  return body;
}

// Accepts a full watch/shorts/youtu.be URL or a bare 11-char id.
export function parseVideoId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/);
  return m ? m[1] : null;
}

export async function getVideo(videoId) {
  const { items } = await yt('videos', { part: 'snippet', id: videoId });
  if (!items?.length) throw new Error('Video not found. Is it public?');
  const sn = items[0].snippet;
  return { id: videoId, title: sn.title, thumb: sn.thumbnails?.medium?.url, description: sn.description || '', tags: sn.tags || [] };
}

// Several videos in one call (1 quota unit): title, channel, thumbnail, length.
const isoSeconds = (iso) => {
  const m = String(iso || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? ((+m[1] || 0) * 86400) + ((+m[2] || 0) * 3600) + ((+m[3] || 0) * 60) + (+m[4] || 0) : null;
};
export async function getVideos(ids) {
  if (!ids.length) return [];
  const { items = [] } = await yt('videos', { part: 'snippet,contentDetails', id: ids.join(',') });
  return items.map((v) => ({
    id: v.id,
    title: v.snippet.title,
    channel: v.snippet.channelTitle,
    thumb: v.snippet.thumbnails?.medium?.url,
    durationSec: isoSeconds(v.contentDetails?.duration),
  }));
}

// @handle -> channel. This is how a viewer's account gets linked to the
// authorChannelId that YouTube puts on every comment they write.
export async function resolveHandle(input) {
  const handle = String(input || '').trim().replace(/^https?:\/\/(www\.)?youtube\.com\//, '').replace(/^@?/, '@');
  if (handle.length < 2) throw new Error('Enter your YouTube @handle');

  const { items } = await yt('channels', { part: 'snippet', forHandle: handle });
  if (!items?.length) throw new Error(`No YouTube channel found for ${handle}`);
  const sn = items[0].snippet;
  return { channelId: items[0].id, handle: sn.customUrl || handle, name: sn.title, avatar: sn.thumbnails?.default?.url };
}

const normaliseThread = (t) => {
  const s = t.snippet.topLevelComment.snippet;
  return {
    id: t.snippet.topLevelComment.id,
    authorChannelId: s.authorChannelId?.value,
    authorName: s.authorDisplayName,
    authorAvatar: s.authorProfileImageUrl,
    text: s.textOriginal ?? s.textDisplay,
    likes: s.likeCount ?? 0,
    publishedAt: s.publishedAt,
  };
};

// Every top-level comment on a video, newest first, up to `max`.
// 1 quota unit per page of 100. Returns the units used too.
export async function allComments(videoId, max = 300) {
  const out = [];
  let pageToken;
  let units = 0;
  do {
    const page = await yt('commentThreads', {
      part: 'snippet', videoId, order: 'time', maxResults: 100, textFormat: 'plainText', ...(pageToken && { pageToken }),
    });
    units++;
    out.push(...(page.items || []).map(normaliseThread));
    pageToken = page.nextPageToken;
  } while (pageToken && out.length < max);
  return { comments: out.slice(0, max), units };
}

// The creator's latest uploads (2 quota units: channel lookup + one playlist page of 50).
export async function channelVideos(channelId) {
  const { items } = await yt('channels', { part: 'contentDetails', id: channelId });
  const uploads = items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error('Channel not found');
  return uploadsPage(uploads);
}

async function uploadsPage(playlistId) {
  const page = await yt('playlistItems', { part: 'snippet', playlistId, maxResults: 50 });
  return (page.items || []).map((i) => ({
    id: i.snippet.resourceId.videoId,
    title: i.snippet.title,
    thumb: i.snippet.thumbnails?.medium?.url,
    publishedAt: i.snippet.publishedAt,
  }));
}

// YouTube sends counts as strings; missing (e.g. likes hidden) stays null.
const num = (v) => (v == null ? null : Number(v));

// Channel stats plus its latest 50 uploads with view/like/comment counts.
// 3 quota units: channels (snippet+statistics+contentDetails), one playlist page, one videos.list.
export async function channelOverview(channelId) {
  const { items } = await yt('channels', { part: 'snippet,statistics,contentDetails', id: channelId });
  const ch = items?.[0];
  if (!ch) throw new Error('Channel not found');
  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
  const list = uploads ? await uploadsPage(uploads) : [];
  const stats = new Map();
  if (list.length) {
    const { items: vids = [] } = await yt('videos', { part: 'snippet,statistics', id: list.map((v) => v.id).join(',') });
    for (const v of vids) stats.set(v.id, v);
  }
  const st = ch.statistics || {};
  return {
    channel: {
      id: ch.id,
      title: ch.snippet?.title,
      handle: ch.snippet?.customUrl || null,
      avatar: ch.snippet?.thumbnails?.default?.url,
      views: num(st.viewCount),
      subscribers: st.hiddenSubscriberCount ? null : num(st.subscriberCount),
      videoCount: num(st.videoCount),
    },
    videos: list.map((v) => {
      const s = stats.get(v.id);
      return {
        ...v,
        title: s?.snippet?.title ?? v.title,
        thumb: s?.snippet?.thumbnails?.medium?.url ?? v.thumb,
        views: num(s?.statistics?.viewCount),
        likes: num(s?.statistics?.likeCount),
        comments: num(s?.statistics?.commentCount),
      };
    }),
  };
}

// 10-minute cache per channel (lives as long as the warm serverless function).
const overviewCache = new Map(); // channel id -> { at, data }
export async function cachedOverview(channelId, refresh = false) {
  const hit = overviewCache.get(channelId);
  if (hit && !refresh && Date.now() - hit.at < 10 * 60_000) return hit.data;
  const data = await channelOverview(channelId);
  overviewCache.set(channelId, { at: Date.now(), data });
  return data;
}

// Posts a reply under a comment as the signed-in channel. 50 quota units.
export async function replyToComment(parentId, text, accessToken) {
  quota.used += 50;
  const res = await fetch(`${API}/comments?part=snippet`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ snippet: { parentId, textOriginal: text } }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message || `YouTube API ${res.status}`);
  return body.id;
}

// Hides comments from the channel (moderationStatus=rejected), optionally banning
// their authors too. Needs the channel owner's token; 50 quota units per call.
// Rejected comments can't be set back to published through the API.
export async function moderateComments(ids, { ban = false } = {}, accessToken) {
  quota.used += 50;
  const url = `${API}/comments/setModerationStatus?id=${ids.map(encodeURIComponent).join(',')}&moderationStatus=rejected${ban ? '&banAuthor=true' : ''}`;
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 204 || res.ok) return;
  const body = await res.json().catch(() => null);
  throw new Error(body?.error?.message || `YouTube API ${res.status}`);
}

// Newest top-level comments on a video, normalised. 1 quota unit per call.
export async function latestComments(videoId) {
  const { items = [] } = await yt('commentThreads', {
    part: 'snippet', videoId, order: 'time', maxResults: 100, textFormat: 'plainText',
  });
  return items.map(normaliseThread);
}
