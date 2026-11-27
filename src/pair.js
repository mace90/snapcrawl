import { crawl } from './crawler.js';
import { buildReport } from './diff.js';

// Two builds of an app installed side by side under different bundle ids (com.firma.app and
// com.firma.app.beta): the first is crawled and becomes the baseline, then the second is
// crawled against it (it follows the baseline, crawl.against) and the two are compared.
// The CLI (crawl --then) and the web UI (Setup → App · then crawl) both call this.
export async function crawlPair({ driverFor, cfg, store, io, base, head, label = '' }) {
  if (!base || !head) throw new Error('two apps are needed · the baseline app (--bundle) and the test app (--then)');
  if (base === head) throw new Error('--then needs another bundle id than --bundle · to compare one app with itself, crawl it twice');
  if (cfg.crawl.reinstall) throw new Error('--reinstall installs one build · with two apps use --intro fresh, each app is reset before its run');
  const named = (part) => [label, part].filter(Boolean).join(' ');

  const one = structuredClone(cfg);
  one.app.bundleId = base;
  one.crawl.against = '';
  io.log('INFO', `1/2 baseline · ${base}`);
  const a = await crawl({ driver: driverFor(base), cfg: one, store, io, label: named('baseline') });
  if (a.meta.status !== 'done' || io.aborted?.()) return { base: a, head: null, report: null };
  store.setBaseline(a.meta.id);
  io.log('INFO', `baseline of ${a.meta.appName || base} is now ${a.meta.id}`);

  const two = structuredClone(cfg);
  two.app.bundleId = head;
  two.crawl.against = base;
  io.log('INFO', `2/2 test · ${head} against the baseline of ${a.meta.appName || base}`);
  const b = await crawl({ driver: driverFor(head), cfg: two, store, io, label: named('test') });
  if (b.meta.status !== 'done') return { base: a, head: b, report: null };

  const report = buildReport({ store, baseId: a.meta.id, headId: b.meta.id, cfg });
  const s = report.summary;
  io.log('DONE', `compared ${a.meta.id} → ${b.meta.id} · ${s.same} same · ${s.changed} changed · ${s.new} new · ${s.bad} broken`);
  return { base: a, head: b, report };
}
