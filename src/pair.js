import { crawl } from './crawler.js';
import { buildReport } from './diff.js';
import { makeDriver } from './drivers/index.js';

// Two builds of an app installed side by side under different bundle ids (com.firma.app and
// com.firma.app.beta): the first is crawled and becomes the baseline, then the second is
// crawled against it (it follows the baseline, crawl.against) and the two are compared.
// The CLI (crawl --then) and the web UI (Setup → App · then crawl) both call this.
//
// parallel: driverFor(head) is on a second simulator and both are crawled at the same time.
// About half the time, but the test build cannot follow a baseline that is still being made:
// its screens are matched afterwards like in any comparison (by path, structure, similarity).
export async function crawlPair({ driverFor, cfg, store, io, base, head, label = '', parallel = false }) {
  if (!base || !head) throw new Error('two apps are needed · the baseline app (--bundle) and the test app (--then)');
  if (base === head) throw new Error('--then needs another bundle id than --bundle · to compare one app with itself, crawl it twice');
  if (cfg.crawl.reinstall) throw new Error('--reinstall installs one build · with two apps use --intro fresh, each app is reset before its run');
  const named = (part) => [label, part].filter(Boolean).join(' ');
  if (parallel) return crawlBoth({ driverFor, cfg, store, io, base, head, named });

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

// Both builds at once, each on its own simulator. Their log lines are marked 1 and 2.
async function crawlBoth({ driverFor, cfg, store, io, base, head, named }) {
  const one = structuredClone(cfg);
  one.app.bundleId = base;
  one.crawl.against = '';
  const two = structuredClone(cfg);
  two.app.bundleId = head;
  two.crawl.against = '';
  two.crawl.follow = false; // the baseline is still being crawled
  const tagged = (n, events) => ({ ...io, log: (lvl, msg) => io.log(lvl, `${n} │ ${msg}`), event: events ? io.event : undefined });
  io.log('INFO', `both at once · 1 ${base} (baseline) · 2 ${head} (test, on a second simulator, without following the baseline)`);
  const [a, b] = await Promise.all([
    crawl({ driver: driverFor(base), cfg: one, store, io: tagged(1, true), label: named('baseline') }),
    crawl({ driver: driverFor(head), cfg: two, store, io: tagged(2, false), label: named('test') }),
  ]);
  if (a.meta.status !== 'done' || io.aborted?.()) return { base: a, head: b, report: null };
  store.setBaseline(a.meta.id);
  io.log('INFO', `baseline of ${a.meta.appName || base} is now ${a.meta.id}`);
  if (b.meta.status !== 'done') return { base: a, head: b, report: null };
  Object.assign(b.meta, { against: base, baseline: a.meta.id, parallel: true });
  store.writeRun(b.meta.id, b);
  const report = buildReport({ store, baseId: a.meta.id, headId: b.meta.id, cfg });
  const s = report.summary;
  io.log('DONE', `compared ${a.meta.id} → ${b.meta.id} · ${s.same} same · ${s.changed} changed · ${s.new} new · ${s.bad} broken`);
  return { base: a, head: b, report };
}

// The second simulator for a parallel pair: booted if needed, never the first one, the test app
// installed on it. Returns its driver.
export async function secondSimulator(first, udid, bundleId) {
  if (first.platform !== 'ios-sim') throw new Error('parallel crawls need simulators · on an iPhone the two builds run one after the other');
  if (!udid) throw new Error('which second simulator? · e.g. "iPhone 17 Pro" (snappcrawl devices lists them)');
  await first.resolve();
  const second = await makeDriver({ platform: 'ios-sim', udid, bundleId }).resolve();
  if (second.udid === first.udid) throw new Error(`${second.name} is already the first simulator · pick another one for the test build`);
  const apps = await second.listApps().catch(() => []);
  if (apps.length && !apps.some((a) => a.bundleId === bundleId)) throw new Error(`${bundleId} is not installed on ${second.name} · xcrun simctl install ${second.udid} <App.app>`);
  return second;
}
