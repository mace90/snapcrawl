import fs from 'node:fs';
import { renderWireframe, WIREFRAMES } from '../src/demo.js';
import { totp } from '../src/totp.js';

// A scripted in-memory "app" that speaks the driver interface, so the crawler can be
// tested without Xcode. It has a login with TOTP, a crash, a blocklisted logout and back navigation.
const W = 393;
const H = 852;
const btn = (label, y, type = 'Button') => ({ type, label, value: '', id: '', enabled: true, x: 20, y, w: W - 40, h: 50 });
const text = (label, y = 70) => ({ type: 'StaticText', label, value: '', id: '', enabled: true, x: 20, y, w: 200, h: 30 });
const back = btn('Back', 50);

const SCREENS = {
  splash: { title: 'Pulse', els: [btn('Los geht’s', 700)], taps: { 'Los geht’s': (app) => (app.loggedIn ? 'home' : 'login') } },
  login: { title: 'Anmelden', login: true },
  otp: { title: 'Bestätigung', otp: true },
  home: { title: 'Hallo, Lena', els: [btn('Workouts', 300), btn('Profil', 360), btn('Pro', 420)], taps: { Workouts: 'workouts', Profil: 'profile', Pro: 'CRASH' } },
  workouts: { title: 'Workouts', els: [back, btn('Ganzkörper', 200, 'Cell'), btn('Rücken', 260, 'Cell')], taps: { Ganzkörper: 'detail', Rücken: 'detail' } },
  detail: { title: 'Workout', els: [back, btn('Starten', 700)], taps: { Starten: 'player' } },
  player: { title: 'Player', els: [back] },
  profile: { title: 'Profil', els: [back, btn('Bearbeiten', 300), btn('Einstellungen', 360)], taps: { Bearbeiten: 'edit', Einstellungen: 'settings' } },
  edit: { title: 'Profil bearbeiten', els: [back] },
  settings: { title: 'Einstellungen', els: [back, btn('Mitteilungen', 300), btn('Abmelden', 600)], taps: { Mitteilungen: 'notif', Abmelden: 'LOGOUT' } },
  notif: { title: 'Mitteilungen', els: [back] },
};

const WIRE = { splash: 'splash', login: 'login', home: 'home', workouts: 'workouts', detail: 'detail', player: 'player', profile: 'profile', edit: 'edit', settings: 'settings', notif: 'notif', otp: 'login' };

// Optional real-world noise (all off by default):
//   sheet: 'first' | 'always'  an onboarding sheet ("Alles klar") over the start screen
//   consent: true              a cookie banner until someone decides
//   alert: true                a notification permission prompt when home appears
//   external: true             home has "Website" (opens Safari), profile a web link "Impressum"
//   ad: true                   a web ad banner on every screen whose text changes on every read
//   onboarding: true           a welcome screen on the very first launch only ("Loslegen")
//   feed: true                 home has a news cell and an ad cell whose texts change on every read
const HEADLINES = ['Dow erases losses to end positive', 'DAX klettert auf Rekordhoch', 'Ölpreis fällt den dritten Tag'];
const SPONSORS = ['Fisher Investments', 'günstig-heizen.de', 'Depot24'];
const ADS = ['Jetzt Depot eröffnen', 'Nur heute: 0 € Ordergebühr', 'Krypto ab 1 €'];
const sheetEls = () => [text('Neu: Watchlists', 300), text('Behalte deine Kurse im Blick', 340), btn('Alles klar', 700)];
const consentEls = () => [text('Ihre Privatsphäre ist uns wichtig', 200), text('Wir verwenden Cookies, wenn Sie auf Alle akzeptieren tippen.', 260), btn('Alle akzeptieren', 600), btn('Alle ablehnen', 660), { ...btn('Datenschutzerklärung', 720, 'Link'), web: true }];

export class FakeApp {
  constructor({ user = 'lena@pulse.app', pass = 'secret', secret = 'JBSWY3DPEHPK3PXP', sheet = false, consent = false, alert = false, external = false, ad = false, onboarding = false, feed = false } = {}) {
    Object.assign(this, { user, pass, secret, sheet, consent, alertOn: alert, external, ad, onboarding, feed });
    this.feedReads = 0;
    this.onboarded = false;
    this.adReads = 0;
    this.overlay = null;
    this.consentDecision = null;
    this.alertAnswer = null;
    this.sheetsShown = 0;
    this.front = 'app';
    this.platform = 'fake';
    this.name = 'Fake iPhone';
    this.runtime = 'iOS 0.0';
    this.udid = 'fake';
    this.loggedIn = false;
    this.running = false;
    this.stack = [];
    this.taps = [];
    this.fields = {};
    this.focus = null;
  }
  get screen() {
    return this.stack.at(-1);
  }
  async resolve() {
    return this;
  }
  async listApps() {
    return [{ bundleId: 'com.pulse.app', name: 'Pulse' }];
  }
  async launch() {
    this.running = true;
    this.front = 'app';
    this.stack = ['splash'];
    this.fields = {};
    this.overlay = this.onboarding && !this.onboarded ? 'welcome' : this.consent && !this.consentDecision ? 'consent' : this.sheet === 'always' || (this.sheet && !this.sheetsShown) ? 'sheet' : null;
    if (this.overlay === 'sheet') this.sheetsShown++;
  }
  async activate() {
    this.front = 'app';
  }
  // permission prompt, as WDA's alert endpoints see it
  get alertVisible() {
    return this.alertOn && !this.alertAnswer && this.front === 'app' && this.screen === 'home';
  }
  alertText() {
    return this.alertVisible ? '„Pulse“ möchte dir Mitteilungen senden' : null;
  }
  answerAlert(button) {
    this.alertAnswer = button;
  }
  async isRunning() {
    return this.running;
  }
  async elements() {
    if (!this.running) return [{ type: 'Application', label: 'SpringBoard', x: 0, y: 0, w: W, h: H, enabled: true, value: '', id: '' }];
    if (this.front === 'safari') return [{ type: 'Application', label: 'Safari', x: 0, y: 0, w: W, h: H, enabled: true, value: '', id: '' }, text('pulse.app'), { ...btn('pulse.app/help', 200, 'Link'), web: true }];
    const appEl = { type: 'Application', label: 'Pulse', x: 0, y: 0, w: W, h: H, enabled: true, value: '', id: '' };
    if (this.overlay === 'sheet') return [appEl, ...sheetEls()];
    if (this.overlay === 'welcome') return [appEl, text('Willkommen bei Pulse', 200), btn('Loslegen', 700)];
    if (this.overlay === 'consent') return [appEl, ...consentEls()];
    const s = SCREENS[this.screen];
    const els = [appEl, text(s.title)];
    if (s.login) els.push({ ...btn('E-Mail', 200, 'TextField'), value: this.fields.user || '' }, { ...btn('Passwort', 280, 'SecureTextField') }, btn('Anmelden', 400));
    else if (s.otp) els.push({ ...btn('Code', 200, 'TextField'), value: this.fields.code || '' }, btn('Bestätigen', 300));
    else els.push(...s.els);
    if (this.external && this.screen === 'home') els.push(btn('Website', 480));
    if (this.feed && this.screen === 'home') {
      const n = this.feedReads++;
      els.push({ ...btn('', 540, 'Cell'), h: 60 }, text(HEADLINES[n % 3], 555), text(`vor ${n % 50 + 1} Std.`, 575));
      els.push({ ...btn('', 610, 'Cell'), h: 60 }, text(`Ad by ${SPONSORS[n % 3]}`, 625), { ...btn('ANZEIGE', 625), x: 300, w: 60, h: 30 });
    }
    if (this.external && this.screen === 'profile') els.push({ ...btn('Impressum', 480, 'Link'), web: true });
    if (this.ad) {
      // above the title, so a name taken from the top would pick it up
      const n = this.adReads++;
      els.push({ ...text(`Anzeige · ${ADS[n % ADS.length]}`, 20), h: 34, web: true }, { ...btn('Weitere Informationen', 20, 'Link'), x: 300, w: 80, h: 30, web: true }, { ...btn(`Ad ${n % 7}`, 20), x: 250, w: 40, h: 30, web: true });
    }
    if (this.alertVisible) els.push({ type: 'Alert', label: this.alertText(), value: '', id: '', enabled: true, x: 40, y: 340, w: W - 80, h: 180, alert: true }, { ...btn('Nicht erlauben', 470), x: 40, w: 150, alert: true }, { ...btn('Erlauben', 470), x: 200, w: 150, alert: true });
    return els;
  }
  async tap(x, y) {
    const el = (await this.elements()).filter((e) => e.type !== 'Application' && e.type !== 'Alert').find((e) => x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h);
    if (!el) return;
    if (this.alertVisible && !el.alert) return; // the prompt blocks the app
    this.taps.push(el.label);
    if (el.alert) return this.answerAlert(el.label === 'Erlauben' ? 'accept' : 'dismiss');
    if (this.overlay === 'sheet') {
      if (el.label === 'Alles klar') this.overlay = null;
      return;
    }
    if (this.overlay === 'welcome') {
      if (el.label === 'Loslegen') {
        this.onboarded = true;
        this.overlay = null;
      }
      return;
    }
    if (this.overlay === 'consent') {
      if (/akzeptieren|ablehnen/.test(el.label)) {
        this.consentDecision = el.label;
        this.overlay = null;
      }
      if (el.type === 'Link') this.front = 'safari';
      return;
    }
    if (el.type === 'Link' || el.label === 'Website') {
      this.front = 'safari';
      return;
    }
    const s = SCREENS[this.screen];
    if (/TextField/.test(el.type)) {
      this.focus = el.type === 'SecureTextField' ? 'pass' : s.otp ? 'code' : 'user';
      return;
    }
    if (el.label === 'Back') {
      if (this.stack.length > 1) this.stack.pop();
      return;
    }
    if (s.login && el.label === 'Anmelden') {
      if (this.fields.user === this.user && this.fields.pass === this.pass) this.stack.push('otp');
      this.fields = {};
      return;
    }
    if (s.otp && el.label === 'Bestätigen') {
      if (this.fields.code === totp(this.secret)) {
        this.loggedIn = true;
        this.stack = ['splash', 'home'];
      }
      return;
    }
    let target = s.taps?.[el.label];
    if (typeof target === 'function') target = target(this);
    if (target === 'CRASH') this.running = false;
    else if (target === 'LOGOUT') {
      this.loggedIn = false;
      this.stack = ['splash'];
    } else if (target) this.stack.push(target);
  }
  async type(t) {
    if (this.focus) this.fields[this.focus] = (this.fields[this.focus] || '') + t;
  }
  async screenshot(file) {
    const key = WIRE[this.screen] || 'splash';
    const spec = WIREFRAMES[key];
    fs.writeFileSync(file, renderWireframe(spec('#3b6ef5')));
  }
}
