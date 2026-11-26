import fs from 'node:fs';
import path from 'node:path';

const slug = (s) => String(s).replace(/[^a-z0-9.]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

// All output lives in one folder (default .snapcrawl/):
//   runs/<runId>/atlas.json + screens/*.png
//   diffs/<base>__<head>/report.json + *.png
//   reports/*.html  (exported reports)
//   baselines.json  (baseline run id per app)
export class Store {
  constructor(root) {
    this.root = path.resolve(root);
    this.runsDir = path.join(this.root, 'runs');
    this.diffsDir = path.join(this.root, 'diffs');
    this.reportsDir = path.join(this.root, 'reports');
  }

  ensure() {
    fs.mkdirSync(this.runsDir, { recursive: true });
    fs.mkdirSync(this.diffsDir, { recursive: true });
    return this;
  }

  newRunId(label) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const id = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return label ? `${id}-${slug(label)}` : id;
  }

  runDir(id) {
    return path.join(this.runsDir, id);
  }

  readRun(id) {
    return JSON.parse(fs.readFileSync(path.join(this.runDir(id), 'atlas.json'), 'utf8'));
  }

  writeRun(id, atlas) {
    const dir = this.runDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, 'atlas.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(atlas, null, 2));
    fs.renameSync(tmp, path.join(dir, 'atlas.json'));
  }

  listRuns() {
    if (!fs.existsSync(this.runsDir)) return [];
    return fs
      .readdirSync(this.runsDir)
      .map((id) => {
        try {
          const a = this.readRun(id);
          return {
            id,
            label: a.meta.label || '',
            created: a.meta.created,
            status: a.meta.status,
            app: a.meta.app,
            appName: a.meta.appName || '',
            device: a.meta.device?.name || '',
            screens: a.screens.length,
            crashes: a.screens.filter((s) => s.crash).length,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.created).localeCompare(String(a.created)));
  }

  latest(app, exclude) {
    return this.listRuns().find((r) => r.status === 'done' && r.id !== exclude && (!app || r.app === app))?.id || null;
  }

  // One baseline per app: { "<bundle id>": "<run id>" }
  readBaselines() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.root, 'baselines.json'), 'utf8'));
    } catch {
      try {
        const legacy = fs.readFileSync(path.join(this.root, 'baseline'), 'utf8').trim();
        if (legacy) return { [this.readRun(legacy).meta.app]: legacy };
      } catch {}
      return {};
    }
  }

  baselineFor(app) {
    return this.readBaselines()[app] || null;
  }

  setBaseline(runId) {
    const app = this.readRun(runId).meta.app;
    const all = this.readBaselines();
    all[app] = runId;
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(path.join(this.root, 'baselines.json'), JSON.stringify(all, null, 2) + '\n');
    return app;
  }

  // Default comparison: the app of the newest finished run, its baseline as base, and the newest
  // run of that app created after the baseline as head. Never picks an older run on its own.
  defaultPair() {
    const runs = this.listRuns().filter((r) => r.status === 'done');
    const baselines = this.readBaselines();
    const latest = runs.find((r) => baselines[r.app]);
    if (!latest) return { error: 'Need two runs of the same app. Crawl it again after your next build, or try: snapcrawl demo' };
    const app = latest.appName || latest.app;
    const base = runs.find((r) => r.id === baselines[latest.app]);
    if (!base) return { error: `${app}: the baseline ${baselines[latest.app]} was not found. Set one with: snapcrawl baseline <run>` };
    const head = runs.find((r) => r.app === latest.app && r.id !== base.id && String(r.created) > String(base.created));
    if (!head) return { error: `${app}: nothing newer than the baseline ${base.label || base.id}. Crawl again, or pass base and head explicitly.` };
    return { base: base.id, head: head.id };
  }

  diffDir(base, head) {
    return path.join(this.diffsDir, `${base}__${head}`);
  }

  readReport(base, head) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.diffDir(base, head), 'report.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  writeReport(report) {
    const dir = this.diffDir(report.base.id, report.head.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  }
}
