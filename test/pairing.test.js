import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { crawl } from '../src/crawler.js';
import { buildReport } from '../src/diff.js';
import { actionHints, pairActions } from '../src/pairing.js';
import { renderReport } from '../src/report.js';
import { Store } from '../src/store.js';
import { FakeApp } from './fake-app.js';

const a = (label, x, y, extra = {}) => ({ type: 'Button', label, id: '', x, y, tier: 'button', ...extra });

test('pairing: by label, by id, by place; relative to the screen size', () => {
  const base = [a('Konto', 100, 300), a('Suche', 350, 75), a('Hilfe', 100, 500), a('Alt', 200, 700)];
  const cur = [a('Mein Konto', 100, 302), a('Suche', 350, 600), a('Hilfe', 100, 500), a('Neu', 200, 200)];
  const { pairs, added, removed } = pairActions(cur, { w: 393, h: 852 }, base, { w: 393, h: 852 });
  const kind = (l) => pairs.find((p) => p.cur.label === l)?.kind;
  assert.equal(kind('Mein Konto'), 'renamed');
  assert.equal(kind('Suche'), 'moved');
  assert.equal(kind('Hilfe'), 'same');
  assert.deepEqual(added.map((x) => x.label), ['Neu']);
  assert.deepEqual(removed.map((x) => x.label), ['Alt']);

  // the same id with another label is a rename even at another place
  assert.equal(pairActions([a('Profile', 50, 50, { id: 'profile' })], null, [a('Profil', 300, 600, { id: 'profile' })], null).pairs[0].kind, 'renamed');
  // another device: the same relative place is the same place
  const big = pairActions([a('Start', 215, 465)], { w: 430, h: 932 }, [a('Los', 196.5, 426)], { w: 393, h: 852 });
  assert.equal(big.pairs[0].kind, 'renamed');
  // list cells pair, but give no hint: their content changes on its own
  const cells = actionHints([a('DAX klettert', 196, 300, { type: 'Cell', tier: 'item' })], null, [a('Dow fällt', 196, 300, { type: 'Cell', tier: 'item' })], null);
  assert.equal(cells, null);
});

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
const withBaseline = async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-'))).ensure();
  const { atlas } = await run(store, new FakeApp());
  store.setBaseline(atlas.meta.id);
  return { store, base: atlas };
};
const report = (store, base, head) => buildReport({ store, baseId: base.meta.id, headId: head.meta.id, cfg: structuredClone(DEFAULTS) });
const home = (r) => r.screens.find((s) => s.name === 'Hallo, Lena');

test('follow: a renamed button (same place) and a moved one (same label) are tapped as in the baseline', async () => {
  const { store, base } = await withBaseline();
  const changes = { home: { Profil: { label: 'Mein Profil' }, Workouts: { y: 480 } } };
  const { atlas, logs } = await run(store, new FakeApp({ changes }));
  assert.ok(logs.some((m) => /"Profil" is now "Mein Profil" · same place/.test(m)), logs.join('\n'));
  assert.ok(logs.some((m) => /"Workouts" moved · 180 pt down/.test(m)));
  assert.ok(logs.some((m) => /leads where "Profil" led · the same button, renamed/.test(m)));
  const r = report(store, base, atlas);
  assert.equal(r.summary.new, 0, 'the screens behind the renamed and the moved button are the baseline screens');
  assert.equal(r.summary.bad, 1, 'only the crash, as in the baseline');
  assert.deepEqual(home(r).hints.renamed, [{ from: 'Profil', to: 'Mein Profil', type: 'Button', same: true }]);
  assert.deepEqual(home(r).hints.moved, [{ label: 'Workouts', type: 'Button', dx: 0, dy: 180, same: true }]);
  const html = renderReport({ store, report: r, type: 'full' });
  assert.ok(html.includes('renamed &quot;Profil&quot; → &quot;Mein Profil&quot; · same place · leads to the same screen'));
  assert.ok(html.includes('moved &quot;Workouts&quot; · 180 pt down · leads to the same screen'));
});

test('follow: another button at the same place is noted, not tried twice', async () => {
  const { store, base } = await withBaseline();
  const { atlas, logs } = await run(store, new FakeApp({ changes: { home: { Profil: { label: 'Neu', to: 'news' } } } }));
  assert.ok(logs.some((m) => /"Neu" on s\d+ leads elsewhere than "Profil" did · another button at the same place/.test(m)));
  assert.ok(!logs.some((m) => /once more after a fresh start/.test(m)));
  const r = report(store, base, atlas);
  assert.deepEqual(home(r).hints.renamed, [{ from: 'Profil', to: 'Neu', type: 'Button', same: false }]);
  assert.ok(r.screens.some((s) => s.name === 'Profil' && s.reason === 'unreachable'));
});

test('two builds side by side: the first becomes the baseline, the second follows it and is compared', async () => {
  const { crawlPair } = await import('../src/pair.js');
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-'))).ensure();
  const v1 = new FakeApp();
  const v2 = new FakeApp({ changes: { home: { Profil: { label: 'Mein Profil' } } } });
  const logs = [];
  const cfg = config(v1);
  const { base, head, report: r } = await crawlPair({ driverFor: (id) => (id === 'com.pulse.app' ? v1 : v2), cfg, store, io: { log: (l, m) => logs.push(m), ask: async () => '' }, base: 'com.pulse.app', head: 'com.pulse.beta', label: 'v2' });
  assert.equal(store.baselineFor('com.pulse.app'), base.meta.id);
  assert.equal(store.baselineFor('com.pulse.beta'), null, 'the test build gets no baseline of its own');
  assert.equal(head.meta.app, 'com.pulse.beta');
  assert.equal(head.meta.against, 'com.pulse.app');
  assert.equal(head.meta.followed, base.meta.id);
  assert.match(base.meta.id, /-v2-baseline$/);
  assert.match(head.meta.id, /-v2-test$/);
  assert.equal(r.summary.new, 0);
  assert.equal(r.summary.bad, 1, 'only the crash, as in the baseline');
  assert.equal(home(r).hints.renamed[0].to, 'Mein Profil');
  assert.deepEqual(store.defaultPair(), { base: base.meta.id, head: head.meta.id }, 'diff without arguments compares the two');
  assert.ok(logs.some((m) => m.startsWith('2/2 test · com.pulse.beta against the baseline of')));
  await assert.rejects(crawlPair({ driverFor: () => v1, cfg, store, io: { log() {}, ask: async () => '' }, base: 'a', head: 'a' }), /another bundle id/);
});

test('against: a run without a baseline for the other app stops with a hint', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-'))).ensure();
  const { atlas } = await run(store, new FakeApp(), { against: 'com.other.app' });
  assert.equal(atlas.meta.status, 'failed');
  assert.match(atlas.meta.error, /no baseline for com\.other\.app · crawl it first/);
});
