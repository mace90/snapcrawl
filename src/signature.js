// Screen identity beyond the exact fingerprint: a weighted set of the parts of a screen that
// stay put between visits (title, selected tab, buttons, toolbar, layout), while the content
// that changes (feed texts in cells, numbers, dates, ads, web content) counts little or not at all.

const norm = (s) => String(s ?? '').toLowerCase().replace(/[’‘`´]/g, "'").replace(/\d+([.,:]\d+)*/g, '#').replace(/\s+/g, ' ').trim();
const INTERACTIVE = /^(button|link|tab|tabbarbutton|segmentedcontrol|switch|toggle|slider|stepper|picker|textfield|securetextfield|searchfield|textview|menuitem|checkbox)$/i;
const CONTAINER = /^(application|window|other|webview|group|layoutarea|scrollview|collectionview|table|tableview|toolbar|tabbar)$/i;
const DATE = /\b(jan|feb|mär|mar|apr|mai|may|jun|jul|aug|sep|okt|oct|nov|dez|dec)[a-zä]*\b|\b(vor|ago|std|min|sek|sec|hrs?|today|heute|gestern|yesterday)\b|#:#/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i; // generated ids change per launch

const wordy = (t) => {
  const letters = (t.match(/\p{L}/gu) || []).length;
  return letters >= 3 && letters / t.length >= 0.5;
};
const bucket = (n) => (n <= 3 ? String(n) : n <= 7 ? '4-7' : n <= 15 ? '8-15' : '16+');

export const titleOf = (els) => {
  const nav = els.find((e) => !e.web && /navigationbar/i.test(e.type) && (e.label || e.id));
  return nav ? norm(nav.label || nav.id) : '';
};

export function signature(els) {
  const own = els.filter((e) => !e.web);
  const tab = own.find((e) => e.tab && e.selected && e.label);
  const cells = own.filter((e) => /^cell$/i.test(e.type) && e.w > 0 && e.h > 0);
  // inside a list cell: from the tree (WDA) or, without one (simulator), from the frames
  const inCell = (e) => e.cell || cells.some((c) => c !== e && e.x >= c.x - 0.5 && e.y >= c.y - 0.5 && e.x + e.w <= c.x + c.w + 0.5 && e.y + e.h <= c.y + c.h + 0.5);
  const parts = {};
  const add = (k, w) => {
    if (w > 0) parts[k] = Math.max(parts[k] || 0, w);
  };
  const title = titleOf(els);
  if (title) add('title:' + title, 2);
  if (tab) add('tab:' + norm(tab.label), 2);
  const counts = {};
  for (const e of own) {
    const type = String(e.type);
    counts[type] = (counts[type] || 0) + 1;
    if (/navigationbar/i.test(type) || CONTAINER.test(type)) continue;
    const id = e.id && !UUID.test(e.id) ? e.id : '';
    const key = id || norm(e.label);
    if (/^cell$/i.test(type)) {
      if (id) add(`Cell:${id}`, 0.5); // a cell's own label is its content
    } else if (INTERACTIVE.test(type)) {
      add(`${type}:${key}`, inCell(e) ? 0.2 : key ? 1 : 0.5);
    } else if (/^(statictext|heading|header)$/i.test(type)) {
      const t = norm(e.label);
      if (!inCell(e) && wordy(t) && !DATE.test(t)) add(`t:${t.slice(0, 40)}`, 1);
    } else if (id && !inCell(e)) add(`${type}:${id}`, 0.5);
  }
  for (const [type, n] of Object.entries(counts)) if (!/^(application|window|other)$/i.test(type)) add(`#${type}:${bucket(n)}`, 0.25);
  return { title, tab: tab ? norm(tab.label) : '', parts };
}

// 0…1. Different navigation bar titles or selected tabs mean different screens, whatever else matches.
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a.title && b.title && a.title !== b.title) return 0;
  if (a.tab && b.tab && a.tab !== b.tab) return 0;
  let min = 0;
  let max = 0;
  for (const k of new Set([...Object.keys(a.parts), ...Object.keys(b.parts)])) {
    const x = a.parts[k] || 0;
    const y = b.parts[k] || 0;
    min += Math.min(x, y);
    max += Math.max(x, y);
  }
  return max ? min / max : 1;
}
