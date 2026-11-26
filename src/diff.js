import fs from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const CELL = 16;

const readPng = (file) => PNG.sync.read(fs.readFileSync(file));

// Group changed pixels into rectangles: mark 16px cells, then merge touching cells.
function boxesFrom(diff, w, h) {
  const cols = Math.ceil(w / CELL);
  const rows = Math.ceil(h / CELL);
  const grid = new Uint8Array(cols * rows);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (diff[i] === 255 && diff[i + 1] === 0 && diff[i + 2] === 0) grid[Math.floor(y / CELL) * cols + Math.floor(x / CELL)] = 1;
    }
  }
  const boxes = [];
  for (let start = 0; start < grid.length; start++) {
    if (grid[start] !== 1) continue;
    let [x0, y0, x1, y1] = [cols, rows, -1, -1];
    const stack = [start];
    grid[start] = 2;
    while (stack.length) {
      const k = stack.pop();
      const cx = k % cols;
      const cy = Math.floor(k / cols);
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const n = ny * cols + nx;
          if (grid[n] === 1) {
            grid[n] = 2;
            stack.push(n);
          }
        }
      }
    }
    boxes.push([x0 * CELL, y0 * CELL, Math.min(w, (x1 + 1) * CELL) - x0 * CELL, Math.min(h, (y1 + 1) * CELL) - y0 * CELL]);
  }
  return boxes.sort((a, b) => b[2] * b[3] - a[2] * a[3]).slice(0, 12);
}

export function comparePng(fileA, fileB, outFile, { threshold = 0.1, ignoreStatusBar = true } = {}) {
  const a = readPng(fileA);
  const b = readPng(fileB);
  if (a.width !== b.width || a.height !== b.height) {
    return { ratio: 1, boxes: [[0, 0, b.width, b.height]], width: b.width, height: b.height, sizeMismatch: true };
  }
  const { width: w, height: h } = a;
  const bData = Buffer.from(b.data);
  if (ignoreStatusBar) {
    const rows = Math.round(h * 0.065); // ~ the iOS status bar
    a.data.copy(bData, 0, 0, rows * w * 4);
  }
  const out = new PNG({ width: w, height: h });
  const changed = pixelmatch(a.data, bData, out.data, w, h, { threshold, includeAA: false, alpha: 0.15, diffColor: [255, 0, 0], aaColor: [255, 255, 0] });
  fs.writeFileSync(outFile, PNG.sync.write(out));
  return { ratio: changed / (w * h), boxes: changed ? boxesFrom(out.data, w, h) : [], width: w, height: h };
}

// Screens are matched across runs by the path of taps that reached them (stable across
// visual changes), then by structural fingerprint.
const pathKey = (s) => s.path.map((r) => `${r.type}:${r.id || r.label}`).join(' > ');

export function buildReport({ store, baseId, headId, cfg }) {
  const base = store.readRun(baseId);
  const head = store.readRun(headId);
  const outDir = store.diffDir(baseId, headId);
  fs.mkdirSync(outDir, { recursive: true });

  const baseByKey = new Map(base.screens.map((s) => [pathKey(s), s]));
  const baseByFp = new Map(base.screens.filter((s) => !s.crash).map((s) => [s.fp, s]));
  const used = new Set();
  const screens = [];
  const idMap = new Map(); // head screen id -> report id
  const baseIdMap = new Map(); // base screen id -> report id

  const img = (run, s) => (s?.screenshot ? `runs/${run}/${s.screenshot}` : null);

  for (const h of head.screens) {
    let b = baseByKey.get(pathKey(h));
    if (!b || used.has(b.id)) b = h.crash ? null : baseByFp.get(h.fp);
    if (b && used.has(b.id)) b = null;
    if (b) used.add(b.id);

    const entry = { id: h.id, name: h.name, depth: h.depth, path: h.path.map((r) => r.label || r.type), elements: h.elements, baseImg: img(baseId, b), headImg: img(headId, h), diffImg: null, ratio: null, boxes: [], size: null };
    if (h.crash) {
      Object.assign(entry, { status: 'bad', reason: 'crash', name: b ? b.name : 'Crash' });
    } else if (!b) {
      Object.assign(entry, { status: 'new' });
    } else if (b.crash) {
      Object.assign(entry, { status: 'new', reason: 'was a crash in baseline' });
    } else {
      const file = `${h.id}.png`;
      const r = comparePng(path.join(store.runDir(baseId), b.screenshot), path.join(store.runDir(headId), h.screenshot), path.join(outDir, file), cfg.diff);
      const changed = r.ratio >= cfg.diff.minChangedRatio;
      Object.assign(entry, { status: changed ? 'changed' : 'same', ratio: r.ratio, boxes: changed ? r.boxes : [], size: [r.width, r.height], diffImg: `diffs/${baseId}__${headId}/${file}`, sizeMismatch: !!r.sizeMismatch });
    }
    idMap.set(h.id, entry.id);
    if (b) baseIdMap.set(b.id, entry.id);
    screens.push(entry);
  }

  for (const b of base.screens) {
    if (used.has(b.id) || b.crash) continue;
    const id = `base-${b.id}`;
    baseIdMap.set(b.id, id);
    screens.push({ id, name: b.name, depth: b.depth, path: b.path.map((r) => r.label || r.type), elements: b.elements, status: 'bad', reason: 'unreachable', baseImg: img(baseId, b), headImg: null, diffImg: null, ratio: null, boxes: [], size: null });
  }

  const edges = [];
  const seen = new Set();
  const add = (from, to, label) => {
    const k = `${from}>${to}`;
    if (from && to && !seen.has(k)) {
      seen.add(k);
      edges.push({ from, to, label });
    }
  };
  for (const e of head.edges) add(idMap.get(e.from), idMap.get(e.to), e.label);
  for (const e of base.edges) add(baseIdMap.get(e.from), baseIdMap.get(e.to), e.label);

  const previous = store.readReport(baseId, headId);
  const count = (st) => screens.filter((s) => s.status === st).length;
  const report = {
    version: 1,
    created: new Date().toISOString(),
    base: { id: baseId, label: base.meta.label, device: base.meta.device?.name || '' },
    head: { id: headId, label: head.meta.label, device: head.meta.device?.name || '' },
    app: head.meta.app,
    appName: head.meta.appName || '',
    summary: { screens: screens.length, same: count('same'), changed: count('changed'), new: count('new'), bad: count('bad') },
    screens,
    edges,
    review: previous?.review || {},
    notes: previous?.notes || {},
  };
  store.writeReport(report);
  return report;
}
