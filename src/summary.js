import path from 'node:path';
import { decisionOf, hintLines, needsReview, reviewState } from './report.js';

// The result of a comparison for machines: coding agents (MCP, `--json`), CI and PR comments.
// Everything an agent needs to decide without looking at pictures first: what changed, in
// words, where the pictures are, and what to run next.
//
// verdict:  passed   nothing open (no changes, or all approved)
//           changes  changed or new screens wait for a decision (not necessarily bugs)
//           broken   a new crash or an unreachable screen that is not approved (a crash the
//                    baseline had too is listed with known: true, but is no reason for broken)
//           failed   a change was rejected
// The CLI exit codes follow it: 0 passed, 1 broken or failed, 2 changes.
export const EXIT = { passed: 0, broken: 1, failed: 1, changes: 2, input: 3, setup: 4 };

export function summarize(report, store) {
  const state = reviewState(report);
  const changes = report.screens.filter(needsReview);
  const open = (s) => decisionOf(report, s) === 'open';
  // a crash the baseline had too is listed (known: true) but did not come with this change
  const broken = changes.some((s) => s.status === 'bad' && open(s) && !s.known);
  const known = changes.filter((s) => s.known && open(s)).length;
  const verdict = state.rejected ? 'failed' : broken ? 'broken' : state.open > known ? 'changes' : 'passed';
  const file = (rel) => (rel ? path.join(store.root, rel) : null);
  const screens = changes.map((s) => {
    const words = s.texts && { added: s.texts.added.slice(0, 15), removed: s.texts.removed.slice(0, 15) };
    return {
      id: s.id,
      name: s.name,
      status: s.status === 'bad' ? 'broken' : s.status,
      ...(s.reason ? { reason: s.reason } : {}),
      ...(s.known ? { known: true } : {}),
      decision: decisionOf(report, s),
      path: ['start', ...s.path],
      ...(s.ratio != null ? { pixelsChanged: `${(s.ratio * 100).toFixed(2)} %` } : {}),
      ...(words ? { texts: words } : {}),
      ...(hintLines(s).length ? { buttons: hintLines(s) } : {}),
      ...(s.ignored?.length ? { ignoredAreas: s.ignored.length } : {}),
      images: { base: file(s.baseImg), head: file(s.headImg), diff: file(s.diffImg) },
    };
  });
  const sum = report.summary;
  return {
    verdict,
    app: report.app,
    base: { run: report.base.id, label: report.base.label || '' },
    head: { run: report.head.id, label: report.head.label || '' },
    counts: { screens: sum.screens, same: sum.same, changed: sum.changed, new: sum.new, broken: sum.bad, oneTime: sum.skipped },
    review: { open: state.open, approved: state.approved, rejected: state.rejected },
    screens,
    next: nextSteps(verdict, screens, report),
  };
}

function nextSteps(verdict, screens, report) {
  const pair = `${report.base.id} ${report.head.id}`;
  if (verdict === 'passed') return [screens.some((s) => s.known) ? 'Nothing new: the app looks and navigates as in the baseline (its known crashes included).' : 'Nothing to do. The app looks and navigates as in the baseline.'];
  const out = [];
  if (screens.some((s) => s.known && s.decision === 'open')) out.push('Crashes marked known were in the baseline too: not caused by this change, but still bugs worth a ticket.');
  if (screens.some((s) => s.status === 'broken' && !s.known && s.decision === 'open')) out.push('Broken screens (crash, unreachable) are most likely bugs: fix them and run the check again.');
  if (screens.some((s) => s.decision === 'open' && s.status !== 'broken')) {
    out.push('Look at each open change (texts, buttons, the head and diff images). Intended: approve it. A bug: fix it, then check again.');
    out.push(`snappcrawl review <id|all> approve ${pair}  ·  snappcrawl review <id> reject ${pair}`);
  }
  out.push('An area that changes on every run (animation, live data): snappcrawl ignore "<screen>" --area x,y,w,h');
  out.push(`When the new state is the reference: snappcrawl baseline ${report.head.id}`);
  return out;
}

// The same as Markdown: for an agent's chat, a pull request comment or a CI summary.
export function summaryMarkdown(r) {
  const icon = { passed: 'passed', changes: 'changes to review', broken: 'broken', failed: 'failed' }[r.verdict];
  const c = r.counts;
  const lines = [`### snappcrawl · ${r.app} · ${icon}`, '', `${r.base.label || r.base.run} → ${r.head.label || r.head.run} · ${c.screens} screens · ${c.same} same · ${c.changed} changed · ${c.new} new · ${c.broken} broken`, ''];
  if (r.screens.length) {
    lines.push('| screen | status | pixels | decision | what changed |', '|---|---|---|---|---|');
    for (const s of r.screens) {
      const what = [
        s.reason,
        s.texts?.added.length ? `new text: ${s.texts.added.slice(0, 4).map((t) => `"${t}"`).join(', ')}` : '',
        s.texts?.removed.length ? `gone: ${s.texts.removed.slice(0, 4).map((t) => `"${t}"`).join(', ')}` : '',
        ...(s.buttons || []).slice(0, 2),
      ].filter(Boolean).join(' · ').replace(/\|/g, '\\|');
      lines.push(`| ${s.name.replace(/\|/g, '\\|')} (${s.id}) | ${s.status} | ${s.pixelsChanged || ''} | ${s.decision} | ${what} |`);
    }
    lines.push('');
  }
  for (const n of r.next) lines.push(`- ${n}`);
  return lines.join('\n');
}
