#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { aiReady, annotate } from '../src/ai.js';
import { GLOBAL_FILE, LOCAL_FILE, TEMPLATE, getGlobal, loadConfig, setGlobal } from '../src/config.js';
import { crawl } from '../src/crawler.js';
import { createDemo } from '../src/demo.js';
import { buildReport } from '../src/diff.js';
import { listAllDevices, makeDriver } from '../src/drivers/index.js';
import { DEFAULT_WDA_URL, IosDevice, Wda, developerMode, listDevices } from '../src/drivers/ios-device.js';
import { hasBinary, listSimulators } from '../src/drivers/ios-sim.js';
import { startForwarder, usbmuxAvailable } from '../src/usbmux.js';
import * as wdaKit from '../src/wda.js';
import { applyReview, decisionOf, needsReview, renderReport, reportFileName, reviewState } from '../src/report.js';
import { startServer } from '../src/server.js';
import { Store } from '../src/store.js';
import * as t from '../src/term.js';

const BIN = fileURLToPath(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

const HELP = `
${t.bold('snapcrawl')} ${t.gray('v' + pkg.version)}  crawl an iOS app, map every screen, diff builds

${t.bold('Usage')}
  snapcrawl <command> [options]

${t.bold('Commands')}
  doctor                      check Xcode, idb and the simulator
  devices                     list simulators and USB-connected iPhones
  apps                        list apps on the simulator, or on an iPhone with --device
  init                        write ${LOCAL_FILE} in this folder
  crawl                       explore the app and capture every screen
  runs                        list previous runs
  baseline [run]              show or set the baseline run
  diff [base] [head]          compare two runs (default: baseline vs the newest run after it)
  review [base] [head]        list the changes and their decisions
  review <id|all> <approve|reject|undo> [base] [head]
                              decide like in the UI · "all" = every open change
  report [base] [head]        write a standalone HTML report (default: summary)
  ui                          open the local web UI (graph, live crawl, review)
  demo                        create two sample runs to try the UI without a simulator
  config set <key> <value>    save a global setting, e.g. ai.provider anthropic
  wda setup --team <TEAM_ID>  download and build WebDriverAgent for the connected iPhone
  wda start [--udid <iphone>] start WebDriverAgent on the iPhone and forward port 8100
  wda stop | wda status       stop it, or show whether it is running

${t.bold('Crawl options')}
  --bundle <id>               app bundle id (or app.bundleId in ${LOCAL_FILE})
  --udid <udid|name>          simulator (default: the booted one)
  --device <udid|name>        real iPhone over USB (needs: snapcrawl wda start)
  --label <text>              tag the run, e.g. v2.4.0
  --max-depth <n>             default 8
  --max-screens <n>           default 200
  --mfa <none|totp|prompt|manual>
  --diff                      compare against the baseline when done
  --prepare                   pause after launch: accept cookies, close onboarding, open the start screen

${t.bold('Other options')}
  --config <file>             use another config file
  --port <n>                  ui port (default 4747)
  --no-open                   do not open the browser
  --ai                        add model notes to a diff (needs ai.provider)
  --full                      report: graph, screenshots and pixel diffs
  --out <file>                report: output file (default .snapcrawl/reports/)
  -h, --help  -v, --version

${t.bold('Real iPhone')}
  1. Xcode → Settings → Accounts: sign in with your Apple ID (a free one works).
  2. iPhone: connect by USB, unlock, tap Trust; Settings → Privacy & Security → Developer Mode on.
  3. snapcrawl wda setup --team <TEAM_ID>
     The team id is 10 characters, e.g. AB12CD34EF. Find it in Xcode → Settings → Accounts →
     your Apple ID → team, on developer.apple.com/account → Membership details, or let
     snapcrawl read it from your signing certificate: snapcrawl wda setup (without --team).
     Optional: --bundle-id <id> if Apple rejects the generated one.
  4. snapcrawl wda start, then snapcrawl crawl --device "<name>" --bundle <app>
`;

const { values: opt, positionals: pos } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    bundle: { type: 'string' },
    udid: { type: 'string' },
    label: { type: 'string' },
    'max-depth': { type: 'string' },
    'max-screens': { type: 'string' },
    device: { type: 'string' },
    team: { type: 'string' },
    'bundle-id': { type: 'string' },
    mfa: { type: 'string' },
    config: { type: 'string' },
    port: { type: 'string' },
    'no-open': { type: 'boolean' },
    diff: { type: 'boolean' },
    prepare: { type: 'boolean' },
    ai: { type: 'boolean' },
    full: { type: 'boolean' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});

const cmd = pos[0];
const cfg = loadConfig(opt.config);
const store = new Store(cfg.outDir).ensure();

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, (err) => resolve(!err)));
const capture = async (cmd, args, timeout = 120_000) => (await promisify(execFile)(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 })).stdout;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wdaUrl = () => cfg.device.wdaUrl || DEFAULT_WDA_URL;

// --device = real iPhone, --udid = simulator, otherwise device.platform from the config.
function driverOpts() {
  const platform = opt.device ? 'ios-device' : opt.udid ? 'ios-sim' : cfg.device.platform;
  const udid = opt.device || opt.udid || (cfg.device.platform === platform ? cfg.device.udid : '');
  return { platform, udid, wdaUrl: wdaUrl() };
}

function openBrowser(url) {
  const bin = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  execFile(bin, [url], () => {});
}

function printReport(r) {
  const s = r.summary;
  t.title('diff', `${r.base.label || r.base.id} → ${r.head.label || r.head.id}`);
  t.table([
    [t.green('same'), s.same],
    [t.yellow('changed'), s.changed],
    [t.cyan('new'), s.new],
    [t.red('broken'), s.bad],
    ...(s.skipped ? [[t.gray('one-time'), s.skipped]] : []),
  ]);
  const rows = r.screens
    .filter((x) => x.status !== 'same')
    .map((x) => [x.id, x.name, { changed: t.yellow, new: t.cyan, bad: t.red, skipped: t.gray }[x.status](x.reason || x.status), x.ratio != null ? (x.ratio * 100).toFixed(2) + ' %' : '', r.notes[x.id]?.summary ? t.gray(r.notes[x.id].summary) : '']);
  if (rows.length) {
    console.log();
    t.table(rows, { head: ['id', 'screen', 'status', 'Δ px', 'note'] });
  }
  console.log(`\n  ${t.gray('review in the browser:')} snapcrawl ui  ${t.gray('· or in the terminal:')} snapcrawl review\n`);
}

const RESULT = { passed: t.green, failed: t.red, 'in review': t.yellow };
const DECISION = { approved: t.green, rejected: t.red, open: t.white, passed: t.green };
const STATUS = { changed: 'changed', new: 'new', bad: 'broken' };
const pct = (r) => (r != null ? (r * 100).toFixed(2) + ' %' : '');

// Explicit runs work in any direction; otherwise the same default as the UI (store.defaultPair).
function pickRuns(baseArg, headArg) {
  if (headArg) {
    const headRun = store.listRuns().find((r) => r.id === headArg && r.status === 'done');
    if (!headRun) throw new Error(`no finished run "${headArg}" · snapcrawl runs lists them`);
    const base = baseArg || store.baselineFor(headRun.app);
    if (!base) throw new Error(`${headRun.appName || headRun.app} has no baseline yet · pass base and head explicitly`);
    return { base, head: headRun.id };
  }
  const pair = store.defaultPair();
  if (pair.error) throw new Error(pair.error);
  return { base: baseArg || pair.base, head: pair.head };
}

// Reuse the stored report so review decisions made in the UI or CLI are kept.
const loadReport = ({ base, head }) => store.readReport(base, head) || buildReport({ store, baseId: base, headId: head, cfg });

function printState(r) {
  const st = reviewState(r);
  console.log(`  ${t.gray('reviewed')} ${st.reviewed}/${st.total}  ${t.gray('approved')} ${st.approved}  ${t.gray('rejected')} ${st.rejected}  ${t.gray('result')} ${RESULT[st.result](st.result)}`);
}

const commands = {
  async doctor() {
    t.title('doctor');
    const checks = [];
    const major = Number(process.versions.node.split('.')[0]);
    checks.push(major >= 20 ? t.ok(`node ${process.versions.node}`) : t.fail(`node ${process.versions.node} · need 20 or newer`));
    const isMac = process.platform === 'darwin';
    checks.push(isMac ? t.ok('macOS') : t.fail(`${process.platform} · the iOS Simulator needs macOS`));
    const xcrun = await hasBinary('xcrun');
    checks.push(xcrun ? t.ok('xcrun (Xcode command line tools)') : t.fail('xcrun missing · install Xcode from the App Store, then: xcode-select --install'));
    if (xcrun) {
      const simctl = await run('xcrun', ['simctl', 'help']);
      checks.push(simctl ? t.ok('simctl (Xcode)') : t.fail('simctl missing · install Xcode, then: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer'));
      const license = await run('xcodebuild', ['-license', 'check']);
      checks.push(license ? t.ok('Xcode license accepted') : t.fail('Xcode license not accepted · sudo xcodebuild -license accept'));
    }
    const idb = await hasBinary('idb');
    checks.push(idb ? t.ok('idb') : t.fail('idb missing · pipx install fb-idb'));
    const companion = await hasBinary('idb_companion');
    checks.push(companion ? t.ok('idb_companion') : t.fail('idb_companion missing · brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion'));
    if (xcrun) {
      try {
        const booted = (await listSimulators()).filter((s) => s.state === 'Booted');
        checks.push(booted.length ? t.ok(`booted simulator: ${booted.map((b) => `${b.name} (${b.runtime})`).join(', ')}`) : t.warn('no simulator booted · snapcrawl devices, then: xcrun simctl boot "<name>"'));
      } catch (e) {
        checks.push(t.fail(e.message));
      }
    }
    if (xcrun) {
      let devs = [];
      try {
        devs = await listDevices();
        checks.push(devs.length ? t.ok(`iPhone: ${devs.map((d) => `${d.name} (iOS ${d.ios}, ${d.transport === 'wired' ? 'USB' : 'Wi-Fi'})`).join(', ')}`) : t.gray('· no iPhone connected (optional) · connect one by USB, unlock it and tap Trust'));
      } catch (e) {
        checks.push(t.fail(`devicectl · ${e.message} · needs Xcode 15 or newer`));
      }
      for (const d of devs) {
        if (!d.paired) checks.push(t.fail(`${d.name} does not trust this Mac · unlock it and tap Trust`));
        d.developerMode ||= await developerMode(d.id).catch(() => '');
        if (d.developerMode === 'enabled') checks.push(t.ok(`${d.name}: Developer Mode on`));
        else if (!d.developerMode) checks.push(t.gray(`· ${d.name}: Developer Mode unknown · if WDA does not start: Settings → Privacy & Security → Developer Mode`));
        else checks.push(t.fail(`${d.name}: Developer Mode ${d.developerMode} · iPhone: Settings → Privacy & Security → Developer Mode, then restart`));
      }
      if (devs.length) {
        checks.push(usbmuxAvailable() ? t.ok('usbmuxd · port forwarding to the iPhone (built in)') : t.fail('usbmuxd socket missing · reinstall Xcode'));
        checks.push((await hasBinary('iproxy')) ? t.ok('iproxy (optional, snapcrawl forwards ports itself)') : t.gray('· iproxy not installed (optional, snapcrawl forwards ports itself)'));
        const setup = wdaKit.readSetup();
        checks.push(setup ? t.ok(`WebDriverAgent ${setup.tag} built · team ${setup.team} · ${setup.bundleId}`) : t.warn('WebDriverAgent not built · snapcrawl wda setup --team <TEAM_ID>'));
        const st = await new Wda(wdaUrl()).status(3000).catch(() => null);
        const ctl = st ? await new Wda(wdaUrl()).canControl() : null;
        checks.push(!st ? t.warn(`WebDriverAgent not reachable at ${wdaUrl()} · snapcrawl wda start`) : ctl.ok ? t.ok(`WebDriverAgent reachable at ${wdaUrl()} and in control`) : t.fail(ctl.notAuthorized ? 'WebDriverAgent answers but may not control the iPhone (it was locked) · snapcrawl wda stop && snapcrawl wda start' : `WebDriverAgent · ${ctl.error}`));
      }
    }
    checks.push(cfg._file ? t.ok(`config ${path.relative(process.cwd(), cfg._file)}`) : t.warn(`no ${LOCAL_FILE} · run snapcrawl init`));
    checks.push(aiReady(cfg.ai) ? t.ok(`ai ${cfg.ai.provider}/${cfg.ai.model}`) : t.gray('· ai off (optional)'));
    for (const c of checks) console.log('  ' + c);
    console.log();
  },

  async devices() {
    t.title('devices', 'iOS Simulator and USB');
    const { sims, devices, errors } = await listAllDevices();
    const rows = [
      ...devices.map((d) => [t.cyan(d.transport === 'wired' ? 'usb' : 'wi-fi'), d.paired ? t.green('● connected') : t.yellow('● not trusted'), d.name, t.gray(`iOS ${d.ios}`), t.gray(d.udid)]),
      ...sims.map((s) => ['simulator', s.state === 'Booted' ? t.green('● booted') : t.gray('○ ' + s.state.toLowerCase()), s.name, t.gray(s.runtime), t.gray(s.udid)]),
    ];
    if (rows.length) t.table(rows, { head: ['type', 'state', 'name', 'runtime', 'udid'] });
    for (const e of errors) console.log('  ' + t.warn(e));
    if (devices.length) console.log(`\n  ${t.gray('crawl the iPhone:')} snapcrawl wda start, then snapcrawl crawl --device "${devices[0].name}" --bundle <id>`);
    console.log();
  },

  async apps() {
    const d = makeDriver(driverOpts());
    await (d.findDevice ? d.findDevice() : d.resolve());
    t.title('apps', `${d.name} · ${d.runtime}`);
    const apps = await d.listApps();
    t.table(apps.map((a) => [a.name, a.bundleId, t.gray(a.type || '')]), { head: ['name', 'bundle id', 'type'] });
    console.log();
  },

  async init() {
    if (fs.existsSync(LOCAL_FILE)) return console.log(t.warn(`${LOCAL_FILE} already exists`));
    fs.writeFileSync(LOCAL_FILE, JSON.stringify(TEMPLATE, null, 2) + '\n');
    console.log(t.ok(`wrote ${LOCAL_FILE}`));
    console.log(t.gray(`  set app.bundleId, then export SNAPCRAWL_USERNAME / SNAPCRAWL_PASSWORD if the app needs a login.`));
    if (fs.existsSync('.gitignore') && !fs.readFileSync('.gitignore', 'utf8').includes('.snapcrawl')) fs.appendFileSync('.gitignore', '\n.snapcrawl/\n');
  },

  async crawl() {
    cfg.app.bundleId = opt.bundle || cfg.app.bundleId;
    if (!cfg.app.bundleId) throw new Error(`No app given. Use --bundle com.example.app or set app.bundleId in ${LOCAL_FILE} (snapcrawl apps lists bundle ids).`);
    if (opt['max-depth']) cfg.crawl.maxDepth = Number(opt['max-depth']);
    if (opt['max-screens']) cfg.crawl.maxScreens = Number(opt['max-screens']);
    if (opt.mfa) cfg.auth.mfa = opt.mfa;
    if (opt.prepare) cfg.crawl.prepare = true;
    const driver = makeDriver({ ...driverOpts(), bundleId: cfg.app.bundleId });
    t.title('crawl', `${cfg.app.bundleId} · ${driver.platform === 'ios-device' ? 'iPhone' : 'simulator'} · depth ≤ ${cfg.crawl.maxDepth} · ≤ ${cfg.crawl.maxScreens} screens`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let stop = false;
    process.on('SIGINT', () => {
      if (stop) process.exit(130);
      stop = true;
      t.logLine('WARN', 'stopping after the current step · press ctrl-c again to quit');
    });
    const io = {
      log: t.logLine,
      ask: async (kind, prompt) => (await rl.question(`         ${t.white('→')} ${kind === 'code' ? 'code: ' : 'press enter to continue '}`)).trim(),
      aborted: () => stop,
    };
    const atlas = await crawl({ driver, cfg, store, io, label: opt.label || '' });
    rl.close();
    if (atlas.meta.status !== 'done') process.exitCode = 1;
    const baseline = store.baselineFor(atlas.meta.app);
    if (!baseline && atlas.meta.status === 'done') {
      store.setBaseline(atlas.meta.id);
      console.log(`\n  ${t.gray('first run of this app → saved as baseline:')} ${atlas.meta.id}`);
    } else if (opt.diff && baseline && baseline !== atlas.meta.id) {
      printReport(buildReport({ store, baseId: baseline, headId: atlas.meta.id, cfg }));
    }
    console.log(`\n  ${t.gray('next:')} snapcrawl ${opt.diff ? 'ui' : 'diff'}\n`);
  },

  async runs() {
    t.title('runs', store.root);
    const b = store.readBaselines();
    const runs = store.listRuns();
    if (!runs.length) return console.log(t.gray('  no runs yet · snapcrawl crawl or snapcrawl demo\n'));
    t.table(runs.map((r) => [b[r.app] === r.id ? t.white('◆') : ' ', r.id, r.label, r.appName || r.app, `${r.screens} screens`, r.crashes ? t.red(`${r.crashes} crash`) : '', t.gray(r.status)]), { head: ['', 'run', 'label', 'app', 'size', '', 'status'] });
    console.log(t.gray('\n  ◆ baseline of its app\n'));
  },

  async baseline() {
    if (pos[1]) console.log(t.ok(`baseline for ${store.setBaseline(pos[1])}: ${pos[1]}`));
    const all = Object.entries(store.readBaselines());
    if (!pos[1]) all.length ? t.table(all.map(([app, id]) => [app, id]), { head: ['app', 'baseline'] }) : console.log(t.gray('no baseline yet'));
  },

  async diff() {
    const { base, head } = pickRuns(pos[1], pos[2]);
    let report = buildReport({ store, baseId: base, headId: head, cfg });
    if (opt.ai) {
      t.logLine('INFO', `notes via ${cfg.ai.provider}/${cfg.ai.model}`);
      report = await annotate({ store, report, cfg, onProgress: (n, total, s) => t.logLine('STEP', `${n}/${total} ${s.name}`) });
    }
    printReport(report);
    if (report.summary.bad) process.exitCode = 1;
  },

  async review() {
    const action = pos[2];
    if (['approve', 'reject', 'undo'].includes(action)) {
      const r = loadReport(pickRuns(pos[3], pos[4]));
      const ids = applyReview(r, pos[1], action);
      store.writeReport(r);
      t.title('review', `${r.base.label || r.base.id} → ${r.head.label || r.head.id}`);
      const names = ids.map((id) => r.screens.find((s) => s.id === id).name);
      console.log('  ' + (ids.length ? t.ok(`${action} · ${ids.length} screen${ids.length === 1 ? '' : 's'}: ${names.join(', ')}`) : t.gray(`nothing to ${action}`)));
      console.log();
      printState(r);
      console.log(`\n  ${t.gray('next:')} snapcrawl ${reviewState(r).open ? 'review' : 'report'}\n`);
      return;
    }
    if (['approve', 'reject', 'undo', 'all'].includes(pos[1])) throw new Error('usage: snapcrawl review <screen-id|all> <approve|reject|undo>');
    const r = loadReport(pickRuns(pos[1], pos[2]));
    const changes = r.screens.filter(needsReview);
    const open = changes.filter((s) => decisionOf(r, s) === 'open');
    t.title('review', `${r.base.label || r.base.id} → ${r.head.label || r.head.id} · ${open.length} of ${changes.length} changes open`);
    // open changes first, decided ones below so the progress stays visible
    const rows = [...open, ...changes.filter((s) => !open.includes(s))].map((s) => {
      const d = decisionOf(r, s);
      return [s.id, s.name, { changed: t.yellow, new: t.cyan, bad: t.red }[s.status](s.reason || STATUS[s.status]), pct(s.ratio), DECISION[d](d)];
    });
    if (rows.length) t.table(rows, { head: ['id', 'screen', 'status', 'Δ px', 'decision'] });
    else console.log(t.gray('  no changes'));
    console.log();
    printState(r);
    console.log(`\n  ${t.gray('decide:')} snapcrawl review <id|all> <approve|reject|undo>\n`);
  },

  async report() {
    const r = loadReport(pickRuns(pos[1], pos[2]));
    const type = opt.full ? 'full' : 'summary';
    const out = path.resolve(opt.out || path.join(store.reportsDir, reportFileName(r, type)));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, renderReport({ store, report: r, type, version: pkg.version }));
    t.title('report', `${type} · ${r.base.label || r.base.id} → ${r.head.label || r.head.id}`);
    console.log('  ' + t.ok(out) + t.gray(`  ${(fs.statSync(out).size / 1024).toFixed(1)} KB`));
    console.log();
    printState(r);
    console.log();
  },

  async ui() {
    const port = Number(opt.port || 4747);
    const { port: actual } = await startServer({ store, cfg, port, version: pkg.version });
    const url = `http://localhost:${actual}`;
    if (actual !== port) console.log(t.gray(`  port ${port} is busy · using ${actual}`));
    t.title('ui', url);
    console.log(t.gray('  ctrl-c to stop\n'));
    if (!opt['no-open']) openBrowser(url);
  },

  async demo() {
    const { base, head } = createDemo(store);
    buildReport({ store, baseId: base, headId: head, cfg });
    t.title('demo', 'two sample runs of a fictional app');
    console.log('  ' + t.ok(`${base} (baseline)`));
    console.log('  ' + t.ok(head));
    console.log(`\n  ${t.gray('next:')} snapcrawl ui\n`);
  },

  async wda() {
    const sub = pos[1] || 'status';
    if (!WDA[sub]) throw new Error('usage: snapcrawl wda <setup|start|stop|status>');
    await WDA[sub]();
  },

  async config() {
    if (pos[1] === 'set' && pos[2]) {
      setGlobal(pos[2], pos[3] ?? '');
      console.log(t.ok(`${pos[2]} saved to ${GLOBAL_FILE}`));
    } else {
      const g = getGlobal();
      if (g.ai?.apiKey) g.ai.apiKey = '•••' + String(g.ai.apiKey).slice(-4);
      console.log(JSON.stringify(g, null, 2));
    }
  },
};

/* ---------- WebDriverAgent ---------- */

const TEAM_HELP = 'Find your team id (10 characters) in Xcode → Settings → Accounts → your Apple ID, or on developer.apple.com/account → Membership details.';

// Run a command, write its output to a log file, echo the interesting lines.
function runLogged(cmd, args, logFile, pick) {
  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const log = fs.createWriteStream(logFile);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let rest = '';
    const onData = (d) => {
      log.write(d);
      const lines = (rest + d).split('\n');
      rest = lines.pop();
      for (const l of lines) if (pick.test(l)) t.logLine(/error|failed/i.test(l) ? 'ERROR' : 'STEP', l.trim().slice(0, 200));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const beat = setInterval(() => t.logLine('STEP', 'still building …'), 20_000);
    child.on('close', (code) => {
      clearInterval(beat);
      log.end(() => resolve(code));
    });
  });
}

const fail = (msg, logFile) => {
  const log = wdaKit.tail(logFile, 400);
  const hints = wdaKit.diagnose(log);
  return new Error(`${msg}\n\n${t.gray(wdaKit.tail(logFile, 12))}\n\n${hints.length ? hints.map((h) => '  → ' + h).join('\n') + '\n' : ''}  full log: ${logFile}`);
};

const WDA = {
  async setup() {
    t.title('wda setup', wdaKit.WDA_HOME);
    for (const b of ['git', 'xcodebuild']) if (!(await hasBinary(b))) throw new Error(`${b} missing · install Xcode and its command line tools`);
    let team = opt.team;
    if (!team) {
      const teams = await wdaKit.findTeams();
      if (teams.length === 1) {
        team = teams[0].team;
        t.logLine('INFO', `team ${team} (${teams[0].name || teams[0].cert}) · read from your signing certificate`);
      } else if (teams.length) {
        throw new Error(`Several teams found, pick one with --team:\n${teams.map((x) => `    ${x.team}  ${x.name}`).join('\n')}`);
      } else throw new Error(`No Apple Development certificate in the keychain. Sign in to Xcode with your Apple ID first, then: snapcrawl wda setup --team <TEAM_ID>\n  ${TEAM_HELP}`);
    }
    if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error(`"${team}" is not a team id. ${TEAM_HELP}`);
    const dev = await new IosDevice({ udid: opt.device || opt.udid || '' }).findDevice();
    t.logLine('INFO', `device ${dev.name} · iOS ${dev.ios} · ${dev.udid}`);
    const prev = wdaKit.readSetup();
    const bundleId = opt['bundle-id'] || (prev?.team === team && prev.bundleId) || wdaKit.bundleIdFor(os.userInfo().username, team);

    const tag = wdaKit.latestTag(await capture('git', ['ls-remote', '--tags', '--refs', wdaKit.WDA_REPO]));
    if (!tag) throw new Error(`no release tag found at ${wdaKit.WDA_REPO}`);
    if (prev?.tag !== tag || !fs.existsSync(path.join(wdaKit.paths.repo, 'WebDriverAgent.xcodeproj'))) {
      t.logLine('INFO', `download WebDriverAgent ${tag}`);
      fs.rmSync(wdaKit.paths.repo, { recursive: true, force: true });
      fs.rmSync(wdaKit.paths.derived, { recursive: true, force: true });
      await capture('git', ['clone', '--quiet', '--depth', '1', '--branch', tag, wdaKit.WDA_REPO, wdaKit.paths.repo], 300_000);
    } else t.logLine('INFO', `WebDriverAgent ${tag} already downloaded`);

    t.logLine('INFO', `build · team ${team} · ${bundleId} · takes 1–3 minutes`);
    const code = await runLogged('xcodebuild', wdaKit.xcodebuildArgs('build-for-testing', { udid: dev.udid, team, bundleId }), wdaKit.paths.buildLog, /(error:|BUILD SUCCEEDED|BUILD FAILED|TEST BUILD SUCCEEDED|TEST BUILD FAILED)/);
    if (code !== 0) throw fail('WebDriverAgent build failed', wdaKit.paths.buildLog);
    wdaKit.writeSetup({ team, bundleId, tag, udid: dev.udid, device: dev.name, built: new Date().toISOString() });
    console.log(`\n  ${t.ok(`WebDriverAgent ${tag} built for ${dev.name}`)}\n  ${t.gray('next:')} snapcrawl wda start\n`);
  },

  async start() {
    const setup = wdaKit.readSetup();
    if (!setup) throw new Error('WebDriverAgent is not built yet · run: snapcrawl wda setup --team <TEAM_ID>');
    const want = opt.device || opt.udid || '';
    let dev;
    try {
      dev = await new IosDevice({ udid: want || setup.udid }).findDevice();
    } catch (e) {
      if (want) throw e;
      dev = await new IosDevice().findDevice();
    }
    const url = wdaUrl();
    const u = new URL(url);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    const port = Number(u.port || 8100);
    const wda = new Wda(url);
    t.title('wda start', `${dev.name} · ${url}`);
    if (dev.udid !== setup.udid) t.logLine('WARN', `built for ${setup.device}; if signing fails, run snapcrawl wda setup again with this iPhone connected`);

    const cur = wdaKit.readPids();
    if (cur && wdaKit.alive(cur.xcodebuild)) {
      const st = await wda.status(3000).catch(() => null);
      if (st && cur.udid === dev.udid) return console.log(`  ${t.ok(`already running · WebDriverAgent ${st.build?.version || ''} on ${cur.device}`)}\n`);
      t.logLine('INFO', 'stopping the previous WebDriverAgent');
      wdaKit.kill(cur.xcodebuild);
      wdaKit.kill(cur.forward);
    }
    if (local && (await wda.status(1500).catch(() => null))) throw new Error(`Something already answers at ${url}, but snapcrawl did not start it. Stop it, or set device.wdaUrl to another port.`);

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
    } else t.logLine('INFO', `${u.hostname} is not local · no port forwarding`);
    wdaKit.writePids({ xcodebuild: xb.pid, forward: fw?.pid || null, udid: dev.udid, device: dev.name, url, started: new Date().toISOString() });

    t.logLine('INFO', 'installing and launching WebDriverAgent on the iPhone · keep it unlocked');
    const t0 = Date.now();
    let st = null;
    let said = 0;
    while (!exited && Date.now() - t0 < 180_000) {
      st = await wda.status(3000).catch(() => null);
      if (st) break;
      if (Date.now() - said > 20_000 && Date.now() - t0 > 15_000) {
        said = Date.now();
        const hints = wdaKit.diagnose(wdaKit.tail(wdaKit.paths.runLog, 200));
        t.logLine('WAIT', hints[0] || 'still waiting for WebDriverAgent …');
      }
      await sleep(2000);
    }
    if (!st) {
      wdaKit.kill(xb.pid);
      wdaKit.kill(fw?.pid);
      wdaKit.clearPids();
      throw fail(exited ? 'xcodebuild stopped before WebDriverAgent answered' : 'WebDriverAgent did not answer within 3 minutes', wdaKit.paths.runLog);
    }
    console.log(`\n  ${t.ok(`WebDriverAgent ${st.build?.version || ''} running on ${dev.name} · ${url}`)}`);
    console.log(`  ${t.gray('next:')} snapcrawl apps --device "${dev.name}"  ·  snapcrawl wda stop when done\n`);
  },

  async stop() {
    const cur = wdaKit.readPids();
    if (!cur) return console.log(t.gray('  WebDriverAgent was not started by snapcrawl'));
    const a = wdaKit.kill(cur.xcodebuild);
    const b = wdaKit.kill(cur.forward);
    wdaKit.clearPids();
    console.log(t.ok(`stopped${a ? ' xcodebuild' : ''}${b ? ' · port forwarding' : ''}${a || b ? '' : ' (nothing was running)'}`));
  },

  async status() {
    t.title('wda', wdaUrl());
    const setup = wdaKit.readSetup();
    const cur = wdaKit.readPids();
    const st = await new Wda(wdaUrl()).status(3000).catch(() => null);
    t.table([
      ['built', setup ? `${setup.tag} · team ${setup.team} · ${setup.bundleId} · for ${setup.device}` : t.yellow('no · snapcrawl wda setup --team <TEAM_ID>')],
      ['xcodebuild', cur && wdaKit.alive(cur.xcodebuild) ? t.green(`running · pid ${cur.xcodebuild} · ${cur.device}`) : t.gray('not running')],
      ['forwarding', cur?.forward && wdaKit.alive(cur.forward) ? t.green(`running · pid ${cur.forward}`) : t.gray('not running')],
      ['reachable', st ? t.green(`yes · WebDriverAgent ${st.build?.version || ''}${st.ios?.ip ? ' · iPhone ip ' + st.ios.ip : ''}`) : t.yellow('no · snapcrawl wda start')],
      ...(st ? [await new Wda(wdaUrl()).canControl().then((c) => ['ui control', c.ok ? t.green('yes') : t.red(c.notAuthorized ? 'no · iPhone was locked · snapcrawl wda stop && snapcrawl wda start' : c.error)])] : []),
    ]);
    console.log();
  },

  // internal: the port forwarder that `wda start` runs in the background
  async forward() {
    const port = Number(opt.port || 8100);
    const udid = opt.device || opt.udid || '';
    await startForwarder({ udid, localPort: port, devicePort: 8100, onError: (e) => console.error(new Date().toISOString(), e.message) });
    console.log(`${new Date().toISOString()} forwarding 127.0.0.1:${port} → ${udid || 'iPhone'}:8100`);
  },
};

try {
  if (opt.version) console.log(pkg.version);
  else if (!cmd || opt.help || cmd === 'help') console.log(HELP);
  else if (!commands[cmd]) {
    console.error(t.fail(`unknown command "${cmd}"`));
    console.log(HELP);
    process.exitCode = 1;
  } else await commands[cmd]();
} catch (e) {
  console.error('\n' + t.fail(e.message) + '\n');
  process.exitCode = 1;
}
