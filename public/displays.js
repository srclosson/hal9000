// Discovery One style sub-displays. Each has:
//   draw(ctx, w, h, t, ship)  the full-screen graphic, on a black canvas
//   stat(t, ship)             { value, unit?, sample? } for its stat panel; sample (0..1) feeds the
//                             sparkline when the value isn't numeric. stat: null shows only the three
//                             letters, as the film's panels do (currently every system).
// ship = { state, voice: number[] } where voice is a rolling history of the eye's pulse.

import { keep as keepLooks, alpha, usePalette } from '/inks.js';

// Discovery display language: white hairlines and monospaced data straight on a muted field colour.
// Every colour comes from the page's tokens (base.css, --panel-* and --field-*), so a UI with another palette draws
// the same panels in its own colours. The values here are only fallbacks; retint() reads the tokens again.
// The ship systems' illustrations (the eye, Jupiter) keep their own colours: they are pictures, not data.
const tok = (name, fallback) => (typeof document === 'undefined' ? '' : css(name).trim()) || fallback;
let GRID, INK, GROUND, VEIL, SCRIM, WATER, WHITE, DIM, FAINT, CHIP, RED, RED_SOFT, AMBER, GREEN, BLUE, DARK, CHIP_INK, BOARD_COLORS;
const inkAt = a => `rgba(${INK},${a})`;          // hairlines, text and fills, at a strength
const ground = a => `rgba(${GROUND},${a})`;    // shadows and scrims under graphics
const veil = a => `rgba(${VEIL},${a})`;        // a dark backing behind labels drawn over data
const water = a => `rgba(${WATER},${a})`;      // the pale blue of node pressure and fix strips
export function retint() {
  INK = tok('--panel-ink', '244,244,244'); GROUND = tok('--panel-ground', '0,0,0'); VEIL = tok('--panel-veil', '18,16,40');
  SCRIM = tok('--panel-scrim', '8,8,24'); WATER = tok('--panel-water', '168,220,255');
  WHITE = inkAt(1); DIM = inkAt(.45); FAINT = inkAt(.16);
  CHIP = tok('--chip-yellow', '#e6d76a');      // pale indicator yellow: WARNING
  RED = tok('--panel-alarm', '#ff2a12'); RED_SOFT = tok('--panel-alarm-soft', '#ffb4a8'); AMBER = tok('--panel-amber', '#f0b43c');
  GREEN = tok('--panel-ok', '#9fe0a0'); BLUE = tok('--panel-aiden', '#8fd3ff');
  DARK = tok('--panel-dark', '#111');          // text on a bright warning or critical fill
  CHIP_INK = tok('--panel-chip-ink', '#14143a');
  // Muted Discovery fields (same family as the ship systems); health is shown by tags, not by the field colour.
  GRID = Number(tok('--panel-grid', '.16'));   // the faint grid behind a panel; 0: none
  const hex = INK.split(',').map(n => Number(n).toString(16).padStart(2, '0')).join('');
  usePalette(tok('--panel-series', 'dark'), `#${hex}`);   // series colours that read on this UI's panels (inks.js)
  BOARD_COLORS = [['--field-blue', '#3c55a5'], ['--field-teal', '#2e5d5a'], ['--field-plum', '#5a3f62'], ['--field-slate', '#4b6189'], ['--field-royal', '#2e5bad'], ['--field-navy', '#18204a']].map(([n, f]) => tok(n, f));
}

function grid(ctx, w, h, step) {
  if (!(step >= 4) || !GRID) return;   // a zero-size panel gives step 0: the loops below would never end (the tab ran out of memory)
  ctx.strokeStyle = inkAt(GRID); ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = step; x < w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let y = step; y < h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
}

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name);
retint();
const FONT = css('--font-mono') || 'monospace';        // data: line-printer monospace
const FONT_WIDE = css('--font-wide') || FONT;          // codes and tags: extended capitals
const FONT_SIGN = css('--font-screen') || FONT;        // signage: thin Futura capitals

// Text cut short by fit() is remembered with its full version; when it is drawn on a board panel, where it sits is
// recorded (drawing.truncHits, in the panel's coordinates), so hovering it shows the whole line (monitor.html).
const shortened = new Map();   // shortened text -> full text
let drawing = null;            // the board panel being drawn, and its offset within its canvas (story elements)
function text(ctx, s, x, y, size, color = WHITE, align = 'left', face = FONT, weight = 400) {
  ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  ctx.font = `${weight} ${size}px ${face}`;
  ctx.fillText(s, x, y);
  const full = shortened.get(s);
  if (full && drawing) {
    const w = ctx.measureText(s).width, left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x, m = ctx.getTransform();
    drawing.truncHits.push({ x0: left + m.e / (m.a || 1), x1: left + w + m.e / (m.a || 1), y0: y - size + m.f / (m.d || 1), y1: y + size * .25 + m.f / (m.d || 1), full });
  }
}

// Tick marks along the bottom and left edges of a plot area, as on the film's chart screens.
function ticks(ctx, x0, y0, x1, y1, n = 8) {
  ctx.strokeStyle = DIM; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y1); ctx.lineTo(x1, y1); ctx.moveTo(x0, y0); ctx.lineTo(x0, y1);
  for (let i = 0; i <= n; i++) {
    const x = x0 + (i / n) * (x1 - x0), y = y1 - (i / n) * (y1 - y0);
    ctx.moveTo(x, y1); ctx.lineTo(x, y1 + 4);
    ctx.moveTo(x0, y); ctx.lineTo(x0 - 4, y);
  }
  ctx.stroke();
}

// Graphics stay white whatever the theme: the film's screens are white line work on colour fields.
// (refreshAccent is kept for the monitor, which still calls it on theme changes.)
// Where a line breaks: samples further apart than one and a half of its usual step (a scrape gap, a pod restart) are
// not joined, so an outage never looks like a smooth ramp. -> (index) => true when point i starts a new run.
function breaksOf(points, stepMs) {
  const diffs = points.slice(1).map(([t], i) => t - points[i][0]).filter(x => x > 0);
  const step = Math.max(stepMs || 0, diffs.length ? Math.min(...diffs) : 0);
  return i => !i || (step > 0 && points[i][0] - points[i - 1][0] > step * 1.5);
}
export function refreshAccent() {}
const accent = () => WHITE;

export const DISPLAYS = [
  {
    code: 'COM', title: 'Voice Communication', color: '#2e5bad',
    stat: null,
    draw(ctx, w, h, t, ship) {
      const u = Math.min(w, h);
      grid(ctx, w, h, h / 6);
      const mid = h / 2, n = ship.voice.length;
      ctx.strokeStyle = WHITE; ctx.lineWidth = 1.25;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w;
        const amp = ship.voice[i] * h * 0.42;
        const y = mid + Math.sin(i * 0.9 + t / 90) * amp;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
      ctx.strokeStyle = DIM; ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
      const mode = (ship.state.mode || 'idle').toUpperCase();
      text(ctx, mode, w - h * .05, u * .92, h * .08, WHITE, 'right');
    },
  },
  {
    code: 'NAV', title: 'Navigation', color: '#3c55a5',
    stat: null,
    draw(ctx, w, h, t) {
      const u = Math.min(w, h);
      const cx = w / 2, cy = h / 2, r = Math.min(w, h) * .36;
      ctx.strokeStyle = DIM; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(cx, cy, r * 1.25, r * .55, -0.25, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(cx, cy, r * .55, r * .25, -0.25, 0, Math.PI * 2); ctx.stroke();
      // planet
      ctx.strokeStyle = WHITE; ctx.lineWidth = 1.25; ctx.fillStyle = FAINT;
      ctx.beginPath(); ctx.arc(cx, cy, r * .16, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // ship on outer orbit
      const a = t / 4000;
      const sx = cx + Math.cos(a) * r * 1.25 * Math.cos(-0.25) - Math.sin(a) * r * .55 * Math.sin(-0.25);
      const sy = cy + Math.cos(a) * r * 1.25 * Math.sin(-0.25) + Math.sin(a) * r * .55 * Math.cos(-0.25);
      ctx.fillStyle = WHITE; ctx.beginPath(); ctx.arc(sx, sy, Math.max(3, h / 60), 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = WHITE; ctx.setLineDash([4, 5]); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(sx, sy); ctx.stroke(); ctx.setLineDash([]);
      text(ctx, `RNG ${(412.7 + Math.sin(a) * 61.3).toFixed(1)} MKM`, u * .05, h * .82, h * .065);
      text(ctx, `VEL ${(29.84 + Math.cos(a) * 1.7).toFixed(2)} KM/S`, u * .05, h * .93, h * .065);
    },
  },
  {
    code: 'GDE', title: 'Guidance', color: '#2e5d5a',
    stat: null,
    draw(ctx, w, h, t) {
      const u = Math.min(w, h);
      const cx = w / 2, cy = h / 2, r = Math.min(w, h) * .4;
      const roll = Math.sin(t / 3100) * .18, pitch = Math.sin(t / 2300) * r * .25;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(roll);
      ctx.strokeStyle = WHITE; ctx.lineWidth = 1.25;
      for (let i = -3; i <= 3; i++) {
        const y = pitch + i * r * .22, len = i === 0 ? r * 1.6 : r * (.5 - Math.abs(i) * .05);
        ctx.globalAlpha = i === 0 ? 1 : .55;
        ctx.beginPath(); ctx.moveTo(-len / 2, y); ctx.lineTo(len / 2, y); ctx.stroke();
      }
      ctx.restore(); ctx.globalAlpha = 1;
      ctx.strokeStyle = WHITE; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, r * .12, 0, Math.PI * 2);
      ctx.moveTo(cx - r * .5, cy); ctx.lineTo(cx - r * .14, cy);
      ctx.moveTo(cx + r * .14, cy); ctx.lineTo(cx + r * .5, cy); ctx.stroke();
      ctx.strokeStyle = DIM; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      text(ctx, `ATT ${(roll * 57.3).toFixed(1)}°`, w - h * .05, u * .93, h * .065, WHITE, 'right');
    },
  },
  {
    code: 'HIB', title: 'Hibernation', color: '#5a3f62',
    stat: null,
    draw(ctx, w, h, t) {
      const u = Math.min(w, h);
      const rows = 3, pad = h * .14, rh = (h - pad * 2) / rows;
      for (let k = 0; k < rows; k++) {
        const y0 = pad + k * rh + rh / 2;
        ctx.strokeStyle = DIM; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(w * .22, y0); ctx.lineTo(w * .97, y0); ctx.stroke();
        ctx.strokeStyle = WHITE; ctx.lineWidth = 1.25; ctx.beginPath();
        for (let x = w * .22; x < w * .97; x += 2) {
          const ph = ((x - t / (14 + k * 3)) / (w * .18)) % 1;
          const p = ph < 0 ? ph + 1 : ph;
          const beat = p > .45 && p < .5 ? -1 : p >= .5 && p < .53 ? .6 : 0;
          const y = y0 + beat * rh * .32;
          x === w * .22 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
        text(ctx, `${['A', 'B', 'C'][k]}  ${(14 + k * 2 + Math.round(Math.sin(t / 5000 + k)))}`, u * .05, y0 + h * .03, h * .075);
      }
    },
  },
  {
    code: 'ATM', title: 'Atmosphere', color: '#4b6189',
    stat: null,
    draw(ctx, w, h, t) {
      const u = Math.min(w, h);
      const labels = ['O2', 'N2', 'CO2', 'H2O', 'PRS', 'TMP'];
      const n = labels.length, bw = (w * .84) / (n * 1.6 - .6), base = h * .82;
      labels.forEach((l, i) => {
        const v = .45 + .3 * Math.sin(t / (2200 + i * 370) + i) + .1 * Math.sin(t / 430 + i * 2);
        const x = w * .08 + i * bw * 1.6;
        // Outlined bars with a light fill; CO2 carries the yellow indicator.
        ctx.fillStyle = i === 2 ? CHIP : inkAt(.22);
        ctx.fillRect(x, base - v * h * .62, bw, v * h * .62);
        ctx.strokeStyle = WHITE; ctx.lineWidth = 1; ctx.strokeRect(x + .5, base - v * h * .62 + .5, bw - 1, v * h * .62);
        text(ctx, l, x + bw / 2, base + h * .1, Math.min(u * .065, bw * .42), WHITE, 'center');
      });
      ctx.strokeStyle = DIM; ctx.beginPath(); ctx.moveTo(0, base); ctx.lineTo(w, base); ctx.stroke();
    },
  },
  {
    code: 'MEM', title: 'Memory', color: '#18204a',
    stat: null,
    draw(ctx, w, h, t) {
      const u = Math.min(w, h);
      const lh = h * .1, cols = Math.max(2, Math.floor(w / (h * .62)));
      const off = (t / 40) % lh, start = Math.floor(t / 40 / lh);
      for (let r = -1; r < 11; r++) {
        for (let c = 0; c < cols; c++) {
          const seed = Math.sin((start + r) * 12.9898 + c * 78.233) * 43758.5453;
          const v = Math.floor((seed - Math.floor(seed)) * 0xffffff).toString(16).toUpperCase().padStart(6, '0');
          const hot = (start + r + c) % 7 === 0;
          text(ctx, v, h * .06 + c * (w / cols), r * lh + lh - off + h * .05, u * .07, hot ? accent() : DIM);
        }
      }
    },
  },
  {
    // What the eye sees: the phone's front camera through a fisheye, as in the 9000's point-of-view shots.
    // Frames arrive only while this panel is on screen in Descriptive view (see eyeFrame below).
    code: 'EYE', title: 'Visual · Eye', color: '#22262e', eye: true,
    stat: null,
    draw(ctx, w, h, t, ship) {
      const u = Math.min(w, h), cx = w / 2, cy = h / 2, r = u * .46;
      const live = ship.eyeView && performance.now() - ship.eyeAt < 3000;
      ctx.strokeStyle = FAINT; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      if (!live) {
        const why = !ship.eyePresent ? ['EYE', 'NOT CONNECTED'] : ship.state.camera === 'denied' ? ['CAMERA', 'NOT PERMITTED']
          : ship.state.camera === 'unavailable' ? ['NON', 'FUNCTION'] : ['ACQUIRING', 'VISUAL'];
        text(ctx, why[0], cx, cy - u * .02, u * .07, WHITE, 'center', FONT_WIDE);
        text(ctx, why[1], cx, cy + u * .08, u * .07, WHITE, 'center', FONT_WIDE);
        return;
      }
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
      ctx.drawImage(ship.eyeView, cx - r, cy - r, r * 2, r * 2);
      const v = ctx.createRadialGradient(cx, cy, r * .5, cx, cy, r);   // lens falloff
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(.75, 'rgba(0,0,0,.25)'); v.addColorStop(1, 'rgba(0,0,0,.92)');
      ctx.fillStyle = v; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      ctx.restore();
      ctx.strokeStyle = 'rgba(244,244,244,.5)'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      const blink = Math.floor(t / 700) % 2;
      if (blink) { ctx.fillStyle = '#ff2a12'; ctx.beginPath(); ctx.arc(u * .06, h - u * .055, u * .012, 0, Math.PI * 2); ctx.fill(); }
      text(ctx, 'LIVE', u * .085, h - u * .043, u * .04, WHITE);
      text(ctx, new Date().toTimeString().slice(0, 8), w - u * .04, h - u * .043, u * .04, DIM, 'right');
    },
  },
  {
    // Jupiter becomes Lucifer (after 2010): monoliths multiply into a black spot that swallows the planet's bands,
    // Jupiter collapses, ignites, and a small new sun burns where it was. A 90-second loop, drawn in hairline.
    code: 'JUP', title: 'Jupiter · Lucifer', color: '#3f3550',
    stat: null,
    draw(ctx, w, h, t) {
      const u = Math.min(w, h);
      grid(ctx, w, h, h / 6);
      const CYCLE = 90, sec = (t / 1000) % CYCLE, p = sec / CYCLE;
      const SWARM = .06, COLLAPSE = .46, FLASH = .62, FADE = .93;
      const clamp = x => Math.max(0, Math.min(1, x)), ease = x => x * x * (3 - 2 * x);
      const cx = w / 2, cy = h * .53, R0 = u * .33;
      // Europa keeps its orbit throughout.
      const ea = t / 9000, ex = cx + Math.cos(ea) * u * .44, ey = cy + Math.sin(ea) * u * .1;
      ctx.fillStyle = 'rgba(244,244,244,.75)'; ctx.beginPath(); ctx.arc(ex, ey, Math.max(1.5, u * .006), 0, Math.PI * 2); ctx.fill();
      text(ctx, 'EUROPA', ex + u * .015, ey - u * .012, u * .026, DIM);

      let phase, count = 0;
      if (p < FLASH) {
        const fadeIn = clamp(p / .03);
        const g = clamp((p - SWARM) / (COLLAPSE - SWARM));            // swarm growth
        const k = ease(clamp((p - COLLAPSE) / (FLASH - COLLAPSE)));   // collapse
        const R = R0 * (1 - .82 * k);
        count = p < SWARM ? 0 : Math.min(4096, Math.floor(2 ** (1 + g * 11)));
        const sx = cx - R * .22, sy = cy + R * .2;                    // where the black spot starts
        const rs = R * (.04 + .95 * g ** 1.6) + R * k;                  // its radius
        const pull = (x, y) => {   // bands bend and swirl into the spot
          const dx = sx - x, dy = sy - y, d = Math.hypot(dx, dy) || 1;
          const f = Math.min(.95, (g * .55 + k) * Math.exp(-d / (rs * 1.4 + R * .15)));
          const a = f * 1.6, cos = Math.cos(a), sin = Math.sin(a);
          const rx = -dx * (1 - f), ry = -dy * (1 - f);
          return [sx + rx * cos - ry * sin, sy + rx * sin + ry * cos];
        };
        ctx.globalAlpha = fadeIn;
        ctx.save();
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(244,244,244,.07)'; ctx.fill(); ctx.clip();
        // Cloud bands, drifting in alternate directions.
        for (let i = 0; i < 15; i++) {
          const lat = -0.93 + i * (1.86 / 14), y0 = cy + R * lat, half = R * Math.sqrt(1 - lat * lat);
          ctx.strokeStyle = i % 2 ? 'rgba(244,244,244,.45)' : WHITE; ctx.lineWidth = i % 3 ? .8 : 1.3;
          ctx.beginPath();
          for (let j = 0; j <= 48; j++) {
            const x = cx - half + (j / 48) * half * 2;
            const y = y0 + Math.sin(j * .55 + (i % 2 ? 1 : -1) * t / 2600 + i) * R * .013;
            const [px, py] = pull(x, y);
            j ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
          }
          ctx.stroke();
        }
        // The Great Red Spot, as an outline.
        ctx.strokeStyle = WHITE; ctx.lineWidth = 1;
        ctx.beginPath();
        for (let j = 0; j <= 32; j++) {
          const a = (j / 32) * Math.PI * 2, [px, py] = pull(cx + R * .32 + Math.cos(a) * R * .15, cy + R * .3 + Math.sin(a) * R * .07);
          j ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.stroke();
        // The monoliths: 1:4:9 slabs, doubling, spread like seeds from the spot's centre until they are a solid black.
        if (count) {
          ctx.fillStyle = `rgba(0,0,0,${Math.min(.9, g * .7 + k)})`;
          ctx.beginPath(); ctx.arc(sx, sy, rs * .8, 0, Math.PI * 2); ctx.fill();
          const mh = Math.max(2, u * .011), mw = mh * 4 / 9;
          ctx.fillStyle = '#050505';
          for (let i = 0; i < count; i++) {
            const a = i * 2.399963, rr = Math.sqrt(i / count) * rs * (.92 + .16 * ((i * 7919) % 13) / 13);
            ctx.fillRect(sx + Math.cos(a) * rr - mw / 2, sy + Math.sin(a) * rr - mh / 2, mw, mh);
          }
        }
        ctx.restore();
        ctx.strokeStyle = WHITE; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
        phase = k > 0 ? 'COLLAPSE' : count ? 'ANOMALY' : 'JUPITER';
      } else {
        // Ignition: a white flash, then a small sun with a slow corona.
        const q = (p - FLASH) / (1 - FLASH), out = clamp((p - FADE) / (1 - FADE));
        const rS = u * .045 * (1 + .6 * clamp(q * 4)), glow = 1 - out;
        const c = ctx.createRadialGradient(cx, cy, rS * .6, cx, cy, rS * 5);
        c.addColorStop(0, `rgba(255,250,235,${.55 * glow})`); c.addColorStop(1, 'rgba(255,250,235,0)');
        ctx.fillStyle = c; ctx.fillRect(cx - rS * 5, cy - rS * 5, rS * 10, rS * 10);
        ctx.strokeStyle = `rgba(244,244,244,${.6 * glow})`; ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < 28; i++) {
          const a = i / 28 * Math.PI * 2 + t / 20000, len = rS * (2.2 + 1.4 * Math.sin(i * 3.7 + t / 900));
          ctx.moveTo(cx + Math.cos(a) * rS * 1.4, cy + Math.sin(a) * rS * 1.4);
          ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
        }
        ctx.stroke();
        ctx.fillStyle = `rgba(255,255,255,${glow})`; ctx.beginPath(); ctx.arc(cx, cy, rS, 0, Math.PI * 2); ctx.fill();
        const flash = 1 - clamp((p - FLASH) / .035);
        if (flash > 0) { ctx.fillStyle = `rgba(255,255,255,${flash})`; ctx.fillRect(0, 0, w, h); }
        phase = 'LUCIFER';
      }
      text(ctx, phase, u * .05, h - u * .1, u * .045, WHITE, 'left', FONT_WIDE);
      text(ctx, count ? `MONOLITHS ${count.toLocaleString('en-US')}` : phase === 'LUCIFER' ? 'NEW STAR' : 'NOMINAL', u * .05, h - u * .045, u * .036, DIM);
    },
  },
];

// ---- the eye's camera --------------------------------------------------------------------------------------
// Each JPEG from the eye is cropped square and bent through a fisheye (the centre bulges, the edges compress),
// then kept on ship.eyeView for the EYE panel. The lookup table is built once per size.
const EYE_SIZE = 360;
let eyeSrc, eyeDst, eyeMap;
export async function eyeFrame(blob, ship) {
  const img = await createImageBitmap(blob).catch(() => null);
  if (!img) return;
  if (!eyeSrc) {
    eyeSrc = Object.assign(document.createElement('canvas'), { width: EYE_SIZE, height: EYE_SIZE });
    eyeDst = Object.assign(document.createElement('canvas'), { width: EYE_SIZE, height: EYE_SIZE });
    eyeMap = new Int32Array(EYE_SIZE * EYE_SIZE).fill(-1);
    const half = EYE_SIZE / 2;
    for (let y = 0; y < EYE_SIZE; y++) for (let x = 0; x < EYE_SIZE; x++) {
      const nx = (x - half) / half, ny = (y - half) / half, rr = Math.hypot(nx, ny);
      if (rr > 1) continue;
      const rs = rr * (.55 + .45 * rr * rr);   // source radius: magnified centre, squeezed rim
      const k = rr ? rs / rr : 0;
      const sx = Math.min(EYE_SIZE - 1, Math.round(half + nx * k * half)), sy = Math.min(EYE_SIZE - 1, Math.round(half + ny * k * half));
      eyeMap[y * EYE_SIZE + x] = (sy * EYE_SIZE + sx) * 4;
    }
  }
  const side = Math.min(img.width, img.height);
  const sg = eyeSrc.getContext('2d', { willReadFrequently: true });
  sg.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, EYE_SIZE, EYE_SIZE);
  img.close?.();
  const src = sg.getImageData(0, 0, EYE_SIZE, EYE_SIZE).data;
  const dg = eyeDst.getContext('2d'), out = dg.createImageData(EYE_SIZE, EYE_SIZE), d = out.data;
  for (let i = 0; i < eyeMap.length; i++) {
    const m = eyeMap[i];
    if (m < 0) continue;
    const o = i * 4;
    d[o] = src[m]; d[o + 1] = src[m + 1]; d[o + 2] = src[m + 2]; d[o + 3] = 255;
  }
  dg.putImageData(out, 0, 0);
  ship.eyeView = eyeDst;
  ship.eyeAt = performance.now();
}

// ---- live data boards ----------------------------------------------------------------------------------
// Panels pushed by the server (boards/index.js) temporarily replace the ship's systems. Simple view shows
// only the letters (their status colours the panel); Descriptive view draws the live value, trend or list.

// Values stay white; WARNING tints them chip-yellow. CRITICAL is carried by the panel's CRIT tag.
const STATUS_INK = { get ok() { return WHITE; }, get warn() { return CHIP; }, get crit() { return WHITE; }, get nodata() { return DIM; } };

// Helpers for board text: word-wrap, truncate to width, and show a time as HH:MM.
function wrap(ctx, str, maxW, size, face = FONT, weight = 400, maxLines = 5) {
  ctx.font = `${weight} ${size}px ${face}`;
  const out = [];
  let line = '';
  for (const word of String(str).split(/\s+/)) {
    const t = line ? line + ' ' + word : word;
    if (ctx.measureText(t).width > maxW && line) { out.push(line); line = word; } else line = t;
  }
  if (line) out.push(line);
  return out.slice(0, maxLines);
}
// Change marks (deploys, scaling, config) on a trend: a yellow tick per change. Only changes that matter to the panel
// (on its service, or followed by a move in its line) get words, e.g. "DEPLOY CHECKOUT-API · ↑ 4 MIN LATER"; the rest
// keep a short tick. Labels never overwrite each other: each goes into the first lane down from the top of the plot
// where it fits, and one that fits nowhere keeps its tick but loses its words. While a story's narration is about a
// change (hl: its time), that mark is lit white and labelled, and the others dim.
// marks: [{ x, ...mark }] in canvas coordinates; box: { left, right, top, bottom }. d.markHits records where each one
// is, so a click opens its card (monitor.html).
function drawMarks(ctx, marks, box, u, d, hl) {
  if (d) d.markHits = [];
  if (!marks.length) return;
  const fs = u * .03, lane = fs * 1.45, lanes = 3, pad = fs * .8, maxW = (box.right - box.left) * .72;
  const used = Array.from({ length: lanes }, () => []);   // [a, b] spans per lane
  const lit = m => hl !== undefined && hl !== null && m.t === hl;
  // Lit and relevant ones claim lanes first.
  const order = [...marks].sort((a, b) => (lit(b) - lit(a)) || ((b.relevant ? 1 : 0) - (a.relevant ? 1 : 0)) || a.x - b.x);
  for (const m of order) {
    const on = lit(m), dim = hl != null && !on, labelled = on || (m.relevant && !dim);
    const colour = on ? WHITE : CHIP;
    ctx.globalAlpha = dim ? .35 : 1;
    ctx.strokeStyle = colour; ctx.lineWidth = on ? 2 : 1; ctx.setLineDash(m.relevant || on ? [] : [2, 3]);
    let yTop = box.bottom - (box.bottom - box.top) * .18;   // an unlabelled tick: short, dotted
    let k = -1, a = 0, b = 0, label = '';
    if (labelled) {
      label = fit(ctx, String(m.label).toUpperCase(), maxW, fs);
      ctx.font = `400 ${fs}px ${FONT}`;
      const tw = ctx.measureText(label).width, rightward = m.x + 4 + tw <= box.right;
      a = rightward ? m.x + 4 : m.x - 4 - tw; b = rightward ? m.x + 4 + tw : m.x - 4;
      k = used.findIndex(spans => spans.every(([p, q]) => b + pad < p || a > q + pad));
      yTop = k >= 0 ? box.top + k * lane : box.top + lanes * lane;
      m.rightward = rightward;
    }
    ctx.beginPath(); ctx.moveTo(m.x, box.bottom); ctx.lineTo(m.x, yTop); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = colour; ctx.beginPath(); ctx.moveTo(m.x, box.bottom - 1); ctx.lineTo(m.x - 4, box.bottom + 6); ctx.lineTo(m.x + 4, box.bottom + 6); ctx.fill();
    d?.markHits.push({ x0: m.x - 8, x1: m.x + 8, y0: yTop, y1: box.bottom + 10, mark: m });
    if (labelled && k >= 0) {
      used[k].push([a, b]);
      // A dark plate behind the words, so they stay readable over the trend and threshold lines.
      ctx.fillStyle = on ? ground(.8) : veil(.62);
      ctx.fillRect(a - 3, yTop + fs * .12, b - a + 6, fs * 1.18);
      text(ctx, label, m.rightward ? a : b, yTop + fs, fs, colour, m.rightward ? 'left' : 'right');
      d?.markHits.push({ x0: a - 3, x1: b + 3, y0: yTop, y1: yTop + fs * 1.4, mark: m });
    }
    ctx.globalAlpha = 1;
  }
}

// Squarified treemap (Bruls, Huizing & van Wijk): items [{ a: area weight, ...}], largest first, into the rectangle
// x, y, w, h -> [{ it, x, y, w, h }], each cell as close to square as the row allows.
function squarify(items, x, y, w, h) {
  const out = [], total = items.reduce((s, it) => s + it.a, 0);
  if (!total || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  let rest = items.map(it => ({ it, area: it.a * scale }));
  const worst = (row, side) => { const s = row.reduce((a, r) => a + r.area, 0), mx = Math.max(...row.map(r => r.area)), mn = Math.min(...row.map(r => r.area)); return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn)); };
  while (rest.length) {
    const side = Math.min(w, h), row = [rest[0]];
    let i = 1;
    while (i < rest.length && worst([...row, rest[i]], side) <= worst(row, side)) row.push(rest[i++]);
    rest = rest.slice(i);
    const s = row.reduce((a, r) => a + r.area, 0);
    if (w >= h) {   // a column on the left
      const cw = s / h; let cy = y;
      for (const r of row) { const ch = r.area / cw; out.push({ it: r.it, x, y: cy, w: cw, h: ch }); cy += ch; }
      x += cw; w -= cw;
    } else {        // a row along the top
      const rh = s / w; let cx = x;
      for (const r of row) { const rw = r.area / rh; out.push({ it: r.it, x: cx, y, w: rw, h: rh }); cx += rw; }
      y += rh; h -= rh;
    }
  }
  return out;
}

function fit(ctx, str, maxW, size) {
  ctx.font = `400 ${size}px ${FONT}`;
  let t = String(str);
  if (ctx.measureText(t).width <= maxW) return t;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  if (shortened.size > 2000) shortened.clear();
  shortened.set(t + '…', String(str));
  return t + '…';
}
function clock(t) {
  if (t === null || t === undefined || t === '') return '';
  const d = typeof t === 'number' ? new Date(t) : new Date(Date.parse(t));
  if (isNaN(d)) return String(t).slice(0, 5);   // already a label like "14:02" or "T-5m"
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });   // 24-hour: fits the time column
}

export function boardPanel(p, index) {
  const d = {
    code: p.code, title: p.title, color: BOARD_COLORS[index % BOARD_COLORS.length], stat: null, board: true, data: p,
    // frame.top: where the monitor's HTML header (code, title, status tag) ends, so nothing is drawn under it.
    draw(ctx, w, h, t = 0, ship, frame = {}) {
      // Shortened text drawn by this panel (and its story elements, drawn inside it) is recorded for hover.
      const outer = drawing;
      if (!outer) { d.truncHits = []; drawing = d; }
      try { return drawPanel(ctx, w, h, t, ship, frame); } finally { if (!outer) drawing = null; }
    },
  };
  function drawPanel(ctx, w, h, t = 0, ship, frame = {}) {
    {
      const u = Math.min(w, h), q = d.data, ink = STATUS_INK[q.status] ?? WHITE;
      // Each kind sets its own hover and click areas as it draws: never ones left over from what the card drew before
      // (the monitor keeps a panel's object when HAL updates the card, even into another kind).
      d.tipAt = null; d.fixHit = null; d.hits = []; d.markHits = []; d.eventHits = [];
      const head = frame.top || u * .1;
      const HY = Math.max(u * .16, head + u * .09);    // headline baseline, clear of the status tag
      const BODY = Math.max(h * .26, HY + u * .05);    // where content starts below the headline
      grid(ctx, w, h, h / 6);
      // Hover on a panel of rows (list, bargauge): the row under the pointer outlined, and a tooltip with its full name,
      // its value, its rank and share, and how far it is from the warn and crit lines.
      const rowHover = (items, top, rowH, x0, x1, show) => {
        const rowAt = py => { const i = Math.floor((py - top) / rowH); return py >= top && i < items.length ? i : -1; };
        if (Number.isFinite(d.hoverX) && d.hoverX >= x0 && d.hoverX <= x1) {
          const i = rowAt(d.hoverY);
          if (i >= 0) { ctx.strokeStyle = inkAt(.7); ctx.lineWidth = 1; ctx.strokeRect(x0 - 3.5, top + i * rowH + .5, x1 - x0 + 7, rowH - 1); }
        }
        const total = items.reduce((a, it) => a + (Number.isFinite(it.value) ? it.value : 0), 0);
        d.tipAt = (px, py) => {
          if (px < x0 || px > x1) return null;
          const i = rowAt(py), it = items[i];
          if (!it) return null;
          const rows = [{ label: it.label, hero: true, value: show(it) }];
          if (items.length > 1) rows.push({ label: 'rank', value: `${[...items].sort((a, b) => b.value - a.value).indexOf(it) + 1} of ${items.length} shown` });
          if (items.length > 1 && total > 0 && q.unit !== '%') rows.push({ label: 'share of shown', value: `${+(100 * it.value / total).toPrecision(2)}%` });
          for (const [v, name] of [[q.warn, 'warn'], [q.crit, 'crit']]) if (Number.isFinite(v)) rows.push({ label: name, value: it.value >= v ? `over (${v})` : `below (${v})` });
          return { title: `${q.title ?? d.title ?? ''}${it.status && it.status !== 'ok' ? ` · ${it.status.toUpperCase()}` : ''}`, rows, notes: q.more > 0 ? [`${q.more} more not shown`] : [] };
        };
      };
      // Rows the builder left out (it keeps the unhealthy and the highest): said, so a short list never looks complete.
      if (q.more > 0 && q.status !== 'nodata') text(ctx, `+${q.more} MORE`, u * .05, head + u * .05, u * .032, DIM);
      if (q.status === 'nodata') {   // the film's own phrase for a dead display
        text(ctx, 'NON', w / 2, h * .48, u * .09, WHITE, 'center', FONT_WIDE);
        text(ctx, 'FUNCTION', w / 2, h * .48 + u * .12, u * .09, WHITE, 'center', FONT_WIDE);
        return;
      }

      if (q.kind === 'note') {   // a few words the 9000 wrote: wrapped, large, centred
        // Set like the ship's signage: thin capitals, centred, plenty of field around them. The size steps down until
        // every word fits in the space under the header (wrap keeps at most five lines).
        const room = h - Math.max(BODY, head + u * .06) - u * .06;
        let size = u * (q.text.length > 90 ? .075 : q.text.length > 45 ? .095 : .12), lines;
        for (;;) {
          lines = wrap(ctx, q.text.toUpperCase(), w - u * .16, size, FONT_SIGN, 300, 99);
          if ((lines.length <= 5 && lines.length * size * 1.3 <= room) || size < u * .035) break;
          size *= .9;
        }
        lines = lines.slice(0, Math.max(1, Math.floor(room / (size * 1.3))));
        const top = Math.max(head + u * .06 + size, (h + Math.max(BODY, head) ) / 2 - ((lines.length - 1) * size * 1.3) / 2 + size * .35 - u * .05);
        lines.forEach((l, i) => text(ctx, l, w / 2, top + i * size * 1.3, size, ink, 'center', FONT_SIGN, 300));
        return;
      }

      if (q.kind === 'events') {   // timeline, oldest first: time on the left, a dot, the label
        const ev = q.events ?? [], rowH = Math.min((h * .78) / Math.max(ev.length, 1), u * .15), x0 = u * .3;
        ctx.strokeStyle = DIM; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x0, h * .16); ctx.lineTo(x0, h * .16 + rowH * ev.length); ctx.stroke();
        // While a story's narration is about one of these (ship.state.focusMark: its time), that row is lit, the rest dim.
        const hl = ship?.state?.focusMark, lit = e => hl != null && Date.parse(e.time) === hl;
        const anyLit = ev.some(lit);
        ev.forEach((e, i) => {
          const y = h * .16 + rowH * (i + .55), last = i === ev.length - 1, on = lit(e);
          ctx.globalAlpha = anyLit && !on ? .35 : 1;
          const c = on ? CHIP : last ? ink : WHITE;
          ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x0, y - rowH * .12, Math.max(4, u / 70) * (on ? 1.6 : 1), 0, Math.PI * 2); ctx.fill();
          text(ctx, clock(e.time), x0 - u * .04, y, rowH * .36, on ? CHIP : DIM, 'right');
          text(ctx, fit(ctx, e.label, w - x0 - u * .1, rowH * .4), x0 + u * .05, y, rowH * .4, c);
          ctx.globalAlpha = 1;
        });
        return;
      }

      if (q.kind === 'logs') {   // latest matching log lines, newest first
        const lines = q.lines ?? [], rowH = Math.min((h * .8) / Math.max(lines.length, 1), u * .13);
        if (!lines.length) { text(ctx, 'NO MATCHING LINES', w / 2, h / 2, u * .07, DIM, 'center'); return; }
        lines.forEach((l, i) => {
          const y = h * .2 + rowH * (i + .6);
          const lv = /err|crit|fatal/i.test(l.level) ? RED : /warn/i.test(l.level) ? AMBER : DIM;
          text(ctx, clock(l.time), u * .05, y, rowH * .32, DIM);
          ctx.fillStyle = lv; ctx.fillRect(u * .2, y - rowH * .32, Math.max(3, u / 160), rowH * .4);
          text(ctx, fit(ctx, l.text, w - u * .3, rowH * .34), u * .23, y, rowH * .34, WHITE);
        });
        return;
      }

      if (q.kind === 'list') {
        const items = q.items ?? [];
        text(ctx, `${q.display} ${q.unit && q.unit.trim() !== '%' ? q.unit : ''}`.trim(), w - u * .05, HY, u * .1, ink, 'right');
        if (!items.length) { text(ctx, 'NONE', w / 2, h * .58, u * .09, DIM, 'center'); return; }
        const top = BODY, rowH = Math.min((h * .96 - top) / items.length, u * .14), max = Math.max(...items.map(i => i.value)) || 1;   // no floor of 1: ratios and small rates fill their bars too
        items.forEach((it, i) => {
          const y = top + i * rowH;
          ctx.fillStyle = inkAt(.12); ctx.fillRect(u * .05, y + rowH * .15, (w - u * .1) * (it.value / max), rowH * .7);
          text(ctx, it.label.length > 34 ? it.label.slice(0, 33) + '…' : it.label, u * .07, y + rowH * .66, rowH * .42, WHITE);
          text(ctx, it.display, w - u * .07, y + rowH * .66, rowH * .42, ink, 'right');
        });
        rowHover(items, top, rowH, u * .05, w - u * .05, it => it.display);
        return;
      }

      const headline = () => text(ctx, `${q.stat ?? ''} ${q.display} ${q.unit && q.unit !== '%' && !/[0-9]m?s$/.test(q.display) ? q.unit : ''}`.trim(),
        w - u * .05, HY, u * .1, ink, 'right');
      const timeAxis = (x0, x1, y, start, end) => {
        text(ctx, clock(start), x0, y, u * .038, DIM);
        text(ctx, clock(end), x1, y, u * .038, DIM, 'right');
        text(ctx, `${q.window ?? 30} MIN`, (x0 + x1) / 2, y, u * .038, DIM, 'center');
      };
      const STATE_FILL = { ok: inkAt(.22), warn: CHIP, crit: RED, nodata: 'transparent' };

      if (q.kind === 'compose' && q.layout === 'story') {   // a story card: its elements stacked, each drawn as its own panel
        const els = q.elements ?? [], total = els.reduce((a, e) => a + e.weight, 0) || 1;
        const top = head + u * .02, bottom = h - (q.caption ? u * .06 : 0), room = bottom - top, gap = u * .015;
        d.subs ??= [];
        d.eventHits = []; d.markHits = []; d.hits = [];
        const rects = [];
        let y = top;
        els.forEach((e, i) => {
          const eh = room * e.weight / total - gap, sub = (d.subs[i] ??= boardPanel(e.data, index));
          sub.data = e.data;
          if (d.replay && !sub.replay) sub.replay = { ...d.replay };   // a replayed card replays its trends
          rects.push({ y, h: eh, sub });
          // Hover reaches the element under the pointer, in its own coordinates.
          sub.hoverX = d.hoverY >= y && d.hoverY <= y + eh ? d.hoverX : NaN; sub.hoverY = d.hoverY - y;
          ctx.save(); ctx.beginPath(); ctx.rect(0, y, w, eh); ctx.clip(); ctx.translate(0, y);
          sub.draw(ctx, w, eh, t, ship, { top: u * .06 });
          ctx.restore();
          const ts = Math.min(u * .028, 15);
          text(ctx, fit(ctx, String(e.title).toUpperCase(), w * .6, ts), u * .03, y + ts * 1.6, ts, inkAt(.8), 'left', FONT_WIDE);
          if (i) { ctx.strokeStyle = inkAt(.3); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(u * .02, y - gap / 2); ctx.lineTo(w - u * .02, y - gap / 2); ctx.stroke(); }
          // Clicks reach the element's markers, boxes and events too.
          for (const k of ['eventHits', 'markHits', 'hits']) for (const hit of sub[k] ?? []) d[k].push({ ...hit, y0: hit.y0 + y, y1: hit.y1 + y });
          y += eh + gap;
        });
        d.tipAt = (px, py) => { const r = rects.find(r => py >= r.y && py <= r.y + r.h); return r?.sub.tipAt?.(px, py - r.y) ?? null; };
        if (q.caption) text(ctx, fit(ctx, q.caption, w - u * .1, u * .036), u * .05, h - u * .02, u * .036, inkAt(.8));
        return;
      }

      if (q.kind === 'compose') {   // a panel the 9000 designed: layers drawn in the house style (boards/compose.js)
        if (q.display) {   // the number, with what it is (MAX, VS YESTERDAY) small beside it, so it fits a small panel
          const unit = q.change || !q.unit || q.unit === '%' || /[0-9]m?s$/.test(q.display) ? '' : ` ${q.unit}`;
          ctx.font = `400 ${u * .1}px ${FONT}`;
          const nw = ctx.measureText(q.display + unit).width;
          text(ctx, q.display + unit, w - u * .05, HY, u * .1, ink, 'right');
          if (q.stat) text(ctx, fit(ctx, q.stat, Math.max(u * .1, w - nw - u * .5), u * .036), w - u * .08 - nw, HY, u * .036, DIM, 'right');
        }
        const twoScales = q.layout === 'time' && (q.series ?? []).some(s => s.axis === 'right') && (q.series ?? []).some(s => s.axis !== 'right');
        const ls = u * .034, x0 = u * .16, x1 = w - (twoScales ? u * .16 : u * .05), y0 = Math.max(h * .28, BODY);
        // The legend sits under the plot and grows upward with its rows; the plot takes what is left.
        const nLegend = q.layout === 'time' ? (q.series ?? []).length : q.layout === 'bars' ? (q.bars ?? []).length : 0;
        const legendCols = Math.max(1, Math.min(nLegend, w > h * 1.4 ? 3 : 2)), legendRows = Math.ceil(nLegend / legendCols);
        const bottom = h - (q.caption ? ls * 2.2 : ls * .9);
        const legendY = bottom - (legendRows - 1) * ls * 1.45;
        const y1 = legendY - ls * (q.layout === 'bars' ? 1.6 : 2.9);
        const num = v => String(+(+v).toPrecision(3));
        if (q.caption) text(ctx, fit(ctx, q.caption, w - u * .1, ls * 1.05), u * .05, h * .965, ls * 1.05, inkAt(.8));
        // How each style strokes and fills: the hero in the panel's ink and heavier, ghosts faint and dotted.
        const DASHES = [[], [8, 4], [12, 3, 2, 3], [1, 7]];
        // c: the line's own colour (public/inks.js); the hero keeps the panel's ink.
        const pen = (st, hero, i, c) => {
          const col = hero ? ink : (c ?? WHITE);
          ctx.globalAlpha = 1; ctx.lineWidth = hero ? 2 : 1.2; ctx.strokeStyle = col; ctx.fillStyle = col;
          ctx.setLineDash(st === 'dotted' ? [2, 4] : st === 'faint' ? [2, 4] : st === 'line' && !hero ? DASHES[i % DASHES.length] : []);
          if (st === 'faint') { ctx.strokeStyle = c && !hero ? alpha(c, .6) : inkAt(.6); ctx.fillStyle = c && !hero ? alpha(c, .3) : inkAt(.3); ctx.lineWidth = 1.3; ctx.setLineDash([2, 3]); }
        };
        const sample = (st, hero, i, x, y, c) => {   // a legend swatch
          pen(st, hero, i, c);
          if (['bars', 'solid'].includes(st) || (st === 'faint' && q.layout === 'bars')) { ctx.setLineDash([]); ctx.fillRect(x, y - ls * .6, u * .05, ls * .5); }
          else if (st === 'outline') { ctx.setLineDash([]); ctx.strokeRect(x, y - ls * .6, u * .05, ls * .5); }
          else if (st === 'points') for (let k = 0; k < 3; k++) ctx.fillRect(x + k * u * .02, y - ls * .45, 3, 3);
          else {
            if (st === 'area') { ctx.globalAlpha = .25; ctx.fillRect(x, y - ls * .35, u * .06, ls * .35); ctx.globalAlpha = 1; }
            ctx.beginPath(); ctx.moveTo(x, y - ls * .35); ctx.lineTo(x + u * .06, y - ls * .35); ctx.stroke();
          }
          ctx.setLineDash([]); ctx.globalAlpha = 1;
        };
        const legend = items => {
          const cols = legendCols, colW = (w - u * .1) / cols;
          items.forEach((it, i) => {
            const x = u * .05 + (i % cols) * colW, y = legendY + Math.floor(i / cols) * ls * 1.45;
            sample(it.style, it.hero, it.i ?? i, x, y, it.c);
            text(ctx, fit(ctx, it.text, colW - u * .09, ls), x + u * .075, y, ls, it.hero ? WHITE : inkAt(.8));
          });
        };

        if (q.layout === 'bars') {
          const rows = q.rows ?? [], n = Math.max(1, q.bars?.length ?? 1), all = rows.flatMap(r => r.values.map(v => v.v)).filter(Number.isFinite);
          const max = q.y?.max ?? (Math.max(...all, ...((q.refs ?? []).map(r => r.value))) * 1.08 || 1);
          const lx = x0 + (w - x0) * .22, bx1 = w - u * .14, rowH = (y1 - y0) / Math.max(rows.length, 1), barH = Math.min(rowH * .78 / n, u * .05);
          const xOf = v => lx + Math.max(0, Math.min(1, v / max)) * (bx1 - lx);
          rows.forEach((r, k) => {
            const top = y0 + k * rowH + (rowH - barH * n) / 2;
            text(ctx, fit(ctx, r.label, lx - u * .07, ls), lx - u * .02, top + barH * n / 2 + ls * .35, ls, WHITE, 'right');
            r.values.forEach((v, j) => {
              if (!Number.isFinite(v.v)) return;
              const y = top + j * barH, x = xOf(v.v);
              pen(v.style, v.hero, j);
              ctx.setLineDash([]);
              if (v.style === 'outline') ctx.strokeRect(lx, y + 1, x - lx, barH - 2); else ctx.fillRect(lx, y + 1, x - lx, barH - 2);
              ctx.globalAlpha = 1;
              text(ctx, v.display, x + u * .012, y + barH * .78, Math.min(ls, barH * .95), v.hero ? WHITE : DIM);
            });
          });
          ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
          for (const r of q.refs ?? []) {
            ctx.strokeStyle = r.tone === 'crit' ? RED : r.tone === 'warn' ? CHIP : DIM;
            ctx.beginPath(); ctx.moveTo(xOf(r.value), y0 - u * .01); ctx.lineTo(xOf(r.value), y1); ctx.stroke();
            text(ctx, `${r.label || ''} ${num(r.value)}`.trim(), xOf(r.value), y0 - u * .02, ls * .9, ctx.strokeStyle, 'center');
          }
          ctx.setLineDash([]);
          legend((q.bars ?? []).map((b, i) => ({ style: b.style, hero: b.hero, i, text: b.label.toUpperCase() })));
          return;
        }

        if (q.layout === 'scatter') {
          const pts = q.points ?? [];
          const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
          const xlo = Math.min(0, ...xs), xhi = Math.max(...xs) * 1.1 || 1, ylo = q.y?.min ?? Math.min(0, ...ys), yhi = q.y?.max ?? (Math.max(...ys) * 1.1 || 1);
          const sx1 = w - u * .08, sy1 = h * (q.caption ? .8 : .84);
          const X = v => x0 + ((v - xlo) / (xhi - xlo || 1)) * (sx1 - x0), Y = v => sy1 - ((v - ylo) / (yhi - ylo || 1)) * (sy1 - y0);
          ticks(ctx, x0, y0, sx1, sy1, 8);
          text(ctx, num(yhi), x0 - u * .02, y0 + ls * .4, ls, DIM, 'right');
          text(ctx, num(ylo), x0 - u * .02, sy1, ls, DIM, 'right');
          text(ctx, num(xlo), x0, sy1 + ls * 1.4, ls, DIM);
          text(ctx, num(xhi), sx1, sy1 + ls * 1.4, ls, DIM, 'right');
          const axisName = a => (a.unit && !a.label.toLowerCase().includes(a.unit.toLowerCase()) ? `${a.label} ${a.unit}` : a.label);
          text(ctx, `${axisName(q.x)} →`.toUpperCase(), (x0 + sx1) / 2, sy1 + ls * 1.4, ls, WHITE, 'center');
          text(ctx, `↑ ${axisName(q.yAxis)}`.toUpperCase(), x0, y0 - ls * .8, ls, WHITE);
          // Name the outliers (farthest from the middle) first; the rest stay dots.
          const cx = xs.reduce((a, b) => a + b, 0) / xs.length, cy = ys.reduce((a, b) => a + b, 0) / ys.length;
          const order = [...pts].sort((a, b) => Math.hypot((b.x - cx) / (xhi || 1), (b.y - cy) / (yhi || 1)) - Math.hypot((a.x - cx) / (xhi || 1), (a.y - cy) / (yhi || 1)));
          const placed = [];
          order.forEach((p, k) => {
            const x = X(p.x), y = Y(p.y);
            ctx.fillStyle = k < 3 ? ink : WHITE; ctx.fillRect(x - 3, y - 3, 6, 6);
            if (k >= 8) return;
            const label = fit(ctx, p.label, u * .3, ls * .9); ctx.font = `400 ${ls * .9}px ${FONT}`;
            const tw = ctx.measureText(label).width, right = x + 8 + tw < sx1, a = right ? x + 8 : x - 8 - tw;
            if (placed.some(([px, py, pw]) => Math.abs(py - y) < ls && a < px + pw && a + tw > px)) return;
            placed.push([a, y, tw]);
            text(ctx, label, right ? x + 8 : x - 8, y + ls * .3, ls * .9, k < 3 ? WHITE : DIM, right ? 'left' : 'right');
          });
          return;
        }

        // time
        const series = q.series ?? [], all = series.flatMap(s => s.points);
        if (all.length < 2) return;
        const t0 = q.t0 ?? Math.min(...all.map(p => p[0])), t1 = q.t1 ?? Math.max(...all.map(p => p[0]));
        // Two scales when a layer asked for its own (axis "right": a metric in other units beside the hero): the left one
        // fits the other series, the reference lines and y; the right one fits its own series and is labelled at the right.
        const onRight = s => twoScales && s.axis === 'right';
        const leftVals = series.filter(s => !onRight(s)).flatMap(s => s.points.map(p => p[1]));
        const vals = leftVals, dlo = Math.min(...vals), dhi = Math.max(...vals), dspan = dhi - dlo || Math.abs(dhi) || 1;
        const near = v => Number.isFinite(v) && v >= dlo - dspan && v <= dhi + dspan * 1.5;
        const refs = (q.refs ?? []).filter(r => near(r.value));
        const lo = q.y?.min ?? (dlo >= 0 && dlo < dspan ? 0 : Math.min(dlo - dspan * .05, ...refs.map(r => r.value)));
        const hi = q.y?.max ?? Math.max(dhi + dspan * .12, ...refs.map(r => r.value)), span = hi - lo || 1;
        const rVals = series.filter(onRight).flatMap(s => s.points.map(p => p[1]));
        const rdlo = Math.min(...rVals), rdhi = Math.max(...rVals), rdspan = rdhi - rdlo || Math.abs(rdhi) || 1;
        const rlo = rdlo >= 0 && rdlo < rdspan ? 0 : rdlo - rdspan * .05, rhi = rdhi + rdspan * .12, rspan = rhi - rlo || 1;
        const xOf = t => x0 + ((t - t0) / (t1 - t0 || 1)) * (x1 - x0);
        const yOf = (v, axis) => (twoScales && axis === 'right' ? y1 - ((Math.max(rlo, Math.min(rhi, v)) - rlo) / rspan) * (y1 - y0)
          : y1 - ((Math.max(lo, Math.min(hi, v)) - lo) / span) * (y1 - y0));
        // Replay (monitor.html sets d.replay while a story tour narrates this panel): the trend draws itself from left
        // to right over the narration, events appearing as the line reaches them, behind a bright "now" cursor.
        const replayF = d.replay ? Math.min(1, (performance.now() - d.replay.start) / d.replay.ms) : 1;
        if (replayF >= 1 && d.replay) d.replay = null;
        const revealX = x0 + replayF * (x1 - x0);
        if (replayF < 1) { ctx.strokeStyle = WHITE; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(revealX, y0); ctx.lineTo(revealX, y1); ctx.stroke(); }
        for (const sp of q.spans ?? []) {   // shaded ranges, under everything
          ctx.fillStyle = sp.tone === 'crit' ? alpha(RED, .2) : sp.tone === 'warn' ? alpha(CHIP, .18) : inkAt(.09);
          ctx.fillRect(xOf(sp.t0), y0, Math.max(2, xOf(sp.t1) - xOf(sp.t0)), y1 - y0);
          if (sp.label) text(ctx, fit(ctx, sp.label.toUpperCase(), Math.max(u * .15, xOf(sp.t1) - xOf(sp.t0)), ls * .85), xOf(sp.t0) + 3, y1 - ls * .4, ls * .85, sp.tone === 'warn' ? CHIP : WHITE);
        }
        ticks(ctx, x0, y0, x1, y1, 10);
        text(ctx, num(hi), x0 - u * .02, y0 + u * .015, ls, DIM, 'right');
        text(ctx, num((hi + lo) / 2), x0 - u * .02, (y0 + y1) / 2 + u * .015, ls, DIM, 'right');
        text(ctx, num(lo), x0 - u * .02, y1, ls, DIM, 'right');
        if (twoScales) {   // the right scale, its unit under it (the legend says which line it is)
          // Enough digits to tell the three labels apart when the line barely moves (-152.31 / -152.27 / -152.23).
          const rs = series.find(onRight), digits = rspan < 10 ? Math.min(4, Math.max(0, Math.ceil(-Math.log10(rspan / 2)) + 1)) : 0;
          const rnum = v => (digits ? (+v).toFixed(digits) : num(v)), room = w - x1 - u * .03;
          text(ctx, fit(ctx, rnum(rhi), room, ls), x1 + u * .02, y0 + u * .015, ls, DIM);
          text(ctx, fit(ctx, rnum((rhi + rlo) / 2), room, ls), x1 + u * .02, (y0 + y1) / 2 + u * .015, ls, DIM);
          text(ctx, fit(ctx, rnum(rlo), room, ls), x1 + u * .02, y1, ls, DIM);
          if (rs.unit) text(ctx, fit(ctx, rs.unit.toUpperCase(), room, ls * .85), x1 + u * .02, y1 + u * .055, ls * .85, DIM);
        }
        timeAxis(x0, x1, y1 + u * .055, t0, t1);
        ctx.setLineDash([5, 5]); ctx.lineWidth = 1;
        for (const r of refs) {
          const c = r.tone === 'crit' ? RED : r.tone === 'warn' ? CHIP : DIM;
          ctx.strokeStyle = c; ctx.beginPath(); ctx.moveTo(x0, yOf(r.value)); ctx.lineTo(x1, yOf(r.value)); ctx.stroke();
          text(ctx, `${(r.label || '').toUpperCase()} ${num(r.value)}`.trim(), x1, yOf(r.value) - 4, ls, c, 'right');
        }
        ctx.setLineDash([]);
        drawMarks(ctx, (q.marks ?? []).filter(m => m.t > t0 && m.t < t1).map(m => ({ ...m, x: xOf(m.t) })),
          { left: x0, right: x1, top: y0, bottom: y1 }, u, d, ship?.state?.focusMark);
        // Each line its own colour and dash, kept by the card across refreshes (public/inks.js keep). The hero is the one
        // the server chose, so the bright line is always the one the headline, status and markers describe; a line that
        // stops being the hero goes back to its own remembered colour.
        const heroKey = (series.find(s => s.hero) ?? {}).key, looks = keepLooks(d.code, series.map(s => s.key ?? s.label), d.color, DASHES.length);
        const inkOf = s => (s.hero || (heroKey !== undefined && s.key === heroKey) ? undefined : looks[series.indexOf(s)].ink);
        const dashOf = s => looks[series.indexOf(s)].dash;
        const order = series.map((s, i) => ({ s, i })).sort((a, b) => (a.s.hero - b.s.hero) || ((b.s.style === 'faint') - (a.s.style === 'faint')));
        for (const { s, i } of order) {
          pen(s.style, s.hero, dashOf(s), inkOf(s));
          const pts = s.points.filter(([t]) => t >= t0 - 1 && t <= t1 + 1 && xOf(t) <= revealX + .5);
          if (!pts.length) continue;
          if (s.style === 'bars') {
            const bw = Math.max(1, ((x1 - x0) / Math.max(pts.length, 1)) * .6);
            ctx.globalAlpha = s.hero ? .85 : .5;
            for (const [t, v] of pts) ctx.fillRect(xOf(t) - bw / 2, yOf(v, s.axis), bw, y1 - yOf(v, s.axis));
            ctx.globalAlpha = 1; continue;
          }
          if (s.style === 'points') { for (const [t, v] of pts) ctx.fillRect(xOf(t) - 2, yOf(v, s.axis) - 2, 4, 4); continue; }
          ctx.beginPath();
          const starts = breaksOf(pts, (q.step ?? 0) * 1000);
          pts.forEach(([t, v], j) => {
            const x = xOf(t), y = yOf(v, s.axis);
            if (starts(j)) return ctx.moveTo(x, y);
            if (s.style === 'step') ctx.lineTo(x, yOf(pts[j - 1][1], s.axis));
            ctx.lineTo(x, y);
          });
          ctx.stroke();
          if (s.style === 'area') {
            ctx.lineTo(xOf(pts.at(-1)[0]), y1); ctx.lineTo(xOf(pts[0][0]), y1); ctx.closePath();
            ctx.globalAlpha = s.hero ? .2 : .12; ctx.fill(); ctx.globalAlpha = 1;
          }
        }
        ctx.setLineDash([]);
        // Hover (monitor.html sets d.hoverX/Y): a crosshair at that moment with a dot on each line, and tipAt() for the
        // tooltip: the time, every line's value then, and the events and changes near it.
        const valueAt = (pts, t) => { let best = null; for (const p of pts) if (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p; return best && Math.abs(best[0] - t) <= (q.step ?? 60) * 1500 ? best[1] : null; };
        const timeAt = px => t0 + ((px - x0) / (x1 - x0 || 1)) * (t1 - t0);
        const fmtV = (v, unit = q.unit) => `${+(+v).toPrecision(3)}${unit && unit !== '%' ? ` ${unit}` : unit === '%' ? '%' : ''}`;
        if (Number.isFinite(d.hoverX) && d.hoverX >= x0 && d.hoverX <= x1 && d.hoverY >= y0 - ls * 2 && d.hoverY <= y1 + ls) {
          const t = timeAt(d.hoverX);
          ctx.strokeStyle = inkAt(.7); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(d.hoverX, y0); ctx.lineTo(d.hoverX, y1); ctx.stroke(); ctx.setLineDash([]);
          for (const s2 of series) { const v = valueAt(s2.points, t); if (v === null) continue; ctx.fillStyle = s2.hero ? ink : (inkOf(s2) ?? WHITE); ctx.beginPath(); ctx.arc(d.hoverX, yOf(v, s2.axis), 3.5, 0, Math.PI * 2); ctx.fill(); }
        }
        d.tipAt = (px, py) => {
          if (px < x0 || px > x1 || py < y0 - ls * 2 || py > y1 + ls) return null;
          const t = timeAt(px), near = (x1 - x0) * .02;
          const rows = series.map(s2 => ({ label: s2.label, value: valueAt(s2.points, t), hero: s2.hero, ink: inkOf(s2), unit: onRight(s2) ? s2.unit : q.unit })).filter(r => r.value !== null).map(r => ({ label: r.label, hero: r.hero, ink: r.ink, value: fmtV(r.value, r.unit) }));
          const notes = [...(q.events ?? []), ...(q.callouts ?? []).map(c => ({ ...c, source: 'note' }))].filter(e => Math.abs(xOf(e.t) - px) <= near)
            .map(e => `${clock(e.t)} ${e.source === 'traces' ? 'trace' : e.source === 'logs' ? 'log' : 'note'}: ${e.text}${e.riseDisplay ? ` (then ${e.riseDisplay})` : ''}`);
          const changes = (q.marks ?? []).filter(m => Math.abs(xOf(m.t) - px) <= near).map(m => `${clock(m.t)} change: ${m.label}`);
          return { title: `${clock(t)} · ${Math.round((Date.now() - t) / 60000)} min ago`, rows, notes: [...notes, ...changes].slice(0, 6) };
        };
        // What else happened, on the line itself: callouts the 9000 wrote, and events from other signals (log lines,
        // traces; profiles once connected), each a marker at its time on the hero line, so the ones before a rise sit
        // at the foot of it. Labels take the first free lane from the top of the plot (never on top of each other);
        // events too close to share a lane are grouped ("+2"). A click opens the trace, or asks about the event.
        const notes = [...(q.callouts ?? []).map(c => ({ ...c, source: 'note' })), ...(q.events ?? [])].filter(e => e.t >= t0 && e.t <= t1 && xOf(e.t) <= revealX + .5)
          .map(e => ({ ...e, x: xOf(e.t), y: Number.isFinite(e.v) ? yOf(e.v, e.axis) : y1 })).sort((a, b) => a.x - b.x);
        d.eventHits = [];
        const lanesUsed = [[], [], [], []], laneH = ls * 1.45, maxW = (x1 - x0) * .42, placed = [];
        for (const e of notes) {
          const words = `${e.source === 'traces' ? 'TRACE ' : e.source === 'logs' ? 'LOG ' : ''}${e.text}${e.riseDisplay ? `  ${e.riseDisplay}` : ''}`;
          const label = fit(ctx, words, maxW, ls * .9); ctx.font = `400 ${ls * .9}px ${FONT}`;
          const tw = ctx.measureText(label).width, right = e.x + 6 + tw <= x1, a = right ? e.x + 6 : e.x - 6 - tw, b = a + tw;
          const lane = lanesUsed.findIndex(spans => spans.every(([p, q2]) => b + 8 < p || a > q2 + 8));
          if (lane < 0) { const near = placed.reduce((m, p) => (!m || Math.abs(p.x - e.x) < Math.abs(m.x - e.x) ? p : m), null); if (near) near.more++; }
          else { lanesUsed[lane].push([a, b]); placed.push({ ...e, label, a, b, right, ly: y0 + ls + lane * laneH, more: 0 }); }
          // The marker, on the line: logs a dot, traces a square, errors red, the 9000's callouts white.
          ctx.fillStyle = e.kind === 'error' ? RED : e.source === 'note' ? WHITE : CHIP;
          if (e.source === 'traces') ctx.fillRect(e.x - 4, e.y - 4, 8, 8); else { ctx.beginPath(); ctx.arc(e.x, e.y, 4, 0, Math.PI * 2); ctx.fill(); }
          d.eventHits.push({ x0: e.x - 7, x1: e.x + 7, y0: e.y - 7, y1: e.y + 7, event: e });
        }
        for (const e of placed) {
          ctx.strokeStyle = inkAt(.55); ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
          ctx.beginPath(); ctx.moveTo(e.x, e.y - 5); ctx.lineTo(e.x, e.ly + ls * .3); ctx.stroke(); ctx.setLineDash([]);
          const extra = e.more ? `  +${e.more}` : '';
          ctx.font = `400 ${ls * .9}px ${FONT}`;
          const w2 = ctx.measureText(e.label + extra).width, a = e.right ? e.a : e.b - w2;
          ctx.fillStyle = veil(.75); ctx.fillRect(a - 3, e.ly - ls * .85, w2 + 6, ls * 1.15);
          text(ctx, e.label + extra, a, e.ly, ls * .9, e.kind === 'error' ? RED_SOFT : WHITE);
          if (e.riseDisplay) { ctx.font = `400 ${ls * .9}px ${FONT}`; }
          d.eventHits.push({ x0: a - 3, x1: a + w2 + 3, y0: e.ly - ls, y1: e.ly + ls * .3, event: e });
        }
        // The trend in context: peak and when, typical level, spikes (and signals asked for but not connected).
        // Built here from the figures (the model hears the same in words), so times are in the screen's own clock.
        const cx = q.context, dur = sec => (sec < 120 ? `${Math.round(sec)} S` : sec < 7200 ? `${Math.round(sec / 60)} MIN` : `${(sec / 3600).toFixed(1)} H`);
        const ctxWords = !cx ? '' : cx.peak - cx.typical < 1e-9 ? `FLAT AT ${fmtV(cx.typical)}`
          : `PEAK ${fmtV(cx.peak)} AT ${clock(cx.peakAt)} · TYPICAL ${fmtV(cx.typical)} · ${cx.spikes && cx.spikes <= 6 ? `${cx.spikes} SPIKE${cx.spikes > 1 ? 'S' : ''}, LONGEST ${dur(cx.longestSeconds)}` : `P95 ${fmtV(cx.p95)}`}`;
        if (ctxWords || q.unavailable?.length) text(ctx, fit(ctx, `${ctxWords}${q.unavailable?.length ? `  ·  NO ${q.unavailable.join(', ').toUpperCase()} YET` : ''}`, x1 - x0, ls * .85),
          x0, Math.max(head + ls * 2, y0 - ls * 1.6), ls * .85, DIM);
        legend(series.map(s => ({ style: s.style, hero: s.hero, i: dashOf(s), c: inkOf(s), text: `${s.label} ${s.display}` })));
        return;
      }

      if (q.kind === 'flow') {   // data-flow diagram: services as boxes in layers, calls as moving arrows; faults lit
        const nodes = q.nodes ?? [], edges = q.edges ?? [];
        text(ctx, q.display, w - u * .05, HY, u * .07, ink, 'right');
        if (!nodes.length) return;
        const layers = Math.max(...nodes.map(n => n.layer)) + 1;
        const cols = Array.from({ length: layers }, () => []);
        nodes.forEach(n => cols[n.layer].push(n));
        const left = u * .05, right = w - u * .05, top = BODY, bottom = h * .95;
        const colW = (right - left) / layers;
        const bw = Math.min(colW * .74, u * .4), bh = Math.min(u * .12, (bottom - top) / Math.max(...cols.map(c => c.length)) * .62);
        const pos = new Map();
        // Order each column by where its callers sit (barycentre), so arrows cross as little as possible.
        cols.forEach((col, i) => {
          if (i) col.sort((a, b) => {
            const bary = n => { const ys = edges.filter(e => e.to === n.id && pos.has(e.from)).map(e => pos.get(e.from).y); return ys.length ? ys.reduce((x, y) => x + y) / ys.length : 1e9; };
            return bary(a) - bary(b);
          });
          const gap = (bottom - top) / col.length;
          col.forEach((n, j) => pos.set(n.id, { x: left + colW * (i + .5), y: top + gap * (j + .5) }));
        });
        const fs = Math.min(bh * .3, u * .036);
        const FILL = { warn: CHIP, crit: RED };
        // Where each box and arrow is, so a click on one can open a drilldown about it (monitor.html).
        d.hits = nodes.map(n => { const { x, y } = pos.get(n.id); return { kind: 'node', id: n.id, label: n.label, x0: x - bw / 2, y0: y - bh / 2, x1: x + bw / 2, y1: y + bh / 2, status: n.status, item: n }; });
        // Hover: a service or call under the pointer, with its rate, errors and state in full (boxes cut long names).
        d.tipAt = (px, py) => {
          const hit = d.hits.find(h2 => px >= h2.x0 && px <= h2.x1 && py >= h2.y0 && py <= h2.y1);
          if (!hit) return null;
          const it = hit.item ?? {}, rows = [];
          if (it.display) rows.push({ label: 'rate', hero: true, value: it.display });
          if (it.errDisplay) rows.push({ label: 'errors', value: it.errDisplay });
          if (hit.kind === 'node') {
            const ins = edges.filter(e => e.to === hit.id).length, outs = edges.filter(e => e.from === hit.id).length;
            rows.push({ label: 'calls', value: `${ins} in · ${outs} out` });
          }
          rows.push({ label: 'state', value: (hit.status ?? 'ok').toUpperCase() });
          return { title: hit.kind === 'edge' ? hit.label : (it.label ?? hit.label), rows, notes: ['click to ask about it'] };
        };
        // Calls: a curve from the caller's right edge to the callee's left edge; dashes flow towards the callee.
        for (const e of edges) {
          const a = pos.get(e.from), b = pos.get(e.to);
          if (!a || !b) continue;
          const bad = e.status === 'warn' || e.status === 'crit', c = bad ? FILL[e.status] : inkAt(.7);
          const x0 = a.x + bw / 2, y0 = a.y, x1 = b.x - bw / 2, y1 = b.y, back = x1 <= x0;
          const cx = back ? Math.max(x0, x1) + colW * .4 : (x0 + x1) / 2;
          ctx.strokeStyle = c; ctx.lineWidth = bad ? 2.5 : 1.2;
          ctx.setLineDash([6, 6]); ctx.lineDashOffset = -((t / 40) % 12);
          ctx.beginPath(); ctx.moveTo(x0, y0);
          back ? ctx.bezierCurveTo(cx, y0 + bh, cx - colW * .8, y1 + bh, x1, y1) : ctx.bezierCurveTo(cx, y0, cx, y1, x1, y1);
          ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
          ctx.fillStyle = c;   // arrowhead
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - u * .018, y1 - u * .01); ctx.lineTo(x1 - u * .018, y1 + u * .01); ctx.fill();
          const hx = back ? cx - colW * .4 : (x0 + x1) / 2, hy = back ? Math.max(y0, y1) + bh * .9 : (y0 + y1) / 2, r = u * .03;
          d.hits.push({ kind: 'edge', from: e.from, to: e.to, label: `${e.from} → ${e.to}`, x0: hx - r, y0: hy - r, x1: hx + r, y1: hy + r, status: e.status, item: e });
          const label = [e.label, e.display, e.errDisplay && `${e.errDisplay} ERR`].filter(Boolean).join(' · ');
          if (label && (bad || colW - bw > u * .13)) {   // quiet rates only where the gap leaves room
            const mx = back ? cx - colW * .4 : (x0 + x1) / 2, my = back ? Math.max(y0, y1) + bh * .9 : (y0 + y1) / 2 - u * .012;
            text(ctx, label, mx, my, fs * (bad ? 1 : .8), bad ? c : DIM, 'center');
          }
        }
        // Services: hairline boxes; a fault fills the box with its colour and shows its error rate.
        for (const n of nodes) {
          const { x, y } = pos.get(n.id), bad = n.status === 'warn' || n.status === 'crit';
          const blink = n.status === 'crit' && Math.floor(t / 600) % 2;
          ctx.fillStyle = bad ? FILL[n.status] : ground(.28);
          ctx.globalAlpha = blink ? .7 : 1; ctx.fillRect(x - bw / 2, y - bh / 2, bw, bh); ctx.globalAlpha = 1;
          ctx.strokeStyle = bad ? FILL[n.status] : WHITE; ctx.lineWidth = 1.2; ctx.strokeRect(x - bw / 2 + .5, y - bh / 2 + .5, bw - 1, bh - 1);
          const fg = bad ? DARK : WHITE;
          // Shrink a long name before truncating it.
          ctx.font = `400 ${fs}px ${FONT}`;
          const ls = Math.max(fs * .55, Math.min(fs, fs * (bw - u * .03) / ctx.measureText(n.label).width));
          text(ctx, fit(ctx, n.label, bw - u * .03, ls), x, y - bh * .06, ls, fg, 'center');
          const sub = [n.display, n.errDisplay && `${n.errDisplay} ERR`].filter(Boolean).join(' · ');
          if (sub) {
            ctx.font = `400 ${fs * .85}px ${FONT}`;
            const ss = Math.max(fs * .5, Math.min(fs * .85, fs * .85 * (bw - u * .03) / ctx.measureText(sub).width));
            text(ctx, fit(ctx, sub, bw - u * .03, ss), x, y + bh * .3, ss, bad ? DARK : DIM, 'center');
          }
        }
        return;
      }

      if (q.kind === 'nodes') {   // a cluster's nodes, each holding its workloads as tiles sized by memory; free memory left empty
        const list = q.nodes ?? [];
        text(ctx, q.display, w - u * .05, HY, u * .07, ink, 'right');
        text(ctx, `${(q.cluster ?? '').toUpperCase()}${q.more ? `  ·  ${q.more} MORE NODES` : ''}`, u * .05, HY, u * .032, DIM);
        if (!list.length) return;
        const left = u * .05, right = w - u * .05, top = BODY, bottom = h * .95, gap = u * .025;
        // A grid of equal boxes, as close to square as the panel allows.
        let best = null;
        for (let c = 1; c <= list.length; c++) {
          const r = Math.ceil(list.length / c), bw = (right - left - gap * (c - 1)) / c, bh = (bottom - top - gap * (r - 1)) / r;
          const score = Math.min(bw, bh * 1.4);
          if (!best || score > best.score) best = { c, r, bw, bh, score };
        }
        const FILL = { warn: CHIP, crit: RED }, blink = Math.floor(t / 600) % 2;
        d.hits = [];
        const fs = Math.min(u * .034, best.bh * .12);
        list.forEach((n, i) => {
          const x = left + (i % best.c) * (best.bw + gap), y = top + Math.floor(i / best.c) * (best.bh + gap), bw = best.bw, bh = best.bh;
          const bad = n.status !== 'ok', edge = bad ? FILL[n.status] : n.unscheduled ? DIM : inkAt(.55);
          ctx.fillStyle = ground(.28); ctx.fillRect(x, y, bw, bh);
          ctx.strokeStyle = edge; ctx.lineWidth = bad ? 2 : 1;
          if (n.unscheduled) ctx.setLineDash([5, 4]);
          ctx.strokeRect(x + .5, y + .5, bw - 1, bh - 1); ctx.setLineDash([]);
          // Header: the node's name, its notes, and how full its memory is (a bar under the name).
          const hh = fs * 2.1, pad = fs * .4;
          const tag = [n.display, ...n.notes].filter(Boolean).join(' · ');
          ctx.font = `400 ${fs * .85}px ${FONT}`;
          const tagW = tag ? ctx.measureText(tag).width + pad : 0;
          text(ctx, fit(ctx, n.name, bw - pad * 2 - tagW, fs), x + pad, y + fs * 1.1, fs, bad ? FILL[n.status] : WHITE);
          if (tag) text(ctx, tag, x + bw - pad, y + fs * 1.1, fs * .85, bad ? FILL[n.status] : DIM, 'right');
          if (Number.isFinite(n.pct)) {
            const by = y + fs * 1.55, bwid = bw - pad * 2;
            ctx.fillStyle = inkAt(.12); ctx.fillRect(x + pad, by, bwid, fs * .22);
            ctx.fillStyle = bad && n.pct >= 85 ? FILL[n.status] : inkAt(.6); ctx.fillRect(x + pad, by, bwid * Math.min(1, n.pct / 100), fs * .22);
          }
          d.hits.push({ kind: 'k8snode', id: n.name, label: n.name, x0: x, y0: y, x1: x + bw, y1: y + hh, status: n.status, item: n });
          // Body: a treemap of workloads by memory against the node's allocatable memory (the rest is free, left
          // empty); workloads with no memory figure still get a sliver so they show.
          const bx = x + pad, by = y + hh, bbw = bw - pad * 2, bbh = bh - hh - pad;
          if (bbw < 4 || bbh < 4) return;
          const total = Math.max(n.alloc || 0, n.used || 0) || n.workloads.reduce((a, wl) => a + (wl.mem || 0), 0) || 1;
          const items = n.workloads.map(wl => ({ wl, a: Math.max(wl.mem || 0, total * .02) })).sort((a2, b2) => b2.a - a2.a);
          const sum = items.reduce((a, it) => a + it.a, 0);
          if (n.alloc && sum < total) items.push({ free: true, a: total - sum });   // last, so free memory is the space left over
          const rects = squarify(items, bx, by, bbw, bbh);
          for (const { it, x: tx, y: ty, w: tw, h: th } of rects) {
            if (it.free) continue;
            const wl = it.wl, wbad = wl.status !== 'ok', g = Math.min(2, tw * .08, th * .08);
            ctx.fillStyle = wbad ? FILL[wl.status] : water(.18);
            ctx.globalAlpha = wl.status === 'crit' && blink ? .7 : 1;
            ctx.fillRect(tx + g, ty + g, tw - g * 2, th - g * 2); ctx.globalAlpha = 1;
            ctx.strokeStyle = wbad ? FILL[wl.status] : water(.5); ctx.lineWidth = 1;
            ctx.strokeRect(tx + g + .5, ty + g + .5, tw - g * 2 - 1, th - g * 2 - 1);
            const ts = Math.min(fs * .85, th * .32);
            if (tw > ts * 3 && th > ts * 1.4) {
              const fg = wbad ? DARK : WHITE;
              text(ctx, fit(ctx, wl.name, tw - g * 2 - ts * .6, ts), tx + g + ts * .3, ty + g + ts * 1.1, ts, fg);
              const sub = [wl.pods.length > 1 && `×${wl.pods.length}`, wl.display, wbad && wl.reason].filter(Boolean).join(' · ');
              if (sub && th > ts * 2.7) text(ctx, fit(ctx, sub, tw - g * 2 - ts * .6, ts * .8), tx + g + ts * .3, ty + g + ts * 2.2, ts * .8, wbad ? DARK : DIM);
            }
            d.hits.push({ kind: 'workload', id: `${wl.namespace}/${wl.name}@${n.name}`, label: `${wl.name} on ${n.name}`, x0: tx, y0: ty, x1: tx + tw, y1: ty + th, status: wl.status, item: wl, node: n });
          }
        });
        // Hover: the tile or node header under the pointer, outlined, with what it is and why it is lit.
        const under = (px, py) => [...d.hits].reverse().find(h2 => px >= h2.x0 && px <= h2.x1 && py >= h2.y0 && py <= h2.y1);
        if (Number.isFinite(d.hoverX)) {
          const hv = under(d.hoverX, d.hoverY);
          if (hv) { ctx.strokeStyle = WHITE; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]); ctx.strokeRect(hv.x0 + .5, hv.y0 + .5, hv.x1 - hv.x0 - 1, hv.y1 - hv.y0 - 1); ctx.setLineDash([]); }
        }
        const gib = v => (!Number.isFinite(v) || !v ? '—' : v >= 1024 ** 3 ? `${(v / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(v / 1024 ** 2)} MiB`);
        d.tipAt = (px, py) => {
          const hv = under(px, py);
          if (!hv) return null;
          if (hv.kind === 'k8snode') {
            const n = hv.item, rows = [];
            if (Number.isFinite(n.pct)) rows.push({ label: 'memory', hero: true, value: `${Math.round(n.pct)}%`, ink: n.status === 'ok' ? undefined : FILL[n.status] });
            rows.push({ label: 'used of allocatable', value: `${gib(n.used)} of ${gib(n.alloc)}` }, { label: 'workloads', value: `${n.workloads.length} · ${n.podCount} pod${n.podCount === 1 ? '' : 's'}` });
            if (!n.unscheduled) rows.push({ label: 'state', value: [n.ready ? 'Ready' : 'NOT READY', n.cordoned && 'cordoned'].filter(Boolean).join(', ') });
            const lit = n.workloads.filter(wl => wl.status !== 'ok');
            return { title: n.unscheduled ? 'Pods no node has taken' : `node ${n.name}`, rows,
              notes: [...(lit.length ? [`in trouble: ${lit.map(wl => wl.name).join(', ')}`] : []), 'click to ask about it'] };
          }
          const wl = hv.item, rows = [{ label: 'memory', hero: true, value: wl.display ? `${wl.display} ${wl.memShown}` : 'no figure' },
            { label: 'pods here', value: String(wl.pods.length) }, { label: 'kind', value: `${wl.kind}${wl.namespace ? ` · ${wl.namespace}` : ''}` }];
          if (wl.restarts) rows.push({ label: 'restarts (1 h)', value: String(wl.restarts) });
          if (hv.node.alloc && wl.mem) rows.push({ label: 'share of node', value: `${Math.round((100 * wl.mem) / hv.node.alloc)}%` });
          const notes = wl.pods.filter(pd => pd.status !== 'ok').slice(0, 4).map(pd => `${pd.name}: ${pd.reason ?? pd.phase}${pd.restarts ? `, ${pd.restarts} restarts` : ''}`);
          return { title: `${wl.name} · ${hv.node.unscheduled ? 'not scheduled' : hv.node.name}${wl.status !== 'ok' ? ` · ${wl.status.toUpperCase()}` : ''}`, rows, notes: [...notes, 'click to ask about it'] };
        };
        return;
      }

      if (q.kind === 'timeline') {   // the story over time: the signal on top, what happened along one time axis below
        const evs = q.events ?? [], t0 = q.start, t1 = Math.max(q.end, t0 + 60_000), x0 = u * .05, x1 = w - u * .05;
        const xOf = tt => x0 + Math.min(1, Math.max(0, (tt - t0) / (t1 - t0))) * (x1 - x0);
        const COLOR = { alert: RED, resolve: GREEN, change: CHIP, ack: WHITE, aiden: BLUE, plan: AMBER, incident: inkAt(.75) };
        const GLYPH = { alert: 'tri', resolve: 'tri-down', change: 'diamond', ack: 'dot', aiden: 'ring', plan: 'square', incident: 'diamond-o' };
        text(ctx, q.display, w - u * .05, HY, u * .07, ink, 'right');
        text(ctx, `${evs.length} EVENT${evs.length === 1 ? '' : 'S'}`, x0, HY, u * .032, DIM);
        const top = BODY, sigB = top + (h * .9 - top) * .42, laneTop = sigB + u * .05, axisY = h * .95;
        // The signal, with its threshold.
        const pts = q.series ?? [];
        if (pts.length > 1) {
          const vals = pts.map(p => p[1]), marks = [q.crit, q.warn].filter(Number.isFinite);
          const lo = Math.min(...vals, ...marks.filter(m => m < Math.max(...vals) * 3)), hi = Math.max(...vals, ...marks.filter(m => m < Math.max(...vals) * 3)) || 1;
          const span = hi - lo || 1, yOf = v => sigB - ((v - lo) / span) * (sigB - top - u * .02);
          ctx.strokeStyle = inkAt(.12); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, sigB); ctx.lineTo(x1, sigB); ctx.stroke();
          for (const [m, c] of [[q.crit, RED], [q.warn, CHIP]]) if (Number.isFinite(m) && m >= lo && m <= hi) {
            ctx.strokeStyle = c; ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.moveTo(x0, yOf(m)); ctx.lineTo(x1, yOf(m)); ctx.stroke(); ctx.setLineDash([]);
          }
          ctx.strokeStyle = WHITE; ctx.lineWidth = 1.6; ctx.beginPath();
          pts.forEach(([tt, v], i) => (i ? ctx.lineTo(xOf(tt), yOf(v)) : ctx.moveTo(xOf(tt), yOf(v))));
          ctx.stroke();
          // Hover on the signal: a crosshair, a dot on the line, the value then and the events near it (each event's own
          // mark still shows its full text).
          const step = Math.min(...pts.slice(1).map(([tt], i) => tt - pts[i][0]).filter(x => x > 0)) || (t1 - t0);
          const at = px => { const tt = t0 + ((px - x0) / (x1 - x0)) * (t1 - t0); const p2 = pts.reduce((a, b) => (Math.abs(b[0] - tt) < Math.abs(a[0] - tt) ? b : a)); return { tt, p2: Math.abs(p2[0] - tt) <= step * 1.5 ? p2 : null }; };
          const onSig = (px, py) => px >= x0 && px <= x1 && py >= top - u * .02 && py <= sigB + u * .01;
          if (Number.isFinite(d.hoverX) && onSig(d.hoverX, d.hoverY)) {
            const { p2 } = at(d.hoverX);
            ctx.strokeStyle = inkAt(.7); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
            ctx.beginPath(); ctx.moveTo(d.hoverX, top); ctx.lineTo(d.hoverX, sigB); ctx.stroke(); ctx.setLineDash([]);
            if (p2) { ctx.fillStyle = WHITE; ctx.beginPath(); ctx.arc(xOf(p2[0]), yOf(p2[1]), 3.5, 0, Math.PI * 2); ctx.fill(); }
          }
          d.tipAt = (px, py) => {
            if (!onSig(px, py)) return null;
            const { tt, p2 } = at(px), near = (t1 - t0) * .02;
            const fmtV = v => `${+(+v).toPrecision(3)}${q.unit === '%' ? '%' : q.unit ? ` ${q.unit}` : ''}`;
            return { title: `${clock(p2?.[0] ?? tt)} · ${Math.round((Date.now() - (p2?.[0] ?? tt)) / 60000)} min ago`,
              rows: [{ label: q.signalLabel ?? 'signal', hero: true, value: p2 ? fmtV(p2[1]) : 'no data' }],
              notes: (q.events ?? []).filter(e => Math.abs(e.t - tt) <= near).slice(0, 4).map(e => `${clock(e.t)} ${e.kind}: ${e.label}`) };
          };
        } else text(ctx, 'NO SIGNAL', (x0 + x1) / 2, (top + sigB) / 2, u * .04, DIM, 'center');
        // Time axis: round clock times, four to six of them.
        const stepMin = [5, 10, 15, 30, 60, 120, 240, 480].find(m => (t1 - t0) / (m * 60_000) <= 6) ?? 720;
        ctx.strokeStyle = inkAt(.25); ctx.beginPath(); ctx.moveTo(x0, axisY - u * .03); ctx.lineTo(x1, axisY - u * .03); ctx.stroke();
        for (let tt = Math.ceil(t0 / (stepMin * 60_000)) * stepMin * 60_000; tt <= t1; tt += stepMin * 60_000) {
          ctx.beginPath(); ctx.moveTo(xOf(tt), axisY - u * .04); ctx.lineTo(xOf(tt), axisY - u * .02); ctx.stroke();
          text(ctx, clock(tt), xOf(tt), axisY, u * .028, DIM, 'center');
        }
        // Events: a hairline up through the signal, a mark in the lane, and words where a lane has room.
        const hl = ship?.state?.focusMark, anyLit = evs.some(e => e.t === hl);
        const fs = u * .03, laneH = fs * 1.7, lanes = Math.max(1, Math.floor((axisY - u * .06 - laneTop) / laneH)), used = Array.from({ length: lanes }, () => []);
        d.markHits = [];
        const glyph = (kind, x, y, r) => {
          ctx.beginPath();
          const g = GLYPH[kind];
          if (g === 'tri') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r * .8); ctx.lineTo(x - r, y + r * .8); ctx.closePath(); ctx.fill(); }
          else if (g === 'tri-down') { ctx.moveTo(x, y + r); ctx.lineTo(x + r, y - r * .8); ctx.lineTo(x - r, y - r * .8); ctx.closePath(); ctx.fill(); }
          else if (g === 'diamond' || g === 'diamond-o') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); g === 'diamond' ? ctx.fill() : ctx.stroke(); }
          else if (g === 'square') ctx.fillRect(x - r * .8, y - r * .8, r * 1.6, r * 1.6);
          else if (g === 'ring') { ctx.lineWidth = 2; ctx.arc(x, y, r * .85, 0, Math.PI * 2); ctx.stroke(); }
          else { ctx.arc(x, y, r * .8, 0, Math.PI * 2); ctx.fill(); }
        };
        // Alerts and plans claim lanes first, then the rest, left to right.
        const PRI = { alert: 0, resolve: 0, plan: 1, ack: 2, aiden: 2, incident: 3, change: 4 };
        const order = evs.map((e, i) => ({ e, i })).sort((a, b) => ((b.e.t === hl) - (a.e.t === hl)) || (PRI[a.e.kind] ?? 5) - (PRI[b.e.kind] ?? 5) || a.e.t - b.e.t);
        for (const { e } of order) {
          const x = xOf(e.t), on = e.t === hl, c = COLOR[e.kind] ?? WHITE;
          ctx.globalAlpha = anyLit && !on ? .3 : 1;
          ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = on ? 2 : 1;
          ctx.setLineDash(on ? [] : [2, 4]); ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, sigB); ctx.stroke(); ctx.setLineDash([]);
          const label = fit(ctx, `${clock(e.t)} ${e.label}`, (x1 - x0) * .45, fs);
          ctx.font = `400 ${fs}px ${FONT}`;
          const tw = ctx.measureText(label).width, right = x + fs + tw <= x1;
          const a0 = right ? x - fs : x - fs - tw, b0 = right ? x + fs + tw : x + fs;
          let k = used.findIndex(sp => sp.every(([p0, p1]) => b0 + fs < p0 || a0 > p1 + fs));
          const y = laneTop + (k >= 0 ? k : lanes - 1) * laneH + laneH / 2;
          ctx.globalAlpha *= .5; ctx.beginPath(); ctx.moveTo(x, sigB); ctx.lineTo(x, y); ctx.stroke(); ctx.globalAlpha = anyLit && !on ? .3 : 1;
          glyph(e.kind, x, y, fs * (on ? .55 : .42));
          if (k >= 0) { used[k].push([a0, b0]); text(ctx, label, right ? x + fs * .9 : x - fs * .9, y + fs * .36, fs, on ? WHITE : c, right ? 'left' : 'right'); }
          d.markHits.push({ x0: x - 9, x1: x + 9, y0: top, y1: y + fs, mark: { ...e, x } });
          if (k >= 0) d.markHits.push({ x0: a0, x1: b0, y0: y - fs * .8, y1: y + fs * .8, mark: { ...e, x } });
          ctx.globalAlpha = 1;
        }
        if (!evs.length) text(ctx, 'NOTHING RECORDED IN THIS WINDOW', (x0 + x1) / 2, (laneTop + axisY) / 2, u * .035, DIM, 'center');
        return;
      }

      if (q.kind === 'plan') {   // a proposed fix: its steps and their state; while it waits, how to approve it
        const pl = q.plan ?? {}, left = u * .05, maxW = w - u * .1;
        text(ctx, fit(ctx, q.display, w * .6, u * .06), w - u * .05, HY, u * .06, ink, 'right');
        text(ctx, pl.id ?? '', left, HY, u * .04, DIM);
        let y = BODY + u * .02;
        const fs = Math.min(u * .042, (h * .9 - BODY) / ((pl.steps?.length ?? 1) + 5));
        for (const l of wrap(ctx, pl.problem ?? '', maxW, fs * .85, FONT, 400).slice(0, 2)) { text(ctx, l, left, y, fs * .85, DIM); y += fs * 1.15; }
        y += fs * .4;
        const MARK = { pending: '□', running: '▶', done: '✓', failed: '✕', skipped: '–' };
        (pl.steps ?? []).forEach((s, i) => {
          const c = s.status === 'failed' ? RED : s.status === 'done' ? WHITE : s.status === 'running' ? CHIP : inkAt(.8);
          text(ctx, `${MARK[s.status] ?? '□'} ${i + 1}`, left, y, fs, c);
          text(ctx, fit(ctx, `${s.tool} · ${s.why}`, maxW - fs * 3, fs), left + fs * 3, y, fs, c);
          y += fs * 1.45;
        });
        y += fs * .3;
        if (pl.verify) text(ctx, fit(ctx, `CHECK ${pl.verify.expect.toUpperCase()} ${pl.verify.value}${pl.verify.now !== null && pl.verify.now !== undefined ? ` · NOW ${+Number(pl.verify.now).toPrecision(3)}` : ''}`, maxW, fs * .85), left, y, fs * .85, DIM), y += fs * 1.3;
        if (pl.status === 'pending') {
          const secs = Math.max(0, Math.round((pl.expiresAt - Date.now()) / 1000));
          const on = Math.floor(t / 700) % 2;
          text(ctx, fit(ctx, `APPROVE ON THE PLAN CARD (P) OR SAY "APPROVE THE PLAN" · EXPIRES ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`, maxW, fs * .85), left, h * .95, fs * .85, on ? CHIP : WHITE);
        } else if (pl.decidedBy) text(ctx, fit(ctx, `${pl.status === 'rejected' ? 'REJECTED' : 'APPROVED'} BY ${pl.decidedBy.toUpperCase()}`, maxW, fs * .85), left, h * .95, fs * .85, DIM);
        return;
      }

      if (q.kind === 'aiden') {   // an Aiden investigation: its state and clock while it works, its findings when done
        const a = q.aiden ?? {}, secs = Math.round(((a.finishedAt ?? Date.now()) - a.startedAt) / 1000);
        const clockTxt = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
        text(ctx, q.display, w - u * .05, HY, u * .07, ink, 'right');
        text(ctx, `${a.done ? 'TOOK' : 'ELAPSED'} ${clockTxt}${a.evidence ? ` · ${a.evidence} EVIDENCE` : ''}`, u * .05, HY, u * .032, DIM);
        const left = u * .05, maxW = w - u * .1, top = BODY;
        if (a.done && a.summary) {
          let size = u * .05, lines;
          for (; size > u * .026; size *= .9) { lines = wrap(ctx, a.summary, maxW, size, FONT, 400); if (top + lines.length * size * 1.35 < h * .95) break; }
          lines.forEach((l, i) => text(ctx, l, left, top + size + i * size * 1.35, size, WHITE));
        } else {
          // Working: a slow sweep along a rule, like a scan in progress.
          const y = top + (h * .95 - top) * .45, x = left + ((t / 2600) % 1) * maxW;
          ctx.fillStyle = inkAt(.15); ctx.fillRect(left, y, maxW, 2);
          if (!['unmatched', 'failed', 'error'].includes(a.status)) { ctx.fillStyle = WHITE; ctx.fillRect(x - u * .06, y - 1, u * .12, 4); }
          const note = { matching: 'Finding the alert in Aiden', queued: 'Waiting for an investigator', running: 'Agents are gathering and checking evidence',
            unmatched: 'Aiden has no record of this alert', failed: 'The investigation did not complete', error: a.error || 'Aiden could not be reached' }[a.status] ?? a.status;
          text(ctx, fit(ctx, note.toUpperCase(), maxW, u * .036), left, y + u * .09, u * .036, DIM);
          text(ctx, fit(ctx, a.alert ?? '', maxW, u * .04), left, y - u * .05, u * .04, WHITE);
        }
        return;
      }

      if (q.kind === 'trace') {   // one request as a waterfall: a bar per span, nested by caller; critical path bright, failures red
        const us = q.us || 1;
        const dur = v => (v >= 1e6 ? `${+(v / 1e6).toFixed(2)} s` : v >= 1000 || !v ? `${Math.round(v / 1000)} ms` : `${Math.round(v)} µs`);
        headline();
        text(ctx, `${q.spanCount} SPANS · ${q.services?.length ?? 0} SERVICES`, u * .05, HY, u * .032, DIM);
        const foot = (q.failures?.length ? 2 : 1) * u * .045;
        const left = u * .05, right = w - u * .05, top = BODY, bottom = h * .97 - foot - u * .04;
        const labelW = Math.min((right - left) * .38, u * .8), x0 = left + labelW, x1 = right;
        // Rows small enough to read: on a small panel, keep the critical path and failures first, in tree order.
        const fitRows = Math.max(3, Math.floor((bottom - top) / (u * .036)));
        let spans = q.spans ?? [];
        if (spans.length > fitRows) {
          const keep = new Set(spans.filter(s => s.crit || s.err).slice(0, fitRows));
          for (const s of spans) if (keep.size < fitRows) keep.add(s);
          spans = spans.filter(s => keep.has(s));
        }
        const folded = (q.hidden ?? 0) + (q.spans?.length ?? 0) - spans.length;
        const rowH = Math.min(u * .06, (bottom - top) / Math.max(spans.length, 1)), fs = Math.min(rowH * .62, u * .03);
        const xOf = v => x0 + (v / us) * (x1 - x0);
        // Time axis: quarter marks across the top of the bars.
        ctx.strokeStyle = inkAt(.12); ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
          const x = xOf((us * i) / 4);
          ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + rowH * spans.length); ctx.stroke();
          if (i && i < 4 && (x1 - x0) > u * .5) text(ctx, dur((us * i) / 4), x, top - u * .008, u * .026, DIM, 'center');
        }
        spans.forEach((s, i) => {
          const y = top + rowH * i, c = s.err ? RED : s.crit ? WHITE : inkAt(.35);
          const bx = xOf(s.start), bwid = Math.max(2, xOf(s.start + s.dur) - bx);
          ctx.fillStyle = c; ctx.fillRect(bx, y + rowH * .2, bwid, Math.max(1.5, rowH * .6));
          if (fs >= 7) {
            const ind = Math.min(s.depth, 8) * fs * .7, name = `${s.service} ${s.op}`;
            text(ctx, fit(ctx, name, labelW - ind - u * .02, fs), left + ind, y + rowH * .72, fs, s.err ? RED : s.crit ? WHITE : DIM);
            const lbl = dur(s.dur), room = x1 - (bx + bwid);
            if (room > fs * 4) text(ctx, lbl, bx + bwid + fs * .4, y + rowH * .72, fs * .85, DIM);
            else if (bwid > fs * 4) text(ctx, lbl, bx + bwid - fs * .3, y + rowH * .72, fs * .85, DARK, 'right');
          }
        });
        if (folded > 0) text(ctx, `+${folded} MORE SPANS`, left, top + rowH * spans.length + u * .035, u * .026, DIM);
        // Hover: the span under the pointer, outlined: its service and operation in full, when it started, how long it
        // took and its share of the request, and why it failed.
        const spanAt = py => { const i = Math.floor((py - top) / rowH); return py >= top && i < spans.length ? i : -1; };
        if (Number.isFinite(d.hoverX) && d.hoverX >= left && d.hoverX <= right && spanAt(d.hoverY) >= 0) {
          ctx.strokeStyle = inkAt(.7); ctx.lineWidth = 1; ctx.strokeRect(left - 3.5, top + spanAt(d.hoverY) * rowH + .5, right - left + 7, rowH - 1);
        }
        d.tipAt = (px, py) => {
          const sp = spans[spanAt(py)];
          if (!sp || px < left || px > right) return null;
          const f = sp.err ? (q.failures ?? []).find(f => f.service === sp.service && f.op === sp.op) : null;
          return { title: `${sp.service}${sp.err ? ' · FAILED' : sp.crit ? ' · critical path' : ''}`,
            rows: [{ label: sp.op, hero: true, value: dur(sp.dur) }, { label: 'started at', value: `+${dur(sp.start)}` },
              { label: 'of the request', value: `${+(100 * sp.dur / us).toPrecision(2)}%` }], notes: f?.msg ? [f.msg] : [] };
        };
        // Where the time goes (the critical path by service), and the first failure.
        const fy = h * .97 - (q.failures?.length ? u * .045 : 0);
        text(ctx, fit(ctx, `CRITICAL PATH  ${(q.critical ?? []).map(c => `${c.service} ${c.display}`).join('  ·  ')}`, right - left, u * .03), left, fy, u * .03, WHITE);
        if (q.failures?.length) {
          const f = q.failures[0];
          text(ctx, fit(ctx, `✕ ${f.service} ${f.op}${f.msg ? ` — ${f.msg}` : ''}${q.failures.length > 1 ? `  (+${q.failures.length - 1})` : ''}`, right - left, u * .03), left, h * .97, u * .03, RED);
        }
        return;
      }

      if (q.kind === 'graph') {   // detailed trend: up to five series told apart by dash pattern, with axes and legend
        const lines = q.graph ?? [];
        headline();
        const all = lines.flatMap(l => l.points);
        if (all.length < 2) return;
        const t0 = Math.min(...all.map(p => p[0])), t1 = Math.max(...all.map(p => p[0])) || t0 + 1;
        const vals = all.map(p => p[1]), dlo = Math.min(0, ...vals), dhi = Math.max(...vals);
        const near = v => Number.isFinite(v) && v <= dhi * 1.6 + 1e-9 && v >= dlo;
        const hi = Math.max(dhi * 1.1, ...[q.warn, q.crit].filter(near)) || 1, lo = dlo, span = hi - lo || 1;
        const x0 = u * .16, x1 = w - u * .05, y0 = Math.max(h * .28, BODY), y1 = h * .8;
        const xOf = t => x0 + ((t - t0) / (t1 - t0 || 1)) * (x1 - x0), yOf = v => y1 - ((v - lo) / span) * (y1 - y0);
        ticks(ctx, x0, y0, x1, y1, 10);
        text(ctx, String(+hi.toPrecision(3)), x0 - u * .02, y0 + u * .015, u * .036, DIM, 'right');
        text(ctx, String(+((hi + lo) / 2).toPrecision(3)), x0 - u * .02, (y0 + y1) / 2 + u * .015, u * .036, DIM, 'right');
        text(ctx, String(+lo.toPrecision(3)), x0 - u * .02, y1, u * .036, DIM, 'right');
        timeAxis(x0, x1, y1 + u * .06, t0, t1);
        ctx.lineWidth = 1;
        for (const [v, c, name] of [[q.warn, CHIP, 'WARN'], [q.crit, RED, 'CRIT']]) {
          if (!near(v)) continue;
          ctx.strokeStyle = c; ctx.setLineDash([5, 5]);
          ctx.beginPath(); ctx.moveTo(x0, yOf(v)); ctx.lineTo(x1, yOf(v)); ctx.stroke();
          text(ctx, `${name} ${v}`, x1, yOf(v) - 4, u * .034, c, 'right');
        }
        if (q.since && q.since > t0 && q.since < t1) {
          ctx.strokeStyle = inkAt(.6); ctx.setLineDash([2, 4]);
          ctx.beginPath(); ctx.moveTo(xOf(q.since), y0); ctx.lineTo(xOf(q.since), y1); ctx.stroke();
        }
        drawMarks(ctx, (q.marks ?? []).filter(m => m.t > t0 && m.t < t1).map(m => ({ ...m, x: xOf(m.t) })),
          { left: x0, right: x1, top: y0, bottom: y1 }, u, d, ship?.state?.focusMark);   // changes during the window
        const DASHES = [[], [8, 4], [2, 4], [12, 3, 2, 3], [1, 7]];
        // Colours and dashes kept by the card across refreshes (public/inks.js keep); the first line, the one the headline
        // reads, is in the panel's ink.
        const leadIx = 0;
        const gLooks = keepLooks(d.code, lines.map(l => l.label), d.color, DASHES.length - 1);
        const gInk = i => (i === leadIx ? ink : gLooks[i].ink), gDash = i => DASHES[i === leadIx ? 0 : gLooks[i].dash + 1];
        lines.forEach((l, i) => {
          ctx.strokeStyle = gInk(i); ctx.lineWidth = i === leadIx ? 1.8 : 1.2; ctx.setLineDash(gDash(i));
          ctx.beginPath();
          const starts = breaksOf(l.points);
          l.points.forEach(([t, v], j) => (starts(j) ? ctx.moveTo(xOf(t), yOf(v)) : ctx.lineTo(xOf(t), yOf(v))));
          ctx.stroke();
        });
        ctx.setLineDash([]);
        // Hover: a crosshair at that moment with a dot on each line, and every line's value then, highest first.
        const step = Math.min(...lines.flatMap(l => l.points.slice(1).map(([t], j) => t - l.points[j][0])).filter(x => x > 0)) || (t1 - t0);
        const valueAt = (pts, t) => { let best = null; for (const p of pts) if (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p; return best && Math.abs(best[0] - t) <= step * 1.5 ? best[1] : null; };
        const timeAt = px => t0 + ((px - x0) / (x1 - x0 || 1)) * (t1 - t0);
        const fmtV = v => `${+(+v).toPrecision(3)}${q.unit === '%' ? '%' : q.unit ? ` ${q.unit}` : ''}`;
        const inPlot = (px, py) => px >= x0 && px <= x1 && py >= y0 - u * .04 && py <= y1 + u * .02;
        if (Number.isFinite(d.hoverX) && inPlot(d.hoverX, d.hoverY)) {
          const t = timeAt(d.hoverX);
          ctx.strokeStyle = inkAt(.7); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(d.hoverX, y0); ctx.lineTo(d.hoverX, y1); ctx.stroke(); ctx.setLineDash([]);
          lines.forEach((l, i) => { const v = valueAt(l.points, t); if (v === null) return; ctx.fillStyle = gInk(i); ctx.beginPath(); ctx.arc(d.hoverX, yOf(v), 3.5, 0, Math.PI * 2); ctx.fill(); });
        }
        d.tipAt = (px, py) => {
          if (!inPlot(px, py)) return null;
          const t = timeAt(px);
          const rows = lines.map((l, i) => ({ label: l.label, ink: gInk(i), hero: i === leadIx, v: valueAt(l.points, t) }))
            .sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity)).map(r => ({ label: r.label, ink: r.ink, hero: r.hero, value: r.v === null ? 'no data' : fmtV(r.v) }));
          return { title: `${clock(t)} · ${Math.round((Date.now() - t) / 60000)} min ago`, rows, notes: q.more > 0 ? [`${q.more} more series not shown`] : [] };
        };
        // Legend under the time axis: a stroke sample, the series name and its latest value.
        const cols = Math.min(lines.length, w > h * 1.4 ? 3 : 2), colW = (x1 - x0 + u * .11) / cols, ls = u * .036;
        lines.forEach((l, i) => {
          const x = u * .05 + (i % cols) * colW, y = h * .92 + Math.floor(i / cols) * ls * 1.5;
          ctx.strokeStyle = gInk(i); ctx.lineWidth = 1.4; ctx.setLineDash(gDash(i));
          ctx.beginPath(); ctx.moveTo(x, y - ls * .35); ctx.lineTo(x + u * .06, y - ls * .35); ctx.stroke(); ctx.setLineDash([]);
          text(ctx, fit(ctx, `${l.label} ${l.display}`, colW - u * .09, ls), x + u * .075, y, ls, WHITE);
        });
        return;
      }

      if (q.kind === 'state') {   // state timeline: one band per series, coloured by state, names written in
        const bands = q.bands ?? [];
        headline();
        if (!bands.length) return;
        const x0 = Math.min(w * .32, u * .5), x1 = w - u * .05, top = BODY, bottom = h * .84;
        const rowH = Math.min((bottom - top) / bands.length, u * .16), span = (q.end - q.start) || 1;
        const xOf = t => x0 + ((t - q.start) / span) * (x1 - x0);
        bands.forEach((b, i) => {
          const y = top + i * rowH, bh = rowH * .72;
          text(ctx, fit(ctx, b.label, x0 - u * .07, rowH * .34), u * .05, y + rowH * .5, rowH * .34, WHITE);
          b.segs.forEach((s, j) => {
            // A run lasts until a step past its last sample (the builder ends it there): gaps, and a series that stopped
            // reporting, stay empty instead of carrying the last state on to now.
            const xa = xOf(s.from), xb = Math.max(xa + 2, Math.min(x1, s.to ? xOf(s.to) : j === b.segs.length - 1 ? x1 : xOf(b.segs[j + 1].from)));
            ctx.fillStyle = STATE_FILL[s.status] ?? STATE_FILL.ok; ctx.fillRect(xa, y + rowH * .14, xb - xa, bh);
            const fs = rowH * .3;
            ctx.font = `400 ${fs}px ${FONT}`;
            if (ctx.measureText(s.name).width < xb - xa - 8)
              text(ctx, s.name, xa + 5, y + rowH * .14 + bh / 2 + fs * .35, fs, s.status === 'ok' ? WHITE : DARK, 'left');
          });
          ctx.strokeStyle = FAINT; ctx.lineWidth = 1; ctx.strokeRect(x0 + .5, y + rowH * .14 + .5, x1 - x0 - 1, bh - 1);
        });
        d.tipAt = (px, py) => {
          if (px < x0 || px > x1 || py < top || py > top + bands.length * rowH) return null;
          const b = bands[Math.floor((py - top) / rowH)], t = q.start + ((px - x0) / (x1 - x0)) * span;
          const seg = b?.segs.find(s => t >= s.from && t <= (s.to ?? s.from));
          return b ? { title: `${clock(t)} · ${Math.round((Date.now() - t) / 60000)} min ago`, rows: [{ label: b.label, hero: true, value: seg ? seg.name : 'no data' }], notes: [] } : null;
        };
        timeAxis(x0, x1, top + bands.length * rowH + u * .05, q.start, q.end);
        return;
      }

      if (q.kind === 'heatmap') {   // distribution over time: rows of cells, brighter = more
        const rows = q.rows ?? [];
        headline();
        if (!rows.length) { text(ctx, 'NO SAMPLES', w / 2, h * .58, u * .07, DIM, 'center'); return; }
        const order = q.lowFirst ? [...rows].reverse() : rows;   // buckets: low bounds at the bottom
        const x0 = Math.min(w * .26, u * .4), x1 = w - u * .05, top = BODY, bottom = h * .84;
        const n = Math.max(...rows.map(r => r.cells.length)), rowH = (bottom - top) / order.length, cw = (x1 - x0) / n;
        const max = Math.max(...rows.flatMap(r => r.cells)) || 1;
        order.forEach((r, i) => {
          const y = top + i * rowH;
          text(ctx, fit(ctx, r.label, x0 - u * .06, Math.min(rowH * .55, u * .04)), x0 - u * .02, y + rowH * .5 + Math.min(rowH * .55, u * .04) * .35,
            Math.min(rowH * .55, u * .04), DIM, 'right');
          r.cells.forEach((v, j) => {
            if (!(v > 0)) return;
            ctx.fillStyle = inkAt((.08 + .92 * Math.sqrt(v / max)).toFixed(3));   // sqrt: faint cells stay visible
            ctx.fillRect(x0 + j * cw + .5, y + .5, Math.max(1, cw - 1), Math.max(1, rowH - 1));
          });
        });
        ctx.strokeStyle = DIM; ctx.lineWidth = 1; ctx.strokeRect(x0, top, x1 - x0, bottom - top);
        // Hover: the cell under the pointer, outlined, and its own row, moment and value.
        const cellAt = (px, py) => {
          if (px < x0 || px >= x1 || py < top || py >= bottom) return null;
          const i = Math.floor((py - top) / rowH), j = Math.floor((px - x0) / cw);
          return order[i] && j < n ? { i, j, r: order[i], v: order[i].cells[j] } : null;
        };
        const hc = Number.isFinite(d.hoverX) ? cellAt(d.hoverX, d.hoverY) : null;
        if (hc) { ctx.strokeStyle = WHITE; ctx.lineWidth = 2; ctx.strokeRect(x0 + hc.j * cw + 1, top + hc.i * rowH + 1, Math.max(1, cw - 2), Math.max(1, rowH - 2)); }
        const cellUnit = q.cellUnit ?? q.unit ?? '';
        const show = v => (v === null || v === undefined ? 'no data' : `${+(+v).toPrecision(3)}${cellUnit === '%' ? '%' : cellUnit ? ` ${cellUnit}` : ''}`);
        d.tipAt = (px, py) => {
          const c = cellAt(px, py);
          if (!c) return null;
          const t = q.times?.[c.j];
          return { title: t ? `${clock(t)} · ${Math.round((Date.now() - t) / 60000)} min ago` : `${n - c.j} steps ago`,
            rows: [{ label: c.r.label, hero: true, value: show(c.v) }], notes: q.cellWord ? [q.cellWord] : [] };
        };
        text(ctx, `${q.window ?? 30} MIN`, (x0 + x1) / 2, bottom + u * .05, u * .038, DIM, 'center');
        text(ctx, 'NOW', x1, bottom + u * .05, u * .038, DIM, 'right');
        return;
      }

      if (q.kind === 'table') {   // label columns, then the value; worst first, with a chip for anything unhealthy
        const cols = q.columns ?? [], rows = q.rows ?? [];
        const top = Math.max(h * .26, head + u * .03), rowH = Math.min((h * .96 - top) / (rows.length + 1), u * .12), fs = rowH * .4;
        const valW = u * .22, labelW = (w - u * .1 - valW) / Math.max(1, cols.length - 1);
        const xs = cols.slice(0, -1).map((_, i) => u * .05 + i * labelW);
        cols.slice(0, -1).forEach((c, i) => text(ctx, fit(ctx, c.replace(/^k8s_|_name$/g, '').toUpperCase(), labelW - u * .03, fs * .85), xs[i], top + rowH * .6, fs * .85, DIM));
        text(ctx, cols.at(-1).toUpperCase(), w - u * .05, top + rowH * .6, fs * .85, DIM, 'right');
        ctx.strokeStyle = DIM; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(u * .05, top + rowH * .85); ctx.lineTo(w - u * .05, top + rowH * .85); ctx.stroke();
        rows.forEach((r, i) => {
          const y = top + (i + 1) * rowH + rowH * .6;
          if (i % 2) { ctx.fillStyle = inkAt(.05); ctx.fillRect(u * .05, y - rowH * .62, w - u * .1, rowH); }
          r.cells.forEach((c, j) => text(ctx, fit(ctx, c, labelW - u * .03, fs), xs[j], y, fs, WHITE));
          if (r.status === 'warn' || r.status === 'crit') {
            ctx.fillStyle = r.status === 'crit' ? RED : CHIP; ctx.fillRect(w - u * .05 - valW + u * .02, y - fs * .75, fs * .6, fs * .6);
          }
          text(ctx, r.display, w - u * .05, y, fs, STATUS_INK[r.status] ?? WHITE, 'right');
        });
        // Hover: the row under the pointer, outlined, and every column in full (cells are cut to fit).
        const rowAt = py => { const i = Math.floor((py - top - rowH * .85) / rowH); return py >= top + rowH * .85 && i < rows.length ? i : -1; };
        if (Number.isFinite(d.hoverX) && d.hoverX >= u * .05 && d.hoverX <= w - u * .05 && rowAt(d.hoverY) >= 0) {
          ctx.strokeStyle = inkAt(.7); ctx.lineWidth = 1; ctx.strokeRect(u * .05 - 3.5, top + rowH * .85 + rowAt(d.hoverY) * rowH + .5, w - u * .1 + 7, rowH - 1);
        }
        d.tipAt = (px, py) => {
          const r = rows[rowAt(py)];
          if (!r || px < u * .05 || px > w - u * .05) return null;
          return { title: `${q.title ?? d.title ?? ''}${r.status && r.status !== 'ok' ? ` · ${r.status.toUpperCase()}` : ''}`,
            rows: [{ label: cols.at(-1), hero: true, value: r.display }, ...r.cells.map((c, j) => ({ label: cols[j].replace(/^k8s_|_name$/g, ''), value: c }))], notes: [] };
        };
        return;
      }

      if (q.kind === 'bargauge') {   // one segmented gauge per series against the scale, thresholds marked
        const items = q.items ?? [], max = q.max || 1;
        headline();
        const top = BODY, rowH = Math.min((h * .96 - top) / Math.max(items.length, 1), u * .15), segs = 24;
        const x0 = u * .05, x1 = w - u * .05, sw = (x1 - x0) / segs;
        items.forEach((it, i) => {
          const y = top + i * rowH, fs = rowH * .3, by = y + rowH * .42, bh = rowH * .38;
          text(ctx, fit(ctx, it.label, (x1 - x0) * .7, fs), x0, y + fs, fs, WHITE);
          text(ctx, it.display, x1, y + fs, fs, STATUS_INK[it.status] ?? WHITE, 'right');
          for (let s = 0; s < segs; s++) {
            const at = ((s + .5) / segs) * max, lit = it.value >= (s / segs) * max + max / segs / 2;
            ctx.fillStyle = !lit ? FAINT
              : Number.isFinite(q.crit) && at > q.crit ? RED : Number.isFinite(q.warn) && at > q.warn ? CHIP : WHITE;
            ctx.fillRect(x0 + s * sw + 1, by, sw - 2, bh);
          }
          for (const [v, c] of [[q.warn, CHIP], [q.crit, RED]]) {
            if (!Number.isFinite(v) || v > max) continue;
            const x = x0 + (v / max) * (x1 - x0);
            ctx.fillStyle = c; ctx.fillRect(x - 1, by - bh * .3, 2, bh * 1.6);
          }
        });
        rowHover(items, top, rowH, x0, x1, it => it.display);
        return;
      }

      if (q.kind === 'histogram') {   // a distribution: hairline bars, bucket bounds beneath, p95 (or max) up top
        const b = q.buckets ?? [];
        text(ctx, `${q.stat ?? ''} ${q.display} ${q.unit && q.unit !== '%' && !/[0-9]m?s$/.test(q.display) ? q.unit : ''}`.trim(), w - u * .05, HY, u * .1, ink, 'right');
        if (q.p50 && q.stat === 'P95') text(ctx, `P50 ${q.p50}`, w - u * .05, HY + u * .07, u * .045, DIM, 'right');
        if (q.maxLabel) text(ctx, fit(ctx, q.maxLabel, w * .7, u * .045), w - u * .05, HY + u * .07, u * .045, DIM, 'right');   // which series the max is
        if (!b.length) { text(ctx, 'NO SAMPLES', w / 2, h * .58, u * .07, DIM, 'center'); return; }
        const x0 = u * .05, x1 = w - u * .05, y0 = Math.max(h * .3, BODY + u * .05), y1 = h * .84;
        const slot = (x1 - x0) / b.length, gap = Math.max(2, slot * .18), max = Math.max(...b.map(x => x.value)) || 1;
        ticks(ctx, x0, y0, x1, y1, 10);
        ctx.strokeStyle = inkAt(.35); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x0, y1); ctx.lineTo(x1, y1); ctx.stroke();
        const labelSize = Math.min(u * .042, slot * .3);
        b.forEach((bar, i) => {
          const x = x0 + i * slot + gap / 2, bw = slot - gap, bh = (bar.value / max) * (y1 - y0);
          ctx.fillStyle = inkAt(.12); ctx.fillRect(x, y1 - bh, bw, bh);
          ctx.strokeStyle = WHITE; ctx.lineWidth = 1.2; ctx.strokeRect(x + .5, y1 - bh + .5, bw - 1, Math.max(0, bh - 1));
          // Bounds beneath: every bar when they fit, otherwise every other one.
          if (b.length <= 6 || i % 2 === 0 || i === b.length - 1)
            text(ctx, bar.label, x + bw / 2, y1 + labelSize * 1.5, labelSize, DIM, 'center');
        });
        // Hover: the bar under the pointer (anywhere in its column), outlined, and what it holds: its range, how much of
        // the whole, how much at or below it, and the series it is made of.
        const barAt = px => { const i = Math.floor((px - x0) / slot); return px >= x0 && i < b.length ? i : -1; };
        const inPlot = (px, py) => px >= x0 && px <= x1 && py >= y0 - u * .04 && py <= y1 + labelSize * 2;
        if (Number.isFinite(d.hoverX) && inPlot(d.hoverX, d.hoverY) && barAt(d.hoverX) >= 0) {
          const i = barAt(d.hoverX);
          ctx.strokeStyle = inkAt(.7); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
          ctx.strokeRect(x0 + i * slot + 1.5, y0, slot - 3, y1 - y0); ctx.setLineDash([]);
        }
        const total = b.reduce((a, x) => a + x.value, 0) || 1;
        const num = v => `${+(+v).toPrecision(3)}`;
        d.tipAt = (px, py) => {
          if (!inPlot(px, py)) return null;
          const i = barAt(px), bar = b[i];
          if (!bar) return null;
          const upTo = b.slice(0, i + 1).reduce((a, x) => a + x.value, 0);
          const rows = [{ label: bar.range ?? bar.label, hero: true, value: `${num(bar.value)}${bar.word ? ` ${bar.word}` : ''}` },
            { label: 'share', value: `${+(100 * bar.value / total).toPrecision(2)}%` },
            { label: 'at or below', value: `${+(100 * upTo / total).toPrecision(3)}%` },
            ...(bar.members ?? []).map(m => ({ label: m.name, value: m.display }))];
          const notes = bar.membersMore ? [`and ${bar.membersMore} more`] : !bar.members?.length && bar.value ? ['this histogram was summed: no per-series names (keep a label, e.g. by (service, le), to see them)'] : [];
          return { title: q.title ?? d.title ?? '', rows, notes };
        };
        return;
      }

      // Situation board: why this panel is on screen, under the title.
      if (q.insight) text(ctx, fit(ctx, q.insight, w - u * .1, u * .055), w / 2, h * .2, u * .055, inkAt(.75), 'center');

      // Situation board: the most likely fix and what it takes, in a strip along the bottom; clicking it asks the 9000
      // to carry it out (a plan, when a tool can) or say how. H is the height left above it.
      d.fixHit = null;
      const H = q.fix ? h - u * .13 : h;
      if (q.fix) {
        const fh = u * .13, y = h - fh, fs = u * .045;
        ctx.fillStyle = `rgba(${SCRIM},.42)`; ctx.fillRect(0, y, w, fh);
        const label = q.fix.digging ? 'LOOKING' : { auto: 'AUTO', quick: 'QUICK', project: 'PROJECT', unknown: 'UNCLEAR' }[q.fix.effort] ?? 'FIX';
        ctx.font = `400 ${fs * .9}px ${FONT_WIDE}`;
        const cw = ctx.measureText(label).width + u * .04, cx = u * .04, cy = y + fh / 2;
        // AUTO solid white, QUICK indicator yellow, PROJECT outlined, INVESTIGATE dim: how close the fix is to done.
        if (q.fix.effort === 'auto' || q.fix.effort === 'quick') { ctx.fillStyle = q.fix.effort === 'auto' ? WHITE : CHIP; ctx.fillRect(cx, cy - fs * .8, cw, fs * 1.5); }
        else { ctx.strokeStyle = q.fix.effort === 'project' ? WHITE : DIM; ctx.lineWidth = 1; ctx.strokeRect(cx + .5, cy - fs * .8 + .5, cw - 1, fs * 1.5 - 1); }
        text(ctx, label, cx + cw / 2, cy + fs * .32, fs * .9, q.fix.effort === 'auto' || q.fix.effort === 'quick' ? CHIP_INK : q.fix.effort === 'project' ? WHITE : DIM, 'center', FONT_WIDE);
        const tx = cx + cw + u * .03;
        text(ctx, fit(ctx, `${q.fix.text} ›`, w - tx - u * .04, fs), tx, cy + fs * .35, fs, WHITE);
        d.fixHit = { x0: 0, x1: w, y0: y, y1: h, fix: q.fix };
      }

      // Big live value, with the unit beneath.
      const big = q.kind === 'timeseries' ? u * .2 : u * .3;
      const vy = q.kind === 'timeseries' ? H * .42 : H * .58;
      text(ctx, q.display, w / 2, vy, big, ink, 'center');
      if (q.unit && q.unit !== '%') text(ctx, q.unit.toUpperCase(), w / 2, vy + u * .1, u * .06, DIM, 'center');
      if (q.stat) text(ctx, q.stat, w / 2, vy - big * .85, u * .04, DIM, 'center');   // "MAX OF 6": the worst of several series

      // Trend over the window: each sample at its own time ([ms, value]; older data sends values only, spread evenly).
      const pts = q.points ?? (q.series ?? []).map((v, i, a) => [Date.now() - (a.length - 1 - i) * ((q.window ?? 30) * 60_000 / Math.max(1, a.length - 1)), v]);
      const s = pts.map(([, v]) => v);
      if (q.kind === 'timeseries' && s.length > 1) {
        // Scale to the data (with headroom). A threshold is drawn as a line only when it is near the data;
        // a far-off one is noted at the top edge, so the trend never flattens against a distant limit.
        const ydPts = (q.yesterday ?? []).length > 1 ? (Array.isArray(q.yesterday[0]) ? q.yesterday
          : q.yesterday.map((v, i, a) => [Date.now() - (a.length - 1 - i) * ((q.window ?? 30) * 60_000 / (a.length - 1)), v])) : [];
        const yd = ydPts.map(([, v]) => v);   // the same window yesterday, for comparison
        const span0 = (q.window ?? 30) * 60_000, xOfT = t => u * .05 + (1 - (Date.now() - t) / span0) * (w - u * .1);
        const step = pts.length > 1 ? Math.min(...pts.slice(1).map(([t], i) => t - pts[i][0]).filter(x => x > 0)) : span0;
        // A line through the points, broken where samples are missing (more than one and a half steps apart).
        const trace = list => { ctx.beginPath(); list.forEach(([t, v], i) => { const x = Math.max(u * .05, xOfT(t)), y = yOf(v); i && t - list[i - 1][0] <= step * 1.5 ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); };
        const dlo = Math.min(...s, ...yd), dhi = Math.max(...s, ...yd), dspan = dhi - dlo || Math.abs(dhi) || 1;
        const near = v => Number.isFinite(v) && v >= dlo - dspan && v <= dhi + dspan * 1.5;
        const marks = [q.warn, q.crit].filter(near);
        const lo = Math.min(dlo, ...marks), hi = Math.max(dhi + dspan * .15, ...marks), span = hi - lo || 1;
        const y0 = H * .62, y1 = H * .92;
        const yOf = v => y1 - ((v - lo) / span) * (y1 - y0);
        ticks(ctx, u * .05, y0, w - u * .05, y1, 10);
        ctx.setLineDash([5, 5]); ctx.lineWidth = 1;
        let far = 0;
        for (const [v, c, name] of [[q.warn, CHIP, 'WARN'], [q.crit, WHITE, 'CRIT']]) {
          if (!Number.isFinite(v)) continue;
          if (!near(v)) {   // out of range: label it at the top edge instead
            if (v > dhi) text(ctx, `${name} ${v} \u25B2`, w - u * .05, y0 - u * .02 - far++ * u * .045, u * .035, c, 'right');
            continue;
          }
          ctx.strokeStyle = c; ctx.beginPath(); ctx.moveTo(u * .05, yOf(v)); ctx.lineTo(w - u * .05, yOf(v)); ctx.stroke();
          text(ctx, `${name} ${v}`, w - u * .05, yOf(v) - 4, u * .035, c, 'right');
        }
        ctx.setLineDash([]);
        if (q.since && q.window) {   // when the alert started
          const frac = 1 - (Date.now() - q.since) / (q.window * 60_000);
          if (frac > 0 && frac < 1) {
            const x = u * .05 + frac * (w - u * .1);
            ctx.strokeStyle = inkAt(.6); ctx.setLineDash([2, 4]);
            ctx.beginPath(); ctx.moveTo(x, y0 - u * .02); ctx.lineTo(x, y1); ctx.stroke(); ctx.setLineDash([]);
            text(ctx, 'SINCE ' + clock(q.since), x + u * .01, y0 - u * .03, u * .04, DIM);
          }
        }
        if (yd.length) {   // yesterday: faint and dotted, under today's line
          ctx.strokeStyle = inkAt(.35); ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
          trace(ydPts.filter(([t]) => xOfT(t) >= u * .05 - 1));
          ctx.setLineDash([]);
          text(ctx, 'YESTERDAY ···', w - u * .05, H * .97, u * .035, DIM, 'right');
        }
        // Changes (rollouts, config) during the window.
        drawMarks(ctx, (q.marks ?? []).map(m => ({ ...m, x: u * .05 + (1 - (Date.now() - m.t) / ((q.window ?? 30) * 60_000)) * (w - u * .1) }))
          .filter(m => m.x > u * .05 && m.x < w - u * .05), { left: u * .05, right: w - u * .05, top: y0, bottom: y1 }, u, d, ship?.state?.focusMark);
        ctx.strokeStyle = ink; ctx.lineWidth = 1.5;
        trace(pts);
        // Hover: the sample nearest the pointer, and yesterday's at the same time of day.
        const nearest = (list, t) => list.reduce((a, b) => (Math.abs(b[0] - t) < Math.abs(a[0] - t) ? b : a), list[0]);
        const fmtV = v => `${+(+v).toPrecision(3)}${q.unit === '%' ? '%' : q.unit ? ` ${q.unit}` : ''}`;
        d.tipAt = (px, py) => {
          if (px < u * .05 || px > w - u * .05 || py < y0 - u * .04 || py > y1 + u * .02) return null;
          const t = Date.now() - (1 - (px - u * .05) / (w - u * .1)) * span0, [pt, pv] = nearest(pts, t);
          if (Math.abs(pt - t) > step * 1.5) return { title: `${clock(t)} · ${Math.round((Date.now() - t) / 60000)} min ago`, rows: [{ label: 'now', hero: true, value: 'no data' }], notes: [] };
          const y = ydPts.length ? nearest(ydPts, pt) : null;
          return { title: `${clock(pt)} · ${Math.round((Date.now() - pt) / 60000)} min ago`,
            rows: [{ label: q.stat ? 'worst series' : 'value', hero: true, value: fmtV(pv) }, ...(y && Math.abs(y[0] - pt) <= step * 1.5 ? [{ label: 'yesterday', value: fmtV(y[1]) }] : [])], notes: [] };
        };
        text(ctx, `${q.window ?? 30} MIN`, u * .05, H * .97, u * .045, DIM);
      }
    }
  }
  return d;
}
