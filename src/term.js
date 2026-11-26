// Minimal terminal output: no dependencies, respects NO_COLOR and non-TTY output.
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open) => (s) => (tty ? `\x1b[${open}m${s}\x1b[0m` : String(s));

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const blue = wrap('34');
export const cyan = wrap('36');
export const gray = wrap('90');
export const white = wrap('97');

const t0 = Date.now();
export function elapsed(ms = Date.now() - t0) {
  const s = ms / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

const LEVEL = { INFO: blue, STEP: gray, AUTH: cyan, WARN: yellow, ERROR: red, DONE: green, WAIT: white };

export function logLine(level, msg) {
  const tag = (LEVEL[level] || ((s) => s))(level.padEnd(5));
  console.log(`${gray(elapsed())}  ${tag}  ${msg}`);
}

export function title(text, sub = '') {
  console.log(`\n${white('■')} ${bold(text)}${sub ? '  ' + gray(sub) : ''}\n`);
}

export function table(rows, { head } = {}) {
  const all = head ? [head, ...rows] : rows;
  const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const widths = all[0].map((_, i) => Math.max(...all.map((r) => strip(r[i] ?? '').length)));
  const fmt = (r) => r.map((c, i) => String(c ?? '') + ' '.repeat(widths[i] - strip(c ?? '').length)).join('   ');
  if (head) {
    console.log('  ' + gray(fmt(head)));
  }
  for (const r of rows) console.log('  ' + fmt(r));
}

export const ok = (s) => `${green('✓')} ${s}`;
export const fail = (s) => `${red('✗')} ${s}`;
export const warn = (s) => `${yellow('!')} ${s}`;
