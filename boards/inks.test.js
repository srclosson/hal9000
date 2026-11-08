// Series colours (public/inks.js): node --test boards/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PALETTE, PALETTE_ON_LIGHT, assign, keep, contrast, fits, hue, MIN_CONTRAST } from '../public/inks.js';

// The board's panel backgrounds: the field tokens displays.js uses, as base.css sets them, so a new one is tested too.
const read = f => fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const BOARD = [...read('displays.js').match(/BOARD_COLORS = \[(.*)\]\.map/)[1].matchAll(/'(--field-[a-z]+)'/g)]
  .map(([, name]) => read('base.css').match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))[1]);

test('no line colour can be mistaken for an alarm: no reds, oranges or yellows', () => {
  for (const c of PALETTE) { const h = hue(c); assert.ok(h > 70 && h < 335, `${c} hue ${h}`); }
});

test('no two palette colours share a hue, so lines on one panel never look alike', () => {
  for (const a of PALETTE) for (const b of PALETTE) {
    if (a === b) continue;
    const d = Math.abs(hue(a) - hue(b)) % 360;
    assert.ok(Math.min(d, 360 - d) >= 25, `${a} and ${b} are only ${Math.round(Math.min(d, 360 - d))}° apart`);
  }
});

test('on every board background, every colour given passes contrast and stands apart from the background', () => {
  const keys = Array.from({ length: 12 }, (_, i) => `/api/v1/route-${i}`);
  for (const bg of BOARD) {
    const usable = PALETTE.filter(c => fits(c, bg));
    assert.ok(usable.length >= 4, `${bg} keeps only ${usable.length} colours`);
    for (const c of assign(keys, bg)) assert.ok(contrast(c, bg) >= MIN_CONTRAST && fits(c, bg), `${c} on ${bg}`);
  }
});

test('different values get different colours while the palette lasts; the same value repeats its colour', () => {
  for (const bg of BOARD) {
    const n = PALETTE.filter(c => fits(c, bg)).length;
    const keys = ['commands', 'gateway', 'hardware', 'systems', 'postgres', 'eye'].slice(0, n);
    const inks = assign([...keys, 'gateway'], bg);
    assert.equal(new Set(inks.slice(0, keys.length)).size, keys.length, bg);
    assert.equal(inks.at(-1), inks[1], 'a shifted copy of gateway is gateway\'s colour');
  }
});

test('a value keeps its colour across panels, monitors and orderings when nothing clashes', () => {
  const bg = '#18204a', values = ['/api/v1/commands', '/api/v1/systems', '/api/v1/devices', 'gateway', 'hardware', 'postgres'];
  const own = v => assign([v], bg)[0];   // a value's colour on its own
  let pairs = 0;
  for (const x of values) for (const y of values) {
    if (x === y || own(x) === own(y)) continue;   // same first choice: whichever comes second moves (a clash)
    pairs++;
    assert.deepEqual(assign([x, y], bg), [own(x), own(y)]);
    assert.deepEqual(assign([y, x], bg), [own(y), own(x)]);
  }
  assert.ok(pairs > 10);
});

// A card keeps how it drew each line: refreshes re-sort lines by value, lines come and go, the card changes slot.
test('a card keeps each line\'s colour and dash however the lines are re-sorted', () => {
  const bg = BOARD[0], first = keep('K1', ['a', 'b', 'c', 'd'], bg, 4);
  const again = keep('K1', ['d', 'b', 'a', 'c'], bg, 4);
  const by = (keys, looks) => Object.fromEntries(keys.map((k, i) => [k, looks[i]]));
  assert.deepEqual(by(['d', 'b', 'a', 'c'], again), by(['a', 'b', 'c', 'd'], first));
  assert.equal(new Set(first.map(l => l.ink)).size, 4, 'distinct colours');
  assert.equal(new Set(first.map(l => l.dash)).size, 4, 'distinct dashes');
});

test('a newcomer never takes a colour or dash from a line the card already shows; a line that left keeps its own', () => {
  const bg = BOARD[0];
  const [a, b] = keep('K2', ['a', 'b'], bg, 4);
  const [n, b2, a2] = keep('K2', ['new', 'b', 'a'], bg, 4);
  assert.deepEqual([a2, b2], [a, b]);
  assert.ok(![a.ink, b.ink].includes(n.ink) && ![a.dash, b.dash].includes(n.dash));
  keep('K2', ['new'], bg, 4);   // a and b drop out for a refresh
  assert.deepEqual(keep('K2', ['a', 'new'], bg, 4)[0], a, 'a comes back as it was');
});

test('a remembered colour gives way only when the card\'s new background does not suit it', () => {
  for (const bg of BOARD) {
    const [x] = keep(`K3${bg}`, ['x'], '#000000', 4), [y] = keep(`K3${bg}`, ['x'], bg, 4);
    assert.ok(fits(y.ink, bg));
    if (fits(x.ink, bg)) assert.equal(y.ink, x.ink);
  }
});

test('the light set (the dashboard\'s white panels): no alarm hues, no two alike, every colour readable on white', () => {
  for (const c of PALETTE_ON_LIGHT) {
    const h = hue(c);
    assert.ok(h > 70 && h < 335, `${c} hue ${h}`);
    assert.ok(fits(c, '#ffffff'), `${c} on white: contrast ${contrast(c, '#ffffff').toFixed(2)}`);
  }
  for (const a of PALETTE_ON_LIGHT) for (const b of PALETTE_ON_LIGHT) {
    if (a === b) continue;
    const d = Math.abs(hue(a) - hue(b)) % 360;
    assert.ok(Math.min(d, 360 - d) >= 25, `${a} and ${b} too alike`);
  }
});
