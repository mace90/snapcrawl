import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function sh(cmd, args, { timeout = 60_000 } = {}) {
  try {
    const { stdout } = await exec(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout });
    return stdout;
  } catch (e) {
    const detail = String(e.stderr || e.message || '').trim().split('\n').pop();
    const err = new Error(`${cmd} ${args.join(' ')} → ${detail}`);
    err.code = e.code;
    throw err;
  }
}

export async function hasBinary(bin) {
  try {
    await exec('which', [bin]);
    return true;
  } catch {
    return false;
  }
}

// Every simulator known to Xcode, newest runtime first.
export async function listSimulators() {
  const json = JSON.parse(await sh('xcrun', ['simctl', 'list', 'devices', 'available', '-j']));
  const out = [];
  for (const [runtime, devices] of Object.entries(json.devices || {})) {
    const rt = runtime.split('.').pop().replace(/^(\w+)-(\d+)-(\d+)$/, '$1 $2.$3').replace(/-/g, ' ');
    for (const d of devices) out.push({ udid: d.udid, name: d.name, state: d.state, runtime: rt });
  }
  return out.sort((a, b) => (a.state === 'Booted' ? -1 : 0) - (b.state === 'Booted' ? -1 : 0) || b.runtime.localeCompare(a.runtime));
}

// idb prints elements either as one JSON array or as one JSON object per line.
function parseJsonish(out) {
  const s = out.trim();
  if (!s) return [];
  if (s.startsWith('[')) return JSON.parse(s);
  return s.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Normalise an accessibility element from `idb ui describe-all --json`.
function normalize(e) {
  let f = e.frame;
  if (!f && typeof e.AXFrame === 'string') {
    const n = e.AXFrame.match(/-?\d+(\.\d+)?/g)?.map(Number);
    if (n?.length === 4) f = { x: n[0], y: n[1], width: n[2], height: n[3] };
  }
  if (!f) return null;
  return {
    type: String(e.type || e.role || '').replace(/^AX/, ''),
    label: String(e.AXLabel ?? e.title ?? '').trim(),
    value: e.AXValue == null ? '' : String(e.AXValue),
    id: e.AXUniqueId || '',
    enabled: e.enabled !== false,
    x: f.x,
    y: f.y,
    w: f.width,
    h: f.height,
  };
}

/**
 * Driver for the iOS Simulator, built on Apple's simctl and Meta's idb.
 * Every driver implements the same small interface, so Android or real devices can be added later:
 *   resolve(), listApps(), launch(), isRunning(), elements(), tap(x, y), type(text), screenshot(file)
 */
export class IosSimulator {
  constructor({ udid = 'booted', bundleId } = {}) {
    this.platform = 'ios-sim';
    this.udid = udid;
    this.bundleId = bundleId;
  }

  async resolve() {
    const sims = await listSimulators();
    const sim = this.udid === 'booted' ? sims.find((s) => s.state === 'Booted') : sims.find((s) => s.udid === this.udid || s.name === this.udid);
    if (!sim) throw new Error('No booted simulator found. Boot one with: xcrun simctl boot "iPhone 16" && open -a Simulator');
    if (sim.state !== 'Booted') await sh('xcrun', ['simctl', 'boot', sim.udid]);
    Object.assign(this, { udid: sim.udid, name: sim.name, runtime: sim.runtime });
    await sh('idb', ['connect', this.udid]).catch(() => {});
    return this;
  }

  async listApps() {
    const apps = parseJsonish(await sh('idb', ['list-apps', '--udid', this.udid, '--json']));
    return apps
      .map((a) => ({ bundleId: a.bundle_id, name: a.name, type: a.install_type }))
      .sort((a, b) => (a.type === 'system') - (b.type === 'system') || a.name.localeCompare(b.name));
  }

  async launch() {
    await sh('xcrun', ['simctl', 'terminate', this.udid, this.bundleId]).catch(() => {});
    await sh('xcrun', ['simctl', 'launch', this.udid, this.bundleId]);
  }

  // Bring the running app back to the front without restarting it.
  async activate() {
    await sh('xcrun', ['simctl', 'launch', this.udid, this.bundleId]);
  }

  async isRunning() {
    const out = await sh('xcrun', ['simctl', 'spawn', this.udid, 'launchctl', 'list']).catch(() => '');
    return out.includes(`UIKitApplication:${this.bundleId}`);
  }

  async elements() {
    const raw = parseJsonish(await sh('idb', ['ui', 'describe-all', '--udid', this.udid, '--json']));
    return (Array.isArray(raw) ? raw : [raw]).map(normalize).filter(Boolean);
  }

  async tap(x, y) {
    await sh('idb', ['ui', 'tap', '--udid', this.udid, String(Math.round(x)), String(Math.round(y))]);
  }

  async type(text) {
    await sh('idb', ['ui', 'text', '--udid', this.udid, text]);
  }

  async screenshot(file) {
    await sh('xcrun', ['simctl', 'io', this.udid, 'screenshot', '--type=png', file]);
  }
}
