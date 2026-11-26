import fs from 'node:fs';
import path from 'node:path';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const W = 393;
const H = 852;
const BLUE = '#3b6ef5';
const ORANGE = '#ff7a1a';
const INK = '#1b2533';

const rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

// A tiny rasteriser so the demo needs no simulator: wireframe screens as real PNGs.
class Canvas {
  constructor() {
    this.png = new PNG({ width: W, height: H });
    this.png.data.fill(255);
  }
  rect(x, y, w, h, color, r = 0) {
    const [cr, cg, cb] = rgb(color);
    const d = this.png.data;
    [x, y, w, h] = [x, y, w, h].map(Math.round);
    r = Math.min(r, w / 2, h / 2);
    for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) {
        if (r) {
          const dx = xx < x + r ? x + r - xx - 0.5 : xx >= x + w - r ? xx - (x + w - r) + 0.5 : 0;
          const dy = yy < y + r ? y + r - yy - 0.5 : yy >= y + h - r ? yy - (y + h - r) + 0.5 : 0;
          if (dx * dx + dy * dy > r * r) continue;
        }
        const i = (yy * W + xx) * 4;
        d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = 255;
      }
    }
  }
  circle(cx, cy, r, color) {
    this.rect(cx - r, cy - r, r * 2, r * 2, color, r);
  }
  buffer() {
    return PNG.sync.write(this.png);
  }
}

function render(spec) {
  const c = new Canvas();
  let y = 0;
  const bars = (n, x0, y0, step, ws, h = 10, color = '#e3e8ee') => {
    for (let i = 0; i < n; i++) c.rect(x0, y0 + i * step, ws[i % ws.length], h, color, h / 2);
  };
  for (const e of spec) {
    switch (e.t) {
      case 'st':
        c.rect(0, 0, W, 54, '#f2f4f7');
        c.rect(32, 22, 42, 13, '#9aa5b1', 6);
        c.rect(300, 22, 62, 13, '#9aa5b1', 6);
        y += 54;
        break;
      case 'nav':
        c.rect(20, y + 18, e.w, 22, INK, 7);
        y += 60;
        break;
      case 'gap':
        y += e.h;
        break;
      case 'logo':
        c.circle(W / 2, y + e.r + 6, e.r, e.c || BLUE);
        c.rect(W / 2 - e.r * 0.55, y + e.r + 3, e.r * 1.1, 6, '#ffffff', 3);
        y += e.r * 2 + 12;
        break;
      case 'title':
        e.lines.forEach((w, i) => c.rect(e.center ? (W - w) / 2 : 20, y + 8 + i * 34, w, 24, INK, 8));
        y += e.lines.length * 34 + 16;
        break;
      case 'img':
        c.rect(20, y + 8, W - 40, e.h, e.c, 18);
        c.circle(W - 80, y + 8 + e.h * 0.3, e.h * 0.1, '#ffffff');
        y += e.h + 18;
        break;
      case 'p':
        bars(e.n, 20, y + 6, 22, [340, 300, 260, 320]);
        y += e.n * 22 + 14;
        break;
      case 'field':
        c.rect(20, y + 4, 70, 9, '#9aa5b1', 4);
        c.rect(20, y + 20, W - 40, 50, '#cfd7e0', 12);
        c.rect(22, y + 22, W - 44, 46, '#ffffff', 10);
        y += 84;
        break;
      case 'btn':
        c.rect(20, y + 10, W - 40, 56, e.c, 28);
        c.rect((W - (e.tw || 110)) / 2, y + 33, e.tw || 110, 11, '#ffffff', 5);
        y += 78;
        break;
      case 'card':
        c.rect(20, y + 8, W - 40, e.h, '#f1f4f8', 18);
        bars(e.n, 44, y + 32, 26, [200, 270, 150]);
        y += e.h + 18;
        break;
      case 'list':
        for (let i = 0; i < e.n; i++) {
          const yy = y + i * 66;
          c.circle(44, yy + 33, 20, '#dde4ec');
          c.rect(80, yy + 20, [190, 150, 220, 130, 170][i % 5], 12, '#c3ccd6', 6);
          c.rect(80, yy + 40, [120, 150, 90, 130, 110][i % 5], 9, '#e6ebf0', 4);
          c.rect(20, yy + 65, W - 40, 1, '#eef1f4');
          if (e.dot && i < 2) c.circle(W - 40, yy + 33, 7, BLUE);
        }
        y += e.n * 66;
        break;
      case 'chart':
        [70, 110, 60, 130, 95, 150, 105].forEach((v, i) => c.rect(34 + i * 48, y + 170 - v, 28, v, i === 5 ? BLUE : '#c9d8f5', 6));
        y += 190;
        break;
      case 'tab':
        c.rect(0, H - 84, W, 84, '#f7f8fa');
        [60, 150, 243, 333].forEach((x, i) => c.circle(x, H - 50, 12, i ? '#c5ced8' : BLUE));
        break;
    }
  }
  return c.buffer();
}

const st = { t: 'st' };
const tab = { t: 'tab' };
const SPEC = {
  splash: () => [{ t: 'gap', h: 330 }, { t: 'logo', r: 52 }, { t: 'title', lines: [130], center: true }],
  onboarding: () => [st, { t: 'img', h: 300, c: '#dbe7ff' }, { t: 'title', lines: [260] }, { t: 'p', n: 3 }, { t: 'gap', h: 60 }, { t: 'btn', c: INK, tw: 120 }],
  login: (c) => [st, { t: 'nav', w: 140 }, { t: 'gap', h: 30 }, { t: 'field' }, { t: 'field' }, { t: 'gap', h: 16 }, { t: 'btn', c, tw: 100 }, { t: 'p', n: 1 }],
  home: (c) => [st, { t: 'nav', w: 170 }, { t: 'card', h: 130, n: 3 }, { t: 'img', h: 170, c: '#ffe7d6' }, { t: 'btn', c, tw: 150 }, tab],
  workouts: () => [st, { t: 'nav', w: 150 }, { t: 'list', n: 9 }, tab],
  stats: () => [st, { t: 'nav', w: 130 }, { t: 'chart' }, { t: 'card', h: 120, n: 3 }, tab],
  profile: (c) => [st, { t: 'nav', w: 90 }, { t: 'gap', h: 10 }, { t: 'logo', r: 44, c: '#c9d6ea' }, { t: 'title', lines: [140], center: true }, { t: 'p', n: 2 }, { t: 'btn', c, tw: 160 }, { t: 'list', n: 2 }, tab],
  paywall: () => [st, { t: 'img', h: 220, c: '#e4ddff' }, { t: 'title', lines: [190] }, { t: 'p', n: 3 }, { t: 'gap', h: 50 }, { t: 'btn', c: BLUE, tw: 120 }],
  detail: (bug) => [st, { t: 'nav', w: 110 }, { t: 'img', h: 220, c: '#d9f0e4' }, { t: 'title', lines: bug ? [560] : [330, 150] }, { t: 'gap', h: bug ? 34 : 0 }, { t: 'p', n: 4 }, { t: 'btn', c: INK, tw: 90 }],
  edit: () => [st, { t: 'nav', w: 200 }, { t: 'gap', h: 16 }, { t: 'field' }, { t: 'field' }, { t: 'field' }, { t: 'gap', h: 20 }, { t: 'btn', c: INK, tw: 110 }],
  settings: () => [st, { t: 'nav', w: 180 }, { t: 'list', n: 10 }],
  checkout: () => [st, { t: 'nav', w: 140 }, { t: 'card', h: 160, n: 4 }, { t: 'field' }, { t: 'gap', h: 20 }, { t: 'btn', c: BLUE, tw: 130 }],
  player: () => [{ t: 'img', h: 430, c: '#1f2a3a' }, { t: 'title', lines: [150], center: true }, { t: 'title', lines: [110], center: true }, { t: 'gap', h: 30 }, { t: 'btn', c: INK, tw: 80 }],
  notif: (c) => [st, { t: 'nav', w: 190 }, { t: 'list', n: 7, dot: true }, { t: 'btn', c, tw: 140 }],
};

// key, name, parent, tap label, extra incoming edges [from, label]
const TREE = [
  ['splash', 'Splash', null, null],
  ['onboarding', 'Onboarding', 'splash', 'Los geht’s'],
  ['login', 'Login', 'onboarding', 'Anmelden'],
  ['home', 'Home', 'login', 'Anmelden'],
  ['workouts', 'Workouts', 'home', 'Workouts'],
  ['stats', 'Statistik', 'home', 'Statistik'],
  ['profile', 'Profil', 'home', 'Profil'],
  ['paywall', 'Pulse Pro', 'home', 'Pro'],
  ['detail', 'Workout-Detail', 'workouts', 'Ganzkörper'],
  ['edit', 'Profil bearbeiten', 'profile', 'Bearbeiten'],
  ['settings', 'Einstellungen', 'profile', 'Einstellungen'],
  ['checkout', 'Checkout', 'paywall', 'Abo starten'],
  ['player', 'Player', 'detail', 'Starten'],
  ['notif', 'Mitteilungen', 'settings', 'Mitteilungen'],
];
const EXTRA = [['detail', 'paywall', 'Pro']];

function buildRun(store, { id, label, created, version }) {
  const head = version === 2;
  const dir = store.runDir(id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'screens'), { recursive: true });
  const color = head ? ORANGE : BLUE;
  const specs = {
    ...SPEC,
    login: () => SPEC.login(color), home: () => SPEC.home(color), profile: () => SPEC.profile(color), notif: () => SPEC.notif(color), detail: () => SPEC.detail(head),
  };

  const screens = [];
  const byKey = {};
  for (const [key, name, parent, via] of TREE) {
    if (!head && key === 'stats') continue;
    if (head && key === 'checkout') continue;
    const p = parent ? byKey[parent] : null;
    const ref = via ? { type: 'Button', label: via, id: '', x: 196, y: 600 } : null;
    const s = { id: '', name, fp: `demo-${key}`, depth: p ? p.depth + 1 : 0, path: p ? [...p.path, ref] : [], screenshot: null, elements: 6 + (key.length % 9), actions: [], blocked: [] };
    if (head && key === 'paywall') Object.assign(s, { name: 'Crash', crash: true, fp: 'crash:home:Pro' });
    s.id = `${s.crash ? 'x' : 's'}${String(screens.length).padStart(3, '0')}`;
    if (!s.crash) {
      s.screenshot = `screens/${s.id}.png`;
      fs.writeFileSync(path.join(dir, s.screenshot), render(specs[key]()));
    }
    byKey[key] = s;
    screens.push(s);
  }
  if (head) byKey.settings.blocked = ['Abmelden', 'Konto löschen'];

  const edges = [];
  const add = (a, b, l) => byKey[a] && byKey[b] && edges.push({ from: byKey[a].id, to: byKey[b].id, action: { type: 'Button', label: l }, label: `tap ${l}` });
  for (const [key, , parent, via] of TREE) if (parent) add(parent, key, via);
  for (const [a, b, l] of EXTRA) add(a, b, l);

  const atlas = {
    version: 1,
    meta: { id, label, created, app: 'com.pulse.app', device: { platform: 'ios-sim', name: 'iPhone 16 (demo)', runtime: 'iOS 18.2', udid: 'demo' }, status: 'done', demo: true, durationMs: head ? 221_000 : 214_000 },
    screens,
    edges,
  };
  store.writeRun(id, atlas);
  return atlas;
}

export function createDemo(store) {
  store.ensure();
  const base = buildRun(store, { id: 'demo-v2.3.0', label: 'v2.3.0', created: '2026-11-20T09:00:00.000Z', version: 1 });
  const head = buildRun(store, { id: 'demo-v2.4.0', label: 'v2.4.0', created: '2026-11-26T09:00:00.000Z', version: 2 });
  store.baseline = base.meta.id;
  return { base: base.meta.id, head: head.meta.id };
}

export { render as renderWireframe, SPEC as WIREFRAMES };
