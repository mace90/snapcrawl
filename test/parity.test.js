import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTIONS, cliWords } from '../src/actions.js';
import { DEFAULTS } from '../src/config.js';
import { createRoutes } from '../src/server.js';
import { Store } from '../src/store.js';
import { cli, tmpDir } from './helpers.js';

test('parity: every action has an API route and a CLI command', () => {
  const { routes } = createRoutes({ store: new Store(tmpDir()).ensure(), cfg: structuredClone(DEFAULTS), version: 'test' });
  const help = cli(tmpDir(), ['help']);
  const missing = [];
  for (const a of ACTIONS) {
    if (!routes[a.route]) missing.push(`${a.id}: route ${a.route}`);
    if (!help.includes(cliWords(a))) missing.push(`${a.id}: "${cliWords(a)}" not in snappcrawl help`);
    assert.ok(a.ui && a.title, `${a.id} names its place in the UI`);
  }
  assert.deepEqual(missing, []);
  const required = ['boot', 'wda-setup', 'wda-start', 'wda-stop', 'wda-status', 'apps', 'crawl', 'continue', 'runs', 'runs-rm', 'baseline', 'diff', 'review', 'report', 'notes', 'config'];
  assert.deepEqual(required.filter((id) => !ACTIONS.some((a) => a.id === id)), []);
});
