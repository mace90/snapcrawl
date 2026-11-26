import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate, aiReady } from './ai.js';
import { crawl } from './crawler.js';
import { buildReport } from './diff.js';
import { IosSimulator, hasBinary, listSimulators } from './drivers/ios-sim.js';
import { REPORT_TYPES, renderReport, reportFileName, setDecision } from './report.js';

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');
const MIME = { '.png': 'image/png', '.json': 'application/json', '.html': 'text/html; charset=utf-8' };

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });

export function startServer({ store, cfg, port = 4747, version, driverFactory = (o) => new IosSimulator(o) }) {
  const clients = new Set();
  const live = { running: false, runId: null, ask: null, log: [], abort: false };

  const broadcast = (type, data) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };

  const io = {
    log(level, msg) {
      const line = { t: Date.now(), level, msg };
      live.log.push(line);
      if (live.log.length > 2000) live.log.shift();
      broadcast('log', line);
    },
    event(type, data) {
      if (type === 'run') live.runId = data.id;
      broadcast(type, data);
    },
    ask(kind, prompt) {
      return new Promise((resolve) => {
        live.ask = { kind, prompt, resolve };
      });
    },
    aborted: () => live.abort,
  };

  async function devices() {
    const tools = { xcrun: await hasBinary('xcrun'), idb: await hasBinary('idb') };
    let sims = [];
    let error = null;
    if (tools.xcrun) {
      try {
        sims = await listSimulators();
      } catch (e) {
        error = e.message;
      }
    } else error = 'xcrun not found: Snapcrawl needs macOS with Xcode for the iOS Simulator.';
    return { tools, sims, error };
  }

  const routes = {
    'GET /api/state': () => ({
      version,
      runs: store.listRuns(),
      baselines: store.readBaselines(),
      pair: store.defaultPair(),
      live: { running: live.running, runId: live.runId, ask: live.ask && { kind: live.ask.kind, prompt: live.ask.prompt } },
      config: {
        bundleId: cfg.app.bundleId,
        username: cfg.auth.username,
        hasPassword: !!cfg.auth.password,
        mfa: cfg.auth.mfa,
        hasTotp: !!cfg.auth.totpSecret,
        fallbackManual: cfg.auth.fallbackManual,
        crawl: { maxDepth: cfg.crawl.maxDepth, maxScreens: cfg.crawl.maxScreens, timeLimitMin: cfg.crawl.timeLimitMin, blocklist: cfg.crawl.blocklist },
        ai: { provider: cfg.ai.provider, model: cfg.ai.model, ready: aiReady(cfg.ai) },
        file: cfg._file,
      },
    }),
    'GET /api/devices': devices,
    'GET /api/apps': async (q) => {
      const d = new IosSimulator({ udid: q.get('udid') || 'booted' });
      await d.resolve();
      return { apps: await d.listApps() };
    },
    'GET /api/run': (q) => store.readRun(q.get('id')),
    'GET /api/log': () => ({ log: live.log }),
    'GET /api/report': (q) => {
      const base = q.get('base');
      const head = q.get('head');
      if (!base || !head) throw Object.assign(new Error('base and head are required'), { status: 400 });
      return (q.get('fresh') ? null : store.readReport(base, head)) || buildReport({ store, baseId: base, headId: head, cfg });
    },
    'POST /api/review': (q, body) => {
      const report = store.readReport(body.base, body.head);
      if (!report) throw Object.assign(new Error('report not found'), { status: 404 });
      setDecision(report, [].concat(body.screen), body.decision);
      store.writeReport(report);
      return { review: report.review };
    },
    'POST /api/baseline': (q, body) => {
      store.setBaseline(body.run);
      return { baselines: store.readBaselines() };
    },
    'POST /api/notes': async (q, body) => {
      const report = store.readReport(body.base, body.head);
      if (!report) throw Object.assign(new Error('report not found'), { status: 404 });
      return annotate({ store, report, cfg, onProgress: (n, total) => broadcast('notes', { n, total }) });
    },
    'POST /api/crawl': (q, body) => {
      if (live.running) throw Object.assign(new Error('A crawl is already running'), { status: 409 });
      const run = structuredClone(cfg);
      run.app.bundleId = body.bundleId || run.app.bundleId;
      if (!run.app.bundleId) throw Object.assign(new Error('Pick an app (bundle id) first'), { status: 400 });
      Object.assign(run.auth, Object.fromEntries(Object.entries(body.auth || {}).filter(([, v]) => v !== '' && v !== undefined)));
      Object.assign(run.crawl, Object.fromEntries(Object.entries(body.crawl || {}).filter(([, v]) => v !== '' && v !== undefined)));
      const driver = driverFactory({ udid: body.udid || run.device.udid, bundleId: run.app.bundleId });
      Object.assign(live, { running: true, runId: null, ask: null, log: [], abort: false });
      crawl({ driver, cfg: run, store, io, label: body.label || '' })
        .then((atlas) => {
          if (atlas.meta.status === 'done' && !store.baselineFor(atlas.meta.app)) {
            store.setBaseline(atlas.meta.id);
            io.log('INFO', `first run of ${atlas.meta.appName || atlas.meta.app} · saved as baseline`);
          }
        })
        .catch((e) => io.log('ERROR', e.message))
        .finally(() => {
          live.running = false;
          live.ask = null;
          broadcast('state', { running: false });
        });
      return { started: true, baseline: store.baselineFor(run.app.bundleId) };
    },
    'POST /api/answer': (q, body) => {
      if (!live.ask) return { ok: false };
      const { resolve } = live.ask;
      live.ask = null;
      resolve(body.value ?? '');
      broadcast('answered', {});
      return { ok: true };
    },
    'POST /api/stop': () => {
      live.abort = true;
      return { ok: true };
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, fs.readFileSync(UI), MIME['.html']);
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (url.pathname.startsWith('/files/')) {
        const rel = decodeURIComponent(url.pathname.slice(7));
        const file = path.resolve(store.root, rel);
        if (!file.startsWith(store.root + path.sep) || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
        return fs.createReadStream(file).pipe(res);
      }
      if (req.method === 'GET' && url.pathname === '/api/export') {
        const q = url.searchParams;
        const base = q.get('base');
        const head = q.get('head');
        const type = q.get('type') || 'summary';
        if (!base || !head) return send(res, 400, { error: 'base and head are required' });
        if (!REPORT_TYPES.includes(type)) return send(res, 400, { error: 'type must be summary or full' });
        const report = store.readReport(base, head) || buildReport({ store, baseId: base, headId: head, cfg });
        const html = renderReport({ store, report, type, version });
        res.writeHead(200, { 'content-type': MIME['.html'], 'content-disposition': `attachment; filename="${reportFileName(report, type)}"`, 'cache-control': 'no-store' });
        return res.end(html);
      }
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) return send(res, 404, { error: 'not found' });
      const body = req.method === 'POST' ? await readBody(req) : null;
      send(res, 200, await handler(url.searchParams, body));
    } catch (e) {
      send(res, e.status || 500, { error: e.message });
    }
  });

  // Take the next free port if the requested one is busy (e.g. another snapcrawl ui).
  return new Promise((resolve, reject) => {
    let p = port;
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && p < port + 20) server.listen(++p, '127.0.0.1');
      else reject(e);
    });
    server.on('listening', () => resolve({ server, port: p }));
    server.listen(p, '127.0.0.1');
  });
}
