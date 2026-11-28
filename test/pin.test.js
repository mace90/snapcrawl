import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { crawl } from '../src/crawler.js';
import { Store } from '../src/store.js';
import { FakeApp } from './fake-app.js';

// The fake app locks itself with a PIN on every start once someone has logged in, so every
// relaunch of the crawl (to replay a path) meets the PIN prompt.
const run = async (app, pin, { ask } = {}) => {
  const cfg = structuredClone(DEFAULTS);
  cfg.app.bundleId = 'com.pulse.app';
  Object.assign(cfg.auth, { username: app.user, password: app.pass, mfa: 'totp', totpSecret: app.secret, pin });
  Object.assign(cfg.crawl, { settleMs: 0, launchMs: 0 });
  const logs = [];
  const asks = [];
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-'))).ensure();
  const atlas = await crawl({ driver: app, cfg, store, io: { log: (l, m) => logs.push(m), ask: async (k) => (asks.push(k), ask?.()) } });
  return { atlas, logs, asks };
};
const names = (atlas) => atlas.screens.map((s) => s.name);

test('pin: tapped digit by digit on the app’s number pad, a leading zero kept', async () => {
  const app = new FakeApp({ pin: { code: '0815', pad: true } });
  const { atlas, logs, asks } = await run(app, '0815');
  assert.equal(atlas.meta.status, 'done');
  assert.ok(app.pinOk > 0, 'the app was unlocked');
  assert.equal(app.pinFails, 0);
  assert.equal(asks.length, 0, 'nobody was asked');
  assert.ok(logs.some((m) => m === 'pin screen · tapping 4 digits on the number pad'));
  assert.ok(!names(atlas).includes('Gib deine PIN ein'), 'the PIN prompt is not crawled as a screen');
  assert.ok(names(atlas).includes('Mitteilungen'), 'deep screens are reached through the lock');
  assert.ok(logs.every((m) => !m.includes('0815')), 'the PIN never appears in the log');
});

test('pin: typed into a secure field, 6 and 8 digits, then "Weiter"', async () => {
  for (const code of ['123456', '12345678']) {
    const app = new FakeApp({ pin: { code } });
    const { atlas, logs } = await run(app, code);
    assert.equal(atlas.meta.status, 'done');
    assert.ok(app.pinOk > 0 && app.pinFails === 0, `${code.length} digits accepted`);
    assert.ok(logs.some((m) => m === `pin screen · typing ${code.length} characters`));
    assert.ok(!names(atlas).includes('Bitte PIN eingeben'));
  }
});

test('pin: a wrong PIN is entered once per prompt, then you are asked', async () => {
  const app = new FakeApp({ pin: { code: '0815', pad: true } });
  const { logs, asks } = await run(app, '1111', { ask: () => void (app.overlay = null) }); // you unlock it on the device
  assert.ok(app.pinFails >= 1);
  assert.equal(app.pinFails, asks.length, 'one try per prompt, never a second one with the same PIN');
  assert.ok(logs.some((m) => /the PIN was not accepted · not tried again/.test(m)));
});

test('pin: none configured → you are asked to enter it', async () => {
  const app = new FakeApp({ pin: { code: '0815', pad: true } });
  const { asks, logs } = await run(app, '', { ask: () => void (app.overlay = null) });
  assert.ok(asks.length >= 1);
  assert.equal(app.pinFails, 0);
  assert.ok(logs.some((m) => /PIN screen detected\. Enter the PIN on the device \(or set auth\.pin/.test(m)));
});
