import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import pngjs from 'pngjs';
import { DEFAULTS } from '../src/config.js';
import { crawl } from '../src/crawler.js';
import { buildReport } from '../src/diff.js';
import { Store } from '../src/store.js';
import { FakeApp } from './fake-app.js';

const { PNG } = pngjs;

const run = async (store) => {
  const app = new FakeApp();
  const cfg = structuredClone(DEFAULTS);
  cfg.app.bundleId = 'com.pulse.app';
  Object.assign(cfg.auth, { username: app.user, password: app.pass, mfa: 'totp', totpSecret: app.secret });
  Object.assign(cfg.crawl, { settleMs: 0, launchMs: 0 });
  return crawl({ driver: app, cfg, store, io: { log() {}, ask: async () => '' } });
};

// paint a block into a screenshot, in points (the fake screen is 393 pt wide)
function paint(file, { x, y, w, h }) {
  const p = PNG.sync.read(fs.readFileSync(file));
  const k = p.width / 393;
  for (let j = Math.round(y * k); j < Math.round((y + h) * k); j++) for (let i = Math.round(x * k); i < Math.round((x + w) * k); i++) p.data.writeUInt32BE(0xff00ffff, (j * p.width + i) * 4);
  fs.writeFileSync(file, PNG.sync.write(p));
}

test('ignore: an area or a whole screen is left out of the pixel comparison, per app and screen name', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-'))).ensure();
  const base = await run(store);
  const head = await run(store);
  const s = head.screens.find((x) => x.name === 'Workouts');
  paint(path.join(store.runDir(head.meta.id), s.screenshot), { x: 40, y: 500, w: 200, h: 120 }); // like an animation
  const cfg = structuredClone(DEFAULTS);
  const compare = () => buildReport({ store, baseId: base.meta.id, headId: head.meta.id, cfg }).screens.find((x) => x.name === 'Workouts');

  assert.equal(compare().status, 'changed');
  store.addIgnore('com.pulse.app', { screen: 'Workouts', area: { x: 30, y: 490, w: 220, h: 140 } });
  let r = compare();
  assert.equal(r.status, 'same', 'the painted area is ignored');
  assert.deepEqual(r.ignored, [{ x: 30, y: 490, w: 220, h: 140 }]);
  assert.deepEqual(r.pt, [393, 852]);

  // a smaller area leaves part of the change visible
  store.removeIgnore('com.pulse.app', 0);
  store.addIgnore('com.pulse.app', { screen: 'Workouts', area: { x: 40, y: 500, w: 100, h: 120 } });
  assert.equal(compare().status, 'changed');

  // the whole screen; other apps' rules do not apply
  store.removeIgnore('com.pulse.app', 0);
  store.addIgnore('com.other.app', { screen: 'Workouts' });
  assert.equal(compare().status, 'changed');
  store.addIgnore('com.pulse.app', { screen: 'Workouts' });
  r = compare();
  assert.equal(r.status, 'same');
  assert.deepEqual(r.ignored, [null]);

  // the config's rules count too
  store.removeIgnore('com.pulse.app', 0);
  cfg.diff.ignore = [{ screen: 'Workouts', area: { x: 0, y: 400, w: 393, h: 300 } }];
  assert.equal(compare().status, 'same');

  assert.throws(() => store.addIgnore('com.pulse.app', { screen: '' }), /which screen/);
  assert.throws(() => store.addIgnore('com.pulse.app', { screen: 'X', area: { x: 0, y: 0, w: 0, h: 10 } }), /x,y,w,h in points/);
  assert.throws(() => store.removeIgnore('com.pulse.app', 5), /no rule 6/);
});
