import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { FakeApp } from './fake-app.js';

// A WebDriverAgent look-alike on top of FakeApp, so the real-device driver and a full crawl
// can be tested without an iPhone. `legacy: true` mimics an older WDA: no /wda/tap (only
// /wda/tap/0), no /wda/apps/state (only /wda/activeAppInfo), string flags, frame strings.
export async function startFakeWda({ app = new FakeApp(), legacy = false, actionsOnly = false, launchDenied = false } = {}) {
  // locked: every session call fails, like WDA after the iPhone was locked
  // halfLocked: only reading the screen fails; status, activeAppInfo and the rest still answer
  const state = { locked: false, halfLocked: false };
  const calls = [];
  let sid = null;
  let n = 0;
  const shotFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-wda-')), 'shot.png');

  const node = (e) => ({
    type: 'XCUIElementType' + e.type,
    label: e.label || null,
    name: e.id || e.label || null,
    value: e.value || null,
    rawIdentifier: legacy ? undefined : e.id || null,
    isEnabled: legacy ? (e.enabled ? '1' : '0') : e.enabled,
    isVisible: legacy ? '1' : true,
    ...(legacy ? { frame: `{{${e.x}, ${e.y}}, {${e.w}, ${e.h}}}` } : { rect: { x: e.x, y: e.y, width: e.width ?? e.w, height: e.height ?? e.h } }),
  });

  async function source() {
    const [root, ...rest] = (await app.elements()).filter((e) => !e.alert); // WDA reports prompts through /alert
    const own = rest.filter((e) => !e.web), web = rest.filter((e) => e.web);
    const tree = { ...node(root), children: own.map(node) };
    if (web.length) tree.children.push({ ...node({ type: 'WebView', label: '', id: '', value: '', enabled: true, x: 0, y: 0, w: root.w, h: root.h }), children: web.map(node) });
    // noise a real tree has: an invisible element and a zero-size one
    tree.children.push({ ...node({ type: 'Button', label: 'Hidden', id: '', value: '', enabled: true, x: 0, y: 0, w: 50, h: 50 }), isVisible: legacy ? '0' : false });
    tree.children.push({ ...node({ type: 'Other', label: '', id: '', value: '', enabled: true, x: 0, y: 0, w: 0, h: 0 }) });
    return tree;
  }

  const err = (res, code, error, message) => send(res, code, { value: { error, message, traceback: '' }, sessionId: sid });
  const send = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, 'http://x');
    const route = `${req.method} ${url.pathname.replace(/^\/session\/[^/]+/, '/session/:id')}`;
    calls.push(route);
    const m = url.pathname.match(/^\/session\/([^/]+)/);
    if (m && m[1] !== sid) return err(res, 404, 'invalid session id', 'Session does not exist');
    const ok = (value = null) => send(res, 200, { value, sessionId: sid });
    if ((state.locked && m) || (state.halfLocked && route === 'GET /session/:id/source')) return err(res, 500, 'unknown error', 'The previously found element "Application \'com.apple.springboard\'" is not present in the current view anymore. Original error: Not authorized for performing UI testing actions.');
    const unknown = () => err(res, 404, 'unknown command', `Unhandled endpoint: ${url.pathname}`);

    switch (route) {
      case 'GET /status':
        return ok({ ready: true, message: 'WebDriverAgent is ready to accept commands', state: 'success', os: { name: 'iOS', version: '26.2' }, ios: { ip: '10.0.0.7' }, build: { version: legacy ? '4.10.0' : '9.14.1' } });
      case 'POST /session':
        sid = `S${++n}`;
        if (body.capabilities?.alwaysMatch?.bundleId) await app.launch();
        return send(res, 200, { value: { sessionId: sid, capabilities: {} }, sessionId: sid });
      case 'GET /session/:id/source':
        return ok(await source());
      case 'GET /session/:id/wda/screen':
        // after a lock the real WDA reports a status bar of 0×0
        return legacy ? unknown() : ok({ statusBarSize: state.halfLocked ? { width: 0, height: 0 } : { width: 393, height: 54 }, scale: 3 });
      case 'POST /session/:id/wda/tap':
        if (legacy || actionsOnly) return unknown();
        await app.tap(body.x, body.y);
        return ok();
      case 'POST /session/:id/wda/tap/0':
        if (actionsOnly) return unknown();
        await app.tap(body.x, body.y);
        return ok();
      case 'POST /session/:id/actions': {
        const move = body.actions?.[0]?.actions?.find((a) => a.type === 'pointerMove');
        await app.tap(move.x, move.y);
        return ok();
      }
      case 'POST /session/:id/wda/keys':
        if (!Array.isArray(body.value)) return err(res, 400, 'invalid argument', 'value must be an array');
        await app.type(body.value.join(''));
        return ok();
      case 'POST /session/:id/wda/apps/launch':
        // as a real iPhone answers for an app whose free provisioning profile expired
        if (launchDenied) return err(res, 500, 'unknown error', 'Error Domain=FBSOpenApplicationServiceErrorDomain Code=1 "The request to open "com.pulse.app" failed." UserInfo={BSErrorCodeDescription=RequestDenied, NSLocalizedFailureReason=Unable to launch com.pulse.app because it has an invalid code signature, inadequate entitlements or its profile has not been explicitly trusted by the user.}');
        await app.launch();
        return ok();
      case 'POST /session/:id/wda/apps/activate':
        if (legacy) return unknown();
        await app.activate();
        return ok();
      case 'GET /session/:id/alert/text':
        return app.alertText() ? ok(app.alertText()) : err(res, 404, 'no such alert', 'An attempt was made to operate on a modal dialog when one was not open');
      case 'GET /session/:id/wda/alert/buttons':
        return app.alertText() ? ok(['Nicht erlauben', 'Erlauben']) : err(res, 404, 'no such alert', 'no alert');
      case 'POST /session/:id/alert/accept':
      case 'POST /session/:id/alert/dismiss':
        if (!app.alertText()) return err(res, 404, 'no such alert', 'no alert');
        app.answerAlert(body.name ? (body.name === 'Erlauben' ? 'accept' : 'dismiss') : route.endsWith('accept') ? 'accept' : 'dismiss');
        return ok();
      case 'POST /session/:id/wda/apps/terminate':
        app.running = false;
        return ok(true);
      case 'POST /session/:id/wda/apps/state':
        return legacy ? unknown() : ok(!app.running ? 1 : app.front === 'app' ? 4 : 3);
      case 'GET /session/:id/wda/activeAppInfo':
        return ok(app.running && app.front === 'app' ? { bundleId: 'com.pulse.app', name: 'Pulse' } : app.running ? { bundleId: 'com.apple.mobilesafari', name: 'Safari' } : { bundleId: 'com.apple.springboard' });
      case 'GET /screenshot':
        await app.screenshot(shotFile);
        return ok(fs.readFileSync(shotFile).toString('base64'));
      default:
        return unknown();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    app,
    calls,
    dropSession: () => (sid = 'gone'),
    lock: () => (state.locked = true),
    halfLock: () => (state.halfLocked = true),
    close: () => new Promise((r) => server.close(r)),
  };
}

// devicectl --json-output fixtures (new `properties` format plus a simulator and an unplugged device).
export const DEVICECTL = {
  'list devices': {
    info: { outcome: 'success' },
    result: {
      devices: [
        { identifier: 'SIM-1', properties: { hardware: { reality: 'simulated', platform: 'iOS', udid: 'SIM-1' }, state: { name: 'iPhone 17', visibilityClass: 'simulators' }, connection: { state: 'connected', transportType: 'sameMachine' } } },
        { identifier: 'CORE-OLD', properties: { hardware: { reality: 'physical', platform: 'iOS', udid: '00008030-OLD' }, state: { name: 'Old iPhone', visibilityClass: 'default' }, connection: { pairingState: 'paired' }, software: { osVersionNumber: { stringValue: '17.5' } } } },
        { identifier: 'CORE-WIFI', properties: { hardware: { reality: 'physical', platform: 'iOS', udid: '00008110-WIFI', marketingName: 'iPhone 14' }, state: { name: 'Wifi iPhone', visibilityClass: 'default' }, connection: { pairingState: 'paired', transportType: 'localNetwork', state: 'connected' }, software: { osVersionNumber: { stringValue: '18.1' } } } },
        { identifier: 'CORE-1', hardwareProperties: { udid: '00008140-FAKE', platform: 'iOS', reality: 'physical', marketingName: 'iPhone 16 Pro' }, deviceProperties: { name: 'Lena’s iPhone', osVersionNumber: '26.2', developerModeStatus: 'enabled' }, connectionProperties: { transportType: 'wired', tunnelState: 'connected', pairingState: 'paired' } },
      ],
    },
  },
  'device info details': { result: { properties: { state: { developerModeStatus: { disabled: { mode: 0 } } } } } },
  'device info apps': {
    result: {
      apps: [
        { bundleIdentifier: 'com.pulse.app', name: 'Pulse', builtByDeveloper: true, removable: true, appClip: false, hidden: false },
        { bundleIdentifier: 'com.yahoo.finance', name: 'Finance', builtByDeveloper: false, removable: true, defaultApp: false, appClip: false, hidden: false },
        { bundleIdentifier: 'com.apple.Preferences', name: 'Settings', builtByDeveloper: false, removable: false, appClip: false, hidden: false },
        { bundleIdentifier: 'com.clip', name: 'Clip', appClip: true },
      ],
    },
  },
};
export const fakeDevicectl = async (args) => {
  const key = Object.keys(DEVICECTL).find((k) => args.join(' ').startsWith(k));
  if (!key) throw new Error(`devicectl ${args.join(' ')} → not faked`);
  return structuredClone(DEVICECTL[key]);
};
