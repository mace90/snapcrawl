import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { totp } from './totp.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TAPPABLE = /^(button|cell|link|tab|tabbarbutton|menuitem|checkbox)$/i;
const BACK = /^(back|zurück|close|schließen|cancel|abbrechen|done|fertig)$/i;
const SUBMIT = /^(log ?in|sign ?in|anmelden|einloggen|continue|weiter|next|submit|verify|bestätigen|ok)$/i;
const OTP = /(code|otp|2fa|one[- ]?time|verification|bestätigung)/i;

const isText = (e) => /statictext/i.test(e.type);
const isField = (e) => /textfield|textview|searchfield/i.test(e.type);
const isSecure = (e) => /securetextfield/i.test(e.type);
const norm = (s) => String(s).toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
const center = (e) => ({ x: e.x + e.w / 2, y: e.y + e.h / 2 });
const clip = (s, n = 32) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * A screen's identity: the structure of its accessibility tree, not its pixels.
 * Numbers are masked so clocks, counters and prices do not create "new" screens.
 */
export function fingerprint(els) {
  const parts = els
    .filter((e) => !/^(application|window|other)$/i.test(e.type))
    .map((e) => (isText(e) ? 't:' + norm(e.label).slice(0, 40) : `${e.type}:${e.id || norm(e.label)}`));
  return crypto.createHash('sha1').update(parts.sort().join('|')).digest('hex').slice(0, 12);
}

function screenSize(els) {
  const app = els.find((e) => /application/i.test(e.type));
  return { w: app?.w || 393, h: app?.h || 852 };
}

function nameOf(els, size, via) {
  const head = els.find((e) => /heading|header|navigationbar/i.test(e.type) && e.label);
  if (head) return clip(head.label);
  const text = els
    .filter((e) => isText(e) && e.label.length > 1 && e.label.length <= 32 && e.y < size.h * 0.3)
    .sort((a, b) => a.y - b.y)[0];
  if (text) return clip(text.label);
  return via ? clip(via) : 'Start';
}

function actionsOf(els, size, blocklist) {
  const seen = new Set();
  const actions = [];
  const blocked = [];
  for (const e of els) {
    if (!TAPPABLE.test(e.type) || !e.enabled || e.w < 8 || e.h < 8) continue;
    const c = center(e);
    if (c.x < 0 || c.y < 0 || c.x > size.w || c.y > size.h) continue;
    const label = e.label.toLowerCase();
    if (label && blocklist.some((b) => label.includes(b.toLowerCase()))) {
      blocked.push(e.label);
      continue;
    }
    if (BACK.test(e.label)) continue;
    const key = `${e.type}:${e.id || norm(e.label) || `${Math.round(c.x)},${Math.round(c.y)}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push({ type: e.type, label: e.label, id: e.id, x: c.x, y: c.y });
  }
  actions.sort((a, b) => a.y - b.y || a.x - b.x);
  return { actions, blocked };
}

// Find the element an earlier action pointed at; fall back to its old coordinates.
function locate(els, ref) {
  const m = (ref.id && els.find((e) => e.id === ref.id)) || els.find((e) => e.type === ref.type && e.label && e.label === ref.label);
  return m ? center(m) : { x: ref.x, y: ref.y };
}

const refOf = (a) => ({ type: a.type, label: a.label, id: a.id, x: a.x, y: a.y });

/**
 * Breadth-first exploration of an app.
 *
 * io: { log(level, msg), ask(kind, prompt) -> Promise<string>, event(type, data), aborted() }
 * Returns the atlas (also written to <outDir>/runs/<id>/atlas.json while crawling).
 */
export async function crawl({ driver, cfg, store, io, label = '' }) {
  const c = cfg.crawl;
  const auth = cfg.auth;
  const log = (lvl, msg) => io.log(lvl, msg);
  const event = (type, data) => io.event?.(type, data);
  const settle = (f = 1) => sleep(c.settleMs * f);

  const runId = store.newRunId(label);
  const dir = store.runDir(runId);
  fs.mkdirSync(path.join(dir, 'screens'), { recursive: true });

  const started = Date.now();
  const deadline = started + c.timeLimitMin * 60_000;
  const atlas = {
    version: 1,
    meta: { id: runId, label, created: new Date(started).toISOString(), app: cfg.app.bundleId, device: null, status: 'running', limits: { maxDepth: c.maxDepth, maxScreens: c.maxScreens, timeLimitMin: c.timeLimitMin } },
    screens: [],
    edges: [],
  };
  const save = () => store.writeRun(runId, atlas);
  const byFp = new Map();
  let current = null; // fingerprint of what is on screen right now

  const observe = async () => {
    const els = await driver.elements();
    return { els, fp: fingerprint(els) };
  };

  const tapEl = async (e) => {
    const p = center(e);
    await driver.tap(p.x, p.y);
  };

  const submit = async (els) => {
    const buttons = els.filter((e) => /button/i.test(e.type) && e.enabled);
    const b = buttons.find((e) => SUBMIT.test(e.label)) || buttons.at(-1);
    if (b) await tapEl(b);
  };

  const isLogin = (els) => els.some(isSecure);
  const isOtp = (els) => !isLogin(els) && els.some((e) => isField(e) && OTP.test(`${e.label} ${e.value} ${e.id}`));

  async function manual(prompt) {
    log('WAIT', prompt);
    event('ask', { kind: 'manual', prompt });
    await io.ask('manual', prompt);
    await settle(1.5);
  }

  async function login(els) {
    if (auth.mfa === 'manual' || !auth.username || !auth.password) {
      await manual('Login screen detected. Log in on the simulator, then continue.');
      return;
    }
    log('AUTH', 'login form detected · filling credentials');
    const user = els.find((e) => isField(e) && !isSecure(e));
    const pass = els.find(isSecure);
    if (user) {
      await tapEl(user);
      await driver.type(auth.username);
    }
    await tapEl(pass);
    await driver.type(auth.password);
    await submit((await observe()).els);
    await settle(2);

    let o = await observe();
    if (isOtp(o.els)) {
      let code;
      if (auth.mfa === 'totp' && auth.totpSecret) {
        code = totp(auth.totpSecret);
        log('AUTH', '2fa · totp code generated');
      } else {
        log('WAIT', '2fa · code required');
        event('ask', { kind: 'code', prompt: 'Enter the 2FA code you received.' });
        code = String(await io.ask('code', 'Enter the 2FA code you received.')).trim();
      }
      const field = o.els.find(isField);
      if (field) await tapEl(field);
      await driver.type(code);
      await submit((await observe()).els);
      await settle(2);
      o = await observe();
    }

    if (isLogin(o.els) || isOtp(o.els)) {
      if (!auth.fallbackManual) throw new Error('Automatic login failed and manual fallback is disabled.');
      log('WARN', 'auto-login failed · falling back to manual login');
      await manual('Automatic login failed. Log in on the simulator, then continue.');
    } else {
      log('AUTH', 'logged in · session kept for the rest of the run');
    }
  }

  async function ensureAuth(o) {
    if (!isLogin(o.els)) return o;
    await login(o.els);
    return observe();
  }

  async function launch() {
    await driver.launch();
    await sleep(c.launchMs);
    const o = await ensureAuth(await observe());
    current = o.fp;
    return o;
  }

  async function register(o, depth, pathRefs, via) {
    const size = screenSize(o.els);
    const id = `s${String(atlas.screens.length).padStart(3, '0')}`;
    const file = `screens/${id}.png`;
    await driver.screenshot(path.join(dir, file));
    const { actions, blocked } = actionsOf(o.els, size, c.blocklist);
    const s = { id, name: nameOf(o.els, size, via), fp: o.fp, depth, path: pathRefs, screenshot: file, elements: o.els.length, size, actions, blocked };
    atlas.screens.push(s);
    byFp.set(o.fp, s);
    save();
    log('INFO', `screen.new ${id} "${s.name}" · ${o.els.length} elements · ${actions.length} actions · depth ${depth}`);
    for (const b of blocked) log('WARN', `action.skip "${b}" (blocklist)`);
    event('screen', { id, name: s.name, depth, screenshot: file, elements: s.elements });
    return s;
  }

  function addEdge(from, to, act) {
    if (atlas.edges.some((e) => e.from === from.id && e.to === to.id)) return;
    const edge = { from: from.id, to: to.id, action: { type: act.type, label: act.label }, label: `tap ${clip(act.label || act.type, 18)}` };
    atlas.edges.push(edge);
    event('edge', edge);
  }

  // Bring the app to screen s: stay, go back one level, or relaunch and replay the path.
  async function goTo(s) {
    let o = await observe();
    if (o.fp === s.fp) return o;
    const back = o.els.find((e) => /button/i.test(e.type) && BACK.test(e.label));
    if (back) {
      await tapEl(back);
      await settle();
      o = await observe();
      if (o.fp === s.fp) return o;
    }
    o = await launch();
    for (const ref of s.path) {
      const p = locate(o.els, ref);
      await driver.tap(p.x, p.y);
      await settle();
      o = await ensureAuth(await observe());
    }
    current = o.fp;
    if (o.fp !== s.fp) {
      log('WARN', `replay to ${s.id} landed on a different screen · skipping its remaining actions`);
      return null;
    }
    return o;
  }

  try {
    await driver.resolve();
    atlas.meta.device = { platform: driver.platform, name: driver.name, runtime: driver.runtime, udid: driver.udid };
    log('INFO', `device ${driver.name} · ${driver.runtime} · ${driver.udid}`);
    try {
      atlas.meta.appName = (await driver.listApps()).find((a) => a.bundleId === cfg.app.bundleId)?.name || '';
    } catch {}
    log('INFO', `app.launch ${atlas.meta.appName ? atlas.meta.appName + ' · ' : ''}${cfg.app.bundleId}`);
    event('run', { id: runId, device: atlas.meta.device });

    const root = await register(await launch(), 0, [], null);
    const queue = [root];
    const limit = () => atlas.screens.length >= c.maxScreens || Date.now() > deadline || io.aborted?.();

    outer: while (queue.length) {
      const s = queue.shift();
      if (s.depth >= c.maxDepth) continue;
      for (const act of s.actions) {
        if (limit()) {
          log('WARN', 'limit reached · stopping');
          break outer;
        }
        const o = await goTo(s);
        if (!o) break;
        const p = locate(o.els, act);
        log('STEP', `tap "${act.label || act.type}" on ${s.id}`);
        event('tap', { screen: s.id, x: p.x, y: p.y, size: s.size });
        await driver.tap(p.x, p.y);
        await settle();

        if (!(await driver.isRunning())) {
          const fp = `crash:${s.id}:${act.label}`;
          let cs = byFp.get(fp);
          if (!cs) {
            cs = { id: `x${String(atlas.screens.length).padStart(3, '0')}`, name: 'Crash', crash: true, fp, depth: s.depth + 1, path: [...s.path, refOf(act)], screenshot: null, elements: 0, actions: [], blocked: [] };
            atlas.screens.push(cs);
            byFp.set(fp, cs);
            event('screen', { id: cs.id, name: cs.name, depth: cs.depth, crash: true });
          }
          addEdge(s, cs, act);
          log('ERROR', `app.crash after tap "${act.label || act.type}" on ${s.id}`);
          current = null;
          save();
          continue;
        }

        const n = await ensureAuth(await observe());
        current = n.fp;
        if (n.fp === s.fp) continue; // tap did not navigate
        let t = byFp.get(n.fp);
        if (!t) {
          t = await register(n, s.depth + 1, [...s.path, refOf(act)], act.label);
          queue.push(t);
        }
        addEdge(s, t, act);
      }
    }
    atlas.meta.status = 'done';
  } catch (e) {
    atlas.meta.status = 'failed';
    atlas.meta.error = e.message;
    log('ERROR', e.message);
  } finally {
    atlas.meta.finished = new Date().toISOString();
    atlas.meta.durationMs = Date.now() - started;
    save();
  }
  const crashes = atlas.screens.filter((s) => s.crash).length;
  if (atlas.meta.status === 'done') log('DONE', `crawl.done ${atlas.screens.length - crashes} screens · ${atlas.edges.length} transitions · ${crashes} crashes · run ${runId}`);
  event('done', { id: runId, status: atlas.meta.status });
  return atlas;
}
