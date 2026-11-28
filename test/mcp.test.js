import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { TOOLS, startMcp } from '../src/mcp.js';
import { Store } from '../src/store.js';
import { FakeApp } from './fake-app.js';

// A client speaking MCP to the server over two streams, like Claude Code or Codex over stdio.
function client({ apps }) {
  const input = new PassThrough();
  const lines = [];
  const waiting = new Map();
  const output = {
    write: (l) => {
      const m = JSON.parse(l);
      lines.push(m);
      if (m.id != null && waiting.has(m.id)) waiting.get(m.id)(m);
    },
  };
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-'))).ensure();
  const cfg = structuredClone(DEFAULTS);
  const one = apps[0];
  Object.assign(cfg.auth, { username: one.user, password: one.pass, mfa: 'totp', totpSecret: one.secret });
  Object.assign(cfg.crawl, { settleMs: 0, launchMs: 0 });
  let n = 0;
  const server = startMcp({ cfg, store, version: 'test', input, output, driverFactory: () => apps.shift() || one });
  const call = (method, params) => new Promise((resolve) => {
    const id = ++n;
    waiting.set(id, resolve);
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async (name, args = {}) => (await call('tools/call', { name, arguments: args, _meta: { progressToken: 'p' } })).result;
  return { call, tool, lines, store, server };
}
const json = (r) => JSON.parse(r.content.at(-1).text.slice(r.content.at(-1).text.indexOf('{')));

test('mcp: initialize, tools, a first check saves the baseline, a second one finds the change', async () => {
  const c = client({ apps: [new FakeApp(), new FakeApp({ changes: { home: { Profil: { label: 'Mein Profil' } } } })] });
  const init = (await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).result;
  assert.equal(init.serverInfo.name, 'snappcrawl');
  assert.match(init.instructions, /before you say the work is done/);
  const { tools } = (await c.call('tools/list', {})).result;
  assert.deepEqual(tools.map((t) => t.name), TOOLS.map((t) => t.name));
  for (const t of tools) assert.equal(t.inputSchema.type, 'object');

  const first = await c.tool('check', { bundleId: 'com.pulse.app' });
  assert.equal(first.structuredContent.verdict, 'baseline');
  assert.equal(first.structuredContent.crashes, 1);
  assert.equal(c.store.baselineFor('com.pulse.app'), first.structuredContent.run);

  const second = await c.tool('check', { bundleId: 'com.pulse.app', label: 'after' });
  const r = second.structuredContent;
  assert.equal(r.verdict, 'changes');
  const home = r.screens.find((s) => s.name === 'Hallo, Lena');
  assert.deepEqual(home.texts, { added: ['Mein Profil'], removed: ['Profil'] });
  assert.ok(home.buttons.some((b) => /renamed "Profil" → "Mein Profil"/.test(b)));
  assert.ok(fs.existsSync(home.images.head));
  assert.match(second.content[0].text, /### snappcrawl · com\.pulse\.app · changes to review/);
  assert.ok(c.lines.some((m) => m.method === 'notifications/progress' && m.params.progressToken === 'p'));

  const shot = await c.tool('screen', { id: home.id });
  assert.ok(shot.content.some((x) => x.type === 'image' && x.mimeType === 'image/png' && x.data.length > 100));

  const rev = await c.tool('review', { screens: 'all', decision: 'approve' });
  assert.match(rev.content[0].text, /verdict now passed/);
  assert.equal((await c.tool('compare')).structuredContent.verdict, 'passed');

  const ign = json(await c.tool('ignore', { bundleId: 'com.pulse.app', screen: 'Workouts', area: { x: 0, y: 100, w: 50, h: 50 } }));
  assert.equal(ign.rules.length, 1);
  assert.match((await c.call('tools/call', { name: 'nope' })).error.message, /unknown tool/);
  const home2 = (await c.tool('compare')).structuredContent.screens.find((s) => s.reason === 'crash');
  assert.equal(home2.known, true, 'the crash was in the baseline too');
  c.server.close();
});

test('mcp: a slow check answers with a job and its progress; a login without credentials asks for a person', async () => {
  const app = new FakeApp();
  const c = client({ apps: [app] });
  const elements = app.elements.bind(app);
  app.elements = async () => (await new Promise((r) => setTimeout(r, 30)), elements());
  const r = json(await c.tool('check', { bundleId: 'com.pulse.app', wait: 1 }));
  assert.equal(r.verdict, 'running');
  assert.match(r.next, /check_status/);
  const busy = await c.tool('check', { bundleId: 'com.pulse.app' });
  assert.match(busy.content[0].text, /already running/);
  const done = await c.tool('check_status', { job: r.job, wait: 60 });
  assert.equal(done.structuredContent.verdict, 'baseline');

  const lonely = client({ apps: [new FakeApp()] });
  const cfgless = await lonely.tool('check', {});
  assert.equal(cfgless.isError, true);
  assert.match(cfgless.content[0].text, /which app/);
  c.server.close();
  lonely.server.close();
});
