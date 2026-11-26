import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { crawl } from '../src/crawler.js';
import { createDemo } from '../src/demo.js';
import { buildReport } from '../src/diff.js';
import { Store } from '../src/store.js';
import { totp } from '../src/totp.js';
import { FakeApp } from './fake-app.js';

const tmpStore = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snapcrawl-'))).ensure();
const config = (auth = {}) => {
  const cfg = structuredClone(DEFAULTS);
  cfg.app.bundleId = 'com.pulse.app';
  cfg.crawl.settleMs = 0;
  cfg.crawl.launchMs = 0;
  Object.assign(cfg.auth, auth);
  return cfg;
};
const quietIo = (ask = async () => '') => ({ log: () => {}, ask });

test('totp matches the RFC 6238 test vector', () => {
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', { time: 59_000, digits: 8 }), '94287082');
});

test('crawler logs in with TOTP, maps the app, records the crash and respects the blocklist', async () => {
  const store = tmpStore();
  const app = new FakeApp();
  const atlas = await crawl({ driver: app, cfg: config({ username: app.user, password: app.pass, mfa: 'totp', totpSecret: app.secret }), store, io: quietIo() });

  assert.equal(atlas.meta.status, 'done');
  const names = atlas.screens.filter((s) => !s.crash).map((s) => s.name).sort();
  assert.deepEqual(names, ['Einstellungen', 'Hallo, Lena', 'Mitteilungen', 'Player', 'Profil', 'Profil bearbeiten', 'Pulse', 'Workout', 'Workouts'].sort());
  assert.equal(atlas.screens.filter((s) => s.crash).length, 1);
  assert.ok(!app.taps.includes('Abmelden'), 'blocklisted action must never be tapped');
  assert.ok(atlas.screens.find((s) => s.name === 'Einstellungen').blocked.includes('Abmelden'));
  for (const s of atlas.screens.filter((x) => !x.crash)) assert.ok(fs.existsSync(path.join(store.runDir(atlas.meta.id), s.screenshot)));
  assert.deepEqual(store.readRun(atlas.meta.id).screens.length, atlas.screens.length);
});

test('crawler waits for a manual login when asked to', async () => {
  const store = tmpStore();
  const app = new FakeApp();
  let asked = 0;
  const ask = async (kind) => {
    asked++;
    assert.equal(kind, 'manual');
    app.loggedIn = true; // the human logs in on the device
    app.stack = ['splash', 'home'];
  };
  const atlas = await crawl({ driver: app, cfg: config({ mfa: 'manual' }), store, io: quietIo(ask) });
  assert.equal(atlas.meta.status, 'done');
  assert.equal(asked, 1);
  assert.ok(atlas.screens.some((s) => s.name === 'Hallo, Lena'));
});

test('diff classifies same, changed, new, crashed and unreachable screens', () => {
  const store = tmpStore();
  const { base, head } = createDemo(store);
  const r = buildReport({ store, baseId: base, headId: head, cfg: config() });
  assert.deepEqual(r.summary, { screens: 14, same: 6, changed: 5, new: 1, bad: 2 });
  assert.equal(r.screens.find((s) => s.name === 'Statistik').status, 'new');
  assert.equal(r.screens.find((s) => s.reason === 'crash').status, 'bad');
  assert.equal(r.screens.find((s) => s.reason === 'unreachable').name, 'Checkout');
  const detail = r.screens.find((s) => s.name === 'Workout-Detail');
  assert.equal(detail.status, 'changed');
  assert.ok(detail.boxes.length > 0);
});
