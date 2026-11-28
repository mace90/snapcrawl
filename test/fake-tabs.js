import fs from 'node:fs';
import { renderWireframe, WIREFRAMES } from '../src/demo.js';

// A scripted app with a tab bar, a navigation bar with a menu and a search button, a plain
// button and a long feed list. Bars are containers like on a real device (or the `bar` flag
// the simulator driver sets); the tab buttons have no tab flag, so the crawler must find them
// by position.
const W = 393;
const H = 852;
const el = (type, label, x, y, w, h, extra = {}) => ({ type, label, value: '', id: '', enabled: true, x, y, w, h, ...extra });
const title = (t) => el('StaticText', t, 20, 110, 250, 30);
const back = el('Button', 'Back', 10, 55, 60, 40);
const tabBar = [el('TabBar', '', 0, 780, W, 72), el('Button', 'Start', 0, 790, 131, 50), el('Button', 'Märkte', 131, 790, 131, 50), el('Button', 'Profil', 262, 790, 131, 50)];
const navBar = (...buttons) => [el('NavigationBar', '', 0, 50, W, 50), ...buttons];
const ARTICLES = ['Börse', 'Politik', 'Sport', 'Kultur', 'Wetter', 'Reise', 'Auto', 'Technik'];
const info = el('Button', 'Info', 20, 400, 120, 44); // a tap that changes nothing

const SCREENS = {
  feed: {
    els: () => [
      ...navBar(el('Button', 'Menü', 10, 55, 50, 40), el('Button', 'Suche', 330, 55, 50, 40)),
      el('Button', 'Konto', 20, 150, 200, 40),
      el('Table', '', 0, 195, W, 560),
      ...ARTICLES.map((a, i) => el('Cell', a, 0, 200 + i * 65, W, 60)),
    ],
    taps: { Menü: 'menu', Suche: 'search', Konto: 'account', ...Object.fromEntries(ARTICLES.map((a) => [a, 'article'])) },
    title: 'Neuigkeiten',
  },
  markets: { title: 'Märkte', els: () => [el('Cell', 'DAX', 0, 200, W, 60), el('Cell', 'Dow', 0, 265, W, 60)], taps: { DAX: 'quote', Dow: 'quote' } },
  profile: { title: 'Mein Profil', els: () => [el('Button', 'Einstellungen', 20, 200, 300, 44), el('Button', 'Datenschutz', 20, 750, 300, 52)], taps: { Einstellungen: 'settings' } },
  article: { title: 'Artikel', els: () => [back, el('Button', 'Teilen', 20, 300, 120, 44)] },
  quote: { title: 'Kurs', els: () => [back, info] },
  search: { title: 'Suchen', els: () => [back, info] },
  account: { title: 'Konto', els: () => [back, info] },
  menu: { title: 'Menü', els: () => [back, info] },
  settings: { title: 'Einstellungen', els: () => [back, info] },
};
const TAB_ROOTS = { Start: 'feed', Märkte: 'markets', Profil: 'profile' };

export class TabApp {
  constructor() {
    Object.assign(this, { platform: 'fake', name: 'Fake iPhone', runtime: 'iOS 0.0', udid: 'fake', running: false, stack: [], taps: [] });
  }
  async resolve() {
    return this;
  }
  async listApps() {
    return [{ bundleId: 'com.tabs.app', name: 'Tabs' }];
  }
  async launch() {
    this.running = true;
    this.stack = ['feed'];
  }
  async activate() {}
  async isRunning() {
    return this.running;
  }
  async elements() {
    const s = SCREENS[this.stack.at(-1)];
    return [el('Application', 'Tabs', 0, 0, W, H), title(s.title), ...s.els(), ...tabBar];
  }
  async tap(x, y) {
    const hit = (await this.elements()).filter((e) => /^(Button|Cell)$/.test(e.type)).find((e) => x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h);
    if (!hit) return;
    this.taps.push(hit.label);
    if (TAB_ROOTS[hit.label]) this.stack = [TAB_ROOTS[hit.label]];
    else if (hit.label === 'Back') this.stack.length > 1 && this.stack.pop();
    else {
      const to = SCREENS[this.stack.at(-1)].taps?.[hit.label];
      if (to) this.stack.push(to);
    }
  }
  async type() {}
  async screenshot(file) {
    fs.writeFileSync(file, renderWireframe(WIREFRAMES.home('#3b6ef5')));
  }
}
