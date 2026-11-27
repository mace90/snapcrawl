// Every action, with where to find it in the web UI, the CLI command and the server route.
// Both sides call the same functions in src/ (control.js, doctor.js, store.js, report.js, …).
// test/parity.test.js checks that each route exists and each command is in `snappcrawl help`.

export const ACTIONS = [
  { id: 'doctor', title: 'Check the setup', ui: 'Settings → System', cli: 'doctor', route: 'GET /api/doctor' },
  { id: 'devices', title: 'List simulators and iPhones', ui: 'Setup → Device · Refresh', cli: 'devices', route: 'GET /api/devices' },
  { id: 'boot', title: 'Boot a simulator', ui: 'Setup → Device · Boot', cli: 'boot <simulator>', route: 'POST /api/boot' },
  { id: 'wda-setup', title: 'Set up WebDriverAgent', ui: 'Setup → iPhone · Set up WebDriverAgent', cli: 'wda setup', route: 'POST /api/wda/setup' },
  { id: 'wda-start', title: 'Start WebDriverAgent', ui: 'Setup → iPhone · Start', cli: 'wda start', route: 'POST /api/wda/start' },
  { id: 'wda-stop', title: 'Stop WebDriverAgent', ui: 'Setup → iPhone · Stop', cli: 'wda stop', route: 'POST /api/wda/stop' },
  { id: 'wda-status', title: 'WebDriverAgent status', ui: 'Setup → iPhone · status line', cli: 'wda status', route: 'GET /api/wda/status' },
  { id: 'apps', title: 'List installed apps', ui: 'Setup → App · installed apps', cli: 'apps', route: 'GET /api/apps' },
  { id: 'crawl', title: 'Crawl with all options', ui: 'Setup → Start crawl', cli: 'crawl', route: 'POST /api/crawl' },
  { id: 'continue', title: 'Continue after Prepare, a login or a code', ui: 'Run → Continue', cli: 'crawl --prepare', route: 'POST /api/answer' },
  { id: 'stop', title: 'Stop a running crawl', ui: 'Run → Stop', cli: 'crawl', route: 'POST /api/stop' },
  { id: 'runs', title: 'List runs', ui: 'Run → runs', cli: 'runs', route: 'GET /api/runs' },
  { id: 'runs-rm', title: 'Delete a run', ui: 'Run → runs · Delete', cli: 'runs rm <run>', route: 'POST /api/runs/delete' },
  { id: 'baseline', title: 'Make a run the baseline', ui: 'Run → Make baseline · Compare → Make head the baseline', cli: 'baseline <run>', route: 'POST /api/baseline' },
  { id: 'diff', title: 'Compare two runs', ui: 'Compare', cli: 'diff', route: 'GET /api/report' },
  { id: 'review', title: 'Approve, reject, undo', ui: 'Compare → Approve / Reject / Undo', cli: 'review <id|all> <approve|reject|undo>', route: 'POST /api/review' },
  { id: 'report', title: 'Export a report (summary or full)', ui: 'Compare → Export', cli: 'report', route: 'GET /api/export' },
  { id: 'notes', title: 'Model notes for changes', ui: 'Compare → Notes', cli: 'notes', route: 'POST /api/notes' },
  { id: 'config', title: 'Settings (AI provider, model, key)', ui: 'Settings → AI', cli: 'config set <key> <value>', route: 'POST /api/config' },
];

// The CLI words to look for in `snappcrawl help`, e.g. "runs rm" or "wda setup".
export const cliWords = (a) => a.cli.split(' ').filter((w) => /^[a-z]/.test(w)).join(' ');
