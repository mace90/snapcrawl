import fs from 'node:fs';
import path from 'node:path';

const slug = (s) => String(s).replace(/[^a-z0-9.]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

// All output lives in one folder (default .snappcrawl/):
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
    const tail = label ? `-${slug(label)}` : '';
    // two runs in the same second (tests, a crawl that ends at once) must not share a folder
    let run = `${id}${tail}`;
    for (let n = 2; fs.existsSync(this.runDir(run)); n++) run = `${id}-${n}${tail}`;
    return run;
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
        // the summary of a run is read again only when its atlas.json changed: the UI asks
        // for the list on every state update, and a run's atlas can be large
        let mtime = 0;
        try {
          mtime = fs.statSync(path.join(this.runDir(id), 'atlas.json')).mtimeMs;
        } catch {
          return null;
        }
        const hit = (this._runCache ||= new Map()).get(id);
        if (hit && hit.mtime === mtime) return hit.summary;
        try {
          const a = this.readRun(id);
          const summary = {
            id,
            label: a.meta.label || '',
            created: a.meta.created,
            status: a.meta.status,
            app: a.meta.app,
            appName: a.meta.appName || '',
            device: a.meta.device?.name || '',
            screens: a.screens.length,
            crashes: a.screens.filter((s) => s.crash).length,
            ...(a.meta.against ? { against: a.meta.against, baseline: a.meta.baseline } : {}),
          };
          this._runCache.set(id, { mtime, summary });
          return summary;
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

  // Areas left out of the comparison, per app: { "<bundle id>": [{ screen, area }] }.
  // screen: the screen's name. area: { x, y, w, h } in points, or null for the whole screen
  // (its pixels are not compared, the screen is still matched and its buttons still checked).
  readIgnore() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.root, 'ignore.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  ignoreFor(app) {
    return this.readIgnore()[app] || [];
  }

  writeIgnore(app, rules) {
    const all = this.readIgnore();
    if (rules.length) all[app] = rules;
    else delete all[app];
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(path.join(this.root, 'ignore.json'), JSON.stringify(all, null, 2) + '\n');
    return rules;
  }

  addIgnore(app, { screen, area = null }) {
    if (!app) throw new Error('which app? · --bundle, or app.bundleId in the config');
    if (!String(screen || '').trim()) throw new Error('which screen? · its name, as in the report');
    const a = area && Object.fromEntries(['x', 'y', 'w', 'h'].map((k) => [k, Math.round(Number(area[k]) * 10) / 10]));
    if (a && (Object.values(a).some((v) => !Number.isFinite(v) || v < 0) || !a.w || !a.h)) throw new Error('an area is x,y,w,h in points, e.g. 0,120,393,300');
    const rules = this.ignoreFor(app);
    rules.push({ screen: String(screen).trim(), area: a || null });
    return this.writeIgnore(app, rules);
  }

  removeIgnore(app, index) {
    const rules = this.ignoreFor(app);
    if (!(index >= 0 && index < rules.length)) throw new Error(`no rule ${index + 1} · snappcrawl ignore lists them`);
    rules.splice(index, 1);
    return this.writeIgnore(app, rules);
  }

  // Default comparison: the app of the newest finished run, its baseline as base, and the newest
  // run of that app created after the baseline as head. Never picks an older run on its own.
  // A newest run crawled against another app (crawl --then, --against) is compared with that baseline.
  defaultPair() {
    const runs = this.listRuns().filter((r) => r.status === 'done');
    // the newest run was crawled against another app's baseline, or is that baseline (two builds
    // crawled at the same time may finish in either order): that pair
    const top = runs[0];
    const paired = top?.against ? top : runs.find((r) => r.against && r.baseline === top?.id);
    if (paired && runs.some((r) => r.id === paired.baseline)) return { base: paired.baseline, head: paired.id };
    const baselines = this.readBaselines();
    const latest = runs.find((r) => baselines[r.app]);
    if (!latest) return { error: 'Need two runs of the same app. Crawl it again after your next build, or try: snappcrawl demo' };
    const app = latest.appName || latest.app;
    const base = runs.find((r) => r.id === baselines[latest.app]);
    if (!base) return { error: `${app}: the baseline ${baselines[latest.app]} was not found. Set one with: snappcrawl baseline <run>` };
    const head = runs.find((r) => r.app === latest.app && r.id !== base.id && String(r.created) > String(base.created));
    if (!head) return { error: `${app}: nothing newer than the baseline ${base.label || base.id}. Crawl again, or pass base and head explicitly.` };
    return { base: base.id, head: head.id };
  }

  clearBaseline(app) {
    const all = this.readBaselines();
    delete all[app];
    fs.writeFileSync(path.join(this.root, 'baselines.json'), JSON.stringify(all, null, 2) + '\n');
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
