import assert from 'node:assert/strict';
import { test } from 'node:test';
import pngjs from 'pngjs';
import { hasScrollBar } from '../src/scrollbar.js';

const { PNG } = pngjs;

// a 393 × 852 pt screen at 3x, filled, with optional rectangles (in points)
function screen(bg, rects = []) {
  const w = 1179;
  const h = 2556;
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) p.data.set([...bg, 255], i * 4);
  for (const { x, y, w: rw, h: rh, c } of rects) for (let yy = y * 3; yy < (y + rh) * 3; yy++) for (let xx = x * 3; xx < (x + rw) * 3; xx++) p.data.set([...c, 255], (yy * w + xx) * 4);
  return p;
}
const LIGHT = [242, 242, 247];
const DARK = [0, 0, 0];

test('scroll bar: found light and dark, faint or not; content at the edge is not one', () => {
  assert.equal(hasScrollBar(screen(LIGHT), 393), false);
  assert.equal(hasScrollBar(screen(LIGHT, [{ x: 387, y: 120, w: 3, h: 300, c: [142, 142, 147] }]), 393), true, 'a light mode bar');
  assert.equal(hasScrollBar(screen(LIGHT, [{ x: 387, y: 120, w: 3, h: 300, c: [212, 212, 216] }]), 393), true, 'fading');
  assert.equal(hasScrollBar(screen(DARK, [{ x: 387, y: 120, w: 3, h: 300, c: [120, 120, 124] }]), 393), true, 'a dark mode bar');
  assert.equal(hasScrollBar(screen(LIGHT, [{ x: 387, y: 120, w: 3, h: 20, c: [142, 142, 147] }]), 393), false, 'too short');
  assert.equal(hasScrollBar(screen(LIGHT, [{ x: 0, y: 120, w: 393, h: 300, c: [90, 140, 200] }]), 393), false, 'a picture across the screen');
  assert.equal(hasScrollBar(screen(LIGHT, [{ x: 300, y: 120, w: 93, h: 300, c: [120, 120, 124] }]), 393), false, 'a gray panel at the edge');
  assert.equal(hasScrollBar(screen(LIGHT, [{ x: 20, y: 120, w: 3, h: 300, c: [142, 142, 147] }]), 393), false, 'a line elsewhere');
});
