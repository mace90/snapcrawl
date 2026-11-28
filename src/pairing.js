// Which action of a baseline screen an action of the same screen in another run is.
// Label and place are both remembered for every action (x, y: the centre of what was tapped),
// so a button can be recognised when one of the two changed:
//   same      same label, same place
//   moved     same label (or same id), another place
//   renamed   same place and type, another label (or same id, another label)
// Places are compared relative to the screen size, so runs on other devices still pair.
// List cells and links pair the same way, but never give a hint: in a list the content moves
// and changes on its own.

export const NEAR = { x: 0.06, y: 0.03 }; // share of the screen width / height, about 24 pt

const DEFAULT_SIZE = { w: 393, h: 852 };
const rel = (a, size) => ({ x: a.x / (size?.w || DEFAULT_SIZE.w), y: a.y / (size?.h || DEFAULT_SIZE.h) });
const isItem = (a) => a.tier === 'item' || /^(cell|link)$/i.test(a.type);

export function pairActions(cur, curSize, base, baseSize) {
  const pos = (a, size) => rel(a, size);
  const dist = (a, b) => {
    const p = pos(a, curSize);
    const q = pos(b, baseSize);
    return { dx: Math.abs(p.x - q.x), dy: Math.abs(p.y - q.y), d: Math.hypot(p.x - q.x, p.y - q.y) };
  };
  const near = (a, b) => {
    const { dx, dy } = dist(a, b);
    return dx <= NEAR.x && dy <= NEAR.y;
  };
  const free = new Set(base.map((_, i) => i));
  const pairs = [];
  const open = new Set(cur.map((_, i) => i));
  // the closest free baseline action that passes `fits`
  const take = (a, fits) => {
    let best = -1;
    let top = Infinity;
    for (const i of free) {
      if (!fits(base[i])) continue;
      const { d } = dist(a, base[i]);
      if (d < top) [best, top] = [i, d];
    }
    if (best < 0) return null;
    free.delete(best);
    return base[best];
  };
  const pass = (fits, kindOf) => {
    for (const i of [...open]) {
      const a = cur[i];
      const b = take(a, (x) => x.type === a.type && fits(a, x));
      if (!b) continue;
      open.delete(i);
      const kind = kindOf(a, b);
      pairs.push({ cur: a, base: b, kind, hint: kind !== 'same' && !isItem(a) });
    }
  };
  // 1 the same accessibility id, 2 the same label, 3 the same place
  pass((a, b) => !!a.id && a.id === b.id, (a, b) => (a.label !== b.label ? 'renamed' : near(a, b) ? 'same' : 'moved'));
  pass((a, b) => !!a.label && a.label === b.label, (a, b) => (near(a, b) ? 'same' : 'moved'));
  pass((a, b) => near(a, b) && !(a.id && b.id && a.id !== b.id), (a, b) => (a.label === b.label ? 'same' : 'renamed'));
  const added = [...open].map((i) => cur[i]);
  const removed = [...free].map((i) => base[i]);
  return { pairs, added, removed };
}

// What changed about the buttons of a screen, for the report: renamed, moved, removed.
// Points are the head run's points.
export function actionHints(cur, curSize, base, baseSize) {
  const { pairs, removed } = pairActions(cur || [], curSize, base || [], baseSize);
  const w = curSize?.w || DEFAULT_SIZE.w;
  const h = curSize?.h || DEFAULT_SIZE.h;
  const renamed = pairs.filter((p) => p.hint && p.kind === 'renamed').map((p) => ({ from: p.base.label, to: p.cur.label, type: p.cur.type }));
  const moved = pairs.filter((p) => p.hint && p.kind === 'moved').map((p) => {
    const q = rel(p.base, baseSize);
    return { label: p.cur.label, type: p.cur.type, dx: Math.round(p.cur.x - q.x * w), dy: Math.round(p.cur.y - q.y * h) };
  });
  const gone = removed.filter((a) => !isItem(a) && a.label).map((a) => a.label);
  return renamed.length || moved.length || gone.length ? { renamed, moved, removed: gone } : null;
}

// "120 pt down, 40 pt left"
export function describeMove({ dx, dy }) {
  const parts = [];
  if (Math.abs(dy) >= 1) parts.push(`${Math.abs(dy)} pt ${dy > 0 ? 'down' : 'up'}`);
  if (Math.abs(dx) >= 1) parts.push(`${Math.abs(dx)} pt ${dx > 0 ? 'right' : 'left'}`);
  return parts.join(', ') || 'in place';
}
