import fs from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import pngjs from 'pngjs';
import { actionHints } from './pairing.js';
import { similarity } from './signature.js';

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

// statusBarRatio: status bar height / screen height (both in points). The mask is applied in
// image pixels, so it fits any screenshot scale (simulator 3x, real devices 2x or 3x).
export function comparePng(fileA, fileB, outFile, { threshold = 0.1, ignoreStatusBar = true, statusBarRatio } = {}) {
  const a = readPng(fileA);
  const b = readPng(fileB);
  if (a.width !== b.width || a.height !== b.height) {
    return { ratio: 1, boxes: [[0, 0, b.width, b.height]], width: b.width, height: b.height, sizeMismatch: true };
  }
  const { width: w, height: h } = a;
  const bData = Buffer.from(b.data);
  if (ignoreStatusBar) {
    const rows = Math.min(h, Math.round(h * (statusBarRatio > 0 && statusBarRatio < 0.25 ? statusBarRatio : 0.065))); // default ~ the iOS status bar
    a.data.copy(bData, 0, 0, rows * w * 4);
  }
  const out = new PNG({ width: w, height: h });
  const changed = pixelmatch(a.data, bData, out.data, w, h, { threshold, includeAA: false, alpha: 0.15, diffColor: [255, 0, 0], aaColor: [255, 255, 0] });
  fs.writeFileSync(outFile, PNG.sync.write(out));
  return { ratio: changed / (w * h), boxes: changed ? boxesFrom(out.data, w, h) : [], width: w, height: h };
}

// Screens are matched across runs by the baseline screen a run that followed the baseline
// recorded (s.base), then by the path of taps that reached them (stable across visual
// changes), then by structural fingerprint, then by signature similarity.
// One-time screens (onboarding) are compared only when both runs have them.
// Measured status bar of either run (real devices report it), as a share of the screen height.
function statusBarRatio(pairs) {
  const ratios = pairs.map(([run, s]) => (run?.meta.device?.statusBar && s?.size?.h ? run.meta.device.statusBar / s.size.h : 0));
  return Math.max(...ratios) || undefined;
}

const pathKey = (s) => s.path.map((r) => `${r.type}:${r.id || r.label}`).join(' > ');

export function buildReport({ store, baseId, headId, cfg }) {
  const base = store.readRun(baseId);
  const head = store.readRun(headId);
  const outDir = store.diffDir(baseId, headId);
  fs.mkdirSync(outDir, { recursive: true });

  const threshold = cfg.crawl?.matchThreshold ?? 0.8;
  const baseByKey = new Map(base.screens.filter((s) => !s.oneTime).map((s) => [pathKey(s), s]));
  const baseByFp = new Map(base.screens.filter((s) => !s.crash).map((s) => [s.fp, s]));
  const similar = (h) => {
    let best = null;
    let top = threshold;
    for (const b of base.screens) {
      if (b.crash || used.has(b.id) || !b.sig || !h.sig) continue;
      const v = similarity(h.sig, b.sig);
      if (v >= top) [best, top] = [b, v];
    }
    return best;
  };
  const used = new Set();
  const screens = [];
  const idMap = new Map(); // head screen id -> report id
  const baseIdMap = new Map(); // base screen id -> report id

  const img = (run, s) => (s?.screenshot ? `runs/${run}/${s.screenshot}` : null);

  // a run that followed this baseline knows for each screen which baseline screen it is
  const followed = head.meta.followed === baseId;
  const baseById = new Map(base.screens.map((s) => [s.id, s]));
  const pairsOf = []; // [head screen, base screen, report entry] for the button hints

  for (const h of head.screens) {
    let b = followed && h.base ? baseById.get(h.base) || null : null;
    if (!b || used.has(b.id)) b = h.oneTime ? null : baseByKey.get(pathKey(h));
    if (!b || used.has(b.id)) b = h.crash ? null : baseByFp.get(h.fp);
    if (b && used.has(b.id)) b = null;
    if (!b && !h.crash) b = similar(h);
    if (b) used.add(b.id);

    const entry = { id: h.id, name: h.name, depth: h.depth, path: h.path.map((r) => r.label || r.type), elements: h.elements, baseImg: img(baseId, b), headImg: img(headId, h), diffImg: null, ratio: null, boxes: [], size: null };
    if (h.oneTime || b?.oneTime) entry.oneTime = true;
    if (h.crash) {
      Object.assign(entry, { status: 'bad', reason: 'crash', name: b ? b.name : 'Crash' });
    } else if (!b && h.oneTime) {
      Object.assign(entry, { status: 'skipped', reason: 'one-time (skipped)' });
    } else if (!b) {
      Object.assign(entry, { status: 'new' });
    } else if (b.crash) {
      Object.assign(entry, { status: 'new', reason: 'was a crash in baseline' });
    } else {
      const file = `${h.id}.png`;
      const r = comparePng(path.join(store.runDir(baseId), b.screenshot), path.join(store.runDir(headId), h.screenshot), path.join(outDir, file), { ...cfg.diff, statusBarRatio: statusBarRatio([[base, b], [head, h]]) });
      const changed = r.ratio >= cfg.diff.minChangedRatio;
      Object.assign(entry, { status: changed ? 'changed' : 'same', ratio: r.ratio, boxes: changed ? r.boxes : [], size: [r.width, r.height], diffImg: `diffs/${baseId}__${headId}/${file}`, sizeMismatch: !!r.sizeMismatch });
    }
    if (b && !h.crash && !b.crash) pairsOf.push([h, b, entry]);
    idMap.set(h.id, entry.id);
    if (b) baseIdMap.set(b.id, entry.id);
    screens.push(entry);
  }

  for (const b of base.screens) {
    if (used.has(b.id) || b.crash) continue;
    const id = `base-${b.id}`;
    baseIdMap.set(b.id, id);
    const gone = b.oneTime ? { status: 'skipped', reason: 'one-time (skipped)', oneTime: true } : { status: 'bad', reason: 'unreachable' };
    screens.push({ id, name: b.name, depth: b.depth, path: b.path.map((r) => r.label || r.type), elements: b.elements, ...gone, baseImg: img(baseId, b), headImg: null, diffImg: null, ratio: null, boxes: [], size: null });
  }

  // Buttons renamed, moved or removed, from the label and the place of every action. For a
  // renamed or moved button: does it still lead to the screen its old self led to?
  const target = (run, from, label) => run.edges.find((e) => e.from === from && e.action?.label === label)?.to;
  for (const [h, b, entry] of pairsOf) {
    const hints = actionHints(h.actions, h.size, b.actions, b.size);
    if (!hints) continue;
    const leads = (newLabel, oldLabel) => {
      const ht = target(head, h.id, newLabel);
      const bt = target(base, b.id, oldLabel);
      return ht && bt ? (idMap.get(ht) && idMap.get(ht) === baseIdMap.get(bt)) : null; // null: not known
    };
    for (const r of hints.renamed) r.same = leads(r.to, r.from);
    for (const m of hints.moved) m.same = leads(m.label, m.label);
    entry.hints = hints;
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
    summary: { screens: screens.length, same: count('same'), changed: count('changed'), new: count('new'), bad: count('bad'), skipped: count('skipped') },
    screens,
    edges,
    review: previous?.review || {},
    notes: previous?.notes || {},
  };
  store.writeReport(report);
  return report;
}
