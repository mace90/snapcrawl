import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { crawl } from '../src/crawler.js';
import { consentAccept, introButtons } from '../src/interrupts.js';
import { Store } from '../src/store.js';
import { FakeApp } from './fake-app.js';

const tmpStore = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-'))).ensure();
const run = async (app, crawlOpts = {}, store = tmpStore()) => {
  const cfg = structuredClone(DEFAULTS);
  cfg.app.bundleId = 'com.pulse.app';
  Object.assign(cfg.auth, { username: app.user, password: app.pass, mfa: 'totp', totpSecret: app.secret });
  Object.assign(cfg.crawl, { settleMs: 0, launchMs: 0 }, crawlOpts);
  const logs = [];
  const asks = [];
  const atlas = await crawl({ driver: app, cfg, store, io: { log: (l, m) => logs.push(m), ask: async (kind, prompt) => (asks.push(prompt), '') } });
  return { atlas, logs, asks, store };
};
const names = (atlas) => atlas.screens.map((s) => s.name);

test('intro skip: taps through the intro, accepts the cookie banner, restarts, crawls without them', async () => {
  const app = new FakeApp({ onboarding: true, consent: true });
  const { atlas, logs } = await run(app, { intro: 'skip' });
  assert.equal(atlas.meta.status, 'done');
  assert.equal(atlas.meta.intro, 'skip');
  assert.ok(app.onboarded, 'the welcome screen was tapped away');
  assert.equal(app.consentDecision, 'Alle akzeptieren');
  assert.ok(!names(atlas).includes('Willkommen bei Pulse'), 'no intro screen in the map');
  assert.ok(!atlas.screens.some((s) => s.oneTime || s.consent));
  assert.ok(names(atlas).includes('Hallo, Lena'), 'the app itself was crawled');
  assert.ok(logs.some((m) => /intro\.skip done · \d+ taps? · restarting/.test(m)));
  assert.ok(!atlas.meta.warnings.length, `no warnings: ${atlas.meta.warnings}`);
});

test('intro fresh: the app is reset before every run, the comparison run inherits it from the baseline', async () => {
  const app = new FakeApp({ onboarding: true });
  app.onboarded = true; // an app that was used before: no intro without a reset
  const first = await run(app, { intro: 'fresh' });
  assert.equal(app.resets, 1);
  assert.equal(first.atlas.meta.intro, 'fresh');
  assert.ok(first.atlas.screens.some((s) => s.name === 'Willkommen bei Pulse' && s.oneTime), 'the intro is in the map, as one-time');

  first.store.setBaseline(first.atlas.meta.id);
  const second = await run(app, {}, first.store);
  assert.equal(app.resets, 2, 'reset again without --intro');
  assert.equal(second.atlas.meta.intro, 'fresh');
  assert.ok(second.logs.some((m) => m === 'intro fresh · like the baseline of this app'));
  assert.ok(second.atlas.screens.some((s) => s.name === 'Willkommen bei Pulse'), 'the comparison run sees the intro too');
});

test('intro fresh: --reinstall installs the build; without a way to reset, the user is asked', async () => {
  const app = new FakeApp({ onboarding: true });
  await run(app, { intro: 'fresh', reinstall: '/builds/Pulse.app' });
  assert.equal(app.reinstalled, '/builds/Pulse.app');

  const phone = new FakeApp({ onboarding: true });
  phone.resetData = undefined; // an iPhone cannot clear an app's data
  phone.reinstall = undefined;
  const { asks } = await run(phone, { intro: 'fresh' });
  assert.ok(asks.some((p) => /Delete Pulse on the iPhone and install it again/.test(p)));
});

test('intro keep: one-time screens come with a hint about fresh and skip', async () => {
  const { atlas, logs } = await run(new FakeApp({ onboarding: true }), { intro: 'keep' });
  assert.ok(atlas.screens.some((s) => s.oneTime));
  assert.ok(logs.some((m) => /one-time screens? \(app intro\) · .*--intro fresh .*--intro skip/.test(m)));
  await assert.rejects(run(new FakeApp(), { intro: 'later' }).then((r) => { if (r.atlas.meta.status === 'failed') throw new Error(r.atlas.meta.error); }), /keep, skip or fresh/);
});

test('intro helpers: accept cookies only on a consent screen, skip before next, never blocklisted', () => {
  const b = (label, y = 600) => ({ type: 'Button', label, enabled: true, x: 20, y, w: 300, h: 44 });
  const t = (label) => ({ type: 'StaticText', label, enabled: true, x: 20, y: 100, w: 300, h: 30 });
  assert.equal(consentAccept([t('Wir verwenden Cookies'), b('Einstellungen verwalten'), b('Alle ablehnen'), b('Alle akzeptieren')]).label, 'Alle akzeptieren');
  assert.equal(consentAccept([t('Neu in der App'), b('Akzeptieren')]), null, 'no privacy text, no consent screen');
  assert.deepEqual(introButtons([b('Weiter'), b('Überspringen', 60), b('Später'), b('Kaufen')], { blocklist: ['kaufen'] }).map((x) => x.label), ['Überspringen', 'Weiter', 'Später']);
  assert.deepEqual(introButtons([b('Abo abschließen'), b('Weiter lesen')]), [], 'exact labels only');
});

test('intro fresh: a cookie banner on the first start is kept as a one-time screen and accepted', async () => {
  const app = new FakeApp({ consent: true });
  const { atlas } = await run(app, { intro: 'fresh' });
  assert.equal(atlas.meta.status, 'done');
  const banner = atlas.screens.find((s) => s.consent);
  assert.ok(banner, 'the banner is in the map');
  assert.deepEqual(banner.actions.map((a) => a.label), ['Alle akzeptieren']);
  assert.ok(banner.oneTime, 'shown only once per run');
  assert.equal(app.consentDecision, 'Alle akzeptieren');
  assert.ok(atlas.screens.some((s) => s.name === 'Hallo, Lena'), 'the crawl went on into the app');
  assert.ok(!atlas.meta.warnings.some((w) => /cookie/.test(w)), `${atlas.meta.warnings}`);

  const keep = await run(new FakeApp({ consent: true }), { intro: 'keep' });
  assert.ok(keep.atlas.meta.warnings.some((w) => /cookie or privacy/.test(w)), 'keep never decides for you');
});
