import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { aiReady } from './ai.js';
import { iphoneStatus } from './control.js';
import { DEFAULT_WDA_URL, listDevices } from './drivers/ios-device.js';
import { hasBinary, listSimulators } from './drivers/ios-sim.js';

// Everything snappcrawl needs, as one list of checks. The banner checklist, `snappcrawl setup`,
// `snappcrawl doctor` and the web UI all read it.
//
// state: ok · fail (missing, needed) · warn (needs attention) · optional (fine without)
// fix:   { cmd }            a command snappcrawl may run after asking
//        { cmd, sudo }      shown only, you run it yourself
//        { steps }          something to do on the iPhone or in Xcode
//        { action }         an internal step: boot, wda-setup, wda-start, wda-restart

const exec = promisify(execFile);
const ok = async (cmd, args, timeout = 8000) => exec(cmd, args, { timeout }).then((r) => r.stdout || true, () => false);

export const GROUPS = ['system', 'devices', 'iphone', 'optional'];

export function checks({ cfg }) {
  const wdaUrl = cfg.device?.wdaUrl || DEFAULT_WDA_URL;
  // shared lookups, started once
  const sims = listSimulators().catch(() => null);
  const phones = listDevices().catch(() => null);
  const phone = phones.then((p) => (p?.[0] ? iphoneStatus(p[0], { wdaUrl }) : null));
  const hasPhone = async () => !!(await phones)?.[0];

  return [
    {
      group: 'system', id: 'node', label: 'node',
      run: async () => {
        const major = Number(process.versions.node.split('.')[0]);
        return major >= 20 ? { state: 'ok', value: process.versions.node } : { state: 'fail', value: `${process.versions.node} · need 20 or newer`, fix: { cmd: 'brew install node', explain: 'snappcrawl needs Node.js 20 or newer.' } };
      },
    },
    {
      group: 'system', id: 'xcode', label: 'xcode',
      run: async () => {
        if (process.platform !== 'darwin') return { state: 'fail', value: `${process.platform} · needs macOS`, fix: { steps: ['The iOS Simulator and iPhone tooling only run on macOS.'] } };
        const version = await ok('xcodebuild', ['-version']);
        if (!version) return { state: 'fail', value: 'not installed', fix: { steps: ['Install Xcode from the App Store and open it once.'], explain: 'Xcode brings simctl and devicectl.' } };
        const name = String(version).split('\n')[0].trim();
        const [simctl, license] = await Promise.all([ok('xcrun', ['simctl', 'help']), ok('xcodebuild', ['-license', 'check'])]);
        if (!simctl) return { state: 'fail', value: `${name} · simctl missing`, fix: { cmd: 'sudo xcode-select -s /Applications/Xcode.app/Contents/Developer', sudo: true, explain: 'Only the command line tools are selected; select the full Xcode.' } };
        if (!license) return { state: 'fail', value: `${name} · license not accepted`, fix: { cmd: 'sudo xcodebuild -license accept', sudo: true, explain: 'Xcode tools refuse to run until the license is accepted.' } };
        return { state: 'ok', value: `${name} · simctl · license ok` };
      },
    },
    {
      group: 'system', id: 'idb', label: 'idb',
      run: async () => {
        const [idb, companion, pipx] = await Promise.all([hasBinary('idb'), hasBinary('idb_companion'), hasBinary('pipx')]);
        if (idb && companion) return { state: 'ok', value: 'idb · idb_companion' };
        const cmds = [];
        if (!companion) cmds.push('brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion');
        if (!idb) cmds.push(pipx ? 'pipx install fb-idb' : 'brew install pipx && pipx ensurepath && pipx install fb-idb');
        return { state: 'warn', value: `${[!idb && 'idb', !companion && 'idb_companion'].filter(Boolean).join(' and ')} missing · needed for simulators`, fix: { cmd: cmds.join(' && '), explain: 'idb reads the screen and taps in the iOS Simulator. Not needed for iPhones.' } };
      },
    },
    {
      group: 'devices', id: 'simulator', label: 'simulator',
      run: async () => {
        const list = await sims;
        if (!list) return { state: 'optional', value: 'not available' };
        const booted = list.find((s) => s.state === 'Booted');
        if (booted) return { state: 'ok', value: `${booted.name} · ${booted.runtime} · booted` };
        const first = list.find((s) => /iphone/i.test(s.name)) || list[0];
        return first ? { state: 'optional', value: 'none booted', fix: { action: 'boot', target: first.name, cmd: `snappcrawl boot "${first.name}"`, explain: 'A booted simulator to crawl apps without an iPhone.' } } : { state: 'optional', value: 'no simulator runtime · Xcode → Settings → Components' };
      },
    },
    {
      group: 'devices', id: 'iphone', label: 'iphone',
      run: async () => {
        const p = await phone;
        if (!p) return { state: 'optional', value: 'none connected', fix: { steps: ['Connect the iPhone by USB, unlock it and tap Trust.'], explain: 'Only needed to crawl on a real iPhone.' } };
        return { state: 'ok', value: `${p.name} · ${p.transport === 'wired' ? 'usb' : 'wi-fi'} · ${p.lock}` };
      },
    },
    {
      group: 'iphone', id: 'trust', label: 'trust', when: hasPhone,
      run: async () => {
        const p = await phone;
        return p.paired ? { state: 'ok', value: 'paired with this Mac' } : { state: 'fail', value: 'does not trust this Mac', fix: { steps: ['Unlock the iPhone and tap Trust on "Trust This Computer?".'] } };
      },
    },
    {
      group: 'iphone', id: 'developer-mode', label: 'developer mode', when: hasPhone,
      run: async () => {
        const p = await phone;
        if (p.developerMode === 'enabled') return { state: 'ok', value: 'on' };
        return { state: 'fail', value: p.developerMode === 'unknown' ? 'unknown' : 'off', fix: { steps: ['iPhone: Settings → Privacy & Security → Developer Mode → on.', 'Restart the iPhone and confirm "Turn On" after the restart.', 'Missing switch: open Xcode → Window → Devices and Simulators once with the iPhone connected.'] } };
      },
    },
    {
      group: 'iphone', id: 'unlocked', label: 'unlocked', when: hasPhone,
      run: async () => {
        const p = await phone;
        if (p.lock === 'locked') return { state: 'warn', value: 'locked', fix: { steps: ['Unlock the iPhone and keep it unlocked while crawling.', 'Settings → Display & Brightness → Auto-Lock → Never helps during a crawl.'] } };
        return { state: 'ok', value: p.lock };
      },
    },
    {
      group: 'iphone', id: 'wda', label: 'webdriveragent', when: hasPhone,
      run: async () => {
        const { wda } = await phone;
        if (!wda.built) return { state: 'fail', value: 'not set up', fix: { action: 'wda-setup', cmd: 'snappcrawl wda setup', explain: 'WebDriverAgent is a small test runner that lets snappcrawl read the screen and tap on the iPhone. It is built once with your Apple ID (1–3 minutes).' } };
        if (wda.notAuthorized) return { state: 'fail', value: 'running · no ui control (the iPhone was locked)', fix: { action: 'wda-restart', cmd: 'snappcrawl wda stop && snappcrawl wda start', explain: 'After a lock WebDriverAgent keeps answering but may no longer tap. A restart fixes it.' } };
        if (wda.reachable && wda.control) return { state: 'ok', value: `running · ui control ok${wda.version ? ' · ' + wda.version : ''}` };
        return { state: 'optional', value: `set up (${wda.setup.tag}) · starts with the first crawl`, fix: { action: 'wda-start', cmd: 'snappcrawl wda start', explain: 'Start it now, or let the first crawl on the iPhone start it.' } };
      },
    },
    {
      group: 'optional', id: 'ai', label: 'ai notes',
      run: async () => (aiReady(cfg.ai) ? { state: 'ok', value: `${cfg.ai.provider} · ${cfg.ai.model}` } : { state: 'optional', value: 'off', fix: { cmd: 'snappcrawl config set ai.provider anthropic', explain: 'Optional one-line notes per change from your own model (UI: Settings).' } }),
    },
    {
      group: 'optional', id: 'config', label: 'config',
      run: async () => (cfg._file ? { state: 'ok', value: cfg._file.split('/').pop() } : { state: 'optional', value: 'defaults · snappcrawl init writes a config file' }),
    },
  ];
}

// Run all checks in parallel: `onStart(rows)` once it is known which apply, then
// `onResult(row, result)` as each one finishes.
export async function runChecks({ cfg, onStart = () => {}, onResult = () => {} }) {
  const list = checks({ cfg });
  const shown = await Promise.all(list.map(async (c) => (c.when ? c.when() : true)));
  const active = list.filter((_, i) => shown[i]);
  onStart(active);
  await Promise.all(active.map(async (c) => {
    try {
      c.result = await c.run();
    } catch (e) {
      c.result = { state: 'fail', value: e.message.split('\n')[0] };
    }
    onResult(c, c.result);
  }));
  return active.map(({ group, id, label, result }) => ({ group, id, label, ...result }));
}

export const needsAttention = (results) => results.filter((r) => r.state === 'fail' || r.state === 'warn');
