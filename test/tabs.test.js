import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IosSimulator } from '../src/drivers/ios-sim.js';

// iOS 26, SwiftUI TabView: the normal read lists the tab bar as one empty group; the automation
// tree (client type XCTest) has radio buttons named like the tabs, or only buttons named after
// their symbols while the bar animates.
const f = (x, y, w, h) => ({ x, y, width: w, height: h });
const PLAIN = [
  { type: 'Application', AXLabel: 'Demo', frame: f(0, 0, 402, 874) },
  { type: 'Heading', AXLabel: 'Hallo, Lena', frame: f(16, 120, 200, 40) },
  { type: 'Group', AXLabel: 'Tab-Leiste', role_description: 'group', frame: f(0, 791, 402, 83) },
];
const radio = (label, x, value) => ({ type: 'RadioButton', AXLabel: label, AXValue: value, frame: f(x, 795, 107, 54) });
const symbol = (label, x) => ({ type: 'Button', AXLabel: label, frame: f(x + 37, 801, 33, 28) });
const FULL = [...PLAIN, radio('Start', 49, '1'), symbol('house', 49), radio('Workouts', 148, '0'), symbol('figure.run', 148), radio('Einstellungen', 246, '0'), symbol('gear', 246)];
const SYMBOLS = [...PLAIN, symbol('house', 49), symbol('figure.run', 148), symbol('gear', 246)];

function sim(trees, points = {}) {
  const d = new IosSimulator({ udid: 'X', bundleId: 'b' });
  const calls = [];
  d.companion = {
    describeAll: async ({ clientType = 0 } = {}) => (calls.push(clientType ? 'xctest' : 'plain'), clientType ? trees.shift() : PLAIN),
    describePoint: async (x, y) => (calls.push(`point ${x},${y}`), points[x] || null),
  };
  return { d, calls };
}
const tabs = (els) => els.filter((e) => e.tab).map((e) => `${e.label}${e.selected ? '*' : ''}`).join(' ');

test('tabs: read from the automation tree when the bar is empty, the selected one marked', async () => {
  const { d } = sim([FULL]);
  assert.equal(tabs(await d.elements()), 'Start* Workouts Einstellungen');
});

test('tabs: symbol names are learned once and replaced; unknown ones asked at their place', async () => {
  const { d, calls } = sim([FULL, SYMBOLS]);
  await d.elements();
  assert.equal(tabs(await d.elements()), 'Start Workouts Einstellungen', 'house → Start, learned from the first read');
  assert.ok(!calls.some((c) => c.startsWith('point')));
  // only radio buttons seen before (no symbols in that read): the place gives the name
  const radiosOnly = [...PLAIN, radio('Start', 49, '1'), radio('Workouts', 148, '0'), radio('Einstellungen', 246, '0')];
  const byPlace = sim([radiosOnly, SYMBOLS]);
  await byPlace.d.elements();
  assert.equal(tabs(await byPlace.d.elements()), 'Start Workouts Einstellungen');
  assert.ok(!byPlace.calls.some((c) => c.startsWith('point')));

  const fresh = sim([SYMBOLS], { 103: { type: 'RadioButton', AXLabel: 'Start', AXValue: '1', frame: f(49, 795, 107, 54) }, 202: { type: 'RadioButton', AXLabel: 'Workouts', AXValue: '0', frame: f(148, 795, 107, 54) }, 300: { type: 'RadioButton', AXLabel: 'Einstellungen', AXValue: '0', frame: f(246, 795, 107, 54) } });
  assert.equal(tabs(await fresh.d.elements()), 'Start* Workouts Einstellungen');
  assert.ok(fresh.calls.includes('point 103,833'), fresh.calls.join());
});

test('tabs: a bar that has its tabs in the normal read is left alone', async () => {
  const { d, calls } = sim([]);
  d.companion.describeAll = async () => (calls.push('plain'), [...PLAIN, { type: 'Button', AXLabel: 'Start', frame: f(49, 795, 107, 54) }]);
  await d.elements();
  assert.deepEqual(calls, ['plain']);
});

test('tabs: symbol-named tabs in the normal read get their learned names, without another read', async () => {
  const { d, calls } = sim([FULL]);
  await d.elements(); // learns house → Start …
  d.companion.describeAll = async () => (calls.push('plain2'), [...PLAIN, symbol('house', 49), symbol('figure.run', 148), symbol('gear', 246)]);
  assert.equal(tabs(await d.elements()), 'Start Workouts Einstellungen');
  assert.deepEqual(calls, ['plain', 'xctest', 'plain2']);
});
