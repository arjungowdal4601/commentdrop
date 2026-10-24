import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { LAYOUTS, SHOT_SIZES, ANGLES, SIDES, MOVES, LOOKS, POSTURES, DISTANCES, LIGHTS, normalizeBeat } from './blueprint.js';

// Studio brain: Claude Sonnet 5.5 at medium effort reads the inspiration
// transcripts, asks clarifying questions, then writes the storyboard.
// Server-side fallbacks ("default") let Anthropic retry a declined request
// on another model inside the same call.
const MODEL = 'claude-sonnet-5-5';
const client = new Anthropic(); // reads ANTHROPIC_API_KEY
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

// Streams (long storyboards would otherwise hit the SDK's non-streaming limit),
// then validates the JSON against the schema.
async function ask(schema, system, content, maxTokens = 16000) {
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    ...FALLBACK,
    output_config: { effort: 'medium', format: betaZodOutputFormat(schema) },
    system,
    messages: [{ role: 'user', content }],
  });
  const res = await stream.finalMessage();
  if (res.stop_reason === 'refusal') throw new Error('Claude declined this request; try rewording your notes');
  if (res.stop_reason === 'max_tokens') throw new Error('The answer was too long; try again');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try { parsed = schema.parse(JSON.parse(text)); } catch { throw new Error('Claude returned an unreadable answer; try again'); }
  return { data: parsed, model: res.model, usage: res.usage };
}

// ---- Context shared by every step ------------------------------------------------
const clip = (s, words) => {
  const w = String(s || '').split(/\s+/);
  return w.length > words ? `${w.slice(0, words).join(' ')} …[transcript cut for length]` : String(s || '');
};
const mmss = (s) => (s == null ? '?' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

export function briefText({ project, inspirations, rounds = [] }) {
  const parts = [
    `PROJECT: ${project.name}`,
    `FORMAT WANTED: ${project.format === 'auto' ? 'not sure, decide' : project.format === 'short' ? 'YouTube Short (vertical, up to 3 minutes)' : 'long-form YouTube video'}`,
    `THEIR TWIST (what they want to do differently): ${project.twist || '(not given)'}`,
  ];
  if (project.research) parts.push(`RESEARCH TOPICS THEY GAVE: ${project.research}`);
  if (project.research_notes) parts.push(`WEB RESEARCH FINDINGS:\n${project.research_notes}`);
  inspirations.forEach((v, i) => {
    parts.push([
      `\n=== INSPIRATION VIDEO ${i + 1}: "${v.title}" by ${v.channel || 'unknown'} (${mmss(v.duration_sec)})`,
      `What the creator likes about it: ${v.notes || '(no notes)'}`,
      v.transcript ? `Transcript (timestamps in [m:ss]):\n${clip(v.transcript, 9000)}` : 'Transcript: not available',
    ].join('\n'));
  });
  rounds.filter((r) => r.answers).forEach((r) => {
    const lines = r.questions.map((q) => `Q: ${q.question}\nA: ${formatAnswer(r.answers[q.id])}`);
    parts.push(`\n=== ANSWERS, ROUND ${r.round}\n${lines.join('\n')}`);
  });
  return parts.join('\n');
}
const formatAnswer = (a) => (a == null || a === '' ? '(skipped)' : Array.isArray(a) ? a.join(', ') : String(a));

const STUDIO_SYSTEM = `You are a friendly, sharp YouTube producer helping a brand-new creator plan one video. They gave you up to four videos that inspire them, notes on what they like, and their own twist. Study what the inspiration videos do (hook, pacing, structure, tone, how they hold attention) and help the creator make something of their own, never a copy. Write in plain, warm language a beginner understands.`;

// ---- Step: research the topics they listed (Claude's web search tool) -----------
export async function research(topics) {
  const messages = [{
    role: 'user',
    content: `A new YouTuber is planning a video and listed these research topics or links:\n${topics}\n\nSearch the web and write a short research brief (under 250 words): the key facts, numbers or angles worth using in the video, each with its source URL. Plain text, no preamble.`,
  }];
  for (let i = 0; i < 3; i++) {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      ...FALLBACK,
      output_config: { effort: 'medium' },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
      messages,
    });
    if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }
    if (res.stop_reason === 'refusal') return null;
    return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || null;
  }
  return null;
}

// ---- Step: clarifying questions (max 6 per round, max 2 rounds) ------------------
const Questions = z.object({
  understanding: z.string().describe('2-3 sentences: what you think this video is, for whom, and its angle'),
  ready: z.boolean().describe('true when you know enough to write a good storyboard'),
  questions: z.array(z.object({
    id: z.string().describe('short id like q1'),
    question: z.string(),
    why: z.string().describe('one short line: how the answer changes the video'),
    kind: z.enum(['single', 'multi', 'text']),
    options: z.array(z.string()).describe('2-5 tappable answers for single/multi; empty for text'),
  })),
});

export async function clarify({ project, inspirations, rounds, round }) {
  const rules = round === 1
    ? `Ask up to 6 questions, only ones whose answers change the storyboard: who the video is for and what they should feel or do after, ${project.format === 'auto' ? 'Long video or Short, ' : ''}how comfortable they are on camera and what they can film with, what to keep or avoid from each inspiration video, how their twist should show up, and the call to action. Skip anything their notes already answer. Prefer tappable options; the app always adds an "Other" box.`
    : 'This is the last round. Ask only what is still essential (0-4 questions). If you can already write a good storyboard, set ready=true and return no questions.';
  const { data, model } = await ask(Questions, STUDIO_SYSTEM,
    `${briefText({ project, inspirations, rounds })}\n\n=== YOUR TASK (question round ${round} of at most 2)\n${rules}`);
  data.questions = data.questions.slice(0, round === 1 ? 6 : 4).map((q, i) => ({ ...q, id: q.id || `q${i + 1}` }));
  if (!data.questions.length) data.ready = true;
  return { ...data, model };
}

// ---- Step: storyboard ------------------------------------------------------------
const Shot = z.object({
  seconds: z.number().int().describe('How long this shot lasts; the shots of a beat add up to its length'),
  layout: z.enum(LAYOUTS).describe('What fills the frame. cam_full: you fill the frame. cam_text: you on one side, big text or a graphic on the other. split: you and the screen side by side (stacked in a Short). screen_bubble: screen recording or graphic full frame with your face in a corner bubble. screen_full: screen recording or graphic only. broll_full: your own B-roll only. title_card: big text on a plain background'),
  you: z.string().describe('What the creator does in frame: pose, gesture, expression. Empty when they are not in this shot'),
  screen: z.string().describe('What the screen recording or graphic shows. Empty if none'),
  broll: z.string().describe('What the B-roll shows. Empty if none'),
  text: z.string().describe('The exact words shown on screen, at most 8. Empty if none'),
  shot_size: z.enum(SHOT_SIZES).describe('How tightly the camera frames the creator or the B-roll subject; none when nothing is filmed'),
  angle: z.enum(ANGLES).describe('Camera height: eye level, slightly high (looking down a little), low, or overhead (top-down)'),
  camera_side: z.enum(SIDES).describe('Where the camera stands relative to the creator, seen from above; above = top-down rig'),
  movement: z.enum(MOVES),
  look: z.enum(LOOKS).describe('Where the creator looks'),
});
const SetPlan = z.object({
  you: z.enum(POSTURES).describe('Where the creator is for this beat'),
  distance: z.enum(DISTANCES).describe('Camera to creator'),
  light: z.enum(LIGHTS),
  background: z.string().describe('What is behind the creator, a few words'),
  props: z.array(z.string()).describe('0-4 things in the scene, 1-3 words each'),
  gear: z.string().describe('What films it, e.g. "Phone on a tripod at eye height, 1x lens" or "Screen recorder"'),
});
const Beat = z.object({
  start_sec: z.number().int(),
  end_sec: z.number().int(),
  label: z.string().describe('2-4 words, e.g. "Hook", "Why it matters"'),
  on_screen_type: z.enum(['face', 'screen', 'broll', 'text', 'mixed']),
  on_screen: z.string().describe('What the viewer sees and what the creator films'),
  script: z.string().describe('The words the creator says, in their voice'),
  sound: z.string().describe('Music mood, sound effects or silence'),
  edit: z.string().describe('Cut style, zooms, captions, transitions'),
  reference: z.string().describe('Optional: which inspiration video and moment inspired this beat, e.g. "Video 2, 0:12 hook pacing"; empty if none'),
  shots: z.array(Shot).describe('1-3 shots in order: the blueprint of what the viewer sees'),
  set: SetPlan,
});
const Storyboard = z.object({
  title_ideas: z.array(z.string()).describe('3 title ideas'),
  hook: z.string().describe('The first line the viewer hears'),
  format: z.enum(['long', 'short']),
  target_length_sec: z.number().int(),
  summary: z.string().describe('One sentence: the promise of this video'),
  beats: z.array(Beat),
});

const STORYBOARD_RULES = `Write the storyboard as timed beats that run back to back from 0 to the target length.
- Short: vertical, 30-90 seconds unless the answers say otherwise (YouTube allows up to 3 minutes), 4-8 beats, hook in the first 2 seconds.
- Long video: usually 6-12 minutes, 8-14 beats, hook in the first 15 seconds, a payoff near the end, then the call to action.
- Plan only footage the creator makes themselves: talking to camera, screen recordings, their own B-roll, text on screen. Never reuse clips from the inspiration videos; YouTube can remove monetisation for reused content. You may name an inspiration moment as a style reference.
- Fit what they said about camera comfort and gear. Keep each field short and practical; the script is the words they will say.
- Blueprint each beat as 1-3 shots: start a new shot whenever the picture changes (a cut, a new layout or a new framing). Beats under 8 seconds get one shot. Vary the framing between neighbouring shots of the creator (medium, then close-up on the key line) so cuts feel intentional. Use "none" for camera fields in shots where nothing is filmed (pure screen recording, graphic or text).
- Keep the set consistent across beats (same seat, same light, same background) unless the video moves somewhere; a beginner films everything in one place.`;

export async function writeStoryboard({ project, inspirations, rounds }) {
  const { data, model } = await ask(Storyboard, STUDIO_SYSTEM,
    `${briefText({ project, inspirations, rounds })}\n\n=== YOUR TASK\n${STORYBOARD_RULES}`, 32000);
  if (!data.beats.length) throw new Error('The storyboard came back empty; try again');
  return { ...data, beats: data.beats.map((b, i) => normalizeBeat({ ...b, id: `b${i + 1}`, approved: false })), model };
}

// ---- Step: redo one beat -----------------------------------------------------------
export async function redoBeat({ project, inspirations, rounds, storyboard, beat, instruction }) {
  const outline = storyboard.beats.map((b) => `${b.id} ${b.start_sec}-${b.end_sec}s ${b.label}: ${b.script.slice(0, 120)}`).join('\n');
  const setLine = beat.set ? `\nThe creator's set elsewhere in the video: ${JSON.stringify(beat.set)}` : '';
  const { data } = await ask(Beat, STUDIO_SYSTEM, `${briefText({ project, inspirations, rounds })}

=== CURRENT STORYBOARD OUTLINE
Hook: ${storyboard.hook}
${outline}

=== BEAT TO REWRITE (${beat.id})
${JSON.stringify(beat)}

=== CREATOR'S REQUEST
${instruction || 'Make this beat stronger.'}
${setLine}
Rewrite only this beat. Keep start_sec and end_sec unless the request asks to change its length. ${STORYBOARD_RULES}`, 8000);
  return normalizeBeat({ ...data, id: beat.id, approved: false });
}
