import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

// One Claude call per video. It first writes a brief of what the video is
// about (from its title, description and tags), then reads every comment in
// that light: sentiment, tone, a category (incl. spam and threats), groups of
// similar comments with one reply per group, and an overview of the feedback.
const MODEL = 'claude-haiku-5-5';
const client = new Anthropic(); // reads ANTHROPIC_API_KEY

export const CATEGORIES = ['positive', 'neutral', 'suggestion', 'negative', 'spam', 'threat'];
export const RISKS = ['none', 'scam', 'impersonation', 'self_promo', 'bot', 'harassment', 'hate', 'threat'];
export const TONES = ['excited', 'grateful', 'curious', 'confused', 'frustrated', 'critical', 'skeptical', 'suggestion', 'humorous', 'matter-of-fact', 'spam'];

const Point = z.object({
  point: z.string().describe('A short plain sentence'),
  refs: z.array(z.string()).describe('Refs of the comments that back it, e.g. c2, c7'),
});

// Field order matters: the brief is generated before the comments are judged.
const Analysis = z.object({
  video_brief: z.object({
    topic: z.string().describe('One sentence: what this video is about and what it teaches or shows'),
    key_points: z.array(z.string()).describe('2-4 short phrases, the main things the video covers'),
    audience: z.string().describe('Who the video is for, in a few words'),
  }),
  summary: z.string().describe('One or two sentences on what viewers are saying overall'),
  comments: z.array(z.object({
    ref: z.string().describe('The comment ref, e.g. c3'),
    sentiment: z.enum(['positive', 'neutral', 'negative']),
    tone: z.enum(TONES),
    category: z.enum(CATEGORIES).describe('Exactly one bucket for the inbox'),
    risk: z.enum(RISKS).describe("'none' unless category is spam or threat"),
    needs_review: z.boolean().describe('true when you are not sure of the category or whether it is spam or a threat, so the creator decides'),
    review_reason: z.string().describe('If needs_review: one short line on why (e.g. "Could be sarcasm or a real complaint"); else empty'),
  })),
  groups: z.array(z.object({
    title: z.string().describe('Short label, e.g. "Asking how to install MCP servers"'),
    type: z.enum(['question', 'praise', 'request', 'feedback', 'complaint', 'spam', 'other']),
    tone: z.enum(TONES).describe('The dominant tone of the group'),
    refs: z.array(z.string()).describe('Refs of the comments in this group'),
    suggested_reply: z.string().describe('One reply that fits every comment in the group; empty for spam'),
  })),
  // Last, so it is written once every comment has been judged.
  overview: z.object({
    headline: z.string().describe('One sentence on the collective feedback for this video'),
    appreciation: z.array(Point).describe('What viewers liked, 0-4 items'),
    improvements: z.array(Point).describe('What viewers think could be better, 0-4 items'),
    requests: z.array(Point).describe('What viewers want next, 0-4 items'),
    warnings: z.array(Point).describe('Spam waves, impersonators, threats; empty if none. 0-4 items'),
  }),
});

const SYSTEM = `You help a YouTube creator understand and answer the comments on one of their videos.

Work in this order.

1. Understand the video first. From its title, description and tags (and what the comments imply), write a short brief: what it is about, its main points, and who it is for. Everything after this is read against that brief.

2. Judge each comment against the video. Sentiment is how the commenter feels about the video or creator: positive, neutral or negative. A plain question is neutral unless its tone says otherwise; "this went over my head" is negative even if polite. Tone is the most fitting one of: excited, grateful, curious, confused, frustrated, critical, skeptical, suggestion (an idea or request for future content), humorous, matter-of-fact, spam.

3. Give each comment exactly one category:
- positive: praise, thanks, enjoyment.
- neutral: questions, plain remarks, anything without a clear feeling.
- suggestion: an idea, request or improvement for the creator or future videos.
- negative: genuine criticism or complaint about the video or creator (not spam, not a threat).
- spam: scams, fake giveaways, crypto or investment pitches, "message me on Telegram/WhatsApp", impersonators of the creator (look-alike names, "reply to claim your prize"), bots, self-promotion, gibberish.
- threat: harassment, hate, threats of violence or doxxing aimed at the creator or anyone else.
Risk is 'none' unless the category is spam or threat; then pick the closest: scam, impersonation, self_promo, bot, harassment, hate or threat.
Set needs_review when you genuinely can't tell: sarcasm that could be praise or an insult, a link that could be helpful or spam, an account that might be the creator's friend or an impersonator, a joke that might be a threat. Give your best category anyway. Most comments should not need review.

4. Group comments that ask or say the same thing, so the creator can answer each group once. Use between 1 and 8 groups, put every comment in exactly one group, and prefer fewer, meaningful groups over many tiny ones. Scams, self-promotion and gibberish go in a "spam" group.

5. For each group except spam, write a suggested reply in the creator's voice: friendly, specific to what the group is about, grounded in what the video actually covers, at most 2 short sentences, and true for every comment in the group. Don't invent facts beyond the brief, don't include links, and don't start with a name or @mention (the app adds the commenter's handle).

6. Last, write an overview of what the comments say as a whole: a one-sentence headline, then up to 4 points each for appreciation (what they liked), improvements (what could be better), requests (what they want next) and warnings (spam waves, impersonators, threats; leave empty if none). Each point is a short plain sentence with the refs of the comments behind it. Leave a list empty rather than stretch.`;

// Old analyses (and anything Claude leaves out) get a category from tone/sentiment.
export function fallbackCategory(c) {
  if (c?.tone === 'spam') return 'spam';
  if (c?.tone === 'suggestion') return 'suggestion';
  return CATEGORIES.includes(c?.sentiment) ? c.sentiment : 'neutral';
}

function videoContext(video) {
  const tags = video.tags?.length ? `\nTags: ${video.tags.slice(0, 20).join(', ')}` : '';
  const desc = video.description?.trim() ? `\nDescription:\n${video.description.trim().slice(0, 3000)}` : '\nDescription: (none)';
  return `Video title: ${video.title}${tags}${desc}`;
}

export async function analyzeComments({ video, creatorName, comments, creatorComments = [] }) {
  // Short refs instead of YouTube's long ids keep the output small; mapped back below.
  const refs = new Map(comments.map((c, i) => [`c${i + 1}`, c]));
  const listing = [...refs].map(([ref, c]) => `${ref} | ${c.authorName}: ${c.text.replace(/\s+/g, ' ').slice(0, 600)}`).join('\n');
  const pinned = creatorComments.length
    ? `\nThe creator's own comments on this video (context only; don't judge or group them):\n${creatorComments.map((c) => `- ${c.text.replace(/\s+/g, ' ').slice(0, 600)}`).join('\n')}\n`
    : '';

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: 'medium', format: zodOutputFormat(Analysis) },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `Creator: ${creatorName}\n${videoContext(video)}\n${pinned}\n${comments.length} viewer comments:\n${listing}`,
    }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude declined to analyse these comments');
  if (response.stop_reason === 'max_tokens') throw new Error('Too many comments to analyse in one go');
  const out = response.parsed_output;
  if (!out) throw new Error('Claude returned an unreadable analysis, try again');

  const judged = new Map(out.comments.map((c) => [c.ref, c]));
  const grouped = new Set();
  const groups = out.groups
    .map((g) => {
      const ids = g.refs.filter((r) => refs.has(r) && !grouped.has(r));
      ids.forEach((r) => grouped.add(r));
      return { title: g.title, type: g.type, tone: g.tone, suggestedReply: g.type === 'spam' ? '' : g.suggested_reply, commentIds: ids.map((r) => refs.get(r).id) };
    })
    .filter((g) => g.commentIds.length);

  // Anything Claude left out still shows up, so no comment silently disappears.
  const leftover = [...refs.keys()].filter((r) => !grouped.has(r));
  if (leftover.length) groups.push({ title: 'Other comments', type: 'other', tone: 'matter-of-fact', suggestedReply: '', commentIds: leftover.map((r) => refs.get(r).id) });

  const toIds = (items = []) => items.map((p) => ({ point: p.point, commentIds: [...new Set(p.refs.filter((r) => refs.has(r)).map((r) => refs.get(r).id))] }));
  const ov = out.overview;
  const overview = ov ? {
    headline: ov.headline,
    appreciation: toIds(ov.appreciation),
    improvements: toIds(ov.improvements),
    requests: toIds(ov.requests),
    warnings: toIds(ov.warnings),
  } : null;

  return {
    brief: out.video_brief,
    summary: out.summary,
    model: response.model,
    usage: response.usage,
    comments: [...refs].map(([ref, c]) => {
      const j = { sentiment: 'neutral', tone: 'matter-of-fact', ...judged.get(ref) };
      const category = j.category || fallbackCategory(j);
      return {
        ...c, sentiment: j.sentiment, tone: j.tone, category, risk: (category === 'spam' || category === 'threat') && j.risk ? j.risk : 'none',
        needsReview: Boolean(j.needs_review), reviewReason: j.needs_review ? String(j.review_reason || '') : '',
      };
    }),
    groups,
    overview,
  };
}

const Polished = z.object({ reply: z.string() });

// Rewrites the creator's draft (or writes one if it's empty) for a group,
// keeping their meaning and voice.
export async function polishReply({ draft, video, brief, group, creatorName }) {
  const sample = group.comments.slice(0, 8).map((c) => `- ${c.authorName}: ${c.text.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
  const briefText = brief ? `What the video is about: ${brief.topic} Main points: ${brief.key_points.join('; ')}.` : '';
  const task = draft.trim()
    ? `Polish this draft reply. Keep the creator's meaning, facts and voice; fix grammar and clarity, make it warm and natural, and keep it to at most 2 short sentences unless the draft clearly needs more. Don't add facts, promises or links that aren't in the draft.\n\nDraft:\n${draft.trim()}`
    : 'Write a reply to this group from scratch: friendly, specific, at most 2 short sentences, no links, no invented facts.';

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'medium', format: zodOutputFormat(Polished) },
    system: 'You polish YouTube comment replies for a creator. The reply is posted under each comment in a group, after the commenter\'s @handle, so never start with a name, greeting with a name, or @mention.',
    messages: [{
      role: 'user',
      content: `Creator: ${creatorName}\nVideo: ${video.title}\n${briefText}\n\nComment group: ${group.title}\n${sample}\n\n${task}`,
    }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude declined to rewrite this reply');
  const reply = response.parsed_output?.reply?.trim();
  if (!reply) throw new Error('Claude returned an empty reply, try again');
  return reply;
}
