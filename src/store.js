import fs from 'node:fs';
import path from 'node:path';

const slug = (s) => String(s).replace(/[^a-z0-9.]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

// All output lives in one folder (default .snapcrawl/):
//   runs/<runId>/atlas.json + screens/*.png
//   diffs/<base>__<head>/report.json + *.png
//   baselines.json  (baseline run id per app)
export class Store {
  constructor(root) {
    this.root = path.resolve(root);
    this.runsDir = path.join(this.root, 'runs');
    this.diffsDir = path.join(this.root, 'diffs');
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
