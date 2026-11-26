import fs from 'node:fs';
import path from 'node:path';
import pngjs from 'pngjs';

const { PNG } = pngjs;

// Standalone HTML reports: everything inline (CSS, script, images as data: URIs), so the
// file can be attached to a ticket or a CI job and opened offline.

export const REPORT_TYPES = ['summary', 'full'];
const STATUS = { same: 'same', changed: 'changed', new: 'new', bad: 'broken' };
const CARD_W = 390; // images in the change cards
const THUMB_W = 200; // graph nodes and the unchanged grid

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (r) => (r == null ? '–' : (r * 100).toFixed(2) + ' %');
const slug = (s) => String(s).replace(/[^a-z0-9.]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'run';
const p2 = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => {
  const x = d ? new Date(d) : null;
  return x && !Number.isNaN(x.getTime()) ? `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())} ${p2(x.getHours())}:${p2(x.getMinutes())}` : '';
};

/* ---------- review ---------- */

// Same screens pass on their own; every other screen needs a decision.
export const decisionOf = (report, s) => (s.status === 'same' ? 'passed' : report.review?.[s.id]?.decision || 'open');

export function reviewState(report) {
  const changes = report.screens.filter((s) => s.status !== 'same');
  const dec = changes.map((s) => decisionOf(report, s));
  const approved = dec.filter((d) => d === 'approved').length;
  const rejected = dec.filter((d) => d === 'rejected').length;
  const open = dec.filter((d) => d === 'open').length;
  // A broken screen counts as accepted only once it is approved; rejecting anything fails the report.
  const result = rejected ? 'failed' : open ? 'in review' : 'passed';
  return { total: changes.length, reviewed: changes.length - open, open, approved, rejected, result };
}

export function setDecision(report, ids, decision) {
  const at = new Date().toISOString();
  report.review ||= {};
  for (const id of ids) {
    if (decision) report.review[id] = { decision, at };
    else delete report.review[id];
  }
}

const ACTIONS = { approve: 'approved', reject: 'rejected', undo: null };

// target: a screen id, or "all" = every open change (approve/reject) or every decided one (undo).
export function applyReview(report, target, action) {
  if (!(action in ACTIONS)) throw new Error(`unknown action "${action}" · use approve, reject or undo`);
  const decision = ACTIONS[action];
  const changes = report.screens.filter((s) => s.status !== 'same');
  let ids;
  if (target === 'all') {
    ids = changes.filter((s) => (decision ? decisionOf(report, s) === 'open' : decisionOf(report, s) !== 'open')).map((s) => s.id);
  } else {
    const s = report.screens.find((x) => x.id === target);
    if (!s) throw new Error(`no screen "${target}" in this report · snapcrawl review lists the ids`);
    if (s.status === 'same') throw new Error(`${target} is unchanged, nothing to review`);
    ids = [s.id];
  }
  setDecision(report, ids, decision);
  return ids;
}

export const reportFileName = (report, type) => `snapcrawl-${slug(report.appName || report.app)}-${slug(report.head.label || report.head.id)}-${type}.html`;

/* ---------- images ---------- */

// Box downsampling: every output pixel is the average of the source pixels it covers.
function shrink(buf, maxW) {
  const src = PNG.sync.read(buf);
  if (src.width <= maxW) return { buf, w: src.width, h: src.height };
  const w = maxW;
  const h = Math.max(1, Math.round((src.height * maxW) / src.width));
  const out = new PNG({ width: w, height: h });
  const sw = src.width, sh = src.height, d = src.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * sh) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * sw) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / w));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0, i = (yy * sw + x0) * 4; xx < x1; xx++, i += 4) {
          r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
        }
      }
      const o = (y * w + x) * 4;
      out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n; out.data[o + 3] = 255;
    }
  }
  return { buf: PNG.sync.write(out, { colorType: 2 }), w, h };
}

// Each (file, width) is decoded and shrunk once per report.
function imageCache(root) {
  const cache = new Map();
  return (rel, maxW) => {
    if (!rel) return null;
    const key = `${rel}@${maxW}`;
    if (!cache.has(key)) {
      let v = null;
      try {
        const r = shrink(fs.readFileSync(path.join(root, rel)), maxW);
        v = { src: `data:image/png;base64,${r.buf.toString('base64')}`, w: r.w, h: r.h };
      } catch {}
      cache.set(key, v);
    }
    return cache.get(key);
  };
}

/* ---------- graph (same layout as the UI) ---------- */

const CW = 128, CH = 272, COLX = 214, ROWY = 300;

function graphSvg(report, thumb) {
  const st = Object.fromEntries(report.screens.map((s) => [s.id, s.status]));
  const nodes = report.screens.map((s) => {
    const d = decisionOf(report, s);
    return {
      id: s.id, name: s.name, depth: s.depth, status: s.status,
      cls: d === 'approved' || d === 'rejected' ? 'r-' + d : '',
      img: thumb(s.headImg || s.baseImg, THUMB_W)?.src,
      placeholder: s.reason === 'crash' ? 'crash' : 'no screen',
      foot: s.status === 'changed' ? `Δ ${pct(s.ratio)}` : s.status === 'same' ? 'Δ 0.00 %' : s.reason || s.status,
    };
  });
  const edges = report.edges.map((e) => ({ ...e, kind: st[e.to] === 'bad' ? 'bad' : st[e.to] === 'new' ? 'new' : '' }));

  // columns by depth, rows ordered by the parent's row
  const parent = {};
  for (const e of edges) if (!(e.to in parent)) parent[e.to] = e.from;
  const cols = {};
  for (const n of nodes) (cols[n.depth] ||= []).push(n);
  const pos = {};
  for (const d of Object.keys(cols).map(Number).sort((a, b) => a - b)) {
    const col = cols[d].map((n, i) => ({ n, k: pos[parent[n.id]]?.r ?? 0, i })).sort((a, b) => a.k - b.k || a.i - b.i);
    col.forEach(({ n }, r) => (pos[n.id] = { x: d * COLX, y: r * ROWY, r }));
  }

  let s = '', labels = '';
  for (const e of edges) {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) continue;
    const y1 = a.y + CH / 2, y2 = b.y + CH / 2;
    let d;
    if (b.x > a.x) {
      const x1 = a.x + CW, x2 = b.x, dx = Math.max(28, (x2 - x1) / 2);
      d = `M${x1} ${y1}C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2 - 2} ${y2}`;
    } else {
      const x1 = a.x, x2 = b.x + CW;
      d = `M${x1} ${y1}C${x1 - 60} ${y1} ${x2 + 60} ${y2} ${x2 + 2} ${y2}`;
    }
    const mx = (a.x + b.x + CW) / 2, my = (y1 + y2) / 2;
    const k = e.kind === 'bad' ? 'b' : e.kind === 'new' ? 'n' : 'a';
    s += `<path class="e ${e.kind}" d="${d}" marker-end="url(#g-${k})"/>`;
    if (e.label && b.x !== a.x) {
      const t = e.label.length > 16 ? e.label.slice(0, 15) + '…' : e.label, w = t.length * 5.9 + 8;
      labels += `<g class="el" transform="translate(${mx - w / 2} ${my - 7})"><rect width="${w}" height="14"/><text x="4" y="10">${esc(t)}</text></g>`;
    }
  }
  s += labels;
  let x0 = 0, y0 = 0, x1 = CW, y1 = CH;
  for (const n of nodes) {
    const p = pos[n.id];
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + CW); y1 = Math.max(y1, p.y + CH);
    const name = n.name.length > 17 ? n.name.slice(0, 16) + '…' : n.name;
    const img = n.img
      ? `<image href="${n.img}" width="100" height="216" preserveAspectRatio="xMidYMid slice" clip-path="url(#g-c)"/><rect width="100" height="216" rx="5" fill="none" stroke="#262626"/>`
      : `<rect class="ph" width="100" height="216" rx="5"/><text class="pht" x="50" y="112" text-anchor="middle">${esc(n.placeholder)}</text>`;
    s += `<a href="#s-${esc(n.id)}" aria-label="${esc(n.name)}"><g class="node s-${n.status}${n.cls ? ' ' + n.cls : ''}" transform="translate(${p.x} ${p.y})">`
      + `<rect class="nb" width="${CW}" height="${CH}" rx="6"/><rect class="sq" x="14" y="11" width="7" height="7"/><text class="nn" x="28" y="18.5">${esc(name)}</text>`
      + `<g transform="translate(14 28)">${img}</g><text class="nf" x="14" y="${CH - 11}">${esc(n.foot)}</text>`
      + `<rect class="port" x="-3" y="${CH / 2 - 3}" width="6" height="6"/><rect class="port" x="${CW - 3}" y="${CH / 2 - 3}" width="6" height="6"/></g></a>`;
  }
  const vb = [x0 - 20, y0 - 20, x1 - x0 + 40, y1 - y0 + 40].join(' ');
  const mk = (id, cls) => `<marker id="g-${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="mk ${cls}"/></marker>`;
  return `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid meet" role="group" aria-label="screen graph"><defs>${mk('a', '')}${mk('b', 'bad')}${mk('n', 'new')}<clipPath id="g-c"><rect width="100" height="216" rx="5"/></clipPath></defs>${s}</svg>`;
}

/* ---------- html ---------- */

const CSS = `
:root{color-scheme:dark;--bg:#0a0a0a;--s1:#0f0f0f;--s2:#151515;--line:#222;--line2:#2e2e2e;--fg:#ededed;--mut:#8f8f8f;--dim:#5a5a5a;--ok:#3fb950;--chg:#d29922;--new:#58a6ff;--bad:#f85149;--sans:Geist,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;--mono:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box;min-width:0}
html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
a{color:inherit}
.top{display:flex;align-items:center;gap:10px;min-height:52px;padding:0 20px;border-bottom:1px solid var(--line);font:500 14px var(--mono)}
.logo{display:flex;gap:3px}.logo i{width:7px;height:7px;background:var(--fg)}.logo i+i{background:none;border:1px solid var(--fg)}
.top .ty{margin-left:16px;color:var(--dim);font-size:12px;font-weight:400}
.wrap{max-width:1280px;margin:0 auto;padding:0 20px}
.head{padding:28px 0 20px;border-bottom:1px solid var(--line)}
.app{font:12px var(--mono);margin:0 0 8px}.app span{color:var(--mut)}
h1{display:flex;align-items:center;gap:12px;font-size:26px;line-height:1.2;font-weight:500;letter-spacing:-.02em;margin:0}
h1 i{width:10px;height:10px;flex:none;background:var(--dim)}
.r-passed h1 i{background:var(--ok)}.r-failed h1 i{background:var(--bad)}.r-in-review h1 i{background:var(--chg)}
.sub{font:12px var(--mono);color:var(--mut);margin:8px 0 0;overflow-wrap:anywhere}.sub b{color:var(--fg);font-weight:400}
h2{display:flex;gap:10px;align-items:baseline;font-size:13px;font-weight:500;margin:0 0 14px}h2 span{font:11px var(--mono);color:var(--dim)}
section{padding:24px 0;border-bottom:1px solid var(--line)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));border-top:1px solid var(--line);border-left:1px solid var(--line)}
.tile{padding:12px 14px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}.tile small{display:flex;align-items:center;gap:8px;font:11px var(--mono);color:var(--mut)}.tile b{display:block;font-size:22px;font-weight:500;letter-spacing:-.02em;margin-top:2px}
.k{width:7px;height:7px;flex:none;background:var(--dim)}.k-same,.k-passed,.k-approved{background:var(--ok)}.k-changed{background:var(--chg)}.k-new{background:var(--new)}.k-bad,.k-rejected{background:var(--bad)}
.tw{overflow-x:auto;border:1px solid var(--line);border-radius:6px}
table.t{width:100%;border-collapse:collapse;font-size:13px}
.t th{font:11px var(--mono);color:var(--mut);font-weight:400;text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
.t td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}.t tr:last-child td{border-bottom:0}
.t .m{font:12px var(--mono);color:var(--mut)}.t .n{white-space:nowrap;text-align:right;font:12px var(--mono)}
.t td small{display:block;font:11px var(--mono);color:var(--dim)}.t .nt{font-size:12px;color:var(--mut);margin-top:4px}
.t a{text-decoration:none}.t a:hover{text-decoration:underline}
.tag{display:inline-block;font:11px var(--mono);padding:1px 6px;border:1px solid var(--line2);border-radius:4px;color:var(--mut);white-space:nowrap}
.t-same,.t-passed,.t-approved{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,transparent)}.t-changed{color:var(--chg);border-color:color-mix(in srgb,var(--chg) 40%,transparent)}.t-new{color:var(--new);border-color:color-mix(in srgb,var(--new) 40%,transparent)}.t-bad,.t-rejected{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent)}.t-open{color:var(--fg)}
.graph{position:relative;height:min(70vh,560px);border:1px solid var(--line);border-radius:6px;overflow:hidden;background-color:var(--bg);background-image:radial-gradient(#1b1b1b 1px,transparent 1.2px);background-size:20px 20px}
.graph svg{position:absolute;inset:0;width:100%;height:100%;cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none}.graph.drag svg{cursor:grabbing}
.tools{position:absolute;right:10px;bottom:10px;display:flex;border:1px solid var(--line2);border-radius:6px;overflow:hidden;background:var(--s1)}
.tools button{min-width:40px;height:34px;border:0;border-right:1px solid var(--line2);background:none;cursor:pointer;font:12px var(--mono);color:var(--mut);padding:0 10px}.tools button:last-child{border-right:0}.tools button:hover{color:var(--fg)}
.legend{position:absolute;left:12px;bottom:14px;display:flex;flex-wrap:wrap;gap:4px 14px;font:11px var(--mono);color:var(--mut);pointer-events:none}.legend span{display:flex;align-items:center;gap:6px}
.e{fill:none;stroke:#3a3a3a;stroke-width:1.2}.e.bad{stroke:var(--bad);stroke-dasharray:4 4}.e.new{stroke:var(--new)}
.mk{fill:#3a3a3a}.mk.bad{fill:var(--bad)}.mk.new{fill:var(--new)}
.el rect{fill:var(--bg)}.el text{font:9.5px var(--mono);fill:#7a7a7a}
.nb{fill:var(--s1);stroke:var(--line2);stroke-width:1}a:hover .nb{stroke:#4a4a4a}a:focus{outline:none}a:focus-visible .nb{stroke:var(--fg)}
.nn{font-size:11.5px;font-weight:500;fill:var(--fg);font-family:var(--sans)}.nf{font:9.5px var(--mono);fill:var(--dim)}
.sq{fill:var(--dim)}.s-same .sq{fill:var(--ok)}.s-changed .sq{fill:var(--chg)}.s-new .sq{fill:var(--new)}.s-bad .sq{fill:var(--bad)}
.s-changed .nb{stroke:color-mix(in srgb,var(--chg) 55%,var(--line2))}.s-new .nb{stroke:color-mix(in srgb,var(--new) 55%,var(--line2))}.s-bad .nb{stroke:color-mix(in srgb,var(--bad) 60%,var(--line2))}
.r-approved .sq{fill:var(--ok)}.r-rejected .nb{stroke:var(--bad);stroke-dasharray:4 3}
.ph{fill:#141414}.pht{font:10px var(--mono);fill:#6a6a6a}.port{fill:var(--bg);stroke:#4a4a4a}
.hint{font:11px var(--mono);color:var(--dim);margin:8px 0 0}
.card{border:1px solid var(--line);border-radius:8px;padding:16px;margin-bottom:16px;scroll-margin-top:16px}
.card:target,.card.hit{border-color:var(--fg)}.card.hit{animation:hit 1.4s ease-out}@keyframes hit{from{background:var(--s2)}}
.ch{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 16px;align-items:flex-start}
.ch h3{margin:0;font-size:16px;font-weight:500}.ch .tags{display:flex;gap:6px}
.path{font:11px var(--mono);color:var(--mut);margin:4px 0 14px;overflow-wrap:anywhere}
.trip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;max-width:760px}
.shot{margin:0}.shot figcaption{font:11px var(--mono);color:var(--dim);margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.frame{position:relative;border:1px solid var(--line2);border-radius:8px;overflow:hidden;background:#000;aspect-ratio:var(--ar,.4613)}
.frame img{display:block;width:100%;height:100%;object-fit:cover}.frame svg{position:absolute;inset:0;width:100%;height:100%}
.noimg{display:grid;place-content:center;height:100%;font:11px var(--mono);color:var(--dim);text-align:center;padding:12px;background:var(--s1)}
.facts{display:flex;flex-wrap:wrap;gap:4px 18px;font:12px var(--mono);color:var(--mut);margin:14px 0 0}.facts b{color:var(--fg);font-weight:400}
.note{border-left:2px solid var(--line2);padding:2px 0 2px 12px;margin:14px 0 0;font-size:13px}.note b{display:block;font:11px var(--mono);color:var(--mut);font-weight:400}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:14px}
.mini{margin:0;scroll-margin-top:16px}.mini figcaption{font:11px var(--mono);color:var(--mut);margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mini:target .frame,.mini.hit .frame{border-color:var(--fg)}
footer{padding:20px 0 32px;font:11px var(--mono);color:var(--dim)}
@media(max-width:640px){table.t{min-width:600px}.t .m{min-width:200px}.wrap{padding:0 14px}.top{padding:0 14px}h1{font-size:22px}.trip{grid-auto-flow:column;grid-template-columns:none;grid-auto-columns:72%;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:4px}.shot{scroll-snap-align:start}.graph{height:60vh;min-height:320px}.card{padding:12px}}
@media(prefers-reduced-motion:reduce){*{animation:none!important}}
@media print{
:root{color-scheme:light;--bg:#fff;--s1:#fafafa;--s2:#f2f2f2;--line:#d8d8d8;--line2:#c4c4c4;--fg:#111;--mut:#555;--dim:#777;--ok:#1a7f37;--chg:#9a6700;--new:#0969da;--bad:#cf222e}
*{-webkit-print-color-adjust:exact;print-color-adjust:exact}
@page{margin:14mm}
html,body{font-size:11px}
.wrap,.top{padding:0;max-width:none}
.tools,.hint{display:none}
.tiles{grid-template-columns:repeat(7,minmax(0,1fr))}.tile{padding:8px 10px}.tile b{font-size:18px}
.graph{height:auto;background:none;break-inside:avoid}.graph svg{position:static;height:auto;max-height:230mm}.legend{position:static;padding:6px 8px}
.e,.mk{stroke:#999}.mk{fill:#999}.el text,.pht{fill:#555}.ph{fill:#eee}
.trip{grid-auto-flow:row;grid-template-columns:repeat(3,minmax(0,1fr));overflow:visible;max-width:150mm}
.card,.tile,.mini,tr{break-inside:avoid}
.frame{background:#fff}
a{text-decoration:none}
}`;

const SCRIPT = `(() => {
  const box = document.querySelector('.graph'); if (!box) return;
  const svg = box.querySelector('svg'), vb = svg.viewBox.baseVal, home = [vb.x, vb.y, vb.width, vb.height];
  const set = (x, y, w, h) => { vb.x = x; vb.y = y; vb.width = w; vb.height = h; };
  const k = () => Math.max(vb.width / svg.clientWidth, vb.height / svg.clientHeight);
  const pt = (cx, cy) => { const p = svg.createSVGPoint(); p.x = cx; p.y = cy; return p.matrixTransform(svg.getScreenCTM().inverse()); };
  const zoom = (f, c) => { const w = Math.min(home[2] * 4, Math.max(160, vb.width * f)); f = w / vb.width; set(c.x - (c.x - vb.x) * f, c.y - (c.y - vb.y) * f, vb.width * f, vb.height * f); };
  let last = null, moved = 0;
  svg.addEventListener('pointerdown', (e) => { if (e.button) return; last = [e.clientX, e.clientY]; moved = 0; box.classList.add('drag'); });
  addEventListener('pointermove', (e) => { if (!last) return; const s = k(), dx = e.clientX - last[0], dy = e.clientY - last[1]; moved += Math.abs(dx) + Math.abs(dy); last = [e.clientX, e.clientY]; vb.x -= dx * s; vb.y -= dy * s; });
  const up = () => { last = null; box.classList.remove('drag'); };
  addEventListener('pointerup', up); addEventListener('pointercancel', up);
  svg.addEventListener('dragstart', (e) => e.preventDefault());
  svg.addEventListener('wheel', (e) => { e.preventDefault(); zoom(Math.exp(e.deltaY * 0.0015), pt(e.clientX, e.clientY)); }, { passive: false });
  svg.addEventListener('click', (e) => {
    const a = e.target.closest('a'); if (!a) return;
    e.preventDefault();
    if (e.detail && moved > 5) return;
    const id = a.getAttribute('href').slice(1), el = document.getElementById(id); if (!el) return;
    el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    history.replaceState(null, '', '#' + id);
    document.querySelectorAll('.hit').forEach((x) => x.classList.remove('hit'));
    void el.offsetWidth; el.classList.add('hit');
  });
  box.querySelector('.tools').addEventListener('click', (e) => {
    const z = e.target.dataset.z, r = svg.getBoundingClientRect(), c = pt(r.left + r.width / 2, r.top + r.height / 2);
    if (z === 'in') zoom(0.8, c); if (z === 'out') zoom(1.25, c); if (z === 'fit') set(...home);
  });
  addEventListener('beforeprint', () => set(...home));
})();`;

function figure(cap, img, { boxes, size, empty } = {}) {
  const ar = img ? img.w / img.h : size ? size[0] / size[1] : 0.4613;
  const marks = img && size && boxes?.length
    ? `<svg viewBox="0 0 ${size[0]} ${size[1]}" preserveAspectRatio="none" aria-hidden="true">${boxes.map((b) => `<rect x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" fill="rgba(248,81,73,.08)" stroke="#f85149" stroke-width="${size[0] / 200}" stroke-dasharray="${size[0] / 60} ${size[0] / 90}"/>`).join('')}</svg>`
    : '';
  const body = img ? `<img alt="${esc(cap)}" src="${img.src}" width="${img.w}" height="${img.h}">${marks}` : `<div class="noimg">${empty}</div>`;
  return `<figure class="shot"><figcaption>${esc(cap)}</figcaption><div class="frame" style="--ar:${ar.toFixed(4)}">${body}</div></figure>`;
}

function card(report, s, image) {
  const d = decisionOf(report, s);
  const base = image(s.baseImg, CARD_W), head = image(s.headImg, CARD_W), diff = image(s.diffImg, CARD_W);
  const note = report.notes?.[s.id];
  const facts = [['screen', s.id], ['pixel Δ', pct(s.ratio)], ['regions', s.boxes.length], ['elements', s.elements ?? '–']];
  if (s.size) facts.push(['size', `${s.size[0]}×${s.size[1]}`]);
  return `<article class="card" id="s-${esc(s.id)}">
<div class="ch"><div><h3>${esc(s.name)}</h3><p class="path">${['start', ...s.path].map(esc).join(' → ')}</p></div><div class="tags"><span class="tag t-${s.status}">${esc(s.reason || STATUS[s.status])}</span><span class="tag t-${d}">${d}</span></div></div>
<div class="trip">${figure(`base · ${report.base.label || report.base.id}`, base, { empty: s.status === 'new' ? 'not in base' : 'no screenshot' })}${figure(`head · ${report.head.label || report.head.id}`, head, { boxes: s.boxes, size: s.size, empty: s.reason === 'crash' ? 'app crashed<br>before render' : s.reason === 'unreachable' ? 'not reached' : 'no screenshot' })}${figure('pixel diff', diff, { empty: 'no diff' })}</div>
<p class="facts">${facts.map(([k, v]) => `<span>${k} <b>${esc(v)}</b></span>`).join('')}</p>
${note ? `<div class="note"><b>note · ${esc(note.model)} · ${esc(note.verdict)}</b>${esc(note.summary)}</div>` : ''}
</article>`;
}

export function renderReport({ store, report, type = 'summary', version = '' }) {
  if (!REPORT_TYPES.includes(type)) throw Object.assign(new Error(`unknown report type "${type}" · use summary or full`), { status: 400 });
  const full = type === 'full';
  const image = full ? imageCache(store.root) : () => null;
  const meta = (id) => {
    try {
      return store.readRun(id).meta;
    } catch {
      return {};
    }
  };
  const bm = meta(report.base.id), hm = meta(report.head.id);
  const st = reviewState(report);
  const sum = report.summary;
  const now = new Date();
  const appName = report.appName || report.app;
  const run = (r, m) => `<b>${esc(r.label || r.id)}</b>${m.created ? ' · ' + esc(fmtDate(m.created)) : ''}`;
  const device = report.base.device && report.base.device !== report.head.device ? `${report.base.device} → ${report.head.device}` : report.head.device || report.base.device;

  const tiles = [
    ['same', sum.same, 'k-same'], ['changed', sum.changed, 'k-changed'], ['new', sum.new, 'k-new'], ['broken', sum.bad, 'k-bad'],
    ['reviewed', `${st.reviewed}/${st.total}`, ''], ['approved', st.approved, 'k-approved'], ['rejected', st.rejected, 'k-rejected'],
  ].map(([l, n, k]) => `<div class="tile"><small><i class="k ${k}"></i>${l}</small><b>${n}</b></div>`).join('');

  const rows = report.screens.map((s) => {
    const d = decisionOf(report, s);
    const note = report.notes?.[s.id]?.summary;
    const name = full ? `<a href="#s-${esc(s.id)}">${esc(s.name)}</a>` : esc(s.name);
    return `<tr><td>${name}<small>${esc(s.id)}</small>${note ? `<div class="nt">${esc(note)}</div>` : ''}</td><td class="m">${['start', ...s.path].map(esc).join(' → ')}</td><td><span class="tag t-${s.status}">${esc(s.reason || STATUS[s.status])}</span></td><td class="n">${pct(s.ratio)}</td><td><span class="tag t-${d}">${d}</span></td></tr>`;
  }).join('\n');

  let extra = '';
  if (full) {
    const changes = report.screens.filter((s) => s.status !== 'same');
    const same = report.screens.filter((s) => s.status === 'same');
    const legend = Object.entries(STATUS).map(([k, l]) => `<span><i class="k k-${k}"></i>${l}</span>`).join('');
    extra = `<section><h2><span>03</span>Screen graph</h2><div class="graph">${graphSvg(report, image)}<div class="legend">${legend}</div><div class="tools"><button type="button" data-z="in" aria-label="zoom in">+</button><button type="button" data-z="out" aria-label="zoom out">−</button><button type="button" data-z="fit">fit</button></div></div><p class="hint">drag to pan · scroll to zoom · click a screen to jump to it</p></section>
<section><h2><span>04</span>Changes · ${changes.length}</h2>${changes.map((s) => card(report, s, image)).join('\n') || '<p class="sub">No changes.</p>'}</section>
<section><h2><span>05</span>Unchanged · ${same.length}</h2><div class="grid">${same.map((s) => {
      const img = image(s.headImg, THUMB_W);
      return `<figure class="mini" id="s-${esc(s.id)}"><div class="frame" style="--ar:${img ? (img.w / img.h).toFixed(4) : 0.4613}">${img ? `<img alt="${esc(s.name)}" src="${img.src}" width="${img.w}" height="${img.h}" loading="lazy">` : '<div class="noimg">no screenshot</div>'}</div><figcaption>${esc(s.name)}</figcaption></figure>`;
    }).join('') || '<p class="sub">None.</p>'}</div></section>`;
  }

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="snapcrawl ${esc(version)}">
<title>snapcrawl · ${esc(appName)} ${esc(report.head.label || report.head.id)} · ${st.result}</title>
<style>${CSS}</style></head>
<body class="r-${st.result.replace(' ', '-')}" data-result="${st.result}" data-type="${type}">
<header class="top"><span class="logo" aria-hidden="true"><i></i><i></i></span>snapcrawl<span class="ty">report · ${type}</span></header>
<main class="wrap">
<div class="head"><p class="app">${esc(appName)} <span>· ${esc(report.app)}</span></p><h1><i aria-hidden="true"></i>${st.result === 'in review' ? 'In review' : st.result === 'passed' ? 'Passed' : 'Failed'}</h1>
<p class="sub">base ${run(report.base, bm)} → head ${run(report.head, hm)}</p>
<p class="sub">${device ? `device <b>${esc(device)}</b> · ` : ''}created <b>${esc(fmtDate(now))}</b></p></div>
<section><h2><span>01</span>Result</h2><div class="tiles">${tiles}</div>
<p class="sub">${st.result === 'passed' ? 'Every change was reviewed and approved.' : st.result === 'failed' ? `${st.rejected} change${st.rejected === 1 ? '' : 's'} rejected.` : `${st.open} of ${st.total} changes still open.`}</p></section>
<section><h2><span>02</span>Screens · ${report.screens.length}</h2><div class="tw"><table class="t"><thead><tr><th>screen</th><th>path</th><th>status</th><th style="text-align:right">pixel Δ</th><th>decision</th></tr></thead><tbody>
${rows}
</tbody></table></div></section>
${extra}
<footer>generated by snapcrawl v${esc(version)} · ${esc(fmtDate(now))}</footer>
</main>
${full ? `<script>${SCRIPT}</script>` : ''}
</body></html>
`;
}
