import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { crawl } from '../src/crawler.js';
import { buildReport } from '../src/diff.js';
import { Store } from '../src/store.js';
import { FakeApp } from './fake-app.js';

const config = (app, crawlOpts = {}) => {
  const cfg = structuredClone(DEFAULTS);
  cfg.app.bundleId = 'com.pulse.app';
  Object.assign(cfg.auth, { username: app.user, password: app.pass, mfa: 'totp', totpSecret: app.secret });
  Object.assign(cfg.crawl, { settleMs: 0, launchMs: 0 }, crawlOpts);
  return cfg;
};
const run = async (store, app, crawlOpts) => {
  const logs = [];
  const atlas = await crawl({ driver: app, cfg: config(app, crawlOpts), store, io: { log: (l, m) => logs.push(m), ask: async () => '' } });
  return { atlas, logs };
};
// a baseline of the plain app, in a fresh store
const withBaseline = async (crawlOpts) => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-'))).ensure();
  const { atlas } = await run(store, new FakeApp(), crawlOpts);
  store.setBaseline(atlas.meta.id);
  return { store, base: atlas };
};
const diff = (store, base, head) => buildReport({ store, baseId: base.meta.id, headId: head.meta.id, cfg: structuredClone(DEFAULTS) }).summary;

test('follow: a tap that lands elsewhere than in the baseline is tried once more', async () => {
  const { store, base } = await withBaseline();

  const free = await run(store, new FakeApp({ flaky: 1 }), { follow: false });
  assert.ok(diff(store, base, free.atlas).bad > 1, 'without following, the timing effect costs baseline screens');

  const { atlas, logs } = await run(store, new FakeApp({ flaky: 1 }));
  assert.equal(atlas.meta.followed, base.meta.id);
  assert.ok(logs.some((m) => /led elsewhere than in the baseline \("Profil"\)/.test(m)));
  assert.ok(logs.some((m) => /as in the baseline/.test(m)));
  assert.ok(!atlas.screens.some((s) => s.name === 'Profil (2)'));
  assert.equal(atlas.screens.find((s) => s.name === 'Profil').elements, 5, 'the profile as in the baseline, not the leftover view');
  const sum = diff(store, base, atlas);
  assert.equal(sum.new, 0);
  assert.equal(sum.bad, 1, 'only the crash, as in the baseline');
  assert.ok(atlas.screens.filter((s) => !s.crash).every((s) => s.base), 'every screen knows its baseline screen');
});

test('follow: the baseline screens come first, in its order, and are kept at the screen limit', async () => {
  const { store, base } = await withBaseline();
  const n = base.screens.length;

  const free = await run(store, new FakeApp({ extra: true }), { follow: false, maxScreens: n });
  const freeSum = diff(store, base, free.atlas);
  assert.ok(freeSum.bad > 1, 'without following, the new screen pushes a baseline screen out');

  const { atlas, logs } = await run(store, new FakeApp({ extra: true }), { maxScreens: n });
  const sum = diff(store, base, atlas);
  assert.equal(sum.bad, 1, 'only the crash: nothing of the baseline is missing');
  assert.ok(logs.some((m) => /baseline followed · \d+ of \d+ screens found again$/.test(m)), logs.filter((m) => m.startsWith('baseline')).join());
  assert.ok(!logs.some((m) => /once more/.test(m)), 'a changed but recognisable screen needs no second try');
  assert.equal(sum.new, 1);
  const order = atlas.screens.filter((s) => s.base).map((s) => s.base);
  assert.deepEqual(order, [...order].sort(), 'baseline screens found in the baseline order');
});

test('follow: actions in the baseline order, not the current rules', async () => {
  const { store } = await withBaseline({ prefer: ['Profil'] });
  const { atlas } = await run(store, new FakeApp());
  const home = atlas.screens.find((s) => s.name === 'Hallo, Lena');
  assert.equal(home.actions[0].label, 'Profil', 'the baseline tapped Profil first, so does the follow-up');
  const own = await run(store, new FakeApp(), { follow: false });
  assert.equal(own.atlas.screens.find((s) => s.name === 'Hallo, Lena').actions[0].label, 'Workouts');
});

test('settled reads: a screen read during its animation or while loading is read again', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-'))).ensure();
  const calm = await run(store, new FakeApp(), { follow: false });
  const moving = await run(store, new FakeApp({ lag: 2 }), { follow: false });
  const shape = (a) => a.screens.map((s) => `${s.name}:${s.actions.length}`).sort();
  assert.deepEqual(shape(moving.atlas), shape(calm.atlas), 'the same screens with the same actions');
  assert.ok(!moving.atlas.meta.warnings.length, `${moving.atlas.meta.warnings}`);
});
