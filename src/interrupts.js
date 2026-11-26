// What gets in the way of a crawl in real apps: onboarding sheets and hints, cookie and
// privacy banners, permission alerts, and links that leave the app.

const q = (s) => String(s ?? '').replace(/[’‘`´]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

export const DEFAULT_DISMISS = [
  'alles klar', 'ok', 'okay', 'verstanden', 'später', 'vielleicht später', 'nicht jetzt', 'jetzt nicht', 'schließen', 'überspringen', 'nein danke',
  'got it', 'not now', 'maybe later', 'later', 'close', 'skip', 'no thanks', 'dismiss',
];

// A cookie or privacy decision is the user's to make, never the crawler's.
const DECISION = /(akzeptier|accept|ablehn|reject|zustimm|\bagree|einwillig|consent|alle erlauben|allow all|deny all|verweiger)/i;
const PRIVACY = /(cookie|datenschutz|privatsphäre|privacy|consent|einwilligung|personenbezogen|personal data)/i;

export function isConsent(els) {
  const text = els.map((e) => `${e.label} ${e.value}`).join('\n');
  return PRIVACY.test(text) && DECISION.test(text);
}

// A visible button whose label is one of the dismiss words (exact match, so "OK" never matches "OK, kaufen").
export function dismissButton(els, words = DEFAULT_DISMISS) {
  const set = new Set(words.map(q));
  return els.find((e) => /^button$/i.test(e.type) && e.enabled !== false && e.w > 0 && e.h > 0 && set.has(q(e.label)) && !DECISION.test(e.label)) || null;
}

/* ---------- permission alerts ---------- */

const PERMISSION = /(don't allow|nicht erlauben|ask app not to track|nicht zu tracken|allow while using|beim verwenden der app|allow once|einmal erlauben|limit access|zugriff beschränken)/i;
const ALLOW = /^(allow|erlauben|ok|allow while using app|beim verwenden der app erlauben|allow once|einmal erlauben|allow full access|vollen zugriff erlauben|zulassen)$/i;
const DENY = /^(don't allow|nicht erlauben|ask app not to track|app bitten, nicht zu tracken|nicht zulassen|limit access|zugriff beschränken)$/i;

// Only system permission prompts are answered automatically; an app's own alerts are crawled like screens.
export const isPermissionAlert = (buttons) => buttons.some((b) => PERMISSION.test(q(b)));

export function pickButton(buttons, mode) {
  const re = mode === 'accept' ? ALLOW : DENY;
  return buttons.find((b) => re.test(q(b))) || null;
}

// Simulator: the prompt is part of the accessibility tree, so it is found by its buttons.
export function alertFromElements(els) {
  const buttons = els.filter((e) => /^button$/i.test(e.type) && (ALLOW.test(q(e.label)) || DENY.test(q(e.label)) || PERMISSION.test(q(e.label))));
  if (!buttons.some((e) => PERMISSION.test(q(e.label)))) return null;
  const box = els.find((e) => /^alert$/i.test(e.type) && e.label);
  const text = box?.label || els.find((e) => /statictext/i.test(e.type) && /(möchte|would like|track|mitteilung|notification|standort|location|kamera|camera|fotos|photos)/i.test(e.label))?.label || 'permission prompt';
  return { text, buttons: buttons.map((b) => b.label), els: buttons };
}

/* ---------- leaving the app ---------- */

// Links (in web views and web content) usually open Safari or another site.
export const isWebLink = (e) => /^link$/i.test(e.type);
