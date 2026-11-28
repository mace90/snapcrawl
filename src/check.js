import fs from 'node:fs';
import pngjs from 'pngjs';
import { buildReport } from './diff.js';
import { summarize } from './summary.js';

const { PNG } = pngjs;

// The end of a check (CLI `snappcrawl check`, MCP `check`): the first run of an app becomes its
// baseline, every later one is compared with it.
export function checkResult({ atlas, pair = null, store, cfg }) {
  if (atlas.meta.status !== 'done') {
    const error = atlas.meta.error || 'the crawl did not finish';
    return { verdict: /^needs a person/.test(error) ? 'input' : 'error', app: atlas.meta.app, run: atlas.meta.id, error };
  }
  const baseline = pair ? pair.base?.meta.id : store.baselineFor(cfg.crawl.against || atlas.meta.app);
  if (!pair && (!baseline || baseline === atlas.meta.id)) {
    store.setBaseline(atlas.meta.id);
    const crashes = atlas.screens.filter((x) => x.crash).length;
    return {
      verdict: 'baseline',
      app: atlas.meta.app,
      run: atlas.meta.id,
      screens: atlas.screens.length,
      crashes,
      next: [
        crashes ? `${crashes} screen${crashes === 1 ? '' : 's'} crashed the app already in this first run: look at them before trusting the baseline.` : 'The app was crawled without a crash.',
        'This first run is now the baseline. Change the app, then check again to compare every screen with it.',
      ],
    };
  }
  const report = pair?.report || buildReport({ store, baseId: baseline, headId: atlas.meta.id, cfg });
  return summarize(report, store);
}

// The limits of the app's baseline run: a check with smaller ones would miss its screens.
export function baselineLimits(store, app) {
  const id = store.baselineFor(app);
  if (!id) return null;
  try {
    return store.readRun(id).meta.limits || null;
  } catch {
    return null;
  }
}

// A screenshot made small for a model: at most `width` pixels wide (box filter), as PNG bytes.
export function thumbnail(file, width = 360) {
  const src = PNG.sync.read(fs.readFileSync(file));
  const f = Math.max(1, Math.ceil(src.width / width));
  if (f === 1) return fs.readFileSync(file);
  const w = Math.floor(src.width / f);
  const h = Math.floor(src.height / f);
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sum = [0, 0, 0, 0];
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const i = ((y * f + dy) * src.width + x * f + dx) * 4;
          for (let k = 0; k < 4; k++) sum[k] += src.data[i + k];
        }
      }
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) out.data[o + k] = Math.round(sum[k] / (f * f));
    }
  }
  return PNG.sync.write(out);
}
