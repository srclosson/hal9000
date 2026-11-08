// Series colours (spec 2.0): when a panel draws several lines, each gets its own colour, so a split reads at a glance.
//   - The hero line stays white (or its health ink): still the brightest thing on the panel.
//   - Red and amber are never used: they mean crit and caution on this ship.
//   - Every colour is checked against the panel's own background: at least 3:1 contrast (the usual bar for lines in a
//     chart) and a clearly different hue, so a pale blue never disappears into a blue panel.
//   - A value keeps its colour everywhere it can: the first choice comes from the value itself (/api/v1/commands is the
//     same colour on every panel and monitor); only a clash with the background, or with a line already on the panel,
//     moves it to the next.
//   - Dashes stay as a second cue (displays.js), for colour-blind eyes and screenshots.

// Light tints, one per hue, spread round the circle (lime 86°, mint 137°, aqua 175°, sky 204°, lavender 255°, orchid
// 287°, pink 330°), skipping red, orange and yellow. Every pair is at least 29° apart, so two lines never share a hue.
export const PALETTE = ['#a8dcff', '#ffb8dc', '#a8f0bc', '#cdbcff', '#8eeee6', '#f0b8ff', '#d2f5a3'];
// For a UI with light panels (the dashboard): deep tones of the same idea, every one at least 3:1 on white.
export const PALETTE_ON_LIGHT = ['#4d7c0f', '#2e7d32', '#00796b', '#1d6fb8', '#4338ca', '#7e22ce', '#a3127a'];
export const PALETTES = { dark: PALETTE, light: PALETTE_ON_LIGHT };
export const MIN_CONTRAST = 3;
// The set in use, and the colour a line falls back to when none fits (the panel's own ink). displays.js sets them
// from the page's tokens (--panel-series, --panel-ink).
let palette = PALETTE, fallback = '#f4f4f4';
export function usePalette(name, ink) { palette = PALETTES[name] ?? PALETTE; if (/^#[0-9a-f]{6}$/i.test(ink ?? '')) fallback = ink; }
const MIN_HUE_GAP = 35;   // degrees between a line's hue and its background's

const rgb = hex => { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.replace(/./g, c => c + c) : h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lum = hex => { const [r, g, b] = rgb(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
// WCAG contrast ratio, 1..21.
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export function hue(hex) {
  const [r, g, b] = rgb(hex).map(v => v / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return null;   // grey: no hue
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const hueGap = (a, b) => { const x = hue(a), y = hue(b); if (x === null || y === null) return 180; const d = Math.abs(x - y) % 360; return Math.min(d, 360 - d); };
export const fits = (ink, bg) => contrast(ink, bg) >= MIN_CONTRAST && hueGap(ink, bg) >= MIN_HUE_GAP;

// A small, stable hash: the same value, the same first choice, on every monitor.
function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

// Colours for the lines of one panel, in order: keys (each line's value; repeats share a colour, e.g. today and a
// shifted copy of the same series) -> colours, never the same twice for different keys while the palette lasts.
export function assign(keys, bg = '#000000') {
  const usable = palette.filter(c => fits(c, bg));
  const pool = usable.length ? usable : [fallback];
  const given = new Map(), taken = new Set();
  return keys.map(k => {
    const key = String(k ?? '');
    if (given.has(key)) return given.get(key);
    const start = hash(key) % pool.length;
    let pick = pool[start];
    for (let i = 0; i < pool.length; i++) { const c = pool[(start + i) % pool.length]; if (!taken.has(c)) { pick = c; break; } }
    taken.add(pick); given.set(key, pick);
    return pick;
  });
}

// A card remembers how it drew each line, for as long as it is up: a refresh re-sorts the lines by their latest value,
// a line appears or drops out, HAL reworks the query, or the card moves to a slot with another background, and still
// every line keeps its colour and dash. A remembered colour gives
// way only when it no longer suits the background; a new line takes what is free. card: any stable id (board + code).
const cards = new Map();   // card -> { lines: Map(key -> { ink, dash, at }) }
const KEEP_LINES = 40;
// -> one { ink, dash } per key, in order (dash: an index into the caller's dash patterns, of which there are dashes).
export function keep(card, keys, bg = '#000000', dashes = 4) {
  if (!cards.has(card)) cards.set(card, { lines: new Map() });
  const memo = cards.get(card).lines, now = Date.now();
  const usable = palette.filter(c => fits(c, bg)), pool = usable.length ? usable : [fallback];
  const distinct = [...new Set(keys.map(k => String(k ?? '')))];
  const inks = new Set(), dashesTaken = new Set(), out = new Map();
  // First the lines the card already knows, so a newcomer can never take a colour from one of them.
  for (const k of distinct) {
    const m = memo.get(k);
    if (!m) continue;
    const ink = pool.includes(m.ink) && !inks.has(m.ink) ? m.ink : null;
    const dash = !dashesTaken.has(m.dash) ? m.dash : null;
    if (ink) inks.add(ink);
    if (dash !== null) dashesTaken.add(dash);
    out.set(k, { ink, dash });
  }
  for (const k of distinct) {
    const got = out.get(k) ?? { ink: null, dash: null };
    if (!got.ink) {
      const start = hash(k) % pool.length;
      got.ink = pool[start];
      for (let i = 0; i < pool.length; i++) { const c = pool[(start + i) % pool.length]; if (!inks.has(c)) { got.ink = c; break; } }
      inks.add(got.ink);
    }
    if (got.dash === null) {
      got.dash = [...Array(dashes).keys()].find(i => !dashesTaken.has(i)) ?? distinct.indexOf(k) % dashes;
      dashesTaken.add(got.dash);
    }
    out.set(k, got);
    memo.set(k, { ...got, at: now });
  }
  if (memo.size > KEEP_LINES) for (const [k] of [...memo].sort((a, b) => a[1].at - b[1].at).slice(0, memo.size - KEEP_LINES)) memo.delete(k);
  return keys.map(k => out.get(String(k ?? '')));
}

// '#a8dcff' at some opacity, for faint (comparison) lines and areas.
export const alpha = (hex, a) => { const [r, g, b] = rgb(hex); return `rgba(${r},${g},${b},${a})`; };
