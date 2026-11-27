import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tmpDir } from './helpers.js';

// settings are global: point them to a throwaway home before anything is imported
const home = tmpDir('snappcrawl-home-');
process.env.SNAPPCRAWL_HOME = home;
process.env.SNAPPCRAWL_LEGACY_HOME = path.join(home, 'legacy');
const { DEFAULTS } = await import('../src/config.js');
const { createDemo } = await import('../src/demo.js');
const { buildReport } = await import('../src/diff.js');
const { createRoutes } = await import('../src/server.js');
const { Store } = await import('../src/store.js');
const { FakeApp } = await import('./fake-app.js');

function api(opts = {}) {
  const store = new Store(tmpDir()).ensure();
  const cfg = structuredClone(DEFAULTS);
  Object.assign(cfg.crawl, { settleMs: 0, launchMs: 0 });
  cfg.device.wdaUrl = 'http://127.0.0.1:9'; // never the WebDriverAgent of the machine running the tests
  const events = [];
  const { routes, live } = createRoutes({ store, cfg, version: 'test', broadcast: (type, data) => events.push([type, data]), ...opts });
  const call = (route, body, query = '') => routes[route](new URLSearchParams(query), body);
  return { store, cfg, call, live, events };
}

test('api: runs are listed and deleted with their comparisons; the baseline goes with them', () => {
  const { store, call } = api();
  const { base, head } = createDemo(store);
  buildReport({ store, baseId: base, headId: head, cfg: DEFAULTS });
  assert.equal(call('GET /api/runs').runs.length, 2);
  assert.deepEqual(call('POST /api/runs/delete', { id: base }), { id: base, diffs: 1, wasBaseline: true });
  assert.deepEqual(call('GET /api/runs').baselines, {});
  assert.ok(!fs.existsSync(store.runDir(base)));
  assert.throws(() => call('POST /api/runs/delete', { id: '../x' }), /no run/);
});

test('api: settings are stored with mode 600 and the key is shown masked', () => {
  const { call } = api();
  call('POST /api/config', { key: 'ai.provider', value: 'anthropic' });
  const r = call('POST /api/config', { key: 'ai.apiKey', value: 'sk-ant-secret-1234' });
  assert.equal(r.settings.ai.apiKey, '•••1234');
  assert.equal(r.ai.provider, 'anthropic');
  assert.equal(r.ai.ready, true, 'takes effect without a restart');
  const file = path.join(home, 'config.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ai.apiKey, 'sk-ant-secret-1234');
  assert.equal(call('GET /api/config').settings.ai.apiKey, '•••1234');
  assert.throws(() => call('POST /api/config', { key: 'auth.password', value: 'x' }), /cannot be set/);
  assert.throws(() => call('POST /api/config', { key: 'ai.provider', value: 'gpt' }), /must be none/);
});

test('api: prepare pauses the crawl until Continue (POST /api/answer)', async () => {
  const app = new FakeApp();
  const { call, live, store } = api({ driverFactory: () => app });
  call('POST /api/crawl', { bundleId: 'com.pulse.app', platform: 'ios-sim', label: 'prep', auth: { username: app.user, password: app.pass, mfa: 'totp', totpSecret: app.secret }, crawl: { prepare: true, systemAlerts: 'dismiss', dismiss: ['Alles klar'] } });
  for (let i = 0; i < 100 && !live.ask; i++) await new Promise((r) => setTimeout(r, 20));
  const state = call('GET /api/state');
  assert.equal(state.live.ask.kind, 'prepare');
  assert.match(state.live.ask.prompt, /Bring the app to the screen where the crawl should start/);
  assert.equal(call('POST /api/answer', { value: '' }).ok, true);
  for (let i = 0; i < 300 && live.running; i++) await new Promise((r) => setTimeout(r, 20));
  const run = store.listRuns()[0];
  assert.equal(run.status, 'done');
  assert.ok(run.screens > 5);
});

test('api: WebDriverAgent status and job state without a running WebDriverAgent', async () => {
  const { call } = api();
  const s = await call('GET /api/wda/status');
  assert.equal(typeof s.built, 'boolean');
  assert.equal(s.reachable, false);
  assert.deepEqual(Object.keys(call('GET /api/job')).sort(), ['error', 'hints', 'kind', 'log', 'ok', 'running']);
});
