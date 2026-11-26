#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { aiReady, annotate } from '../src/ai.js';
import { GLOBAL_FILE, LOCAL_FILE, TEMPLATE, getGlobal, loadConfig, setGlobal } from '../src/config.js';
import { crawl } from '../src/crawler.js';
import { createDemo } from '../src/demo.js';
import { buildReport } from '../src/diff.js';
import { IosSimulator, hasBinary, listSimulators } from '../src/drivers/ios-sim.js';
import { startServer } from '../src/server.js';
import { Store } from '../src/store.js';
import * as t from '../src/term.js';

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

const HELP = `
${t.bold('snapcrawl')} ${t.gray('v' + pkg.version)}  crawl an iOS app, map every screen, diff builds

${t.bold('Usage')}
  snapcrawl <command> [options]

${t.bold('Commands')}
  doctor                      check Xcode, idb and the simulator
  devices                     list simulators
  apps                        list apps installed on the booted simulator
  init                        write ${LOCAL_FILE} in this folder
  crawl                       explore the app and capture every screen
  runs                        list previous runs
  baseline [run]              show or set the baseline run
  diff [base] [head]          compare two runs (default: baseline vs latest)
  ui                          open the local web UI (graph, live crawl, review)
  demo                        create two sample runs to try the UI without a simulator
  config set <key> <value>    save a global setting, e.g. ai.provider anthropic

${t.bold('Crawl options')}
  --bundle <id>               app bundle id (or app.bundleId in ${LOCAL_FILE})
  --udid <udid|name>          simulator (default: the booted one)
  --label <text>              tag the run, e.g. v2.4.0
  --max-depth <n>             default 8
  --max-screens <n>           default 200
  --mfa <none|totp|prompt|manual>
  --diff                      compare against the baseline when done

${t.bold('Other options')}
  --config <file>             use another config file
  --port <n>                  ui port (default 4747)
  --no-open                   do not open the browser
  --ai                        add model notes to a diff (needs ai.provider)
  -h, --help  -v, --version
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
    mfa: { type: 'string' },
    config: { type: 'string' },
    port: { type: 'string' },
    'no-open': { type: 'boolean' },
    diff: { type: 'boolean' },
    ai: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});

const cmd = pos[0];
const cfg = loadConfig(opt.config);
const store = new Store(cfg.outDir).ensure();

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
  ]);
  const rows = r.screens
    .filter((x) => x.status !== 'same')
    .map((x) => [x.id, x.name, { changed: t.yellow, new: t.cyan, bad: t.red }[x.status](x.reason || x.status), x.ratio != null ? (x.ratio * 100).toFixed(2) + ' %' : '', r.notes[x.id]?.summary ? t.gray(r.notes[x.id].summary) : '']);
  if (rows.length) {
    console.log();
    t.table(rows, { head: ['id', 'screen', 'status', 'Δ px', 'note'] });
  }
  console.log(`\n  ${t.gray('review in the browser:')} snapcrawl ui\n`);
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
    const idb = await hasBinary('idb');
    checks.push(idb ? t.ok('idb') : t.fail('idb missing · pipx install fb-idb'));
    const companion = await hasBinary('idb_companion');
    checks.push(companion ? t.ok('idb_companion') : t.fail('idb_companion missing · brew tap facebook/fb && brew install idb-companion'));
    if (xcrun) {
      try {
        const booted = (await listSimulators()).filter((s) => s.state === 'Booted');
        checks.push(booted.length ? t.ok(`booted simulator: ${booted.map((b) => `${b.name} (${b.runtime})`).join(', ')}`) : t.warn('no simulator booted · xcrun simctl boot "iPhone 16" && open -a Simulator'));
      } catch (e) {
        checks.push(t.fail(e.message));
      }
    }
    checks.push(cfg._file ? t.ok(`config ${path.relative(process.cwd(), cfg._file)}`) : t.warn(`no ${LOCAL_FILE} · run snapcrawl init`));
    checks.push(aiReady(cfg.ai) ? t.ok(`ai ${cfg.ai.provider}/${cfg.ai.model}`) : t.gray('· ai off (optional)'));
    for (const c of checks) console.log('  ' + c);
    console.log();
  },

  async devices() {
    t.title('devices', 'iOS Simulator');
    const sims = await listSimulators();
    t.table(sims.map((s) => [s.state === 'Booted' ? t.green('● booted') : t.gray('○ ' + s.state.toLowerCase()), s.name, t.gray(s.runtime), t.gray(s.udid)]), { head: ['state', 'name', 'runtime', 'udid'] });
    console.log();
  },

  async apps() {
    const d = await new IosSimulator({ udid: opt.udid || cfg.device.udid }).resolve();
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
    t.title('crawl', `${cfg.app.bundleId} · depth ≤ ${cfg.crawl.maxDepth} · ≤ ${cfg.crawl.maxScreens} screens`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let stop = false;
    process.on('SIGINT', () => {
      if (stop) process.exit(130);
      stop = true;
      t.logLine('WARN', 'stopping after the current step · press ctrl-c again to quit');
    });
    const io = {
      log: t.logLine,
      ask: async (kind, prompt) => (await rl.question(`         ${t.white('→')} ${kind === 'code' ? 'code: ' : prompt + ' [enter] '}`)).trim(),
      aborted: () => stop,
    };
    const driver = new IosSimulator({ udid: opt.udid || cfg.device.udid, bundleId: cfg.app.bundleId });
    const atlas = await crawl({ driver, cfg, store, io, label: opt.label || '' });
    rl.close();
    if (atlas.meta.status !== 'done') process.exitCode = 1;
    if (!store.baseline && atlas.meta.status === 'done') {
      store.baseline = atlas.meta.id;
      console.log(`\n  ${t.gray('first run → set as baseline:')} ${atlas.meta.id}`);
    } else if (opt.diff && store.baseline && store.baseline !== atlas.meta.id) {
      printReport(buildReport({ store, baseId: store.baseline, headId: atlas.meta.id, cfg }));
    }
    console.log(`\n  ${t.gray('next:')} snapcrawl ${opt.diff ? 'ui' : 'diff'}\n`);
  },

  async runs() {
    t.title('runs', store.root);
    const b = store.baseline;
    const runs = store.listRuns();
    if (!runs.length) return console.log(t.gray('  no runs yet · snapcrawl crawl or snapcrawl demo\n'));
    t.table(runs.map((r) => [r.id === b ? t.white('◆') : ' ', r.id, r.label, r.app, `${r.screens} screens`, r.crashes ? t.red(`${r.crashes} crash`) : '', t.gray(r.status)]), { head: ['', 'run', 'label', 'app', 'size', '', 'status'] });
    console.log(t.gray('\n  ◆ baseline\n'));
  },

  async baseline() {
    if (pos[1]) {
      store.readRun(pos[1]);
      store.baseline = pos[1];
    }
    console.log(store.baseline ? `baseline: ${store.baseline}` : t.gray('no baseline yet'));
  },

  async diff() {
    const base = pos[1] || store.baseline;
    const head = pos[2] || store.latest(base);
    if (!base || !head) throw new Error('Need two runs. Crawl twice, or try: snapcrawl demo');
    let report = buildReport({ store, baseId: base, headId: head, cfg });
    if (opt.ai) {
      t.logLine('INFO', `notes via ${cfg.ai.provider}/${cfg.ai.model}`);
      report = await annotate({ store, report, cfg, onProgress: (n, total, s) => t.logLine('STEP', `${n}/${total} ${s.name}`) });
    }
    printReport(report);
    if (report.summary.bad) process.exitCode = 1;
  },

  async ui() {
    const port = Number(opt.port || 4747);
    await startServer({ store, cfg, port, version: pkg.version });
    const url = `http://localhost:${port}`;
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
