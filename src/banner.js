import { runChecks } from './doctor.js';
import * as t from './term.js';

// The start banner: the logo from the web UI (a filled square wired to two outlined ones)
// and SNAPPCRAWL in the "ANSI Shadow" figlet style. Full blocks bright, shadow lines grey.

const GLYPHS = {
  S: ['███████╗', '██╔════╝', '███████╗', '╚════██║', '███████║', '╚══════╝'],
  N: ['███╗   ██╗', '████╗  ██║', '██╔██╗ ██║', '██║╚██╗██║', '██║ ╚████║', '╚═╝  ╚═══╝'],
  A: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  P: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔═══╝ ', '██║     ', '╚═╝     '],
  C: [' ██████╗', '██╔════╝', '██║     ', '██║     ', '╚██████╗', ' ╚═════╝'],
  R: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██║  ██║', '╚═╝  ╚═╝'],
  W: ['██╗    ██╗', '██║    ██║', '██║ █╗ ██║', '██║███╗██║', '╚███╔███╔╝', ' ╚══╝╚══╝ '],
  L: ['██╗     ', '██║     ', '██║     ', '██║     ', '███████╗', '╚══════╝'],
};
// filled square → outlined square, which is wired down to a second outlined square
// (as in the web UI: squares bright, the wires grey). L = light, S = shadow/wire.
const LOGO = [
  [['███', 'L'], ['─', 'S'], ['┌─┐', 'L']],
  [['███', 'L'], [' ', 'S'], ['└┬┘', 'L']],
  [['     ', 'S'], ['│', 'S'], [' ', 'S']],
  [['    ', 'S'], ['┌┴┐', 'L']],
  [['    ', 'S'], ['└─┘', 'L']],
  [['       ', 'S']],
];
const logoText = (row) => LOGO[row].map(([s]) => s).join('');
const logoPaint = (row) => LOGO[row].map(([s, tone]) => (tone === 'L' ? light()(s) : shadow()(s))).join('');
export const TAGLINE = 'crawl your app, map every screen, diff builds';

export function wordmark(word = 'SNAPPCRAWL') {
  return GLYPHS.S.map((_, row) => [...word].map((ch) => GLYPHS[ch][row]).join(''));
}

const light = () => t.shade([237, 237, 237], 255, 97);
const shadow = () => t.shade([90, 90, 90], 240, 90);

// Bright blocks, grey box-drawing shadow.
const paint = (line) => {
  const b = light();
  const s = shadow();
  return line.replace(/█+|[^█]+/g, (run) => (run[0] === '█' ? b(run) : s(run)));
};

export const FULL_WIDTH = 2 + logoText(0).length + 3 + wordmark()[0].length;

/**
 * The banner as text, or '' when it should not be shown (no TTY, NO_COLOR, CI).
 * Narrower than ~100 columns: one compact line.
 */
export function banner(version, { columns = t.columns(), tty = t.isTTY, env = process.env } = {}) {
  if (!tty || env.NO_COLOR || env.CI) return '';
  if (columns < Math.max(100, FULL_WIDTH + 2)) return `\n  ${t.white('■')} ${t.bold('snappcrawl')} ${t.gray('v' + version)}\n`;
  const word = wordmark();
  const lines = word.map((w, i) => `  ${logoPaint(i)}   ${paint(w)}`);
  return `\n${lines.join('\n')}\n  ${t.gray(`v${version} · ${TAGLINE}`)}\n`;
}

/* ---------- the setup checklist ---------- */

const MARK = { ok: () => t.green('✓'), fail: () => t.red('✗'), warn: () => t.yellow('!'), optional: () => t.gray('○') };
const LABEL = 15;

function line(row, res, frame) {
  const mark = res ? MARK[res.state]() : t.gray(t.SPINNER[frame % t.SPINNER.length]);
  const value = res ? (res.state === 'optional' ? t.gray(res.value) : res.value) : t.gray('checking');
  let text = `  ${mark} ${row.label.padEnd(LABEL)} ${value}`;
  const cmd = res && (res.state === 'fail' || res.state === 'warn') && res.fix ? res.fix.cmd || res.fix.steps?.[0] : '';
  if (cmd) {
    // the exact fix to the right when it fits, else on the next line
    const room = t.columns() - t.width(text) - 4;
    const shown = res.fix.sudo ? `${cmd}  ${t.gray('(run it yourself)')}` : cmd;
    text += t.width(shown) <= room ? '   ' + t.white(shown) : `\n    ${' '.repeat(LABEL + 1)}${t.white(shown)}`;
  }
  return text;
}

/**
 * Run all checks in parallel and show them as a to-do list, grouped, with a spinner per line
 * that turns into ✓ ✗ ! ○. Without a TTY the finished list is printed once.
 */
export async function checklist({ cfg, print = console.log }) {
  let rows = [];
  const results = new Map();
  let frame = 0;
  let drawn = 0;
  const render = () => {
    const out = [];
    let group = '';
    for (const r of rows) {
      if (r.group !== group) {
        group = r.group;
        out.push(`  ${t.gray(group)}`);
      }
      out.push(line(r, results.get(r.id), frame));
    }
    return out.join('\n').split('\n');
  };
  const draw = () => {
    if (!t.isTTY) return;
    const lines = render();
    if (drawn) process.stdout.write(`\x1b[${drawn}A`);
    for (const l of lines) process.stdout.write(`\r\x1b[2K${l}\n`);
    drawn = lines.length;
  };
  print();
  const timer = t.isTTY ? setInterval(() => (frame++, draw()), 80) : null;
  const final = await runChecks({
    cfg,
    onStart: (list) => {
      rows = list;
      draw();
    },
    onResult: (row, res) => {
      results.set(row.id, res);
      draw();
    },
  });
  clearInterval(timer);
  if (t.isTTY) draw();
  else for (const l of render()) print(l);
  if (final.some((r) => r.state === 'fail' || r.state === 'warn')) print(`\n  ${t.gray('→')} ${t.white('snappcrawl setup')} ${t.gray('fixes this step by step')}`);
  return final;
}
