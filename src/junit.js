// The result of a check as JUnit XML, which every CI shows as tests: one test case per screen.
// broken and rejected screens fail, changes waiting for review fail as "review", the rest pass.
const x = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

export function junitXml(r, report) {
  const open = new Map(r.screens.map((s) => [s.id, s]));
  const cases = report.screens.map((s) => {
    const o = open.get(s.id);
    const name = `${s.name} (${s.id})`;
    const path = ['start', ...(s.path || [])].join(' → ');
    if (!o || o.decision === 'approved' || o.decision === 'passed') return `    <testcase classname="${x(r.app)}" name="${x(name)}"><system-out>${x(path)}</system-out></testcase>`;
    const what = [o.reason, o.pixelsChanged && `${o.pixelsChanged} of the pixels`, o.texts?.added.length && `new text: ${o.texts.added.join(', ')}`, o.texts?.removed.length && `gone: ${o.texts.removed.join(', ')}`, ...(o.buttons || [])].filter(Boolean).join('\n');
    const type = o.decision === 'rejected' ? 'rejected' : o.status === 'broken' && !o.known ? 'broken' : 'review';
    return `    <testcase classname="${x(r.app)}" name="${x(name)}"><failure type="${type}" message="${x(`${o.status}${o.reason ? ` · ${o.reason}` : ''}`)}">${x(`${path}\n${what}\n${o.images?.diff || o.images?.head || o.images?.base || ''}`)}</failure></testcase>`;
  });
  const failures = cases.filter((c) => c.includes('<failure')).length;
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="snappcrawl" tests="${cases.length}" failures="${failures}">
  <testsuite name="${x(`snappcrawl ${r.app} ${r.base.label || r.base.run} → ${r.head.label || r.head.run}`)}" tests="${cases.length}" failures="${failures}">
${cases.join('\n')}
  </testsuite>
</testsuites>
`;
}
