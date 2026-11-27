import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/snappcrawl.js', import.meta.url));
export const tmpDir = (prefix = 'snappcrawl-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// The CLI under test never sees the real home folder or the developer's variables.
export function cliEnv(cwd, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^SNAPP?CRAWL_/.test(k)));
  return { ...env, NO_COLOR: '1', SNAPPCRAWL_HOME: path.join(cwd, '.home'), SNAPPCRAWL_LEGACY_HOME: path.join(cwd, '.legacy-home'), SNAPPCRAWL_WDA_HOME: path.join(cwd, '.home', 'wda'), ...extra };
}

export const cli = (cwd, args, extra) => execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: cliEnv(cwd, extra) });
export const cliRun = (cwd, args, extra) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: cliEnv(cwd, extra) });
