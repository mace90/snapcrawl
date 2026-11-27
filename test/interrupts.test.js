import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { crawl, fingerprint, nameOf, uniqueName } from '../src/crawler.js';
import { buildReport } from '../src/diff.js';
import { signature, similarity } from '../src/signature.js';
import { IosDevice } from '../src/drivers/ios-device.js';
import { alertFromElements, dismissButton, isConsent, pickButton } from '../src/interrupts.js';
import { Store } from '../src/store.js';
import { FakeApp } from './fake-app.js';
import { fakeDevicectl, startFakeWda } from './fake-wda.js';

const NAMES = ['Einstellungen', 'Hallo, Lena', 'Mitteilungen', 'Player', 'Profil', 'Profil bearbeiten', 'Pulse', 'Workout', 'Workouts'].sort();

// Crawl the fake app directly (simulator-like driver) or through the fake WebDriverAgent.
async function run(via, appOpts = {}, crawlOpts = {}, ask = async () => '') {
  const app = new FakeApp(appOpts);
  const cfg = structuredClone(DEFAULTS);
  cfg.app.bundleId = 'com.pulse.app';
  Object.assign(cfg.crawl, { settleMs: 0, launchMs: 0 }, crawlOpts);
  Object.assign(cfg.auth, { username: app.user, password: app.pass, mfa: 'totp', totpSecret: app.secret });
  const logs = [];
  const asked = [];
  const wda = via === 'wda' ? await startFakeWda({ app }) : null;
  const driver = wda ? new IosDevice({ bundleId: 'com.pulse.app', wdaUrl: wda.url, run: fakeDevicectl }) : app;
  try {
    const atlas = await crawl({ driver, cfg, store: new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-'))).ensure(), io: { log: (l, m) => logs.push(`${l} ${m}`), ask: async (kind, prompt) => (asked.push(kind), ask(kind, prompt, app)) } });
    assert.equal(atlas.meta.status, 'done', atlas.meta.error);
    return { atlas, app, logs, asked, calls: wda?.calls || [], names: atlas.screens.filter((s) => !s.crash).map((s) => s.name).sort() };
  } finally {
    await wda?.close();
  }
}

for (const via of ['sim', 'wda']) {
  test(`${via}: an onboarding sheet on every launch is dismissed, start and replays still work`, async () => {
    const r = await run(via, { sheet: 'always' });
    assert.deepEqual(r.names, NAMES);
    assert.ok(r.app.sheetsShown > 3, 'the sheet came back on every relaunch');
    assert.ok(r.logs.some((l) => l === 'INFO dismiss "Alles klar" (start)'));
    assert.ok(r.logs.some((l) => l === 'INFO dismiss "Alles klar" (after launch)'));
    assert.deepEqual(r.atlas.meta.warnings, []);
  });

  test(`${via}: links are skipped, a tap that opens Safari is noted and the crawl goes on`, async () => {
    const r = await run(via, { external: true });
    assert.deepEqual(r.names, NAMES, 'no Safari screen registered');
    assert.equal(r.atlas.screens.filter((s) => s.crash).length, 1, 'only the real crash, no crash node for Safari');
    assert.ok(!r.app.taps.includes('Impressum'));
    assert.ok(r.logs.includes('STEP action.skip "Impressum" (web link)'));
    assert.ok(r.app.taps.includes('Website'));
    assert.ok(r.atlas.meta.warnings.some((w) => /^left app after tap "Website" on s\d+/.test(w)), r.atlas.meta.warnings.join('\n'));
    assert.equal(r.app.front, 'app');
  });

  test(`${via}: permission prompts are denied by default, accepted or left to the user if configured`, async () => {
    const deny = await run(via, { alert: true });
    assert.equal(deny.app.alertAnswer, 'dismiss');
    assert.deepEqual(deny.names, NAMES);
    assert.ok(deny.logs.some((l) => /^INFO alert "„Pulse“ möchte dir Mitteilungen senden" → dismiss "Nicht erlauben"$/.test(l)), deny.logs.filter((l) => l.includes('alert')).join('\n'));
    if (via === 'wda') assert.ok(deny.calls.includes('POST /session/:id/alert/dismiss'));
    else assert.ok(deny.app.taps.includes('Nicht erlauben'));
    assert.equal((await run(via, { alert: true }, { systemAlerts: 'accept' })).app.alertAnswer, 'accept');
    const pause = await run(via, { alert: true }, { systemAlerts: 'pause' }, async (kind, prompt, app) => kind === 'alert' && app.answerAlert('dismiss'));
    assert.deepEqual(pause.asked, ['alert']);
    assert.equal(pause.app.alertAnswer, 'dismiss');
  });

  test(`${via}: cookie banners are never decided by the crawler`, async () => {
    const r = await run(via, { consent: true });
    assert.equal(r.app.consentDecision, null);
    assert.equal(r.atlas.screens.length, 1);
    assert.equal(r.atlas.screens[0].consent, true);
    assert.ok(r.atlas.meta.warnings.some((w) => w.includes('cookie or privacy decision')));
    assert.ok(!r.app.taps.length, 'nothing on the banner was tapped');
  });

  test(`${via}: --prepare pauses after launch; the screen after continuing is the root`, async () => {
    // the user rejects the cookies and stays on the start screen
    const r = await run(via, { consent: true, sheet: 'first' }, { prepare: true }, async (kind, prompt, app) => {
      if (kind === 'prepare') {
        app.consentDecision = 'Alle ablehnen';
        app.overlay = null;
      }
    });
    assert.deepEqual(r.asked, ['prepare']);
    assert.equal(r.app.consentDecision, 'Alle ablehnen');
    assert.deepEqual(r.names, NAMES);
    assert.equal(r.atlas.screens[0].name, 'Pulse');
    assert.ok(!r.logs.some((l) => l.includes('(start)')), 'nothing dismissed automatically before the user is done');

    // the user goes deeper: that screen becomes the root
    const deep = await run(via, {}, { prepare: true, maxScreens: 3 }, async (kind, prompt, app) => {
      app.loggedIn = true;
      app.stack = ['splash', 'home', 'workouts'];
    });
    assert.equal(deep.atlas.screens[0].name, 'Workouts');
    assert.equal(deep.atlas.screens[0].depth, 0);
  });
}

for (const via of ['sim', 'wda']) {
  test(`${via}: a rotating web ad banner creates no new screens and never names one`, async () => {
    const plain = await run(via);
    const r = await run(via, { ad: true });
    assert.ok(r.app.adReads > 20, 'the banner changed on every read');
    assert.deepEqual(r.names, NAMES);
    assert.deepEqual(r.atlas.screens.map((s) => s.fp), plain.atlas.screens.map((s) => s.fp), 'same fingerprints as without the banner');
    assert.equal(r.atlas.edges.length, plain.atlas.edges.length);
    assert.ok(r.logs.some((l) => l === 'STEP action.skip "Weitere Informationen" (web link)'));
    assert.deepEqual(r.atlas.meta.warnings, []);
  });
}

for (const via of ['sim', 'wda']) {
  test(`${via}: onboarding shown once becomes one-time; the next screen is the launch screen`, async () => {
    const r = await run(via, { onboarding: true, sheet: 'always', ad: true });
    const [welcome, splash] = r.atlas.screens;
    assert.equal(welcome.name, 'Willkommen bei Pulse');
    assert.equal(welcome.oneTime, true);
    assert.equal(splash.name, 'Pulse');
    assert.equal(splash.launch, true);
    assert.deepEqual(splash.path, [], 'paths are relative to the launch screen');
    assert.deepEqual(r.atlas.screens.find((s) => s.name === 'Workouts').path.map((p) => p.label), ['Los geht’s', 'Workouts']);
    assert.deepEqual(r.names, [...NAMES, 'Willkommen bei Pulse'].sort(), 'everything after the onboarding is explored');
    assert.deepEqual(r.atlas.meta.warnings, [], 'one-time screens are not a warning');
    assert.ok(r.logs.some((l) => /^INFO launch screen is now s001 "Pulse" · 1 one-time screen before it$/.test(l)), r.logs.filter((l) => l.includes('launch')).join('\n'));
    assert.ok(r.logs.some((l) => l === 'INFO dismiss "Alles klar" (after launch)'));
  });

  test(`${via}: rotating headlines and ad cells create no new screen and break no replay`, async () => {
    const r = await run(via, { feed: true });
    assert.ok(r.app.feedReads > 10);
    assert.deepEqual(r.names, NAMES);
    assert.equal(r.atlas.screens.filter((s) => s.name === 'Hallo, Lena').length, 1);
    assert.deepEqual(r.atlas.meta.warnings, []);
    const ok = r.logs.filter((l) => /^STEP replay s\d+ ok · match \d\.\d\d$/.test(l));
    assert.ok(ok.length > 3, 'replays are logged with their match');
    assert.ok(r.atlas.screens.every((s) => s.crash || Object.keys(s.sig.parts).length), 'signatures are stored in atlas.json');
  });
}

test('signature: same layout, different navigation bar title → different screens; feed content does not count', () => {
  const el = (type, label, extra = {}) => ({ type, label, value: '', id: '', enabled: true, x: 0, y: 100, w: 200, h: 30, ...extra });
  const detail = (title, headline, price) => [
    el('NavigationBar', '', { id: title, y: 50 }), el('Button', 'Zurück', { y: 50 }), el('Button', 'Zur Watchlist', { y: 120 }),
    el('StaticText', `${price} €`, { y: 160 }), el('StaticText', 'Kursverlauf', { y: 200 }), el('Button', '1 T', { y: 240 }), el('Button', '1 M', { y: 240 }),
    el('Cell', '', { y: 400, h: 80 }), el('StaticText', headline, { y: 410 }), el('Image', '', { id: '2AD6232E-B42E-4B20-9638-AD4C1C04F2CB', y: 20 }),
  ];
  const dax = signature(detail('DAX', 'DAX klettert', '25.261,99'));
  assert.equal(similarity(dax, signature(detail('Gold', 'DAX klettert', '25.261,99'))), 0, 'other title, other screen');
  const later = signature(detail('DAX', 'Anleger nehmen Gewinne mit', '25.198,10'));
  assert.equal(similarity(dax, later), 1, 'new headline in a cell and a new price: same screen');
  assert.ok(!Object.keys(dax.parts).some((k) => k.includes('2ad')), 'generated uuids do not count');
  const other = signature([el('NavigationBar', '', { id: 'DAX', y: 50 }), el('Button', 'Kaufen', { y: 300 }), el('Button', 'Verkaufen', { y: 360 })]);
  assert.ok(similarity(dax, other) < 0.8, 'same title, different content: below the threshold');
});

test('diff: one-time screens are compared only when both runs have them', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-')));
  store.ensure();
  const cfg = structuredClone(DEFAULTS);
  cfg.app.bundleId = 'com.pulse.app';
  Object.assign(cfg.crawl, { settleMs: 0, launchMs: 0 });
  const go = async (opts, label) => {
    const app = new FakeApp(opts);
    Object.assign(cfg.auth, { username: app.user, password: app.pass, mfa: 'totp', totpSecret: app.secret });
    return crawl({ driver: app, cfg, store, io: { log: () => {}, ask: async () => '' }, label });
  };
  const first = await go({ onboarding: true, feed: true }, 'v1');
  const second = await go({ feed: true }, 'v2'); // onboarding already done
  for (const [b, h] of [[first, second], [second, first]]) {
    const r = buildReport({ store, baseId: b.meta.id, headId: h.meta.id, cfg });
    const welcome = r.screens.find((s) => s.name === 'Willkommen bei Pulse');
    assert.deepEqual([welcome.status, welcome.reason, welcome.oneTime], ['skipped', 'one-time (skipped)', true]);
    assert.equal(r.summary.skipped, 1);
    assert.equal(r.summary.new, 0, 'everything else is matched despite relative paths and rotating feed');
    assert.equal(r.summary.bad, 1, 'only the real crash');
  }
});

test('screen names: navigation bar → selected tab → large text → action; web content ignored; duplicates numbered', () => {
  const size = { w: 393, h: 852 };
  const el = (type, label, extra = {}) => ({ type, label, value: '', id: '', enabled: true, x: 0, y: 100, w: 200, h: 30, ...extra });
  const ad = el('StaticText', 'Anzeige · Jetzt Depot eröffnen', { y: 10, h: 40, web: true });
  const title = el('StaticText', 'Kurse', { y: 150, h: 34 });
  const small = el('StaticText', 'zuletzt aktualisiert', { y: 120, h: 14 });
  const tab = el('Button', 'Märkte', { y: 800, tab: true, selected: true });
  const otherTab = el('Button', 'Nachrichten', { y: 800, tab: true });
  const nav = el('NavigationBar', '', { id: 'Watchlist', y: 60, h: 44 }); // WDA: title in the identifier

  assert.equal(nameOf([ad, small, title, otherTab, tab, nav], size, 'tap X'), 'Watchlist');
  assert.equal(nameOf([ad, small, title, otherTab, tab], size, 'tap X'), 'Märkte');
  assert.equal(nameOf([ad, small, title, otherTab], size, 'tap X'), 'Kurse', 'large text, not the small one above it');
  assert.equal(nameOf([ad, small], size, 'DAX'), 'DAX', 'web text never names a screen; small text loses to the action');
  assert.equal(nameOf([ad], size, null), 'Start');
  assert.equal(nameOf([el('StaticText', 'Profil', { header: true, y: 200, h: 16 }), title], size, null), 'Profil', 'a header trait wins over size');

  const seen = new Map();
  assert.deepEqual(['Profil', 'Kurse', 'Profil', 'Profil'].map((n) => uniqueName(seen, n)), ['Profil', 'Kurse', 'Profil (2)', 'Profil (3)']);

  assert.equal(fingerprint([title, ad]), fingerprint([title, { ...ad, label: 'Krypto ab 1 €' }]), 'web content does not change the fingerprint');
  assert.notEqual(fingerprint([ad]), fingerprint([{ ...ad, label: 'Krypto ab 1 €' }]), 'a page that is only web content is told apart by it');
});

test('interrupt rules: dismiss words match exactly and never a privacy decision', () => {
  const b = (label) => ({ type: 'Button', label, value: '', id: '', enabled: true, x: 0, y: 0, w: 10, h: 10 });
  assert.equal(dismissButton([b('OK, kaufen'), b('Später')]).label, 'Später');
  assert.equal(dismissButton([b('Alle akzeptieren'), b('Accept')], ['accept', 'alle akzeptieren']), null);
  assert.equal(isConsent([b('Alle akzeptieren'), { ...b('Wir verwenden Cookies'), type: 'StaticText' }]), true);
  assert.equal(isConsent([b('Akzeptieren'), b('Weiter')]), false, 'accept alone is not a privacy screen');
  assert.equal(pickButton(['Allow Once', 'Allow While Using App', 'Don’t Allow'], 'dismiss'), 'Don’t Allow');
  assert.equal(pickButton(['Ask App Not to Track', 'Allow'], 'accept'), 'Allow');
  assert.equal(alertFromElements([b('Abbrechen'), b('OK')]), null, 'an ordinary app alert is not a permission prompt');
  assert.deepEqual(alertFromElements([b('App bitten, nicht zu tracken'), b('Erlauben')]).buttons, ['App bitten, nicht zu tracken', 'Erlauben']);
});
