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
import { applyReview, decisionOf, renderReport, reportFileName, reviewState } from '../src/report.js';
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
  diff [base] [head]          compare two runs (default: baseline vs the newest run after it)
  review [base] [head]        list the changes and their decisions
  review <id|all> <approve|reject|undo> [base] [head]
                              decide like in the UI · "all" = every open change
  report [base] [head]        write a standalone HTML report (default: summary)
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
  --full                      report: graph, screenshots and pixel diffs
  --out <file>                report: output file (default .snapcrawl/reports/)
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
    const changes = r.screens.filter((s) => s.status !== 'same');
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
