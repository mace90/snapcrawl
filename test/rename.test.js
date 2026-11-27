import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { envValue, hintOnce, legacyInUse, migrate } from '../src/legacy.js';
import { cli, tmpDir } from './helpers.js';

// Old-name fixtures: a project folder with data and config, and an old home folder.
function oldProject() {
  const cwd = tmpDir('snappcrawl-rename-');
  fs.mkdirSync(path.join(cwd, '.snapcrawl'));
  fs.writeFileSync(path.join(cwd, 'snapcrawl.config.json'), JSON.stringify({ app: { bundleId: 'com.old.app' }, auth: { username: 'env:SNAPCRAWL_USERNAME' } }));
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'node_modules/\n.snapcrawl/\n');
  fs.mkdirSync(path.join(cwd, '.legacy-home', 'wda'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.legacy-home', 'config.json'), JSON.stringify({ ai: { provider: 'ollama' } }));
  return cwd;
}

test('rename: old data, config, home and variables are still read, with one hint', () => {
  const cwd = oldProject();
  const first = cli(cwd, ['runs'], { SNAPCRAWL_PASSWORD: 'x' });
  cli(cwd, ['demo']);
  assert.match(cli(cwd, ['runs']), /\/\.snapcrawl\n[\s\S]*demo-v2\.4\.0/, 'the old data folder is used while it is the only one');
  assert.match(first, /still reading files from before the rename: .*\.snapcrawl.*snapcrawl\.config\.json.*config\.json.*wda/);
  assert.match(first, /move them with: snappcrawl migrate {2}· {2}rename the environment variables to SNAPPCRAWL_\*/);
  assert.doesNotMatch(cli(cwd, ['runs'], { SNAPCRAWL_PASSWORD: 'x' }), /still reading/, 'the hint is shown once');
  assert.match(cli(cwd, ['config']), /ollama/, 'the old global config is read');
  assert.ok(!fs.existsSync(path.join(cwd, '.snappcrawl')), 'nothing was moved without asking');
});

test('rename: snappcrawl migrate moves everything to the new names', () => {
  const cwd = oldProject();
  cli(cwd, ['demo']);
  const out = cli(cwd, ['migrate']);
  assert.match(out, /\.snapcrawl → .*\.snappcrawl/);
  assert.ok(fs.existsSync(path.join(cwd, '.snappcrawl', 'runs', 'demo-v2.4.0')));
  assert.ok(!fs.existsSync(path.join(cwd, '.snapcrawl')));
  const cfg = JSON.parse(fs.readFileSync(path.join(cwd, 'snappcrawl.config.json'), 'utf8'));
  assert.equal(cfg.auth.username, 'env:SNAPPCRAWL_USERNAME');
  assert.ok(!fs.existsSync(path.join(cwd, 'snapcrawl.config.json')));
  assert.match(fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8'), /^\.snappcrawl\/$/m);
  assert.ok(fs.existsSync(path.join(cwd, '.home', 'wda')) && fs.existsSync(path.join(cwd, '.home', 'config.json')));
  assert.match(cli(cwd, ['runs']), /\.snappcrawl/);
  assert.match(cli(cwd, ['migrate']), /nothing to move/);
});

test('rename: helpers', () => {
  const cwd = oldProject();
  const opts = { home: path.join(cwd, '.home'), legacyHome: path.join(cwd, '.legacy-home') };
  assert.equal(legacyInUse(cwd, opts).filter((f) => !f.env).length, 4);
  const found = legacyInUse(cwd, opts);
  assert.ok(hintOnce(found, opts));
  assert.equal(hintOnce(found, opts), null);
  const r = migrate(cwd, { ...opts, isRunning: () => true });
  assert.ok(r.skipped.some((s) => s.includes('WebDriverAgent is running')), 'a running WDA is not moved');
  process.env.SNAPCRAWL_RENAME_TEST = 'old';
  assert.equal(envValue('SNAPPCRAWL_RENAME_TEST'), 'old');
  delete process.env.SNAPCRAWL_RENAME_TEST;
});
