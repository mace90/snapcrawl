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

export class FakeApp {
  constructor({ user = 'lena@pulse.app', pass = 'secret', secret = 'JBSWY3DPEHPK3PXP' } = {}) {
    Object.assign(this, { user, pass, secret });
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
    this.stack = ['splash'];
    this.fields = {};
  }
  async isRunning() {
    return this.running;
  }
  async elements() {
    if (!this.running) return [{ type: 'Application', label: 'SpringBoard', x: 0, y: 0, w: W, h: H, enabled: true, value: '', id: '' }];
    const s = SCREENS[this.screen];
    const els = [{ type: 'Application', label: 'Pulse', x: 0, y: 0, w: W, h: H, enabled: true, value: '', id: '' }, text(s.title)];
    if (s.login) els.push({ ...btn('E-Mail', 200, 'TextField'), value: this.fields.user || '' }, { ...btn('Passwort', 280, 'SecureTextField') }, btn('Anmelden', 400));
    else if (s.otp) els.push({ ...btn('Code', 200, 'TextField'), value: this.fields.code || '' }, btn('Bestätigen', 300));
    else els.push(...s.els);
    return els;
  }
  async tap(x, y) {
    const el = (await this.elements()).filter((e) => e.type !== 'Application').find((e) => x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h);
    if (!el) return;
    this.taps.push(el.label);
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
