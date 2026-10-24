// Blueprint drawings for the Studio storyboard: the program frame with dotted
// placement zones, the camera seen from the side, and the set seen from above.
// Pure functions that return HTML/SVG strings; studio-project.js places them.
const BP = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const n1 = (v) => Math.round(v * 10) / 10;
  const C = { you: '#5b9cf0', screen: '#f08a5d', broll: '#3cc995', text: '#f2b934', cap: '#a1a1aa', light: '#f5c451', cam: '#e4e4e7' };

  const LAYOUT_NAME = {
    cam_full: 'You, full frame', cam_text: 'You + text', split: 'Side by side', screen_bubble: 'Screen + face bubble',
    screen_full: 'Screen only', broll_full: 'B-roll only', title_card: 'Title card',
  };
  const LAYOUT_GROUPS = [['Camera only', ['cam_full', 'cam_text']], ['Camera + screen', ['split', 'screen_bubble']], ['No camera', ['screen_full', 'broll_full', 'title_card']]];
  const showsYou = (l) => ['cam_full', 'cam_text', 'split', 'screen_bubble'].includes(l);
  const layoutKind = (l) => (showsYou(l) ? 'you' : l === 'broll_full' ? 'broll' : l === 'title_card' ? 'text' : 'screen');
  const layoutName = (l, aspect) => (l === 'split' && aspect === 'v' ? 'Stacked' : LAYOUT_NAME[l]);

  // Zones as [kind, x%, y%, w%, h%, variant] for a 16:9 (h) or 9:16 (v) frame.
  const ZONES = {
    h: {
      cam_full: [['you', 4, 6, 92, 88]],
      cam_text: [['you', 4, 6, 50, 88], ['text', 58, 20, 38, 60, 'side']],
      split: [['you', 4, 6, 45, 88], ['screen', 51, 6, 45, 88]],
      screen_bubble: [['screen', 4, 6, 92, 88], ['you', 73, 54, 21, 37, 'bubble']],
      screen_full: [['screen', 4, 6, 92, 88]],
      broll_full: [['broll', 4, 6, 92, 88]],
      title_card: [['text', 12, 24, 76, 52, 'title']],
    },
    v: {
      cam_full: [['you', 5, 3, 90, 94]],
      cam_text: [['text', 8, 7, 84, 26, 'side'], ['you', 5, 36, 90, 61]],
      split: [['screen', 5, 3, 90, 46], ['you', 5, 51, 90, 46]],
      screen_bubble: [['screen', 5, 3, 90, 94], ['you', 50, 52, 40, 22, 'bubble']],
      screen_full: [['screen', 5, 3, 90, 94]],
      broll_full: [['broll', 5, 3, 90, 94]],
      title_card: [['text', 8, 28, 84, 36, 'title']],
    },
  };
  const LOWER = { h: [6, 62, 50, 17], v: [8, 55, 74, 11] };
  const CAPS = { h: [16, 84, 68, 9], v: [8, 70, 76, 8] };

  // ---- The creator, framed by shot size -------------------------------------------
  // Crop windows over a figure drawn in a 100-wide space (head at y=24, waist 120):
  // [centre y, height] for wide zones, [width, top] for tall ones.
  const FRAMING = {
    'extreme close-up': [24, 24, 30, 12], 'close-up': [34, 50, 60, 8], 'medium close-up': [46, 76, 84, 5],
    medium: [62, 120, 116, 2], wide: [100, 236, 170, -12], none: [46, 76, 84, 5],
  };
  function person(shot, sitting, aspect) {
    const [cy, H, W0, top] = FRAMING[shot.shot_size] || FRAMING.none;
    const vb = aspect >= 1 ? [50 - (H * aspect) / 2, cy - H / 2, H * aspect, H] : [50 - W0 / 2, top, W0, W0 / aspect];
    const dx = shot.look === 'off camera' ? -3.2 : shot.look === 'at the screen' ? 3.2 : 0;
    const legs = sitting
      ? '<g class="desk"><rect x="-80" y="108" width="260" height="8" rx="2"/><rect x="-6" y="116" width="5" height="96"/><rect x="101" y="116" width="5" height="96"/></g>'
      : '<path class="body" d="M25 118 L33 206 L46 206 L50 148 L54 206 L67 206 L75 118 Z"/>';
    return `<svg class="fig" viewBox="${vb.map(n1).join(' ')}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      ${sitting ? '' : legs}<g class="body"><path d="M17 64 C17 47 30 40 50 40 C70 40 83 47 83 64 L85 122 L15 122 Z"/><rect x="45" y="31" width="10" height="11" rx="3"/><circle cx="50" cy="24" r="11"/></g>
      <g class="eyes"><circle cx="${n1(45.6 + dx)}" cy="23" r="1.3"/><circle cx="${n1(54.4 + dx)}" cy="23" r="1.3"/></g>${sitting ? legs : ''}</svg>`;
  }

  // ---- Program frame -------------------------------------------------------------------
  // o: { aspect: 'h'|'v', sitting, mini, captions, captionHtml }
  function frame(shot, o = {}) {
    const a = o.aspect === 'v' ? 'v' : 'h';
    const ratio = a === 'v' ? 9 / 16 : 16 / 9;
    const zones = ZONES[a][shot.layout].map((z) => [...z]);
    if (shot.text && !zones.some((z) => z[0] === 'text')) zones.push(['text', ...LOWER[a], 'lower']);
    if (o.captions && !o.mini) zones.push(['cap', ...CAPS[a]]);
    const zoneHtml = zones.map(([kind, x, y, w, h, variant]) => {
      let inner = '';
      let label = { you: 'You', screen: 'Screen', broll: 'B-roll', text: 'Text', cap: o.live ? 'Script' : 'Captions' }[kind];
      if (kind === 'you') {
        inner = person(shot, o.sitting, (w * ratio) / h);
        if (shot.shot_size !== 'none') label += ` · ${cap1(shot.shot_size)}`;
      } else if (kind === 'screen') {
        inner = '<div class="scr"><div class="bar"><i></i><i></i><i></i><b></b></div><div class="sk"><i style="width:68%"></i><i style="width:48%"></i><i style="width:58%"></i><i style="width:36%"></i></div></div>';
      } else if (kind === 'broll') {
        inner = `<svg class="xph" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="0" x2="100" y2="100"/><line x1="100" y1="0" x2="0" y2="100"/></svg>
          <svg class="cam-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2" y="7" width="14" height="11" rx="2"/><path d="m16 11 6-3v9l-6-3"/></svg>`;
      } else if (kind === 'text') {
        inner = o.mini ? '<div class="tx-bars"><i></i><i></i></div>'
          : `<div class="tx-big ${variant || ''}">${shot.text ? esc(shot.text) : '<em>Your text here</em>'}</div>`;
      } else {
        inner = `<div class="cap-txt">${o.captionHtml || ''}</div>`;
      }
      return `<div class="z z-${kind} ${variant || ''}" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%">${inner}
        ${o.mini ? '' : `<span class="zt">${esc(label)}</span>`}</div>`;
    }).join('');
    const shortsUi = a === 'v' ? `<div class="sui"><div class="sui-r"><i></i><i></i><i></i><i></i></div><div class="sui-b"><i></i><i></i></div>${o.mini ? '' : '<span>Shorts buttons</span>'}</div>` : '';
    return `<div class="pf ${a} ${o.mini ? 'mini' : ''}" style="aspect-ratio:${a === 'v' ? '9/16' : '16/9'}">
      <div class="g3"><i></i><i></i><i></i><i></i></div><div class="safe"></div>${zoneHtml}${shortsUi}</div>`;
  }

  // ---- Camera, side view ------------------------------------------------------------
  const DIST_LABEL = { "arm's length": "arm's length", 'about 1 m': '≈ 1 m', 'about 2 m': '≈ 2 m' };
  function arrow(x1, y1, x2, y2, color) {
    const a = Math.atan2(y2 - y1, x2 - x1);
    const h = (d) => `${n1(x2 - 6 * Math.cos(a + d))},${n1(y2 - 6 * Math.sin(a + d))}`;
    return `<line x1="${n1(x1)}" y1="${n1(y1)}" x2="${n1(x2)}" y2="${n1(y2)}" stroke="${color}" stroke-width="1.6"/><polygon points="${n1(x2)},${n1(y2)} ${h(0.45)} ${h(-0.45)}" fill="${color}"/>`;
  }
  function camBody(x, y, deg) {
    return `<g transform="translate(${n1(x)} ${n1(y)}) rotate(${n1(deg)})"><rect x="-13" y="-8" width="20" height="16" rx="3" fill="#2a2a30" stroke="${C.cam}" stroke-width="1.4"/>
      <rect x="7" y="-5.5" width="8" height="11" rx="1.5" fill="#3a3a42" stroke="${C.cam}" stroke-width="1.2"/><rect x="-9" y="-11.5" width="8" height="3.5" rx="1" fill="${C.cam}"/></g>`;
  }
  function captureCard(shot) {
    const text = shot.layout === 'title_card';
    const broll = shot.layout === 'broll_full';
    const color = text ? C.text : broll ? C.broll : C.screen;
    const inner = text
      ? `<text x="160" y="80" text-anchor="middle" font-size="26" font-weight="800" fill="${color}">Aa</text>`
      : '<path d="M176 60 l0 22 l6 -6 l5 10 l4 -2 l-5 -10 l8 0 z" fill="#f4f4f5"/><circle cx="117" cy="45" r="3.5" fill="#ef4444"/><text x="124" y="48" font-size="8" font-weight="700" fill="#ef4444">REC</text>';
    const note = text ? 'No camera · make it in your editor (Canva, CapCut)' : broll ? 'No camera on you · film the B-roll separately' : 'No camera · record your screen at 1080p or more';
    return `<svg class="diag" viewBox="0 0 320 180" role="img" aria-label="${esc(note)}">
      <rect x="100" y="28" width="120" height="78" rx="7" fill="#1d1d22" stroke="${color}" stroke-width="1.5"/>
      <rect x="107" y="35" width="106" height="64" rx="3" fill="${color}" fill-opacity=".1" stroke="${color}" stroke-opacity=".5" stroke-dasharray="3 2"/>
      ${inner}<rect x="153" y="106" width="14" height="14" fill="#2a2a30"/><rect x="136" y="120" width="48" height="5" rx="2" fill="#2a2a30"/>
      <text x="160" y="152" text-anchor="middle" font-size="10.5" fill="#a1a1aa">${esc(note)}</text></svg>`;
  }
  function cameraView(shot, set) {
    if (shot.shot_size === 'none' || shot.camera_side === 'none') return captureCard(shot);
    const you = showsYou(shot.layout);
    const pose = !you || set.you === 'not on camera' ? 'object' : set.you === 'sitting at desk' ? 'sit' : 'stand';
    const color = pose === 'object' ? C.broll : C.you;
    const floor = 160;
    const eye = pose === 'stand' ? [234, 38] : pose === 'sit' ? [234, 69] : [226, 98];
    const over = shot.angle === 'overhead' || shot.camera_side === 'above';
    const camX = { "arm's length": 168, 'about 2 m': 66 }[set.distance] || 118;
    const cam = over ? [pose === 'stand' ? 226 : 206, 18]
      : [camX, Math.min(146, Math.max(20, eye[1] + ({ 'slightly high': -26, low: 34 }[shot.angle] || 0)))];
    const aim = { 'extreme close-up': [0, 6], 'close-up': [3, 12], 'medium close-up': [12, 20], medium: [24, 31], wide: pose === 'stand' ? [60, 66] : [42, 50] }[shot.shot_size] || [12, 20];
    let target = pose === 'object' ? [eye[0], eye[1]] : [eye[0] + 2, eye[1] + aim[0]];
    let spread = pose === 'object' ? aim[1] * 0.6 : aim[1];
    if (over) { target = pose === 'stand' ? [226, 96] : [pose === 'sit' ? 204 : 226, 104]; spread = Math.max(14, aim[1] * 0.8); }
    const deg = (Math.atan2(target[1] - cam[1], target[0] - cam[0]) * 180) / Math.PI;
    const tip = [cam[0] + 15 * Math.cos((deg * Math.PI) / 180), cam[1] + 15 * Math.sin((deg * Math.PI) / 180)];
    const cone = over
      ? `${n1(tip[0])},${n1(tip[1])} ${n1(target[0] - spread)},${target[1]} ${n1(target[0] + spread)},${target[1]}`
      : `${n1(tip[0])},${n1(tip[1])} ${target[0]},${n1(target[1] - spread)} ${target[0]},${n1(target[1] + spread)}`;

    const fig = `stroke="${color}" stroke-linecap="round" fill="none"`;
    const subject = pose === 'sit' ? `
        <g stroke="#3a3a42" stroke-width="4" stroke-linecap="round"><line x1="262" y1="92" x2="262" y2="158"/><line x1="238" y1="124" x2="262" y2="124"/><line x1="240" y1="124" x2="240" y2="158"/></g>
        <g fill="#2b2b31"><rect x="172" y="104" width="54" height="5" rx="1.5"/><rect x="176" y="109" width="4" height="49"/><rect x="218" y="109" width="4" height="49"/></g>
        <path d="M190 103 L214 103 M192 103 L186 87" stroke="#6b6b75" stroke-width="2.4" stroke-linecap="round"/>
        <g ${fig}><line x1="239" y1="81" x2="243" y2="121" stroke-width="11"/><line x1="243" y1="121" x2="219" y2="123" stroke-width="9"/>
        <line x1="219" y1="124" x2="219" y2="156" stroke-width="8"/><line x1="239" y1="90" x2="214" y2="101" stroke-width="5.5"/></g>
        <circle cx="236" cy="69" r="9.5" fill="${color}"/>`
      : pose === 'stand' ? `
        <g ${fig}><line x1="236" y1="49" x2="236" y2="100" stroke-width="11"/><line x1="236" y1="100" x2="230" y2="156" stroke-width="8"/>
        <line x1="236" y1="100" x2="243" y2="156" stroke-width="8"/><line x1="236" y1="56" x2="227" y2="92" stroke-width="5.5"/></g>
        <circle cx="236" cy="38" r="9.5" fill="${color}"/>`
      : `<g fill="#2b2b31"><rect x="186" y="106" width="86" height="5" rx="1.5"/><rect x="190" y="111" width="4" height="47"/><rect x="264" y="111" width="4" height="47"/></g>
        <path d="M208 105 L244 105 M210 105 L203 86" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`;

    let rig = '';
    const handheld = shot.movement === 'handheld';
    if (over) rig = `<g stroke="#4a4a52" stroke-width="3" stroke-linecap="round"><line x1="140" y1="158" x2="140" y2="12"/><line x1="140" y1="12" x2="${cam[0] - 8}" y2="12"/><line x1="128" y1="158" x2="152" y2="158"/></g>`;
    else if (set.distance === "arm's length" && pose !== 'object' && !/tripod|stand|mount|clamp/i.test(set.gear || '')) rig = `<line x1="${eye[0] - 2}" y1="${eye[1] + 22}" x2="${cam[0] + 8}" y2="${cam[1] + 4}" stroke="${color}" stroke-width="5" stroke-linecap="round" opacity=".75"/>`;
    else if (!handheld) rig = `<g stroke="#4a4a52" stroke-width="2.2" stroke-linecap="round"><line x1="${cam[0]}" y1="${cam[1] + 8}" x2="${cam[0] - 17}" y2="${floor}"/><line x1="${cam[0]}" y1="${cam[1] + 8}" x2="${cam[0] + 17}" y2="${floor}"/><line x1="${cam[0]}" y1="${cam[1] + 8}" x2="${cam[0]}" y2="${floor}"/></g>`;

    let move = '';
    const my = cam[1] < 40 ? cam[1] + 30 : cam[1] - 20;
    if (shot.movement === 'slow push in') move = arrow(cam[0] - 6, my, cam[0] + 30, my, C.light) + `<text x="${cam[0] + 12}" y="${my - 6}" text-anchor="middle" font-size="9" fill="${C.light}">push in</text>`;
    if (shot.movement === 'pull out') move = arrow(cam[0] + 30, my, cam[0] - 6, my, C.light) + `<text x="${cam[0] + 12}" y="${my - 6}" text-anchor="middle" font-size="9" fill="${C.light}">pull out</text>`;
    if (shot.movement === 'pan') move = `<path d="M${cam[0] - 16} ${my + 4} Q${cam[0]} ${my - 10} ${cam[0] + 16} ${my + 4}" fill="none" stroke="${C.light}" stroke-width="1.6"/>${arrow(cam[0] + 12, my + 1, cam[0] + 16, my + 4, C.light)}<text x="${cam[0]}" y="${my - 10}" text-anchor="middle" font-size="9" fill="${C.light}">pan</text>`;
    if (handheld) move = `<g stroke="${C.light}" stroke-width="1.4" fill="none"><path d="M${cam[0] - 20} ${cam[1] - 4} q3 -4 0 -8 q-3 -4 0 -8"/><path d="M${cam[0] + 22} ${cam[1] - 4} q3 -4 0 -8 q-3 -4 0 -8"/></g><text x="${cam[0]}" y="${my - 4}" text-anchor="middle" font-size="9" fill="${C.light}">handheld</text>`;

    const eyeLine = !over && shot.angle === 'eye level' && pose !== 'object'
      ? `<line x1="${cam[0] + 16}" y1="${eye[1]}" x2="${eye[0] - 12}" y2="${eye[1]}" stroke="#ffffff" stroke-opacity=".35" stroke-dasharray="2 3"/><text x="${(cam[0] + eye[0]) / 2}" y="${eye[1] - 5}" text-anchor="middle" font-size="8.5" fill="#a1a1aa">eye line</text>` : '';
    const dist = DIST_LABEL[set.distance];
    const dim = !over && dist ? `<g stroke="#63636b" stroke-width="1"><line x1="${cam[0]}" y1="170" x2="${eye[0]}" y2="170"/><line x1="${cam[0]}" y1="166" x2="${cam[0]}" y2="174"/><line x1="${eye[0]}" y1="166" x2="${eye[0]}" y2="174"/></g>
      <rect x="${(cam[0] + eye[0]) / 2 - 28}" y="164" width="56" height="12" rx="6" fill="#0c0c0e"/><text x="${(cam[0] + eye[0]) / 2}" y="173" text-anchor="middle" font-size="9" fill="#a1a1aa">${esc(dist)}</text>` : '';
    const bg = set.background ? `<line x1="294" y1="14" x2="294" y2="${floor}" stroke="#3a3a42" stroke-width="4"/><text transform="translate(306 ${floor - 4}) rotate(-90)" font-size="8.5" fill="#71717a">${esc(set.background.slice(0, 26))}</text>` : '';

    return `<svg class="diag" viewBox="0 0 320 180" role="img" aria-label="${esc(`Camera ${shot.angle}, ${shot.shot_size}, ${set.distance}`)}">
      <line x1="10" y1="${floor}" x2="300" y2="${floor}" stroke="#3a3a42" stroke-width="1.5"/>${bg}
      <polygon points="${cone}" fill="${color}" fill-opacity=".14" stroke="${color}" stroke-opacity=".55" stroke-dasharray="3 3"/>
      ${subject}${eyeLine}${rig}${camBody(cam[0], cam[1], deg)}${move}${dim}</svg>`;
  }

  // ---- Set, seen from above ------------------------------------------------------------
  const HALF = { 'extreme close-up': 7, 'close-up': 12, 'medium close-up': 17, medium: 23, wide: 32, none: 17 };
  function setView(shot, set) {
    const onCam = set.you !== 'not on camera';
    const sitting = set.you === 'sitting at desk';
    const P = set.you === 'standing' ? [160, 80] : set.you === 'walking' ? [126, 80] : [160, 62];
    const desk = sitting ? [106, 82, 108, 26] : onCam ? null : [106, 60, 108, 36];
    const focus = onCam ? P : [160, 78];
    const filmed = shot.shot_size !== 'none' && shot.camera_side !== 'none';
    const over = shot.angle === 'overhead' || shot.camera_side === 'above';
    const sideDeg = { front: 0, 'front-left': -35, 'front-right': 35, side: 80 }[shot.camera_side] ?? 0;
    const d = { "arm's length": 50, 'about 2 m': 114 }[set.distance] || 84;
    const r = (sideDeg * Math.PI) / 180;
    const cam = [focus[0] + Math.sin(r) * d, Math.min(186, focus[1] + Math.cos(r) * d)];
    const toFocus = Math.atan2(focus[1] - cam[1], focus[0] - cam[0]);

    let lights = '';
    const beam = (x, y, size, label) => {
      const a = Math.atan2(P[1] - y, P[0] - x);
      const s1 = [P[0] + 26 * Math.cos(a + Math.PI / 2), P[1] + 26 * Math.sin(a + Math.PI / 2)];
      const s2 = [P[0] + 26 * Math.cos(a - Math.PI / 2), P[1] + 26 * Math.sin(a - Math.PI / 2)];
      return `<polygon points="${n1(x)},${n1(y)} ${n1(s1[0])},${n1(s1[1])} ${n1(s2[0])},${n1(s2[1])}" fill="${C.light}" fill-opacity=".09"/>
        <g transform="translate(${n1(x)} ${n1(y)}) rotate(${n1((a * 180) / Math.PI)})"><rect x="-4" y="${-size / 2}" width="8" height="${size}" rx="2" fill="#3a3216" stroke="${C.light}" stroke-width="1.4"/></g>
        <text x="${n1(x)}" y="${n1(y + (y > P[1] ? 16 : -10))}" text-anchor="middle" font-size="8.5" fill="${C.light}">${label}</text>`;
    };
    if (set.light === 'window in front') {
      lights = `<g stroke="${C.light}" stroke-opacity=".35" stroke-dasharray="2 4">${[-30, 0, 30].map((dx) => `<line x1="${160 + dx}" y1="192" x2="${P[0] + dx / 3}" y2="${P[1] + 12}"/>`).join('')}</g>
        <rect x="118" y="190" width="84" height="6" fill="#0c0c0e" stroke="${C.light}" stroke-width="1.4"/><line x1="118" y1="193" x2="202" y2="193" stroke="${C.light}" stroke-width=".8"/>
        <text x="236" y="196" font-size="8.5" fill="${C.light}">Window</text>`;
    } else if (set.light === 'key light + fill') {
      lights = beam(P[0] - 78, P[1] + 58, 22, 'Key') + beam(P[0] + 84, P[1] + 50, 14, 'Fill');
    } else if (set.light === 'room light') {
      lights = `<circle cx="286" cy="38" r="18" fill="${C.light}" fill-opacity=".06" stroke="${C.light}" stroke-opacity=".4" stroke-dasharray="2 3"/><circle cx="286" cy="38" r="5" fill="${C.light}"/><text x="286" y="66" text-anchor="middle" font-size="8.5" fill="${C.light}">Room light</text>`;
    }

    let camera = '';
    if (filmed && over) {
      // Top-down rig: frame the desk for B-roll, the creator otherwise.
      const box = desk && !showsYou(shot.layout) ? [desk[0] - 6, desk[1] - 6, desk[2] + 12, desk[3] + 12] : [focus[0] - 30, focus[1] - 18, 60, 36];
      const [bx, by, bw, bh] = box;
      camera = `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="6" fill="${C.cam}" fill-opacity=".05" stroke="${C.cam}" stroke-dasharray="3 3"/>
        <circle cx="${bx + bw}" cy="${by}" r="7" fill="#2a2a30" stroke="${C.cam}" stroke-width="1.4"/><circle cx="${bx + bw}" cy="${by}" r="2.6" fill="${C.cam}"/>
        <text x="${bx + bw + 12}" y="${by + 4}" font-size="8.5" fill="${C.cam}">camera above,</text><text x="${bx + bw + 12}" y="${by + 15}" font-size="8.5" fill="${C.cam}">looking down</text>`;
    } else if (filmed) {
      const half = (HALF[shot.shot_size] * Math.PI) / 180;
      const len = d + 30;
      const e1 = [cam[0] + len * Math.cos(toFocus - half), cam[1] + len * Math.sin(toFocus - half)];
      const e2 = [cam[0] + len * Math.cos(toFocus + half), cam[1] + len * Math.sin(toFocus + half)];
      const ring = set.light === 'ring light' ? `<circle cx="${n1(cam[0])}" cy="${n1(cam[1])}" r="15" fill="none" stroke="${C.light}" stroke-width="2"/><text x="${n1(cam[0] + 20)}" y="${n1(cam[1] + 3)}" font-size="8.5" fill="${C.light}">Ring light</text>` : '';
      const dist = DIST_LABEL[set.distance];
      const mid = [(cam[0] + focus[0]) / 2, (cam[1] + focus[1]) / 2];
      camera = `<polygon points="${n1(cam[0])},${n1(cam[1])} ${n1(e1[0])},${n1(e1[1])} ${n1(e2[0])},${n1(e2[1])}" fill="${onCam ? C.you : C.broll}" fill-opacity=".12" stroke="${onCam ? C.you : C.broll}" stroke-opacity=".5" stroke-dasharray="3 3"/>
        ${dist ? `<rect x="${n1(mid[0] - 25)}" y="${n1(mid[1] - 6)}" width="50" height="12" rx="6" fill="#0c0c0e"/><text x="${n1(mid[0])}" y="${n1(mid[1] + 3)}" text-anchor="middle" font-size="8.5" fill="#a1a1aa">${esc(dist)}</text>` : ''}
        ${ring}${camBody(cam[0], cam[1], (toFocus * 180) / Math.PI)}`;
    }

    let deskHtml = '';
    if (desk) {
      const props = set.props || [];
      deskHtml = `<rect x="${desk[0]}" y="${desk[1]}" width="${desk[2]}" height="${desk[3]}" rx="3" fill="#232328" stroke="#3a3a42"/>` + props.map((p, i) => {
        const x = desk[0] + (desk[2] * (i + 1)) / (props.length + 1);
        return `<rect x="${n1(x - 7)}" y="${desk[1] + desk[3] / 2 - 4}" width="14" height="8" rx="2" fill="#3a3a42"/>
          <text x="${n1(x)}" y="${desk[1] + desk[3] + 10 + (i % 2) * 9}" text-anchor="middle" font-size="7.5" fill="#8a8a93">${esc(String(p).slice(0, 12))}</text>`;
      }).join('');
    }

    let who = '';
    if (onCam) {
      const face = !filmed || shot.look === 'at the screen' || over ? Math.PI / 2
        : Math.atan2(cam[1] - P[1], cam[0] - P[0]) + (shot.look === 'off camera' ? 0.7 : 0);
      const fd = (face * 180) / Math.PI;
      const tipP = (k) => [P[0] + k * Math.cos(face), P[1] + k * Math.sin(face)];
      const [tx, ty] = tipP(13.5);
      const [bx, by] = tipP(8);
      const px = 3.4 * Math.cos(face + Math.PI / 2);
      const py = 3.4 * Math.sin(face + Math.PI / 2);
      who = `${sitting ? `<rect x="${P[0] - 14}" y="${P[1] - 24}" width="28" height="9" rx="4" fill="#2b2b31"/>` : ''}
        ${set.you === 'standing' ? `<g stroke="${C.light}" stroke-opacity=".6" stroke-width="2"><line x1="${P[0] - 8}" y1="${P[1] - 8}" x2="${P[0] + 8}" y2="${P[1] + 8}"/><line x1="${P[0] + 8}" y1="${P[1] - 8}" x2="${P[0] - 8}" y2="${P[1] + 8}"/></g>` : ''}
        ${set.you === 'walking' ? `<path d="M${P[0] + 22} ${P[1]} L${P[0] + 96} ${P[1]}" stroke="${C.you}" stroke-dasharray="3 3"/>${arrow(P[0] + 86, P[1], P[0] + 100, P[1], C.you)}` : ''}
        <ellipse cx="${P[0]}" cy="${P[1]}" rx="19" ry="8.5" transform="rotate(${n1(fd - 90)} ${P[0]} ${P[1]})" fill="${C.you}" fill-opacity=".28" stroke="${C.you}" stroke-width="1.4"/>
        <circle cx="${P[0]}" cy="${P[1]}" r="8.5" fill="${C.you}"/>
        <polygon points="${n1(tx)},${n1(ty)} ${n1(bx + px)},${n1(by + py)} ${n1(bx - px)},${n1(by - py)}" fill="${C.you}"/>
        <text x="${P[0] - 24}" y="${P[1] - 10}" text-anchor="end" font-size="8.5" font-weight="700" fill="${C.you}">YOU</text>`;
    }

    const bg = set.background ? `<text x="20" y="27" font-size="8.5" fill="#71717a">Background: ${esc(set.background.slice(0, 40))}</text>` : '';
    return `<svg class="diag" viewBox="0 0 320 200" role="img" aria-label="${esc(`Set from above: ${set.you}, camera ${shot.camera_side}, ${set.light}`)}">
      <defs><pattern id="bpgrid" width="16" height="16" patternUnits="userSpaceOnUse"><path d="M16 0H0V16" fill="none" stroke="#ffffff" stroke-opacity=".04"/></pattern></defs>
      <rect width="320" height="200" fill="url(#bpgrid)"/><line x1="14" y1="14" x2="306" y2="14" stroke="#3a3a42" stroke-width="4"/>${bg}
      ${lights}${deskHtml}${camera}${who}</svg>`;
  }

  function zoneNotes(shot) {
    const rows = [
      ['you', 'You', shot.you, showsYou(shot.layout)],
      ['screen', 'Screen', shot.screen, ['split', 'screen_bubble', 'screen_full'].includes(shot.layout)],
      ['broll', 'B-roll', shot.broll, shot.layout === 'broll_full'],
      ['text', 'Text', shot.text, Boolean(shot.text) || ['cam_text', 'title_card'].includes(shot.layout)],
    ].filter((r) => r[3]);
    return rows.map(([k, label, v]) => `<div class="zn"><i class="zk z-${k}"></i><b>${label}</b><span>${v ? esc(v) : '<em>Not planned yet</em>'}</span></div>`).join('');
  }

  return { frame, zoneNotes, cameraView, setView, LAYOUT_NAME, LAYOUT_GROUPS, layoutName, layoutKind, showsYou, COLOR: C };
})();
