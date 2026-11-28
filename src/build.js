import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Build an app from its Xcode project for the Simulator, so a check needs no manual build step:
// `snappcrawl check --build` in the repository, or `--base-ref main` to build and crawl another
// git state first as the baseline (in a temporary worktree, the working tree stays as it is).

async function sh(cmd, args, { cwd, timeout = 30 * 60_000, log } = {}) {
  try {
    const { stdout } = await run(cmd, args, { cwd, maxBuffer: 256 * 1024 * 1024, timeout });
    return stdout;
  } catch (e) {
    const out = `${e.stdout || ''}\n${e.stderr || ''}`;
    // xcodebuild's own error lines say more than its exit code
    const lines = out.split('\n').filter((l) => /error:|\*\* BUILD FAILED|xcodebuild: error/.test(l)).slice(0, 8);
    log?.('ERROR', lines.join('\n') || out.trim().split('\n').slice(-5).join('\n'));
    const err = new Error(`${cmd} failed · ${lines[0]?.trim() || String(e.message).split('\n')[0]}`);
    err.output = out;
    throw err;
  }
}

// The Xcode workspace or project in `dir` (a workspace wins, it carries the CocoaPods/SPM setup).
export function findProject(dir) {
  const entries = fs.readdirSync(dir);
  const ws = entries.filter((e) => e.endsWith('.xcworkspace'));
  const pj = entries.filter((e) => e.endsWith('.xcodeproj'));
  if (ws.length === 1) return { workspace: path.join(dir, ws[0]) };
  if (pj.length === 1) return { project: path.join(dir, pj[0]) };
  if (ws.length + pj.length === 0) return null;
  throw new Error(`more than one Xcode project in ${dir} (${[...ws, ...pj].join(', ')}) · pass --project <path>`);
}

const projectArgs = (p) => (p.workspace ? ['-workspace', p.workspace] : ['-project', p.project]);

// The scheme to build: the given one, else the only one, else the one named like the project.
export async function pickScheme(p, scheme) {
  if (scheme) return scheme;
  const json = JSON.parse(await sh('xcodebuild', ['-list', '-json', ...projectArgs(p)]));
  const info = json.workspace || json.project || {};
  const schemes = info.schemes || [];
  if (schemes.length === 1) return schemes[0];
  const named = schemes.find((s) => s === info.name || s === path.basename(p.workspace || p.project).replace(/\.\w+$/, ''));
  if (named) return named;
  throw new Error(`which scheme? · ${schemes.join(', ') || 'none shared'} · pass --scheme <name>`);
}

// Build for the Simulator, return the .app and its bundle id.
export async function buildApp({ dir = process.cwd(), project, scheme, configuration = 'Debug', derivedData, settings = [], log = () => {} }) {
  const p = project ? (project.endsWith('.xcworkspace') ? { workspace: path.resolve(dir, project) } : { project: path.resolve(dir, project) }) : findProject(dir);
  if (!p) throw new Error(`no Xcode project in ${dir} · run it in the app's folder or pass --project <path>`);
  const sch = await pickScheme(p, scheme);
  const dd = derivedData || path.join(dir, '.snappcrawl', 'build');
  log('INFO', `build ${sch} · ${configuration} · Simulator · ${path.basename(p.workspace || p.project)}`);
  const t0 = Date.now();
  await sh('xcodebuild', [...projectArgs(p), '-scheme', sch, '-configuration', configuration, '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', dd, 'CODE_SIGNING_ALLOWED=NO', ...settings, 'build', '-quiet'], { cwd: dir, log });
  const products = path.join(dd, 'Build', 'Products', `${configuration}-iphonesimulator`);
  const apps = fs.existsSync(products) ? fs.readdirSync(products).filter((f) => f.endsWith('.app')) : [];
  if (!apps.length) throw new Error(`the build made no .app in ${products}`);
  // more than one (an app and its extensions' host apps): the one named like the scheme
  const app = path.join(products, apps.find((a) => a === `${sch}.app`) || apps[0]);
  const bundleId = await bundleIdOf(app);
  log('INFO', `built ${path.basename(app)} · ${bundleId} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return { app, bundleId, scheme: sch };
}

export async function bundleIdOf(app) {
  return (await sh('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(app, 'Info.plist')])).trim();
}

export async function installApp(udid, app) {
  await sh('xcrun', ['simctl', 'install', udid, app]);
}

// Build another git state (a branch, a tag, a commit) in a temporary worktree.
export async function buildRef({ dir = process.cwd(), ref, project, scheme, configuration, settings, log = () => {} }) {
  const top = (await sh('git', ['rev-parse', '--show-toplevel'], { cwd: dir })).trim();
  const sha = (await sh('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: dir })).trim();
  const rel = path.relative(top, path.resolve(dir));
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-ref-'));
  log('INFO', `${ref} (${sha.slice(0, 8)}) in a temporary worktree`);
  await sh('git', ['worktree', 'add', '--detach', tree, sha], { cwd: top });
  try {
    // its own derived data: the two builds must not mix
    return { ...(await buildApp({ dir: path.join(tree, rel), project: project && path.relative(path.resolve(dir), path.resolve(dir, project)), scheme, configuration, settings, derivedData: path.join(path.resolve(dir), '.snappcrawl', 'build-ref'), log })), ref, sha };
  } finally {
    await sh('git', ['worktree', 'remove', '--force', tree], { cwd: top }).catch(() => {});
  }
}
