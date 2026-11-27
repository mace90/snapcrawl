import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The project used to have another name. Its files and variables are still read silently,
// a hint explains the move once, and `snappcrawl migrate` moves everything.

export const HOME = process.env.SNAPPCRAWL_HOME || path.join(os.homedir(), '.snappcrawl');
export const LEGACY_HOME = process.env.SNAPPCRAWL_LEGACY_HOME || path.join(os.homedir(), '.snapcrawl');
export const DATA_DIR = '.snappcrawl';
export const LEGACY_DATA_DIR = '.snapcrawl';
export const CONFIG_FILE = 'snappcrawl.config.json';
export const LEGACY_CONFIG_FILE = 'snapcrawl.config.json';
const PREFIX = 'SNAPPCRAWL_';
const LEGACY_PREFIX = 'SNAPCRAWL_';

// SNAPPCRAWL_NAME, else the old SNAPCRAWL_NAME.
export const env = (name) => process.env[PREFIX + name] ?? process.env[LEGACY_PREFIX + name];

// "env:SNAPPCRAWL_X" in a config also finds SNAPCRAWL_X, and the other way round.
export function envValue(name) {
  if (process.env[name] !== undefined) return process.env[name];
  if (name.startsWith(PREFIX)) return process.env[LEGACY_PREFIX + name.slice(PREFIX.length)];
  if (name.startsWith(LEGACY_PREFIX)) return process.env[PREFIX + name.slice(LEGACY_PREFIX.length)];
  return undefined;
}

// New location if it exists or the old one does not; otherwise the old one.
export const pick = (current, legacy) => (fs.existsSync(current) || !fs.existsSync(legacy) ? current : legacy);

// What is still read from the old locations, relative to a project folder.
export function legacyInUse(cwd = process.cwd(), { home = HOME, legacyHome = LEGACY_HOME } = {}) {
  const found = [];
  const rel = (p) => path.join(cwd, p);
  if (!fs.existsSync(rel(DATA_DIR)) && fs.existsSync(rel(LEGACY_DATA_DIR))) found.push({ from: rel(LEGACY_DATA_DIR), to: rel(DATA_DIR) });
  if (!fs.existsSync(rel(CONFIG_FILE)) && fs.existsSync(rel(LEGACY_CONFIG_FILE))) found.push({ from: rel(LEGACY_CONFIG_FILE), to: rel(CONFIG_FILE) });
  // per entry, because ~/.snappcrawl may already exist (state.json) while config or WDA are still old
  for (const name of ['config.json', 'wda']) {
    if (!fs.existsSync(path.join(home, name)) && fs.existsSync(path.join(legacyHome, name))) found.push({ from: path.join(legacyHome, name), to: path.join(home, name) });
  }
  const vars = Object.keys(process.env).filter((k) => k.startsWith(LEGACY_PREFIX) && process.env[PREFIX + k.slice(LEGACY_PREFIX.length)] === undefined);
  if (vars.length) found.push({ from: vars.join(', '), to: vars.map((v) => PREFIX + v.slice(LEGACY_PREFIX.length)).join(', '), env: true });
  return found;
}

// The hint is shown once per set of old locations; remembered in ~/.snappcrawl/state.json.
export function hintOnce(found, { home = HOME } = {}) {
  if (!found.length) return null;
  const key = found.map((f) => f.from).sort().join('|');
  const file = path.join(home, 'state.json');
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  if (state.legacyHint?.includes(key)) return null;
  state.legacyHint = [...(state.legacyHint || []), key];
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
  return found;
}

const exists = (p) => fs.existsSync(p);

// Move the old files to the new names. Returns what was done and what was left alone.
export function migrate(cwd = process.cwd(), { home = HOME, legacyHome = LEGACY_HOME, isRunning = () => false } = {}) {
  const done = [];
  const skipped = [];
  const move = (from, to) => {
    if (!exists(from)) return;
    if (exists(to)) return skipped.push(`${from} (${to} already exists)`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    done.push(`${from} → ${to}`);
  };

  move(path.join(cwd, LEGACY_DATA_DIR), path.join(cwd, DATA_DIR));

  const oldCfg = path.join(cwd, LEGACY_CONFIG_FILE);
  const newCfg = path.join(cwd, CONFIG_FILE);
  if (exists(oldCfg) && !exists(newCfg)) {
    const text = fs.readFileSync(oldCfg, 'utf8').replaceAll(`env:${LEGACY_PREFIX}`, `env:${PREFIX}`).replaceAll(`"${LEGACY_DATA_DIR}"`, `"${DATA_DIR}"`);
    fs.writeFileSync(newCfg, text);
    fs.rmSync(oldCfg);
    done.push(`${oldCfg} → ${newCfg} (env: names updated)`);
  } else if (exists(oldCfg)) skipped.push(`${oldCfg} (${newCfg} already exists)`);

  const gi = path.join(cwd, '.gitignore');
  if (exists(gi) && !fs.readFileSync(gi, 'utf8').includes(`${DATA_DIR}/`)) {
    fs.appendFileSync(gi, `\n${DATA_DIR}/\n`);
    done.push(`.gitignore: added ${DATA_DIR}/`);
  }

  if (exists(legacyHome)) {
    if (isRunning()) skipped.push(`${legacyHome} (WebDriverAgent is running from it · stop it first: snappcrawl wda stop)`);
    else if (!exists(home)) move(legacyHome, home);
    else for (const name of fs.readdirSync(legacyHome)) move(path.join(legacyHome, name), path.join(home, name));
  }
  return { done, skipped };
}
