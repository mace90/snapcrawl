import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { crawl } from '../src/crawler.js';
import { Store } from '../src/store.js';
import { TabApp } from './fake-tabs.js';
import { cli, tmpDir } from './helpers.js';

const run = async (crawlOpts = {}) => {
  const cfg = structuredClone(DEFAULTS);
  cfg.app.bundleId = 'com.tabs.app';
  Object.assign(cfg.crawl, { settleMs: 0, launchMs: 0 }, crawlOpts);
  const app = new TabApp();
  const logs = [];
  const progress = [];
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-'))).ensure();
  const atlas = await crawl({ driver: app, cfg, store, io: { log: (l, m) => logs.push(m), ask: async () => '', event: (t, d) => t === 'progress' && progress.push(d) } });
  const byName = (n) => atlas.screens.find((s) => s.name === n);
  // the order in which screens were explored: the first tap logged on each
  const explored = [];
  for (const m of logs) {
    const id = m.match(/^tap ".*" on (s\d+)$/)?.[1];
    if (id && !explored.includes(id)) explored.push(id);
  }
  return { atlas, app, logs, progress, byName, explored: explored.map((id) => atlas.screens.find((s) => s.id === id).name) };
};
const tapsOf = (logs, label) => logs.filter((m) => m.startsWith(`tap "${label}" on`)).length;

test('priority: navigation first, then buttons, then list items; tab bar found by position', async () => {
  const { atlas, byName } = await run();
  assert.equal(atlas.meta.status, 'done');
  const root = byName('Neuigkeiten');
  assert.deepEqual(root.actions.slice(0, 6).map((a) => a.label), ['Menü', 'Suche', 'Start', 'Märkte', 'Profil', 'Konto']);
  assert.deepEqual(root.actions.slice(0, 6).map((a) => a.tier), ['nav', 'nav', 'nav', 'nav', 'nav', 'button']);
  assert.ok(root.actions.slice(6).every((a) => a.tier === 'item' && !['Konto'].includes(a.label)));
  assert.ok(root.actions.filter((a) => a.tab).length === 3, 'the three tab bar buttons are tabs');
  const row = byName('Mein Profil').actions.find((a) => a.label === 'Datenschutz');
  assert.equal(row.tier, 'button', 'a row that slides under the tab bar is not part of it');
});

test('priority: screens reached through navigation are explored first within a level', async () => {
  const { explored } = await run();
  assert.equal(explored[0], 'Neuigkeiten');
  // level 1: menu, search, the two other tabs (navigation) → account (button) → article (list item)
  const at = (n) => explored.indexOf(n);
  for (const nav of ['Menü', 'Suchen', 'Märkte', 'Mein Profil']) {
    assert.ok(at(nav) >= 0, `${nav} explored`);
    assert.ok(at(nav) < at('Konto') || at('Konto') < 0, `${nav} before Konto`);
    assert.ok(at(nav) < at('Artikel'), `${nav} before Artikel`);
  }
  assert.ok(at('Konto') < at('Artikel') || at('Konto') < 0);
  // level 2 only after level 1
  assert.ok(at('Einstellungen') > at('Artikel'), 'a level 2 screen after every level 1 screen');
});

test('priority: each tab is tapped once per run, other screens still get the transition', async () => {
  const { atlas, logs, progress, byName } = await run();
  for (const tab of ['Start', 'Märkte', 'Profil']) assert.equal(tapsOf(logs, tab), 1, `${tab} tapped once`);
  assert.ok(logs.some((m) => /repeated tab taps? saved/.test(m)));
  const edge = (from, to) => atlas.edges.some((e) => e.from === byName(from).id && e.to === byName(to).id);
  assert.ok(edge('Artikel', 'Märkte'), 'article → markets known without tapping');
  assert.ok(edge('Kurs', 'Neuigkeiten'), 'quote → feed via Start');
  const last = progress.at(-1);
  assert.equal(last.done, last.total);
  assert.equal(last.pct, 100);
});

test('max per list: only the first n cells of a list are tapped', async () => {
  const { byName, logs } = await run({ maxPerList: 3 });
  const root = byName('Neuigkeiten');
  assert.deepEqual(root.actions.filter((a) => a.tier === 'item').map((a) => a.label), ['Börse', 'Politik', 'Sport']);
  assert.equal(root.limited, 5);
  assert.equal(tapsOf(logs, 'Kultur'), 0);
  assert.ok(logs.some((m) => m.includes('action.skip 5 more list items (max 3 per list)')));
  assert.equal(byName('Märkte').actions.length, 2 + 3, 'a short list is not cut (two cells + three tabs)');
});

test('prefer: listed labels come before everything else, in the order given', async () => {
  const { byName, explored, atlas } = await run({ prefer: ['Konto', 'sport'] });
  const root = byName('Neuigkeiten');
  assert.deepEqual(root.actions.slice(0, 2).map((a) => [a.label, a.tier]), [['Konto', 'prefer'], ['Sport', 'prefer']]);
  assert.equal(root.actions[2].tier, 'nav');
  assert.equal(explored[1], 'Konto', 'the preferred screen is explored first on its level');
  assert.deepEqual(atlas.meta.limits.prefer, ['Konto', 'sport']);
});

test('config set crawl.prefer stores a list', () => {
  const dir = tmpDir();
  cli(dir, ['config', 'set', 'crawl.prefer', 'Konto, Einstellungen']);
  cli(dir, ['config', 'set', 'crawl.maxPerList', '3']);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, '.home', 'config.json'), 'utf8'));
  assert.deepEqual(saved.crawl.prefer, ['Konto', 'Einstellungen']);
  assert.equal(saved.crawl.maxPerList, 3);
});
