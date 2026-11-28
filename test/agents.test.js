import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { initAgents } from '../src/agents.js';

test('init --agents: a marked block per file, MCP entries merged, nothing doubled on a second run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  const p = (f) => path.join(dir, f);
  fs.writeFileSync(p('AGENTS.md'), '# MyApp\n\nRun swift test.\n');
  fs.mkdirSync(p('.vscode'));
  fs.writeFileSync(p('.vscode/mcp.json'), JSON.stringify({ servers: { github: { command: 'gh' } } }));
  fs.writeFileSync(p('.cursor.json'), 'not json');
  const first = initAgents({ dir, bundleId: 'com.acme.app' });
  assert.deepEqual(first.files.map((f) => f.state), ['updated', 'created', 'created', 'created', 'updated', 'created']);
  const agents = fs.readFileSync(p('AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith('# MyApp\n\nRun swift test.\n\n<!-- snappcrawl:start -->'));
  assert.match(agents, /snappcrawl check --bundle com\.acme\.app --json/);
  assert.equal(fs.readFileSync(p('CLAUDE.md'), 'utf8'), '<!-- snappcrawl:start -->\n@AGENTS.md\n<!-- snappcrawl:end -->\n');
  const vscode = JSON.parse(fs.readFileSync(p('.vscode/mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(vscode.servers), ['github', 'snappcrawl']);
  assert.deepEqual(vscode.servers.snappcrawl, { type: 'stdio', command: 'snappcrawl', args: ['mcp'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(p('.mcp.json'), 'utf8')).mcpServers.snappcrawl, { command: 'snappcrawl', args: ['mcp'] });

  const again = initAgents({ dir, bundleId: 'com.acme.app' });
  assert.ok(again.files.every((f) => f.state.startsWith('unchanged')), JSON.stringify(again.files));
  assert.equal(fs.readFileSync(p('AGENTS.md'), 'utf8'), agents);
  // a new bundle id replaces the block, it is not added twice
  initAgents({ dir, bundleId: 'com.acme.beta' });
  const updated = fs.readFileSync(p('AGENTS.md'), 'utf8');
  assert.equal(updated.match(/snappcrawl:start/g).length, 1);
  assert.match(updated, /com\.acme\.beta/);
  // a broken config is left alone
  fs.writeFileSync(p('.mcp.json'), '{ broken');
  assert.match(initAgents({ dir }).files.find((f) => f.file === '.mcp.json').state, /skipped/);
});
