import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import pngjs from 'pngjs';
import { DEFAULTS } from '../src/config.js';
import { crawl, nameOf } from '../src/crawler.js';
import { comparePng } from '../src/diff.js';
import { IosDevice, developerMode, flattenSource, parseApps, parseDevices } from '../src/drivers/ios-device.js';
import { makeDriver } from '../src/drivers/index.js';
import { Store } from '../src/store.js';
import { buildPlist, listUsbDevices, parsePlist, startForwarder } from '../src/usbmux.js';
import { bundleIdFor, diagnose, latestTag } from '../src/wda.js';
import { FakeApp } from './fake-app.js';
import { DEVICECTL, fakeDevicectl, startFakeWda } from './fake-wda.js';

const { PNG } = pngjs;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const config = (auth = {}) => {
  const cfg = structuredClone(DEFAULTS);
  cfg.app.bundleId = 'com.pulse.app';
  cfg.crawl.settleMs = 0;
  cfg.crawl.launchMs = 0;
  Object.assign(cfg.auth, auth);
  return cfg;
};
const device = (wda, udid = '') => new IosDevice({ udid, bundleId: 'com.pulse.app', wdaUrl: wda.url, run: fakeDevicectl });

test('devicectl: only reachable physical iPhones, wired first; apps without clips', () => {
  const devs = parseDevices(DEVICECTL['list devices']);
  assert.deepEqual(devs.map((d) => [d.name, d.udid, d.ios, d.transport]), [
    ['Lena’s iPhone', '00008140-FAKE', '26.2', 'wired'],
    ['Wifi iPhone', '00008110-WIFI', '18.1', 'localNetwork'],
  ]);
  assert.equal(devs[0].developerMode, 'enabled');
  assert.equal(devs[1].developerMode, '');
  assert.deepEqual(parseApps(DEVICECTL['device info apps']).map((a) => [a.bundleId, a.type]), [['com.yahoo.finance', 'user'], ['com.pulse.app', 'developer'], ['com.apple.Preferences', 'system']]);
});

test('devicectl: developer mode from device details (enum object)', async () => {
  assert.equal(await developerMode('CORE-1', fakeDevicectl), 'disabled');
});

test('ios-device driver speaks WDA: elements, tap, type, app state, screenshot, status bar', async () => {
  const wda = await startFakeWda();
  try {
    const d = device(wda, 'Lena’s iPhone');
    await d.resolve();
    assert.deepEqual([d.platform, d.name, d.runtime, d.udid, d.statusBar], ['ios-device', 'Lena’s iPhone', 'iOS 26.2', '00008140-FAKE', 54]);
    assert.deepEqual((await d.listApps()).map((a) => a.name), ['Finance', 'Pulse', 'Settings']);
    await d.launch();
    assert.equal(await d.isRunning(), true);
    // same element format as the simulator driver; invisible and zero-size elements dropped
    assert.deepEqual(await d.elements(), await wda.app.elements());
    const start = (await d.elements()).find((e) => e.label === 'Los geht’s');
    await d.tap(start.x + start.w / 2, start.y + start.h / 2);
    assert.equal(wda.app.screen, 'login');
    const mail = (await d.elements()).find((e) => e.type === 'TextField');
    await d.tap(mail.x + 5, mail.y + 5);
    await d.type('lena@pulse.app');
    assert.equal((await d.elements()).find((e) => e.type === 'TextField').value, 'lena@pulse.app');
    const file = path.join(tmp('snapcrawl-shot-'), 's.png');
    await d.screenshot(file);
    assert.equal(PNG.sync.read(fs.readFileSync(file)).width, 393);
    // WDA restarted: the stale session is replaced transparently
    wda.dropSession();
    assert.ok((await d.elements()).length > 1);
    assert.ok(wda.calls.includes('POST /session/:id/wda/tap'));
  } finally {
    await wda.close();
  }
});

test('ios-device driver falls back on older WDA endpoints', async () => {
  for (const variant of [{ legacy: true }, { actionsOnly: true }]) {
    const wda = await startFakeWda(variant);
    try {
      const d = device(wda);
      await d.resolve();
      await d.launch();
      assert.equal(await d.isRunning(), true);
      const els = await d.elements();
      assert.deepEqual(els, await wda.app.elements(), 'frame strings and "1"/"0" flags are understood');
      const start = els.find((e) => e.label === 'Los geht’s');
      await d.tap(start.x + 10, start.y + 10);
      await d.tap(10, 10); // second tap goes straight to the endpoint that worked
      assert.equal(wda.app.screen, 'login');
      const used = wda.calls.filter((c) => /tap|actions/.test(c));
      assert.deepEqual(used, variant.legacy
        ? ['POST /session/:id/wda/tap', 'POST /session/:id/wda/tap/0', 'POST /session/:id/wda/tap/0']
        : ['POST /session/:id/wda/tap', 'POST /session/:id/wda/tap/0', 'POST /session/:id/actions', 'POST /session/:id/actions']);
    } finally {
      await wda.close();
    }
  }
});

test('ios-device: a full crawl through WebDriverAgent', async () => {
  for (const legacy of [false, true]) {
    const app = new FakeApp();
    const wda = await startFakeWda({ app, legacy });
    try {
      const store = new Store(tmp('snapcrawl-')).ensure();
      const atlas = await crawl({ driver: device(wda), cfg: config({ username: app.user, password: app.pass, mfa: 'totp', totpSecret: app.secret }), store, io: { log: () => {}, ask: async () => '' } });
      assert.equal(atlas.meta.status, 'done', atlas.meta.error);
      assert.equal(atlas.meta.device.platform, 'ios-device');
      assert.equal(atlas.meta.device.statusBar, legacy ? undefined : 54);
      assert.equal(atlas.meta.appName, 'Pulse');
      const names = atlas.screens.filter((s) => !s.crash).map((s) => s.name).sort();
      assert.deepEqual(names, ['Einstellungen', 'Hallo, Lena', 'Mitteilungen', 'Player', 'Profil', 'Profil bearbeiten', 'Pulse', 'Workout', 'Workouts'].sort());
      assert.equal(atlas.screens.filter((s) => s.crash).length, 1);
      assert.ok(!app.taps.includes('Abmelden'));
      assert.ok(!app.taps.includes('Hidden'), 'invisible elements are never tapped');
    } finally {
      await wda.close();
    }
  }
});

test('ios-device: clear message when WebDriverAgent is not reachable', async () => {
  const d = new IosDevice({ bundleId: 'x', wdaUrl: 'http://127.0.0.1:9', run: fakeDevicectl });
  await assert.rejects(d.resolve(), /WebDriverAgent not reachable at http:\/\/127\.0\.0\.1:9 \(.+\) · run: snapcrawl wda start/);
  const wda = await startFakeWda();
  wda.lock();
  await assert.rejects(device(wda).resolve(), /lost the permission to control the iPhone .* snapcrawl wda stop && snapcrawl wda start/);
  await wda.close();
  const none = new IosDevice({ udid: 'Nope', run: fakeDevicectl });
  await assert.rejects(none.findDevice(), /No connected iPhone matches "Nope"/);
  assert.equal(makeDriver({ platform: 'ios-device', udid: 'booted' }).udid, '');
  assert.throws(() => makeDriver({ platform: 'android' }), /unknown device.platform/);
});

test('WDA source flattening: web, tab bar, selected and header flags (as Yahoo Finance reports them)', () => {
  const f = (frame) => `{{${frame.join(', ')}}}`.replace(/^\{\{(\S+), (\S+), (\S+), (\S+)\}\}$/, '{{$1, $2}, {$3, $4}}');
  const els = flattenSource({
    type: 'Application', label: 'Finance', frame: f([0, 0, 440, 956]), isVisible: '1',
    children: [
      { type: 'NavigationBar', label: null, rawIdentifier: 'Startseite', frame: f([0, 268, 440, 54]), isVisible: '1', traits: '' },
      { type: 'StaticText', label: 'Märkte heute', frame: f([16, 330, 200, 30]), isVisible: '1', traits: 'Header, StaticText' },
      { type: 'WebView', frame: f([0, 62, 440, 204]), isVisible: '1', children: [{ type: 'Other', frame: f([0, 62, 440, 204]), isVisible: '1', children: [{ type: 'Link', label: 'Weitere Informationen', frame: f([300, 70, 100, 30]), isVisible: '1' }] }] },
      { type: 'TabBar', label: 'Tableiste', frame: f([0, 873, 440, 83]), isVisible: '1', children: [
        { type: 'Button', label: 'Startseite', value: '1', traits: 'Selected, Button', frame: f([77, 877, 102, 54]), isVisible: '1' },
        { type: 'Button', label: 'Nachrichten', value: null, traits: 'Button', frame: f([170, 877, 101, 54]), isVisible: '1' },
      ] },
    ],
  });
  const by = (label) => els.find((e) => e.label === label || e.id === label);
  assert.equal(by('Startseite').type, 'NavigationBar');
  assert.equal(by('Märkte heute').header, true);
  assert.equal(by('Weitere Informationen').web, true);
  assert.equal(els.find((e) => e.type === 'Button' && e.label === 'Startseite').selected, true);
  assert.equal(els.find((e) => e.type === 'Button' && e.label === 'Startseite').tab, true);
  assert.equal(by('Nachrichten').selected, undefined);
  assert.equal(nameOf(els, { w: 440, h: 956 }, 'x'), 'Startseite');
});

test('WDA source flattening: XCUIElementType prefix, rect or frame, visibility', () => {
  const els = flattenSource({
    type: 'XCUIElementTypeApplication', label: 'Pulse', rect: { x: 0, y: 0, width: 393, height: 852 },
    children: [
      { type: 'XCUIElementTypeButton', label: 'Go', name: 'go-button', rect: { x: 10, y: 20, width: 100, height: 44 }, isEnabled: '0' },
      { type: 'XCUIElementTypeCell', label: 'Below the fold', rect: { x: 0, y: 2000, width: 393, height: 44 } },
      { type: 'XCUIElementTypeStaticText', label: ' Hello ', frame: '{{5, 6}, {7, 8}}', isVisible: '1', children: [{ type: 'XCUIElementTypeImage', label: 'x', rect: { x: 1, y: 1, width: 2, height: 2 }, isVisible: false }] },
    ],
  });
  assert.deepEqual(els.map((e) => [e.type, e.label, e.id, e.enabled, e.x, e.y, e.w, e.h]), [
    ['Application', 'Pulse', '', true, 0, 0, 393, 852],
    ['Button', 'Go', 'go-button', false, 10, 20, 100, 44],
    ['StaticText', 'Hello', '', true, 5, 6, 7, 8],
  ]);
});

// A fake usbmuxd on a unix socket: ListDevices + Connect, then pipes to a TCP port.
async function fakeUsbmuxd(targetPort) {
  const sockPath = path.join(tmp('mux-'), 's');
  const frame = (obj) => {
    const body = Buffer.from(buildPlist(obj));
    const h = Buffer.alloc(16);
    h.writeUInt32LE(16 + body.length, 0); h.writeUInt32LE(1, 4); h.writeUInt32LE(8, 8); h.writeUInt32LE(1, 12);
    return Buffer.concat([h, body]);
  };
  const server = net.createServer((c) => {
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 16 || buf.length < buf.readUInt32LE(0)) return;
      const msg = parsePlist(buf.subarray(16, buf.readUInt32LE(0)).toString());
      c.removeListener('data', onData);
      if (msg.MessageType === 'ListDevices') {
        c.end(frame({ DeviceList: [{ DeviceID: 7, MessageType: 'Attached', Properties: { SerialNumber: '00008140-FAKE', ConnectionType: 'USB', DeviceID: 7 } }] }));
      } else if (msg.MessageType === 'Connect') {
        const port = ((msg.PortNumber & 0xff) << 8) | (msg.PortNumber >> 8);
        if (msg.DeviceID !== 7 || port !== 8100) return c.end(frame({ MessageType: 'Result', Number: 3 }));
        c.write(frame({ MessageType: 'Result', Number: 0 }));
        const up = net.createConnection(targetPort, '127.0.0.1');
        c.pipe(up).pipe(c);
      }
    };
    c.on('data', onData);
  });
  await new Promise((r) => server.listen(sockPath, r));
  return { sockPath, close: () => server.close() };
}

test('usbmux: plist round trip, device list and port forwarding to WebDriverAgent', async () => {
  const v = { MessageType: 'Connect', DeviceID: 7, PortNumber: 46111, Name: 'a & <b>', Ok: true, No: false, List: [1, 'x', {}], Data: Buffer.from('hi') };
  const back = parsePlist(buildPlist(v));
  assert.deepEqual({ ...back, Data: back.Data.toString() }, { ...v, Data: 'hi' });

  const wda = await startFakeWda();
  const mux = await fakeUsbmuxd(wda.port);
  const fwd = await startForwarder({ udid: '00008140-FAKE', localPort: 0, socketPath: mux.sockPath });
  try {
    assert.deepEqual(await listUsbDevices({ socketPath: mux.sockPath }), [{ id: 7, udid: '00008140-FAKE', type: 'USB' }]);
    const r = await (await fetch(`http://127.0.0.1:${fwd.address().port}/status`)).json();
    assert.equal(r.value.ready, true);
    const d = new IosDevice({ bundleId: 'com.pulse.app', wdaUrl: `http://127.0.0.1:${fwd.address().port}`, run: fakeDevicectl });
    await d.resolve();
    await d.launch();
    assert.ok((await d.elements()).some((e) => e.label === 'Los geht’s'));
  } finally {
    fwd.close();
    mux.close();
    await wda.close();
  }
});

test('diff masks the measured status bar at any screenshot scale', () => {
  const dir = tmp('snapcrawl-bar-');
  const img = (file, bar) => {
    const p = new PNG({ width: 300, height: 600 }); // e.g. a 2x screenshot of a 150×300 pt screen
    p.data.fill(255);
    for (let y = 0; y < 60; y++) for (let x = 0; x < 300; x++) if (bar) p.data[(y * 300 + x) * 4] = 0; // 10 % high bar
    fs.writeFileSync(path.join(dir, file), PNG.sync.write(p));
    return path.join(dir, file);
  };
  const a = img('a.png', false), b = img('b.png', true);
  assert.ok(comparePng(a, b, path.join(dir, 'd1.png')).ratio > 0, 'default mask (6.5 %) is too small for this bar');
  assert.equal(comparePng(a, b, path.join(dir, 'd2.png'), { statusBarRatio: 30 / 300 }).ratio, 0, '30 pt bar of a 300 pt screen');
});

test('wda helpers: latest tag, bundle id, failure hints', () => {
  assert.equal(latestTag('a\trefs/tags/v9.2.0\nb\trefs/tags/v10.1.3\nc\trefs/tags/v9.14.1\nd\trefs/tags/beta\n'), 'v10.1.3');
  assert.equal(bundleIdFor('Lena.M', 'AB12CD34EF'), 'com.lenam.snapcrawl.ab12cd34ef.WebDriverAgentRunner');
  assert.match(diagnose('error: Developer Mode disabled')[0], /Developer Mode/);
  assert.match(diagnose('The application could not be launched because the Developer App Certificate is not trusted. invalid code signature')[0], /VPN & Device Management/);
  assert.deepEqual(diagnose('Unlock iPhone to Continue … later: profile has not been explicitly trusted').map((h) => h.split(' ')[0]), ['Trust', 'Unlock']);
});
