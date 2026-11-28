import fs from 'node:fs';
import pngjs from 'pngjs';

const { PNG } = pngjs;

// Is a scroll bar showing? iOS shows a list's scroll bar for a moment when the list appears
// and again when it grows; whether a screenshot catches it depends on timing, so the same screen
// would differ between runs. The bar: a gray, 2–4 pt wide, at least 36 pt long vertical stripe
// 1–8 pt from the right edge, unlike what is just left of it, on light and dark backgrounds.
// pointsWide: the screen width in points (for the scale).
export function hasScrollBar(png, pointsWide) {
  const { width: w, height: h, data } = png;
  const k = pointsWide > 0 ? w / pointsWide : 3;
  const lum = (x, y) => {
    const i = (y * w + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  const gray = (x, y) => {
    const i = (y * w + x) * 4;
    return Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) < 14;
  };
  const top = Math.round(h * 0.07); // below the status bar
  const need = Math.round(36 * k);
  for (let pt = 1.5; pt <= 8; pt += 0.5) {
    const x = Math.round(w - pt * k);
    const left = Math.round(x - 4 * k); // beside the bar (it is at most 4 pt wide)
    if (left < 0) continue;
    let run = 0;
    for (let y = top; y < h; y++) {
      // the bar's column differs from beside it, while just right of it looks like the bar
      const d = Math.abs(lum(x, y) - lum(left, y));
      const near = Math.abs(lum(x, y) - lum(Math.min(w - 1, x + Math.round(0.5 * k)), y)) < 20;
      if (d > 22 && gray(x, y) && near) {
        if (++run >= need) return true;
      } else run = 0;
    }
  }
  return false;
}

export const fileHasScrollBar = (file, pointsWide) => hasScrollBar(PNG.sync.read(fs.readFileSync(file)), pointsWide);
