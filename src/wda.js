import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// WebDriverAgent lives outside any project: built once per Mac, reused by every crawl.
export const WDA_HOME = process.env.SNAPCRAWL_WDA_HOME || path.join(os.homedir(), '.snapcrawl', 'wda');
export const WDA_REPO = 'https://github.com/appium/WebDriverAgent.git';
export const paths = {
  repo: path.join(WDA_HOME, 'WebDriverAgent'),
  derived: path.join(WDA_HOME, 'DerivedData'),
  setup: path.join(WDA_HOME, 'setup.json'),
  pids: path.join(WDA_HOME, 'pids'),
  buildLog: path.join(WDA_HOME, 'build.log'),
  runLog: path.join(WDA_HOME, 'xcodebuild.log'),
  forwardLog: path.join(WDA_HOME, 'forward.log'),
};

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
};

export const readSetup = () => readJson(paths.setup);
export const writeSetup = (v) => writeJson(paths.setup, v);
export const readPids = () => readJson(paths.pids);
export const writePids = (v) => writeJson(paths.pids, v);
export const clearPids = () => fs.rmSync(paths.pids, { force: true });

export function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Processes are started detached (own process group), so the whole group is stopped.
export function kill(pid) {
  if (!alive(pid)) return false;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  return true;
}

// Newest release tag from `git ls-remote --tags --refs`.
export function latestTag(lsRemote) {
  const tags = [...String(lsRemote).matchAll(/refs\/tags\/(v?(\d+)\.(\d+)\.(\d+))\s*$/gm)].map((m) => ({ tag: m[1], v: [+m[2], +m[3], +m[4]] }));
  tags.sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
  return tags[0]?.tag || null;
}

// A bundle id Apple will accept for a personal team: unique per user and team.
export function bundleIdFor(user, team) {
  const clean = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '') || 'user';
  return `com.${clean(user)}.snapcrawl${team ? '.' + clean(team) : ''}.WebDriverAgentRunner`;
}

// Team ids from the Apple Development certificates in the login keychain (subject OU).
export function teamsFromPem(pem, now = new Date()) {
  const teams = new Map();
  for (const block of String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []) {
    try {
      const c = new crypto.X509Certificate(block);
      if (new Date(c.validTo) < now) continue;
      const f = Object.fromEntries(c.subject.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      if (f.OU && /^[A-Z0-9]{10}$/.test(f.OU)) teams.set(f.OU, { team: f.OU, name: f.O || '', cert: f.CN || '' });
    } catch {}
  }
  return [...teams.values()];
}

export async function findTeams() {
  let pem = '';
  for (const name of ['Apple Development', 'iPhone Developer']) {
    try {
      pem += (await exec('security', ['find-certificate', '-a', '-p', '-c', name], { maxBuffer: 16 * 1024 * 1024 })).stdout;
    } catch {}
  }
  return teamsFromPem(pem);
}

// Common xcodebuild failures → what to do about them.
const HINTS = [
  [/developer mode/i, 'Turn on Developer Mode on the iPhone: Settings → Privacy & Security → Developer Mode, then restart it.'],
  [/(untrusted developer|not been explicitly trusted|invalid code signature|profile has not been explicitly trusted)/i, 'Trust the developer certificate on the iPhone: Settings → General → VPN & Device Management → your Apple ID → Trust. Then run snapcrawl wda start again.'],
  [/(device is locked|passcode protected|unlock)/i, 'Unlock the iPhone and keep it unlocked while WebDriverAgent starts.'],
  [/(failed to register bundle identifier|is not available|cannot be registered)/i, 'The bundle id is taken. Run snapcrawl wda setup again with --bundle-id com.<you>.<something>.WebDriverAgentRunner.'],
  [/(no account for team|no signing certificate|requires a development team|no profiles for)/i, 'Sign in to Xcode with your Apple ID (Xcode → Settings → Accounts) and check --team.'],
  [/(maximum number of apps|app id limit)/i, 'A free Apple ID allows only a few app ids per week. Reuse the existing bundle id (snapcrawl wda setup reads it from setup.json) or wait.'],
  [/(provisioning profile.*expired|profile.*has expired)/i, 'The provisioning profile expired (free Apple IDs: after 7 days). Run snapcrawl wda setup again.'],
  [/(unable to find a destination|no destinations? matching|device.*not available|is not connected)/i, 'Connect the iPhone by USB, unlock it and tap Trust. snapcrawl devices lists it when Xcode can see it.'],
  [/(is busy|preparing the device|copying shared cache)/i, 'Xcode is still preparing the iPhone for development. Wait until the progress in Xcode → Window → Devices and Simulators is done, then retry.'],
];

// Most recent problem first: an early "locked" can be followed by a later "not trusted".
export function diagnose(log) {
  const last = (re) => {
    let at = -1;
    for (const m of String(log).matchAll(new RegExp(re.source, 'gi'))) at = m.index;
    return at;
  };
  return HINTS.map(([re, hint]) => [last(re), hint]).filter(([at]) => at >= 0).sort((a, b) => b[0] - a[0]).map(([, hint]) => hint);
}

export const tail = (file, n = 25) => {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n');
  } catch {
    return '';
  }
};

export function xcodebuildArgs(action, { udid, team, bundleId }) {
  return [
    action,
    '-project', path.join(paths.repo, 'WebDriverAgent.xcodeproj'),
    '-scheme', 'WebDriverAgentRunner',
    '-destination', `id=${udid}`,
    '-derivedDataPath', paths.derived,
    '-allowProvisioningUpdates',
    '-allowProvisioningDeviceRegistration',
    `DEVELOPMENT_TEAM=${team}`,
    `PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`,
    'CODE_SIGN_STYLE=Automatic',
  ];
}
