import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { signature, similarity } from './signature.js';
import { DEFAULT_DISMISS, alertFromElements, dismissButton, isConsent, isPermissionAlert, isWebLink, pickButton } from './interrupts.js';
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
 * Web content (ad banners, embedded pages) is left out: it rotates while the screen stays the same.
 * Only a screen that is nothing but web content is identified by it.
 */
export function fingerprint(els) {
  const part = (e) => (isText(e) ? 't:' + norm(e.label).slice(0, 40) : `${e.type}:${e.id || norm(e.label)}`);
  const relevant = els.filter((e) => !/^(application|window|other|webview)$/i.test(e.type));
  const own = relevant.filter((e) => !e.web);
  const parts = (own.length ? own : relevant).map(part);
  return crypto.createHash('sha1').update(parts.sort().join('|')).digest('hex').slice(0, 12);
}

function screenSize(els) {
  const app = els.find((e) => /application/i.test(e.type));
  return { w: app?.w || 393, h: app?.h || 852 };
}

/**
 * A readable screen name, ignoring web content:
 * navigation bar title → selected tab → first large text near the top → the action that led here.
 */
export function nameOf(els, size, via) {
  const own = els.filter((e) => !e.web);
  const nav = own.find((e) => /navigationbar/i.test(e.type) && (e.label || e.id));
  if (nav) return clip(nav.label || nav.id);
  const tab = own.find((e) => e.tab && e.selected && e.label);
  if (tab) return clip(tab.label);
  const texts = own
    .filter((e) => (isText(e) || /^(heading|header)$/i.test(e.type)) && !e.tab && e.label.length > 1 && e.label.length <= 40 && e.y < size.h * 0.35)
    .sort((a, b) => (b.header === true) - (a.header === true) || a.y - b.y);
  const big = texts.find((e) => e.header || e.h >= 20);
  if (big) return clip(big.label);
  if (via) return clip(via);
  return texts[0] ? clip(texts[0].label) : 'Start';
}

// "Profil", "Profil (2)", "Profil (3)" within one run.
export function uniqueName(seen, name) {
  const n = (seen.get(name) || 0) + 1;
  seen.set(name, n);
  return n === 1 ? name : `${name} (${n})`;
}

function actionsOf(els, size, blocklist, { webLinks = 'skip' } = {}) {
  const seen = new Set();
  const actions = [];
  const blocked = [];
  const web = [];
  for (const e of els) {
    if (!TAPPABLE.test(e.type) || !e.enabled || e.w < 8 || e.h < 8) continue;
    const c = center(e);
    if (c.x < 0 || c.y < 0 || c.x > size.w || c.y > size.h) continue;
    if (webLinks !== 'tap' && isWebLink(e)) {
      web.push(e.label || e.id || 'link');
      continue;
    }
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
  return { actions, blocked, web: [...new Set(web)] };
}

const appLabel = (els) => els.find((e) => /^application$/i.test(e.type))?.label || '';

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
  const byId = new Map();
  const names = new Map();
  const dismissWords = c.dismiss || DEFAULT_DISMISS;
  const alertMode = c.systemAlerts || 'dismiss'; // dismiss | accept | pause
  atlas.meta.warnings = [];
  const warn = (msg) => {
    atlas.meta.warnings.push(msg);
    log('WARN', msg);
  };
  let root = null;
  let entry = null; // where the app opens: the root, or a later "launch screen" once the root was one-time
  let rootApp = ''; // Application label of the app, to notice when another app is in front
  const threshold = c.matchThreshold ?? 0.8;

  // How well what is on screen matches a known screen: 1 for the same fingerprint, else the
  // similarity of their signatures (stable parts only, see signature.js).
  const score = (o, s) => (!s || s.crash ? 0 : o.fp === s.fp ? 1 : similarity(o.sig, s.sig));
  const is = (o, s) => score(o, s) >= threshold;
  function known(o) {
    const exact = byFp.get(o.fp);
    if (exact && !exact.crash) return exact;
    let best = null;
    let top = threshold;
    for (const s of atlas.screens) {
      const v = score(o, s);
      if (v >= top) [best, top] = [s, v];
    }
    return best;
  }

  // Answer a permission prompt as configured. WDA has alert endpoints; on the simulator the
  // prompt is in the accessibility tree.
  async function answerAlert(a) {
    if (alertMode === 'pause') {
      await manual(`System alert "${clip(a.text.replace(/\s+/g, ' '), 80)}". Answer it on the device, then continue.`, 'alert');
      return;
    }
    const button = pickButton(a.buttons, alertMode);
    log('INFO', `alert "${clip(a.text.replace(/\s+/g, ' '), 60)}" → ${alertMode}${button ? ` "${button}"` : ''}`);
    if (a.els) {
      const el = a.els.find((e) => e.label === button) || (alertMode === 'accept' ? a.els.at(-1) : a.els[0]);
      await tapEl(el);
    } else await driver.alertAction(alertMode === 'accept' ? 'accept' : 'dismiss', button);
    await settle();
  }

  const observe = async () => {
    for (let i = 0; ; i++) {
      if (driver.alert && i < 3) {
        const a = await driver.alert().catch(() => null);
        if (a && isPermissionAlert(a.buttons)) {
          await answerAlert(a);
          continue;
        }
      }
      const els = await driver.elements();
      const a = !driver.alert && i < 3 ? alertFromElements(els) : null;
      if (a) {
        await answerAlert(a);
        continue;
      }
      return { els, fp: fingerprint(els), sig: signature(els) };
    }
  };

  // Tap away onboarding sheets and hints until a wanted screen (predicate) is on screen, or
  // nothing is left to dismiss. Cookie and privacy screens are never touched.
  async function dismissInterstitials(o, want, why) {
    for (let i = 0; i < 3; i++) {
      if (want && want(o)) return o;
      if (isConsent(o.els)) return o;
      const b = dismissButton(o.els, dismissWords);
      if (!b) return o;
      log('INFO', `dismiss "${b.label}" (${why})`);
      await tapEl(b);
      await settle(1.5);
      o = await observe();
    }
    return o;
  }

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

  async function manual(prompt, kind = 'manual') {
    log('WAIT', prompt);
    event('ask', { kind, prompt });
    await io.ask(kind, prompt);
    await settle(1.5);
  }

  async function login(els) {
    if (auth.mfa === 'manual' || !auth.username || !auth.password) {
      await manual('Login screen detected. Log in on the device, then continue.');
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
      await manual('Automatic login failed. Log in on the device, then continue.');
    } else {
      log('AUTH', 'logged in · session kept for the rest of the run');
    }
  }

  async function ensureAuth(o) {
    if (!isLogin(o.els)) return o;
    await login(o.els);
    return observe();
  }

  // First start: optional manual preparation, otherwise dismiss whatever covers the start screen.
  async function start() {
    await driver.launch();
    await sleep(c.launchMs);
    let o = await ensureAuth(await observe());
    if (c.prepare) {
      await manual('Bring the app to the screen where the crawl should start, then continue.', 'prepare');
      o = await ensureAuth(await observe());
    } else o = await dismissInterstitials(o, null, 'start');
    rootApp = appLabel(o.els);
    return o;
  }

  // Later starts should reach one of `targets` (the screens of the path being replayed):
  // dismiss what is in the way, leave privacy decisions to the user.
  async function relaunch(targets) {
    await driver.launch();
    await sleep(c.launchMs);
    let o = await ensureAuth(await observe());
    const hit = (x) => targets.some((t) => is(x, t));
    if (hit(o)) return o;
    o = await dismissInterstitials(o, hit, 'after launch');
    if (!hit(o) && isConsent(o.els)) {
      if (c.prepare) {
        await manual('A cookie or privacy screen appeared. Decide on the device, bring the app back to the start screen, then continue.', 'prepare');
        o = await ensureAuth(await observe());
      } else warn('cookie or privacy screen after launch · not decided automatically (decide once on the device, or use --prepare)');
    }
    return o;
  }

  async function register(o, depth, pathRefs, via, parent = null) {
    const size = screenSize(o.els);
    const id = `s${String(atlas.screens.length).padStart(3, '0')}`;
    const file = `screens/${id}.png`;
    await driver.screenshot(path.join(dir, file));
    const consent = isConsent(o.els);
    const { actions, blocked, web } = consent ? { actions: [], blocked: [], web: [] } : actionsOf(o.els, size, c.blocklist, { webLinks: c.webLinks });
    const s = { id, name: uniqueName(names, nameOf(o.els, size, via)), fp: o.fp, sig: o.sig, depth, path: pathRefs, parent, screenshot: file, elements: o.els.length, size, actions, blocked };
    if (consent) s.consent = true;
    atlas.screens.push(s);
    byFp.set(o.fp, s);
    byId.set(id, s);
    save();
    log('INFO', `screen.new ${id} "${s.name}" · ${o.els.length} elements · ${actions.length} actions · depth ${depth}`);
    for (const b of blocked) log('WARN', `action.skip "${b}" (blocklist)`);
    for (const w of web) log('STEP', `action.skip "${clip(w)}" (web link)`);
    event('screen', { id, name: s.name, depth, screenshot: file, elements: s.elements });
    return s;
  }

  function addEdge(from, to, act) {
    if (atlas.edges.some((e) => e.from === from.id && e.to === to.id)) return;
    const edge = { from: from.id, to: to.id, action: { type: act.type, label: act.label }, label: `tap ${clip(act.label || act.type, 18)}` };
    atlas.edges.push(edge);
    event('edge', edge);
  }

  // Screens from the entry point to s, following the screen each one was discovered from.
  const chain = (s) => {
    const out = [];
    for (let x = s; x; x = x === entry ? null : x.parent ? byId.get(x.parent) : null) out.unshift(x);
    return out;
  };
  const ancestry = (s) => {
    const ids = [];
    for (let x = s; x; x = x.parent ? byId.get(x.parent) : null) ids.push(x.id);
    return ids;
  };

  // The app no longer opens on the entry screen, twice in a row on the same other screen
  // (typically an onboarding that is shown once): that screen becomes the launch screen and
  // everything only reachable through the old entry is one-time. Not a warning.
  let miss = null;
  async function checkEntry(o) {
    if (is(o, entry) || isConsent(o.els)) {
      miss = null;
      return;
    }
    const k = known(o);
    if (k?.oneTime) return;
    const key = k ? k.id : `new:${o.fp}`;
    miss = miss?.key === key ? { key, n: miss.n + 1 } : { key, n: 1 };
    if (miss.n < 2) return;
    miss = null;
    const next = k || (await register(o, 0, [], null, null));
    const cut = next.path.length;
    let n = 0;
    for (const s of atlas.screens) {
      if (ancestry(s).includes(next.id)) s.path = s.path.slice(cut); // paths relative to the launch screen
      else if (!s.oneTime) {
        s.oneTime = true;
        n++;
      }
    }
    next.launch = true;
    next.parent = null;
    entry = next;
    log('INFO', `launch screen is now ${next.id} "${next.name}" · ${n} one-time screen${n === 1 ? '' : 's'} before it`);
    event('launch', { id: next.id });
    save();
  }

  // Bring the app to screen s: stay, go back one level, or relaunch and replay the path from the
  // deepest screen of it that is showing. Every step is checked by similarity; a step that lands
  // elsewhere gets the dismiss treatment; a failed replay is retried once from a fresh start.
  async function goTo(s) {
    if (s.oneTime) return null;
    let o = await observe();
    if (is(o, s)) return o;
    const back = o.els.find((e) => /button/i.test(e.type) && BACK.test(e.label));
    if (back) {
      await tapEl(back);
      await settle();
      o = await observe();
      if (is(o, s)) return o;
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      o = await relaunch(chain(s));
      await checkEntry(o);
      if (s.oneTime) return null;
      const steps = chain(s);
      let k = -1;
      for (let j = steps.length - 1; j >= 0 && k < 0; j--) if (is(o, steps[j])) k = j;
      for (let i = k + 1; k >= 0 && i < steps.length; i++) {
        const p = locate(o.els, steps[i].path.at(-1));
        await driver.tap(p.x, p.y);
        await settle();
        o = await ensureAuth(await observe());
        if (!is(o, steps[i])) o = await dismissInterstitials(o, (x) => is(x, steps[i]), 'replay');
        if (!is(o, steps[i])) break;
      }
      const m = score(o, s);
      if (m >= threshold) {
        log('STEP', `replay ${s.id} ok · match ${m.toFixed(2)}`);
        return o;
      }
      if (attempt === 1) log('INFO', `replay to ${s.id} landed elsewhere (match ${m.toFixed(2)}) · starting the app once more`);
    }
    warn(`replay to ${s.id} "${s.name}" failed twice · skipping its remaining actions`);
    return null;
  }

  // 4 = in front. Drivers without app state: running or not, plus who owns the screen.
  const appState = async () => (driver.appState ? Number(await driver.appState()) : (await driver.isRunning()) ? 4 : 1);

  try {
    await driver.resolve();
    atlas.meta.device = { platform: driver.platform, name: driver.name, runtime: driver.runtime, udid: driver.udid };
    if (driver.statusBar) atlas.meta.device.statusBar = driver.statusBar; // points, used to mask it in diffs
    log('INFO', `device ${driver.name} · ${driver.runtime} · ${driver.udid}`);
    try {
      atlas.meta.appName = (await driver.listApps()).find((a) => a.bundleId === cfg.app.bundleId)?.name || '';
    } catch {}
    log('INFO', `app.launch ${atlas.meta.appName ? atlas.meta.appName + ' · ' : ''}${cfg.app.bundleId}`);
    event('run', { id: runId, device: atlas.meta.device });

    root = await register(await start(), 0, [], null);
    entry = root;
    if (root.consent) warn(`the start screen asks for a cookie or privacy decision · not decided automatically. Decide once on the device, or crawl with --prepare`);
    const queue = [root];
    const limit = () => atlas.screens.length >= c.maxScreens || Date.now() > deadline || io.aborted?.();

    outer: while (queue.length) {
      const s = queue.shift();
      if (s.depth >= c.maxDepth || s.oneTime) continue;
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

        const state = await appState();
        if (state !== 4 && state > 1) {
          // Safari or another app came to the front: note it, go back, register nothing
          warn(`left app after tap "${act.label || act.type}" on ${s.id} · returning`);
          await (driver.activate ? driver.activate() : driver.launch());
          await settle();
          continue;
        }
        if (state <= 1) {
          const fp = `crash:${s.id}:${act.label}`;
          let cs = byFp.get(fp);
          if (!cs) {
            cs = { id: `x${String(atlas.screens.length).padStart(3, '0')}`, name: 'Crash', crash: true, fp, depth: s.depth + 1, path: [...s.path, refOf(act)], parent: s.id, screenshot: null, elements: 0, actions: [], blocked: [] };
            byId.set(cs.id, cs);
            atlas.screens.push(cs);
            byFp.set(fp, cs);
            event('screen', { id: cs.id, name: cs.name, depth: cs.depth, crash: true });
          }
          addEdge(s, cs, act);
          log('ERROR', `app.crash after tap "${act.label || act.type}" on ${s.id}`);
          save();
          continue;
        }

        const n = await ensureAuth(await observe());
        if (rootApp && appLabel(n.els) && appLabel(n.els) !== rootApp) {
          warn(`left app after tap "${act.label || act.type}" on ${s.id} (${appLabel(n.els)} in front) · returning`);
          await (driver.activate ? driver.activate() : driver.launch());
          await settle();
          continue;
        }
        if (is(n, s)) continue; // tap did not navigate (or only changed content)
        let t = known(n);
        if (!t && isConsent(n.els)) {
          warn(`cookie or privacy screen after tap "${act.label || act.type}" on ${s.id} · skipped, not decided automatically`);
          continue;
        }
        if (!t) {
          t = await register(n, s.depth + 1, [...s.path, refOf(act)], act.label, s.id);
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
