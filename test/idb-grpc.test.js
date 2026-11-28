import assert from 'node:assert/strict';
import fs from 'node:fs';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Companion, companionAddress, decode, touch } from '../src/drivers/idb-grpc.js';
import { IosSimulator } from '../src/drivers/ios-sim.js';

// A stand-in for idb_companion on a local socket: answers accessibility_info, hid and screenshot
// the way the real one does (gRPC framing, the reply message, grpc-status in the trailers).
const frame = (b) => {
  const h = Buffer.alloc(5);
  h.writeUInt32BE(b.length, 1);
  return Buffer.concat([h, b]);
};
const field = (n, buf) => Buffer.concat([Buffer.from([(n << 3) | 2, buf.length]), buf]); // short messages only
const ELEMENTS = [{ AXLabel: 'Allgemein', type: 'Button', frame: { x: 16, y: 200, width: 370, height: 44 } }];

async function fakeCompanion({ fail = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idb-'));
  const sock = path.join(dir, 'companion.sock');
  const seen = [];
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      const method = headers[':path'].split('/').pop();
      const body = Buffer.concat(chunks);
      const msgs = [];
      for (let i = 0; i < body.length; ) {
        const n = body.readUInt32BE(i + 1);
        msgs.push(body.subarray(i + 5, i + 5 + n));
        i += 5 + n;
      }
      seen.push({ method, msgs });
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers(fail ? { 'grpc-status': '14', 'grpc-message': 'unavailable' } : { 'grpc-status': '0' }));
      if (fail) return stream.end();
      if (method === 'accessibility_info') {
        const json = Buffer.from(JSON.stringify(ELEMENTS));
        stream.end(frame(Buffer.concat([Buffer.from([0x0a]), Buffer.from([json.length & 0x7f | 0x80, json.length >> 7]), json])));
      } else if (method === 'screenshot') stream.end(frame(field(1, Buffer.from('PNGDATA'))));
      else stream.end(frame(Buffer.alloc(0)));
    });
  });
  await new Promise((r) => server.listen(sock, r));
  return { sock, seen, dir, close: () => new Promise((r) => server.close(r)) };
}

test('idb gRPC: reads the screen, taps and takes screenshots over the companion socket', async () => {
  const f = await fakeCompanion();
  const c = new Companion({ path: f.sock });
  assert.deepEqual(await c.describeAll(), ELEMENTS);
  await c.tap(201, 222);
  assert.equal((await c.screenshot()).toString(), 'PNGDATA');
  c.close();
  await f.close();
  const hid = f.seen.find((s) => s.method === 'hid');
  assert.equal(hid.msgs.length, 2, 'touch down, touch up');
  assert.deepEqual(hid.msgs[0], touch(201, 222, 0));
  // HIDEvent.press.action.touch.point: x and y as doubles, direction down then up
  const press = decode(decode(hid.msgs[1])[1][0]);
  const point = decode(decode(decode(press[1][0])[1][0])[1][0]);
  assert.deepEqual([point[1][0], point[2][0], Number(press[2][0])], [201, 222, 1]);
});

test('idb gRPC: the companion address comes from idb’s state file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idb-'));
  const sock = path.join(dir, 'x.sock');
  fs.writeFileSync(sock, '');
  const state = path.join(dir, 'state');
  fs.writeFileSync(state, JSON.stringify([{ udid: 'A', is_local: true, path: sock }, { udid: 'B', host: 'localhost', port: 10882 }]));
  assert.deepEqual(companionAddress('A', state), { path: sock });
  assert.deepEqual(companionAddress('B', state), { host: 'localhost', port: 10882 });
  assert.equal(companionAddress('nope-' + Date.now(), state), null);
});

test('idb gRPC: errors fall back to the idb command line, after two the companion is dropped', async () => {
  const f = await fakeCompanion({ fail: true });
  const sim = new IosSimulator({ udid: 'X', bundleId: 'com.x' });
  sim.companion = new Companion({ path: f.sock });
  sim.transport = 'idb_companion';
  let cli = 0;
  const viaCli = async () => (cli++, 'cli');
  assert.equal(await sim.fast('describe', (c) => c.describeAll(), viaCli), 'cli');
  assert.ok(sim.companion, 'one error: still the companion next time');
  assert.equal(await sim.fast('describe', (c) => c.describeAll(), viaCli), 'cli');
  assert.equal(sim.companion, null);
  assert.equal(sim.transport, 'idb');
  assert.match(sim.fellBack, /unavailable/);
  assert.equal(cli, 2);
  await f.close();
});
