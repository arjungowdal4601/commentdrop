// The visual blueprint behind each storyboard beat: 1-3 shots (what the viewer
// sees and how the camera frames it) plus the set (where the creator sits, the
// light, the props). Storyboards written before this existed have none of it,
// so normalizeBeat derives a plain default from the beat's on_screen_type.
export const LAYOUTS = ['cam_full', 'cam_text', 'split', 'screen_bubble', 'screen_full', 'broll_full', 'title_card'];
export const SHOT_SIZES = ['extreme close-up', 'close-up', 'medium close-up', 'medium', 'wide', 'none'];
export const ANGLES = ['eye level', 'slightly high', 'low', 'overhead', 'none'];
export const SIDES = ['front', 'front-left', 'front-right', 'side', 'above', 'none'];
export const MOVES = ['static', 'slow push in', 'pull out', 'pan', 'handheld', 'none'];
export const LOOKS = ['into the lens', 'off camera', 'at the screen', 'none'];
export const POSTURES = ['sitting at desk', 'standing', 'walking', 'not on camera'];
export const DISTANCES = ["arm's length", 'about 1 m', 'about 2 m', 'none'];
export const LIGHTS = ['window in front', 'key light + fill', 'ring light', 'room light', 'none'];

const SHOT_ENUMS = { layout: LAYOUTS, shot_size: SHOT_SIZES, angle: ANGLES, camera_side: SIDES, movement: MOVES, look: LOOKS };
const SHOT_TEXT = ['you', 'screen', 'broll', 'text'];
const SET_ENUMS = { you: POSTURES, distance: DISTANCES, light: LIGHTS };
const SET_TEXT = ['background', 'gear'];

const DEFAULT_LAYOUT = { face: 'cam_full', screen: 'screen_bubble', broll: 'broll_full', text: 'title_card', mixed: 'split' };
export const showsYou = (layout) => ['cam_full', 'cam_text', 'split', 'screen_bubble'].includes(layout);

function defaultShot(beat) {
  const layout = DEFAULT_LAYOUT[beat.on_screen_type] || 'cam_full';
  const you = showsYou(layout);
  const broll = beat.on_screen_type === 'broll';
  return {
    seconds: beat.end_sec - beat.start_sec,
    layout,
    you: you ? 'Talking to camera' : '',
    screen: ['screen', 'mixed'].includes(beat.on_screen_type) ? beat.on_screen : '',
    broll: broll ? beat.on_screen : '',
    text: beat.on_screen_type === 'text' ? beat.label : '',
    shot_size: you ? (layout === 'screen_bubble' ? 'close-up' : 'medium close-up') : broll ? 'medium' : 'none',
    angle: you || broll ? 'eye level' : 'none',
    camera_side: you ? 'front' : broll ? 'front-right' : 'none',
    movement: you || broll ? 'static' : 'none',
    look: you ? 'into the lens' : 'none',
  };
}

const defaultSet = (onCam) => ({
  you: onCam ? 'sitting at desk' : 'not on camera',
  distance: onCam ? 'about 1 m' : 'none',
  light: onCam ? 'window in front' : 'none',
  background: onCam ? 'Plain wall' : '',
  props: [],
  gear: onCam ? 'Phone on a tripod at eye height' : 'Screen recorder',
});

const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);
const str = (v, max = 600) => (typeof v === 'string' ? v.slice(0, max) : null);

// Shot lengths must add up to the beat: scale them to whole seconds, at least 1 each.
function fitSeconds(shots, len) {
  const list = shots.slice(0, Math.max(1, Math.min(shots.length, len)));
  const weights = list.map((sh) => Math.max(1, Number(sh.seconds) || 1));
  const total = weights.reduce((a, w) => a + w, 0);
  let acc = 0;
  let prev = 0;
  return list.map((sh, i) => {
    acc += weights[i];
    const left = list.length - 1 - i;
    const end = i === list.length - 1 ? len : Math.min(len - left, Math.max(prev + 1, Math.round((acc / total) * len)));
    const out = { ...sh, seconds: end - prev };
    prev = end;
    return out;
  });
}

export function normalizeBeat(beat) {
  const len = Math.max(1, beat.end_sec - beat.start_sec);
  const base = defaultShot(beat);
  const raw = Array.isArray(beat.shots) && beat.shots.length ? beat.shots.slice(0, 3) : [base];
  const shots = fitSeconds(raw.map((sh) => {
    const out = { ...base, ...sh };
    for (const [k, list] of Object.entries(SHOT_ENUMS)) out[k] = pick(out[k], list, base[k]);
    for (const k of SHOT_TEXT) out[k] = str(out[k]) ?? '';
    return out;
  }), len);
  const onCam = shots.some((sh) => showsYou(sh.layout));
  const set = { ...defaultSet(onCam), ...(beat.set || {}) };
  for (const [k, list] of Object.entries(SET_ENUMS)) set[k] = pick(set[k], list, defaultSet(onCam)[k]);
  set.props = (Array.isArray(set.props) ? set.props : []).map((p) => String(p).slice(0, 40)).slice(0, 4);
  return { ...beat, shots, set };
}

// Edits from the page: one shot's fields, or the set. Unknown values are ignored.
export function patchShot(beat, i, patch = {}) {
  const shot = beat.shots[i];
  if (!shot) throw new Error('Unknown shot');
  const before = shot.layout;
  for (const [k, list] of Object.entries(SHOT_ENUMS)) if (list.includes(patch[k])) shot[k] = patch[k];
  for (const k of SHOT_TEXT) if (str(patch[k]) != null) shot[k] = str(patch[k]);
  if (shot.layout === before) return;
  // A new layout brings camera settings that make sense for it.
  if (showsYou(shot.layout)) {
    if (shot.shot_size === 'none') Object.assign(shot, { shot_size: 'medium close-up', angle: 'eye level', camera_side: 'front', movement: 'static', look: 'into the lens' });
    if (beat.set.you === 'not on camera') Object.assign(beat.set, { you: 'sitting at desk', distance: 'about 1 m' });
  } else if (shot.layout === 'broll_full') {
    if (shot.shot_size === 'none') Object.assign(shot, { shot_size: 'medium', angle: 'eye level', camera_side: 'front-right', movement: 'static' });
    shot.look = 'none';
  } else {
    Object.assign(shot, { shot_size: 'none', angle: 'none', camera_side: 'none', movement: 'none', look: 'none' });
  }
}
export function patchSet(beat, patch = {}) {
  for (const [k, list] of Object.entries(SET_ENUMS)) if (list.includes(patch[k])) beat.set[k] = patch[k];
  for (const k of SET_TEXT) if (str(patch[k], 200) != null) beat.set[k] = str(patch[k], 200);
  if (Array.isArray(patch.props)) beat.set.props = patch.props.map((p) => String(p).slice(0, 40)).filter(Boolean).slice(0, 4);
}
