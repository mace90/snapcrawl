import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getGlobal, setGlobal } from './config.js';
import { DEFAULT_WDA_URL, IosDevice, Wda, devicectl, developerMode, listDevices } from './drivers/ios-device.js';
import { hasBinary, listSimulators } from './drivers/ios-sim.js';
import * as wdaKit from './wda.js';

// The actions behind both the web UI and the CLI. They report progress through `log(level, msg)`
// and throw errors whose message reads "<what> · <what to do>".

const exec = promisify(execFile);
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'snappcrawl.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};

const fail = (message, extra = {}) => Object.assign(new Error(message), extra);

/* ---------- simulators ---------- */

export async function bootSimulator(nameOrUdid, { log = quiet, open = true } = {}) {
  const sims = await listSimulators();
  const sim = sims.find((s) => s.udid === nameOrUdid || s.name === nameOrUdid) || (!nameOrUdid && sims[0]);
  if (!sim) throw fail(`no simulator "${nameOrUdid}" · snappcrawl devices lists them`, { status: 404 });
  if (sim.state !== 'Booted') {
    log('INFO', `booting ${sim.name} · ${sim.runtime}`);
    await exec('xcrun', ['simctl', 'boot', sim.udid], { timeout: 120_000 });
    await exec('xcrun', ['simctl', 'bootstatus', sim.udid, '-b'], { timeout: 180_000 }).catch(() => {});
  }
  if (open) {
    // the window is optional, the booted simulator is enough
    const dev = (await exec('xcode-select', ['-p']).catch(() => ({ stdout: '' }))).stdout.trim();
    if (dev) execFile('open', [path.join(dev, 'Applications', 'Simulator.app')], () => {});
  }
  return { ...sim, state: 'Booted' };
}

/* ---------- iPhones ---------- */

// Locked or not, through devicectl (works without WebDriverAgent).
export async function lockState(id, run = devicectl) {
  const r = (await run(['device', 'info', 'lockState', '--device', id]))?.result || {};
  return r.passcodeRequired === undefined ? 'unknown' : r.passcodeRequired ? 'locked' : 'unlocked';
}

// Everything the UI and the checklist show about one iPhone and its WebDriverAgent.
export async function iphoneStatus(d, { wdaUrl = DEFAULT_WDA_URL } = {}) {
  const [lock, devMode, wda] = await Promise.all([lockState(d.id).catch(() => 'unknown'), d.developerMode || developerMode(d.id).catch(() => ''), wdaState(wdaUrl)]);
  return { ...d, lock, developerMode: devMode || 'unknown', wda };
}

export async function wdaState(url = DEFAULT_WDA_URL) {
  const setup = wdaKit.readSetup();
  const pids = wdaKit.readPids();
  const w = new Wda(url);
  const st = await w.status(2500).catch(() => null);
  const ctl = st ? await w.canControl(8000) : null;
  return {
    url,
    built: !!setup,
    setup,
    running: !!(pids && wdaKit.alive(pids.xcodebuild)),
    reachable: !!st,
    control: !!ctl?.ok,
    notAuthorized: !!ctl?.notAuthorized,
    version: st?.build?.version || '',
    device: pids?.device || '',
  };
}

export async function teams() {
  return wdaKit.findTeams();
}

/* ---------- WebDriverAgent ---------- */

const TEAM_HELP = 'find your team id (10 characters) in Xcode → Settings → Accounts → your Apple ID, or on developer.apple.com/account → Membership details';

// Run a command into a log file; pass the interesting lines on.
function runLogged(cmd, args, logFile, pick, log) {
  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.createWriteStream(logFile);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let rest = '';
    const onData = (d) => {
      out.write(d);
      const lines = (rest + d).split('\n');
      rest = lines.pop();
      for (const l of lines) if (pick.test(l)) log(/error|failed/i.test(l) ? 'ERROR' : 'STEP', l.trim().slice(0, 200));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const beat = setInterval(() => log('STEP', 'still building …'), 20_000);
    child.on('close', (code) => {
      clearInterval(beat);
      out.end(() => resolve(code));
    });
  });
}

// A failure of xcodebuild: last log lines plus what to do on the iPhone.
function xcodeFailure(message, logFile) {
  const hints = wdaKit.diagnose(wdaKit.tail(logFile, 400));
  return fail(`${message}${hints.length ? ' · ' + hints[0] : ''}`, { hints, log: wdaKit.tail(logFile, 12), logFile });
}

async function pickDevice(udid) {
  return new IosDevice({ udid: udid || '' }).findDevice();
}

export async function wdaSetup({ team, udid, bundleId, log = quiet } = {}) {
  for (const b of ['git', 'xcodebuild']) if (!(await hasBinary(b))) throw fail(`${b} missing · install Xcode and its command line tools`);
  if (!team) {
    const found = await wdaKit.findTeams();
    if (found.length !== 1) throw fail(found.length ? `several teams found (${found.map((x) => x.team).join(', ')}) · pick one with --team` : `no Apple Development certificate · sign in to Xcode with your Apple ID, then ${TEAM_HELP}`, { teams: found });
    team = found[0].team;
    log('INFO', `team ${team} (${found[0].name || found[0].cert}) · read from your signing certificate`);
  }
  if (!/^[A-Z0-9]{10}$/.test(team)) throw fail(`"${team}" is not a team id · ${TEAM_HELP}`, { status: 400 });
  const dev = await pickDevice(udid);
  log('INFO', `device ${dev.name} · iOS ${dev.ios}`);
  const prev = wdaKit.readSetup();
  const id = bundleId || (prev?.team === team && prev.bundleId) || wdaKit.bundleIdFor(os.userInfo().username, team);

  const tag = wdaKit.latestTag((await exec('git', ['ls-remote', '--tags', '--refs', wdaKit.WDA_REPO], { timeout: 60_000 })).stdout);
  if (!tag) throw fail(`no release tag found at ${wdaKit.WDA_REPO}`);
  if (prev?.tag !== tag || !fs.existsSync(path.join(wdaKit.paths.repo, 'WebDriverAgent.xcodeproj'))) {
    log('INFO', `download WebDriverAgent ${tag}`);
    fs.rmSync(wdaKit.paths.repo, { recursive: true, force: true });
    fs.rmSync(wdaKit.paths.derived, { recursive: true, force: true });
    await exec('git', ['clone', '--quiet', '--depth', '1', '--branch', tag, wdaKit.WDA_REPO, wdaKit.paths.repo], { timeout: 300_000 });
  } else log('INFO', `WebDriverAgent ${tag} already downloaded`);

  log('INFO', `build · team ${team} · ${id} · takes 1–3 minutes`);
  const code = await runLogged('xcodebuild', wdaKit.xcodebuildArgs('build-for-testing', { udid: dev.udid, team, bundleId: id }), wdaKit.paths.buildLog, /(error:|BUILD SUCCEEDED|BUILD FAILED|TEST BUILD SUCCEEDED|TEST BUILD FAILED)/, log);
  if (code !== 0) throw xcodeFailure('WebDriverAgent build failed', wdaKit.paths.buildLog);
  const setup = { team, bundleId: id, tag, udid: dev.udid, device: dev.name, built: new Date().toISOString() };
  wdaKit.writeSetup(setup);
  log('DONE', `WebDriverAgent ${tag} built for ${dev.name}`);
  return setup;
}

export async function wdaStart({ udid, url = DEFAULT_WDA_URL, log = quiet, timeoutMs = 180_000 } = {}) {
  const setup = wdaKit.readSetup();
  if (!setup) throw fail('WebDriverAgent is not set up yet · snappcrawl wda setup (UI: Set up WebDriverAgent)');
  let dev;
  try {
    dev = await pickDevice(udid || setup.udid);
  } catch (e) {
    if (udid) throw e;
    dev = await pickDevice('');
  }
  const u = new URL(url);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  const port = Number(u.port || 8100);
  const wda = new Wda(url);
  if (dev.udid !== setup.udid) log('WARN', `built for ${setup.device}; if signing fails, set it up again with this iPhone connected`);

  const cur = wdaKit.readPids();
  if (cur && wdaKit.alive(cur.xcodebuild)) {
    const ctl = (await wda.status(3000).catch(() => null)) ? await wda.canControl(8000) : null;
    if (ctl?.ok && cur.udid === dev.udid) {
      log('INFO', `already running on ${cur.device}`);
      return wdaState(url);
    }
    log('INFO', 'restarting WebDriverAgent');
    wdaStop();
  } else if (local && (await wda.status(1500).catch(() => null))) {
    throw fail(`something already answers at ${url}, but snappcrawl did not start it · stop it, or set device.wdaUrl to another port`);
  }
  if (await lockState(dev.id).catch(() => '') === 'locked') log('WAIT', `${dev.name} is locked · unlock it, WebDriverAgent can only start on an unlocked iPhone`);

  fs.mkdirSync(wdaKit.WDA_HOME, { recursive: true });
  const out = fs.openSync(wdaKit.paths.runLog, 'w');
  const xb = spawn('xcodebuild', wdaKit.xcodebuildArgs('test-without-building', { udid: dev.udid, team: setup.team, bundleId: setup.bundleId }), { detached: true, stdio: ['ignore', out, out] });
  let exited = false;
  xb.on('exit', () => (exited = true));
  xb.unref();
  let fw = null;
  if (local) {
    const fo = fs.openSync(wdaKit.paths.forwardLog, 'w');
    fw = spawn(process.execPath, [BIN, 'wda', 'forward', '--device', dev.udid, '--port', String(port)], { detached: true, stdio: ['ignore', fo, fo] });
    fw.unref();
  }
  wdaKit.writePids({ xcodebuild: xb.pid, forward: fw?.pid || null, udid: dev.udid, device: dev.name, url, started: new Date().toISOString() });

  log('INFO', `installing and launching WebDriverAgent on ${dev.name} · keep it unlocked`);
  const t0 = Date.now();
  let st = null;
  let said = 0;
  while (!exited && Date.now() - t0 < timeoutMs) {
    st = await wda.status(3000).catch(() => null);
    if (st) break;
    if (Date.now() - said > 20_000 && Date.now() - t0 > 15_000) {
      said = Date.now();
      log('WAIT', wdaKit.diagnose(wdaKit.tail(wdaKit.paths.runLog, 200))[0] || 'still waiting for WebDriverAgent …');
    }
    await sleep(2000);
  }
  if (!st) {
    wdaStop();
    throw xcodeFailure(exited ? 'xcodebuild stopped before WebDriverAgent answered' : 'WebDriverAgent did not answer within 3 minutes', wdaKit.paths.runLog);
  }
  log('DONE', `WebDriverAgent ${st.build?.version || ''} running on ${dev.name} · ${url}`);
  return wdaState(url);
}

export function wdaStop() {
  const cur = wdaKit.readPids();
  if (!cur) return { stopped: false };
  const a = wdaKit.kill(cur.xcodebuild);
  const b = wdaKit.kill(cur.forward);
  wdaKit.clearPids();
  return { stopped: a || b, xcodebuild: a, forward: b };
}

// Before a crawl on an iPhone: start WebDriverAgent when it does not answer or lost control.
export async function ensureWda({ udid, url = DEFAULT_WDA_URL, log = quiet } = {}) {
  const s = await wdaState(url);
  if (s.reachable && s.control) return s;
  log('INFO', s.notAuthorized ? 'WebDriverAgent lost control of the iPhone · restarting it' : 'WebDriverAgent is not running · starting it');
  if (s.notAuthorized) wdaStop();
  return wdaStart({ udid, url, log });
}

/* ---------- runs ---------- */

export function deleteRun(store, id) {
  const runs = store.listRuns();
  const run = runs.find((r) => r.id === id);
  if (!run || !/^[\w.-]+$/.test(id)) throw fail(`no run "${id}" · snappcrawl runs lists them`, { status: 404 });
  fs.rmSync(store.runDir(id), { recursive: true, force: true });
  let diffs = 0;
  if (fs.existsSync(store.diffsDir)) {
    for (const d of fs.readdirSync(store.diffsDir)) {
      if (d.split('__').includes(id)) {
        fs.rmSync(path.join(store.diffsDir, d), { recursive: true, force: true });
        diffs++;
      }
    }
  }
  const wasBaseline = store.readBaselines()[run.app] === id;
  if (wasBaseline) store.clearBaseline(run.app);
  return { id, diffs, wasBaseline };
}

/* ---------- settings ---------- */

const mask = (v) => (v ? '•••' + String(v).slice(-4) : '');

// Global settings without secrets in clear text.
export function settings() {
  const g = structuredClone(getGlobal());
  if (g.ai?.apiKey) g.ai.apiKey = mask(g.ai.apiKey);
  return g;
}

const SETTABLE = /^(ai\.(provider|model|apiKey|baseUrl)|device\.(platform|udid|wdaUrl)|crawl\.\w+|diff\.\w+|outDir)$/;

export function setSetting(key, value) {
  if (!SETTABLE.test(key)) throw fail(`"${key}" cannot be set · e.g. ai.provider, ai.model, ai.apiKey, device.wdaUrl`, { status: 400 });
  if (key === 'ai.provider' && !['none', 'anthropic', 'openai', 'ollama'].includes(value)) throw fail('ai.provider must be none, anthropic, openai or ollama', { status: 400 });
  setGlobal(key, value);
  return settings();
}
