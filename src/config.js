import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GLOBAL_FILE = path.join(os.homedir(), '.snapcrawl', 'config.json');
export const LOCAL_FILE = 'snapcrawl.config.json';

export const DEFAULTS = {
  app: { bundleId: '' },
  device: { platform: 'ios-sim', udid: 'booted' },
  auth: {
    username: '',
    password: '',
    mfa: 'none', // none | totp | prompt | manual
    totpSecret: '',
    fallbackManual: true,
  },
  crawl: {
    maxDepth: 8,
    maxScreens: 200,
    timeLimitMin: 20,
    settleMs: 900,
    launchMs: 2500,
    blocklist: [
      'log out', 'logout', 'sign out', 'abmelden',
      'delete account', 'konto löschen',
      'buy', 'kaufen', 'purchase', 'pay now', 'jetzt zahlen', 'kauf abschließen',
    ],
  },
  diff: {
    threshold: 0.1, // per-pixel color tolerance (pixelmatch)
    minChangedRatio: 0.0005, // below this share of changed pixels a screen counts as unchanged
    ignoreStatusBar: true,
  },
  ai: {
    provider: 'none', // none | anthropic | openai | ollama
    model: '',
    apiKey: '',
    baseUrl: '',
  },
  outDir: '.snapcrawl',
};

export const AI_DEFAULT_MODEL = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4.1-mini',
  ollama: 'llava',
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function merge(base, over) {
  if (over === undefined || over === null) return base;
  if (Array.isArray(over) || typeof over !== 'object') return over;
  const out = { ...(base || {}) };
  for (const k of Object.keys(over)) out[k] = merge(base?.[k], over[k]);
  return out;
}

// "env:NAME" values are read from the environment, so secrets never live in the config file.
function resolveEnv(v) {
  if (typeof v === 'string' && v.startsWith('env:')) return process.env[v.slice(4)] || '';
  if (Array.isArray(v)) return v.map(resolveEnv);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveEnv(x)]));
  return v;
}

export function loadConfig(file) {
  const local = path.resolve(file || LOCAL_FILE);
  let cfg = merge(DEFAULTS, readJson(GLOBAL_FILE));
  cfg = merge(cfg, readJson(local));
  cfg = resolveEnv(cfg);

  const env = process.env;
  cfg.auth.username ||= env.SNAPCRAWL_USERNAME || '';
  cfg.auth.password ||= env.SNAPCRAWL_PASSWORD || '';
  cfg.auth.totpSecret ||= env.SNAPCRAWL_TOTP_SECRET || '';
  if (!cfg.ai.apiKey) {
    if (cfg.ai.provider === 'anthropic') cfg.ai.apiKey = env.ANTHROPIC_API_KEY || '';
    if (cfg.ai.provider === 'openai') cfg.ai.apiKey = env.OPENAI_API_KEY || '';
  }
  cfg.ai.model ||= AI_DEFAULT_MODEL[cfg.ai.provider] || '';
  cfg._file = fs.existsSync(local) ? local : null;
  return cfg;
}

export function getGlobal() {
  return readJson(GLOBAL_FILE) || {};
}

export function setGlobal(key, value) {
  const data = getGlobal();
  const parts = key.split('.');
  let node = data;
  for (const p of parts.slice(0, -1)) node = node[p] = node[p] && typeof node[p] === 'object' ? node[p] : {};
  let v = value;
  if (v === 'true' || v === 'false') v = v === 'true';
  else if (v !== '' && !Number.isNaN(Number(v))) v = Number(v);
  node[parts.at(-1)] = v;
  fs.mkdirSync(path.dirname(GLOBAL_FILE), { recursive: true });
  fs.writeFileSync(GLOBAL_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  return data;
}

export const TEMPLATE = {
  app: { bundleId: 'com.example.myapp' },
  device: { platform: 'ios-sim', udid: 'booted' },
  auth: {
    username: 'env:SNAPCRAWL_USERNAME',
    password: 'env:SNAPCRAWL_PASSWORD',
    mfa: 'none',
    totpSecret: 'env:SNAPCRAWL_TOTP_SECRET',
    fallbackManual: true,
  },
  crawl: { maxDepth: 8, maxScreens: 200, timeLimitMin: 20, blocklist: DEFAULTS.crawl.blocklist },
  diff: { threshold: 0.1, minChangedRatio: 0.0005, ignoreStatusBar: true },
};
