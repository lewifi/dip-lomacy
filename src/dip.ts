// Dip animation rig, baked from the sauce tuner. Both presets are locked (see
// architecture.md). Each mascot's dipping parts are wrapped so the food swings on an
// off-frame arc while a level "sauce line" clips its underside away (reverse cutout),
// revealing the bowl's own sauce and garnish. Secondary spin, ginger shimmy, gloopy
// drips and Tendie's ranch drool are all set up here.

type Side = 'tendie' | 'dimmie';

interface Preset {
  pivot: [number, number];
  angle: number;
  anticipation: number;
  overshoot: number;
  secondSpin: number;
  antMs: number;
  downMs: number;
  holdMs: number;
  upMs: number;
  wave: { line: number; amp: number; rise: number };
  drool?: { pos: [number, number]; scale: [number, number] };
}

const PRESETS: Record<Side, Preset> = {
  tendie: {
    pivot: [-1200, 1338], angle: 8, anticipation: 4, overshoot: 6, secondSpin: 16,
    antMs: 162, downMs: 60, holdMs: 232, upMs: 224,
    wave: { line: 44, amp: 47, rise: 70 }, drool: { pos: [-8, -32], scale: [0.338, 0.45] },
  },
  dimmie: {
    pivot: [1922, 788], angle: -21, anticipation: 3, overshoot: 6, secondSpin: 11,
    antMs: 260, downMs: 480, holdMs: 171, upMs: 321,
    wave: { line: 75, amp: 22, rise: 70 },
  },
};

const BOWL_ID: Record<Side, string> = { tendie: 'bowl', dimmie: 'Vinegar_Bowl' };
const SPIN: Record<Side, string[]> = { tendie: ['tendie'], dimmie: ['Chop_Stick_Front', 'Chop_Stick_Back'] };
const SPIN_ORIGIN: Record<Side, string> = { tendie: 'center top', dimmie: 'center' };
const NS = 'http://www.w3.org/2000/svg';

// Face expression IDs per mascot.
const FACES: Record<Side, string[]> = {
  tendie: ['Face_Happy', 'Face_Stunned', 'Face_Angry', 'Face_Surprised'],
  dimmie: ['XLB_Face_Happy', 'XLB_Face_Begging', 'XLB_Face_Worried', 'XLB_Face_Angry', 'XLB_Face_Stunned', 'XLB_Face_Surprised'],
};
const DIPPED_FACE: Record<Side, string> = { tendie: 'Face_Stunned', dimmie: 'XLB_Face_Stunned' };
const REACT_FACES: Record<Side, string[]> = {
  tendie: ['Face_Angry', 'Face_Surprised'],
  dimmie: ['XLB_Face_Angry', 'XLB_Face_Surprised'],
};
const FACE_FADE_MS = 120;
// Groups that rotate with the dip but should NOT be sauce-clipped (hand never submerges).
const NO_CLIP: Record<Side, string[]> = { tendie: ['Hand', 'Thumb'], dimmie: [] };

interface Rig {
  svg: SVGSVGElement;
  side: Side;
  rotors: SVGElement[];
  spinners: SVGElement[];
  gingers: SVGElement[];
  drool: SVGGElement | null;
  droolBase: [number, number];
  clipPath: SVGPathElement | null;
  geom: { x: number; w: number; baseY: number } | null;
  wave: { line: number; amp: number; rise: number };
  waveLift: number;
  dipToken: number;
  faces: Map<string, SVGElement>;
  activeFace: string;
}

const rigs: Partial<Record<Side, Rig>> = {};

const easeInCubic = (t: number) => t * t * t;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number, k: number) => {
  const c1 = 1.70158 * k;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

// Move an element's children into a new inner <g> so it can be transformed
// independently of the outer element.
function wrapChildren(grp: Element): SVGGElement {
  const inner = document.createElementNS(NS, 'g');
  while (grp.firstChild) inner.appendChild(grp.firstChild);
  grp.appendChild(inner);
  return inner;
}

function setupRig(svg: SVGSVGElement, side: Side): Rig {
  const rig: Rig = {
    svg, side, rotors: [], spinners: [], gingers: [], drool: null, droolBase: [0, 0],
    clipPath: null, geom: null, wave: { ...PRESETS[side].wave }, waveLift: 0, dipToken: 0,
    faces: new Map(), activeFace: FACES[side][0],
  };

  // Cache face elements and set up opacity crossfade.
  FACES[side].forEach((id) => {
    const el = svg.getElementById(id) as SVGElement | null;
    if (!el) return;
    rig.faces.set(id, el);
    el.style.transition = `opacity ${FACE_FADE_MS}ms ease`;
    // The first face (Happy) starts visible; rest hidden via opacity not display
    // so crossfade actually animates.
    if (id === rig.activeFace) {
      el.style.opacity = '1';
      el.style.display = '';
      el.removeAttribute('class'); // remove tst15/dst15 (display:none) if present
    } else {
      el.removeAttribute('class');
      el.style.display = '';
      el.style.opacity = '0';
    }
  });
  const bowlId = BOWL_ID[side];
  const bowl = svg.querySelector('#' + bowlId) as SVGGraphicsElement | null;

  // Reverse-cutout clip: keep only what's above a wavy sauce line.
  if (bowl) {
    const b = bowl.getBBox();
    rig.geom = { x: b.x - b.width, w: b.width * 3, baseY: b.y + b.height * 0.3 };
    let defs = svg.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS(NS, 'defs');
      svg.insertBefore(defs, svg.firstChild);
    }
    const clip = document.createElementNS(NS, 'clipPath');
    clip.id = `sauceClip-${side}`;
    clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
    const p = document.createElementNS(NS, 'path');
    clip.appendChild(p);
    defs.appendChild(clip);
    rig.clipPath = p;
  }

  // Each dipping group: outer carries the fixed clip, inner rotor does the arc rotate.
  const skipIds = [bowlId, ...NO_CLIP[side]];
  const targets = Array.from(svg.querySelectorAll(':scope > g')).filter((g) => !skipIds.includes(g.id));
  targets.forEach((t) => {
    const inner = wrapChildren(t);
    inner.style.transformBox = 'view-box';
    inner.style.willChange = 'transform';
    rig.rotors.push(inner);
    if (rig.clipPath) t.setAttribute('clip-path', `url(#sauceClip-${side})`);
  });
  // Hand/Thumb still rotate with the dip arc but are never sauce-clipped.
  NO_CLIP[side].forEach((id) => {
    const g = svg.querySelector('#' + id);
    if (!g) return;
    const inner = wrapChildren(g);
    inner.style.transformBox = 'view-box';
    inner.style.willChange = 'transform';
    rig.rotors.push(inner);
  });

  // Secondary centre-spin, nested inside the rotor.
  SPIN[side].forEach((id) => {
    const outer = svg.querySelector('#' + id);
    if (!outer || !outer.firstElementChild) return;
    const inner = wrapChildren(outer.firstElementChild);
    inner.style.transformBox = 'fill-box';
    inner.style.transformOrigin = SPIN_ORIGIN[side];
    rig.spinners.push(inner);
  });

  // Gloopy chin drip.
  const drip = svg.querySelector('#Drip');
  if (drip) wrapChildren(drip).classList.add('glooping');

  // Ginger slivers shimmy on impact.
  if (side === 'dimmie') {
    rig.gingers = Array.from(svg.querySelectorAll('[id^="Ginger"]')) as SVGElement[];
    rig.gingers.forEach((g) => {
      g.style.transformBox = 'fill-box';
      g.style.transformOrigin = 'center';
    });
  }

  updateWave(rig);
  return rig;
}

// Tendie has no drool art: clone Dimmie's #Drip, recolour it ranch, hang it behind the
// tongue at his upper lip.
function addTendieDrool(rig: Rig, dimmieSvg: SVGSVGElement) {
  const preset = PRESETS.tendie.drool;
  const src = dimmieSvg.querySelector('#Drip');
  const tongue = rig.svg.querySelector('#tongue') as SVGGraphicsElement | null;
  if (!preset || !src || !tongue) return;

  const drip = src.cloneNode(true) as SVGElement;
  drip.removeAttribute('id');
  drip.querySelectorAll('*').forEach((el) => {
    el.setAttribute('fill', '#fdf6df');
    el.setAttribute('stroke', 'none');
    el.removeAttribute('class');
  });
  const gloop = document.createElementNS(NS, 'g');
  gloop.classList.add('glooping');
  gloop.appendChild(drip);
  const pos = document.createElementNS(NS, 'g');
  pos.appendChild(gloop);
  tongue.parentNode!.insertBefore(pos, tongue);
  rig.drool = pos;

  const db = (drip as SVGGraphicsElement).getBBox();
  drip.setAttribute('transform', `translate(${-(db.x + db.width / 2)}, ${-db.y})`);
  const tb = tongue.getBBox();
  rig.droolBase = [tb.x + tb.width / 2, tb.y];

  const x = rig.droolBase[0] + preset.pos[0];
  const y = rig.droolBase[1] + preset.pos[1];
  pos.setAttribute('transform', `translate(${x},${y}) scale(${preset.scale[0]},${preset.scale[1]})`);
}

function updateWave(rig: Rig) {
  if (!rig.clipPath || !rig.geom) return;
  const g = rig.geom;
  const top = g.baseY - 4000;
  const y = g.baseY + rig.wave.line - rig.waveLift;
  const amp = rig.wave.amp;
  const ph = performance.now() / 280;
  const n = 6;
  const step = g.w / n;
  let d = `M ${g.x} ${top} L ${g.x + g.w} ${top} L ${g.x + g.w} ${y}`;
  for (let i = n; i > 0; i--) {
    const x1 = g.x + (i - 1) * step;
    const cx = g.x + (i - 0.5) * step;
    const cy = y + Math.sin(ph + i) * amp;
    d += ` Q ${cx} ${cy}, ${x1} ${y}`;
  }
  d += ' Z';
  rig.clipPath.setAttribute('d', d);
}

function tick() {
  if (rigs.tendie) updateWave(rigs.tendie);
  if (rigs.dimmie) updateWave(rigs.dimmie);
  requestAnimationFrame(tick);
}

// Crossfade to a target face on a rig. Returns the previous face id.
function setFace(rig: Rig, faceId: string): string {
  const prev = rig.activeFace;
  if (prev === faceId) return prev;
  const oldEl = rig.faces.get(prev);
  const newEl = rig.faces.get(faceId);
  if (oldEl) oldEl.style.opacity = '0';
  if (newEl) newEl.style.opacity = '1';
  rig.activeFace = faceId;
  return prev;
}

// Fire a dip. Re-tapping restarts it (so rapid dipping stays responsive).
export function triggerDip(side: Side) {
  const rig = rigs[side];
  if (!rig) return;
  const P = PRESETS[side];
  const [pivotX, pivotY] = P.pivot;
  const A = P.angle;

  rig.dipToken += 1;
  const token = rig.dipToken;
  const t0 = performance.now();

  const setAngle = (a: number) => {
    const tf = `rotate(${a}deg)`;
    rig.rotors.forEach((r) => {
      r.style.transformOrigin = `${pivotX}px ${pivotY}px`;
      r.style.transform = tf;
    });
  };
  const spin = (deg: number) => {
    const tf = `rotate(${deg}deg)`;
    rig.spinners.forEach((s) => (s.style.transform = tf));
  };

  // Ginger shimmy on the tap.
  rig.gingers.forEach((gg) => gg.classList.remove('ginger-jiggle'));
  requestAnimationFrame(() => rig.gingers.forEach((gg) => gg.classList.add('ginger-jiggle')));

  // Expression crossfade: dipped mascot goes stunned, opponent reacts.
  const other: Side = side === 'tendie' ? 'dimmie' : 'tendie';
  const otherRig = rigs[other];
  let faceChanged = false;

  const frame = (now: number) => {
    if (rig.dipToken !== token) return; // superseded by a newer tap
    const t = now - t0;
    let a: number;
    if (t < P.antMs) {
      a = -P.anticipation * easeOutCubic(t / P.antMs);
    } else if (t < P.antMs + P.downMs) {
      const p = (t - P.antMs) / P.downMs;
      a = -P.anticipation + (A + P.anticipation) * easeInCubic(p);
      // Crossfade at the commit point (start of downswing).
      if (!faceChanged) {
        faceChanged = true;
        const dippedFace = DIPPED_FACE[side];
        if (dippedFace) setFace(rig, dippedFace);
        // Opponent reacts.
        const reactPool = REACT_FACES[other];
        if (otherRig && reactPool.length > 0) {
          const pick = reactPool[Math.floor(Math.random() * reactPool.length)];
          setFace(otherRig, pick);
        }
      }
    } else if (t < P.antMs + P.downMs + P.holdMs) {
      a = A;
    } else {
      const p = Math.min(1, (t - P.antMs - P.downMs - P.holdMs) / P.upMs);
      a = A * (1 - easeOutBack(p, 0.4 + P.overshoot / 8));
      if (p >= 1) {
        setAngle(0);
        spin(0);
        rig.waveLift = 0;
        // Reset faces to happy.
        setFace(rig, FACES[side][0]);
        if (otherRig) setFace(otherRig, FACES[other][0]);
        return;
      }
    }
    setAngle(a);
    spin(A ? P.secondSpin * (a / A) : 0);
    rig.waveLift = rig.geom ? P.wave.rise * (A ? a / A : 0) : 0;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

export function initDip(tendieSvg: SVGSVGElement, dimmieSvg: SVGSVGElement) {
  tendieSvg.style.overflow = 'visible';
  dimmieSvg.style.overflow = 'visible';
  rigs.tendie = setupRig(tendieSvg, 'tendie');
  addTendieDrool(rigs.tendie, dimmieSvg); // clone Dimmie's raw #Drip before it is wrapped
  rigs.dimmie = setupRig(dimmieSvg, 'dimmie');
  requestAnimationFrame(tick);
}
