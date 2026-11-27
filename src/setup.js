import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { checklist } from './banner.js';
import * as control from './control.js';
import { DEFAULT_WDA_URL } from './drivers/ios-device.js';
import * as t from './term.js';

// `snappcrawl setup`: everything still missing, one to-do at a time. Commands run only after
// a yes; sudo commands are shown for you to run; iPhone and Xcode steps are confirmed with enter.

const runShell = (cmd) =>
  new Promise((resolve) => {
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', cmd], { stdio: 'inherit' });
    child.on('close', (code) => resolve(code === 0));
  });

export async function setup({ cfg, input = process.stdin, output = process.stdout }) {
  const results = await checklist({ cfg, print: t.print });
  // missing or needing attention, plus optional steps snappcrawl can do itself (boot, start WDA)
  const todo = results.filter((r) => r.fix && (r.state === 'fail' || r.state === 'warn' || (r.state === 'optional' && r.fix.action)));
  if (!todo.length) {
    t.print(`\n  ${t.ok('nothing to do · everything is set up')}\n`);
    return results;
  }
  if (!t.isTTY || !input.isTTY) {
    t.print(`\n  ${t.gray('not an interactive terminal · the steps:')}`);
    for (const r of todo) t.print(`    ${r.label}: ${r.fix.cmd || (r.fix.steps || []).join(' ')}`);
    t.print();
    return results;
  }

  const rl = readline.createInterface({ input, output });
  const ask = async (q, dflt = true) => {
    const a = (await rl.question(`    ${q} ${t.gray(dflt ? '[Y/n]' : '[y/N]')} `)).trim().toLowerCase();
    return a ? a.startsWith('y') : dflt;
  };
  const enter = (q) => rl.question(`    ${t.gray(q)} `);
  const log = (level, msg) => t.logLine(level, msg);

  try {
    for (const [i, r] of todo.entries()) {
      const f = r.fix;
      t.title(`${i + 1}/${todo.length}  ${r.label}`, r.value);
      if (f.explain) t.print(`    ${f.explain}`);
      if (f.steps) for (const s of f.steps) t.print(`    ${t.gray('·')} ${s}`);

      if (f.sudo) {
        t.print(`\n    ${t.gray('run this yourself, it asks for your password:')}\n    ${t.white(f.cmd)}\n`);
        await enter('press enter when done');
      } else if (f.action) {
        t.print(`\n    ${t.white(f.cmd)}`);
        if (!(await ask('Run it now?', r.state !== 'optional'))) continue;
        try {
          if (f.action === 'boot') await control.bootSimulator(f.target, { log });
          if (f.action === 'wda-setup') {
            const teams = await control.teams();
            let team = teams.length === 1 ? teams[0].team : '';
            if (!team) team = (await rl.question(`    ${teams.length ? `team id (${teams.map((x) => x.team).join(', ')})` : 'team id (Xcode → Settings → Accounts → your Apple ID)'}: `)).trim().toUpperCase();
            await control.wdaSetup({ team, log });
          }
          if (f.action === 'wda-restart') control.wdaStop();
          if (f.action === 'wda-start' || f.action === 'wda-restart') {
            const started = control.wdaStart({ url: cfg.device.wdaUrl || DEFAULT_WDA_URL, log });
            await started.catch(async (e) => {
              t.print(t.errorBlock(e));
              if (/trust/i.test(e.message + (e.hints || []).join(' '))) {
                await enter('trust the certificate on the iPhone, then press enter to try again');
                await control.wdaStart({ url: cfg.device.wdaUrl || DEFAULT_WDA_URL, log });
              } else throw e;
            });
          }
          t.print('    ' + t.ok('done'));
        } catch (e) {
          t.print(t.errorBlock(e));
        }
      } else if (f.cmd) {
        t.print(`\n    ${t.white(f.cmd)}`);
        if (await ask('Run it now?')) t.print((await runShell(f.cmd)) ? '    ' + t.ok('done') : '    ' + t.fail('the command failed · see its output above'));
      } else {
        await enter('press enter when done, or ctrl-c to stop');
      }
    }
  } finally {
    rl.close();
  }
  t.title('setup', 'checking again');
  return checklist({ cfg, print: t.print });
}
