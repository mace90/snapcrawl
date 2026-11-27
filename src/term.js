// Terminal output: no dependencies, respects NO_COLOR, non-TTY output and narrow terminals.
const out = process.stdout;
export const isTTY = !!out.isTTY;
export const color = isTTY && !process.env.NO_COLOR;
export const columns = () => out.columns || 80;
// truecolor when the terminal says so, else 256 colours, else the 16 basic ones
export const depth = !color ? 0 : /truecolor|24bit/i.test(process.env.COLORTERM || '') ? 3 : /256/.test(process.env.TERM || '') ? 2 : 1;

const wrap = (open) => (s) => (color ? `\x1b[${open}m${s}\x1b[0m` : String(s));
export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const blue = wrap('34');
export const cyan = wrap('36');
export const gray = wrap('90');
export const white = wrap('97');

// a fixed shade at the best depth: [r, g, b], 256-colour index, 16-colour code
export function shade(rgb, c256, c16) {
  if (depth === 3) return wrap(`38;2;${rgb.join(';')}`);
  if (depth === 2) return wrap(`38;5;${c256}`);
  return wrap(String(c16));
}

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
export const width = (s) => [...strip(s)].length;

const t0 = Date.now();
export function elapsed(ms = Date.now() - t0) {
  const s = ms / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

/* ---------- a status line that stays below the log ---------- */

let status = '';
const clearStatus = () => status && isTTY && out.write('\r\x1b[2K');
const drawStatus = () => status && isTTY && out.write(status);
export function setStatus(text) {
  if (!isTTY) return;
  clearStatus();
  status = text ? '  ' + text : '';
  drawStatus();
}
// everything printed while a status line is shown goes above it
export function print(line = '') {
  clearStatus();
  out.write(line + '\n');
  drawStatus();
}

const LEVEL = { INFO: blue, STEP: gray, AUTH: cyan, WARN: yellow, ERROR: red, DONE: green, WAIT: white };

export function logLine(level, msg) {
  const tag = (LEVEL[level] || ((s) => s))(level.padEnd(5));
  print(`${gray(elapsed())}  ${tag}  ${msg}`);
}

/* ---------- headings, tables, marks ---------- */

// "■ title  sub" with a thin rule below
export function title(text, sub = '') {
  const head = `${white('■')} ${bold(text)}${sub ? '  ' + gray(sub) : ''}`;
  print();
  print('  ' + head);
  print('  ' + gray('─'.repeat(Math.max(24, Math.min(columns() - 4, width(head) + 8, 72)))));
}

export function table(rows, { head } = {}) {
  const all = head ? [head, ...rows] : rows;
  const widths = all[0].map((_, i) => Math.max(...all.map((r) => width(r[i] ?? ''))));
  const fmt = (r) => r.map((c, i) => String(c ?? '') + ' '.repeat(widths[i] - width(c ?? ''))).join('   ').trimEnd();
  if (head) print('  ' + gray(fmt(head)));
  for (const r of rows) print('  ' + fmt(r));
}

export const ok = (s) => `${green('✓')} ${s}`;
export const fail = (s) => `${red('✗')} ${s}`;
export const warn = (s) => `${yellow('!')} ${s}`;
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/* ---------- errors ---------- */

// "<what> · <what to do>" becomes a short block; stacks only with --debug.
export function errorBlock(e, { debug = false } = {}) {
  const [what, ...todo] = String(e.message || e).split('\n')[0].split(' · ');
  const lines = ['', '  ' + fail(bold(what))];
  for (const t of todo) lines.push('    ' + gray('→ ') + t);
  for (const h of (e.hints || []).slice(todo.length ? 1 : 0)) lines.push('    ' + gray('→ ') + h);
  const rest = String(e.message || '').split('\n').slice(1).join('\n').trim();
  if (rest) lines.push(rest.split('\n').map((l) => '    ' + l).join('\n'));
  if (e.log) lines.push(gray(e.log.split('\n').map((l) => '    ' + l).join('\n')));
  if (e.logFile) lines.push('    ' + gray('full log: ' + e.logFile));
  if (debug && e.stack) lines.push(gray(e.stack.split('\n').slice(1).join('\n')));
  else if (!todo.length && !e.hints?.length) lines.push('    ' + gray('details: run again with --debug'));
  return lines.join('\n') + '\n';
}
