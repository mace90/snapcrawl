import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { banner, FULL_WIDTH, wordmark } from '../src/banner.js';
import { errorBlock } from '../src/term.js';
import { cli, cliRun, tmpDir } from './helpers.js';

test('cli: runs rm, notes and config set work like their UI counterparts', () => {
  const cwd = tmpDir();
  cli(cwd, ['demo']);
  assert.match(cli(cwd, ['runs']), /demo-v2\.3\.0[\s\S]*runs rm <run> deletes one/);
  assert.match(cli(cwd, ['runs', 'rm', 'demo-v2.4.0']), /deleted demo-v2\.4\.0 and 1 comparison/);
  assert.doesNotMatch(cli(cwd, ['runs']), /demo-v2\.4\.0/);
  const noRun = cliRun(cwd, ['runs', 'rm']);
  assert.equal(noRun.status, 1);
  assert.match(noRun.stderr, /✗ which run\?\n {4}→ snappcrawl runs rm <run>/);

  cli(cwd, ['demo']);
  const notes = cliRun(cwd, ['notes']);
  assert.match(notes.stderr, /no ai provider\n {4}→ snappcrawl config set ai\.provider anthropic/);

  assert.match(cli(cwd, ['config', 'set', 'ai.apiKey', 'sk-1234567890']), /ai\.apiKey saved/);
  assert.match(cli(cwd, ['config']), /•••7890/);
  const file = path.join(cwd, '.home', 'config.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(cliRun(cwd, ['config', 'set', 'auth.password', 'x']).stderr, /cannot be set/);
});

test('cli: unknown commands and errors are short blocks; stacks only with --debug', () => {
  const cwd = tmpDir();
  const r = cliRun(cwd, ['frobnicate']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /✗ unknown command "frobnicate"\n {4}→ snappcrawl help lists all commands/);
  assert.doesNotMatch(r.stderr, /at .*\.js:\d+/);
  const boom = new Error('kaputt');
  assert.match(errorBlock(boom), /details: run again with --debug/);
  assert.match(errorBlock(boom, { debug: true }), /at .*cli\.test\.js/);
  assert.match(errorBlock(Object.assign(new Error('WebDriverAgent did not start · Trust the certificate'), { hints: ['Trust the certificate', 'Unlock it'] })), /✗ WebDriverAgent did not start\n {4}→ Trust the certificate\n {4}→ Unlock it/);
});

test('banner: full wordmark when wide, one line when narrow, nothing without a terminal', () => {
  assert.equal(banner('0.3.0', { tty: false, columns: 200, env: {} }), '', 'no TTY');
  assert.equal(banner('0.3.0', { tty: true, columns: 200, env: { NO_COLOR: '1' } }), '', 'NO_COLOR');
  assert.equal(banner('0.3.0', { tty: true, columns: 200, env: { CI: 'true' } }), '', 'CI');
  const narrow = banner('0.3.0', { tty: true, columns: 90, env: {} });
  assert.match(narrow, /■ snappcrawl v0\.3\.0/);
  assert.doesNotMatch(narrow, /█/);
  const wide = banner('0.3.0', { tty: true, columns: 120, env: {} });
  for (const l of wordmark()) assert.ok(wide.includes(l), 'every wordmark line');
  assert.match(wide, /v0\.3\.0 · crawl your app, map every screen, diff builds/);
  assert.ok(FULL_WIDTH <= 100);
  assert.equal(wordmark().length, 6);
  // the CLI itself prints no banner into a pipe
  assert.doesNotMatch(cli(tmpDir(), ['help']), /█/);
});
