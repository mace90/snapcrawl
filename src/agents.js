import fs from 'node:fs';
import path from 'node:path';

// `snappcrawl init --agents`: tell the coding agents working in an app's repository that
// snappcrawl is there and when to use it. Every file gets a marked block (replaced on the next
// run, the rest of the file untouched); MCP configs get one server entry, other entries stay.

const START = '<!-- snappcrawl:start -->';
const END = '<!-- snappcrawl:end -->';
export const SERVER = { command: 'snappcrawl', args: ['mcp'] };

export function agentBlock({ bundleId = '' } = {}) {
  const id = bundleId || '<bundle id>';
  return `${START}
## UI checks with snappcrawl

This is an iOS app. snappcrawl crawls it in the Simulator, maps every screen and compares each one with a baseline run (pixels, texts, buttons, navigation, crashes). After changing anything a user can see or reach (views, navigation, texts, layout, assets, startup), check the app with it before you call the work done.

- **MCP** (tools \`status\`, \`check\`, \`screen\`, \`review\`, \`set_baseline\`, \`ignore\`): \`check\` with \`bundleId: "${id}"\`, then look at changed screens with \`screen\`.
- **CLI**: \`snappcrawl check --bundle ${id} --json\` · exit 0 passed, 1 broken (new crash or unreachable screen), 2 changes to review, 3 needs login data, 4 setup problem.
- **No baseline yet**: the first check saves it. Make it from the code before your change (\`git stash\`, build, install, check, \`git stash pop\`).
- **Build and install for the Simulator**: \`xcodebuild -scheme <Scheme> -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build\` then \`xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/<App>.app\` (or pass \`appPath\` to the MCP \`check\`).
- **Read the result**: \`broken\` is almost always a bug you made: fix it and check again. \`changes\` lists per screen the texts that came and went and the buttons that were renamed, moved or removed: confirm each is intended (\`screen\` shows the pictures), otherwise fix it. Approve intended changes (\`review\`), and make the new state the reference (\`set_baseline\` / \`snappcrawl baseline <run>\`) only when the user agrees.
- **Logins**: set \`SNAPPCRAWL_USERNAME\`, \`SNAPPCRAWL_PASSWORD\` (and \`SNAPPCRAWL_TOTP_SECRET\` or \`SNAPPCRAWL_PIN\`) for test accounts; never real ones.
${END}`;
}

// put the block into a text file: replace an earlier block, else append
export function upsertBlock(file, block) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`${START}[\\s\\S]*?${END}`);
  const after = re.test(before) ? before.replace(re, block) : `${before}${before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : ''}${block}\n`;
  if (after === before) return 'unchanged';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, after);
  return before ? 'updated' : 'created';
}

// one server entry in an MCP config (key: mcpServers, or servers for VS Code)
export function upsertServer(file, key, entry) {
  let json = {};
  const existed = fs.existsSync(file);
  if (existed) {
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return 'skipped (not valid JSON, left as it is)';
    }
  }
  json[key] ||= {};
  if (JSON.stringify(json[key].snappcrawl) === JSON.stringify(entry)) return 'unchanged';
  json[key].snappcrawl = entry;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  return existed ? 'updated' : 'created';
}

export function initAgents({ dir = process.cwd(), bundleId = '' } = {}) {
  const block = agentBlock({ bundleId });
  const p = (f) => path.join(dir, f);
  const done = [];
  done.push(['AGENTS.md', upsertBlock(p('AGENTS.md'), block), 'Codex, Copilot, Cursor, Gemini, Jules and others']);
  // Claude Code reads CLAUDE.md; an import keeps one copy of the text
  const claude = p('CLAUDE.md');
  const claudeText = fs.existsSync(claude) ? fs.readFileSync(claude, 'utf8') : '';
  done.push(['CLAUDE.md', /^@AGENTS\.md\s*$/m.test(claudeText) ? 'unchanged (imports AGENTS.md)' : upsertBlock(claude, `${START}\n@AGENTS.md\n${END}`), 'Claude Code']);
  done.push(['.github/copilot-instructions.md', upsertBlock(p('.github/copilot-instructions.md'), block), 'GitHub Copilot']);
  done.push(['.mcp.json', upsertServer(p('.mcp.json'), 'mcpServers', SERVER), 'Claude Code (project MCP server)']);
  done.push(['.vscode/mcp.json', upsertServer(p('.vscode/mcp.json'), 'servers', { type: 'stdio', ...SERVER }), 'VS Code with Copilot']);
  done.push(['.cursor/mcp.json', upsertServer(p('.cursor/mcp.json'), 'mcpServers', SERVER), 'Cursor']);
  return {
    files: done.map(([file, state, who]) => ({ file, state, for: who })),
    commands: [
      { for: 'Codex (once per machine)', cmd: 'codex mcp add snappcrawl -- snappcrawl mcp' },
      { for: 'Claude Code (all projects)', cmd: 'claude mcp add --scope user snappcrawl -- snappcrawl mcp' },
    ],
  };
}
