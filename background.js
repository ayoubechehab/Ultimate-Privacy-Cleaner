// ===== Constants =====
const DATA_TYPES = ['cookies', 'cache', 'localStorage', 'sessionStorage', 'indexedDB', 'history'];
const TABS = ['cleaner', 'domains', 'panic'];
const DEFAULT_SETTINGS = { globalInterval: 60, domains: [] };
TABS.forEach(t => DATA_TYPES.forEach(d => { DEFAULT_SETTINGS[`${t}_${d}`] = true; }));

// ===== Smart domain extraction (handles "https;//", missing colon, www, paths) =====
function normalizeDomain(input) {
  let d = String(input || '').toLowerCase().trim();
  d = d.replace(/^(https?[:;]?\/*)?(www\.)?/, '');
  return d.split(/[\/?#]/)[0];
}

// ===== Build chrome.browsingData dataTypes object =====
//
// Chrome's browsingData API has a quirk: when RemovalOptions.origins is set,
// the `cache` data type is NOT allowed (cache isn't origin-scoped — it would
// wipe the whole disk cache anyway). Passing { origins } together with
// { cache: true } throws an error and the call clears NOTHING.
//
// Same goes for `history` — also not origin-scoped (handled separately
// via chrome.history.deleteUrl).
//
// `mode: 'origins'` => emit ONLY origin-compatible types
// `mode: 'global'`  => everything is fair game (call must use {since} or {})
function buildDataTypes(s, tab, opts = {}) {
  const c = {
    cookies: !!s[`${tab}_cookies`],
    localStorage: !!s[`${tab}_localStorage`],
    indexedDB: !!s[`${tab}_indexedDB`]
  };

  if (opts.mode === 'origins') {
    // Origin-compatible only. Map "cache" checkbox to cacheStorage (origin-scoped).
    if (s[`${tab}_cache`]) c.cacheStorage = true;
    if (c.indexedDB || c.localStorage) {
      c.fileSystems = true;
      c.webSQL = true;
      c.serviceWorkers = true;
    }
  } else {
    // Global mode: full set allowed.
    c.cache = !!s[`${tab}_cache`];
    if (c.cache) c.cacheStorage = true;
    if (c.indexedDB || c.localStorage) {
      c.fileSystems = true;
      c.webSQL = true;
      c.serviceWorkers = true;
    }
    if (opts.allowHistory && s[`${tab}_history`]) c.history = true;
  }
  return c;
}

// ===== sessionStorage clearing via injected script =====
// browsingData has no sessionStorage option; inject into matching tabs.
async function clearSessionStorage(matchFn) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.url || !/^https?:/i.test(t.url)) continue;
      let url;
      try { url = new URL(t.url); } catch { continue; }
      if (matchFn && !matchFn(url)) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: t.id },
          func: () => { try { sessionStorage.clear(); } catch (e) {} }
        });
      } catch (e) {
        // chrome:// pages, devtools, etc. — ignore quietly
      }
    }
  } catch (e) {
    console.warn('clearSessionStorage error:', e);
  }
}

// ===== Cleaner =====
// Manual trigger from the popup → clean ALL TIME (matches user expectation
// when they click "activate" and expect to see something happen).
// Alarm trigger → rolling window since last interval.
async function cleanGlobal(manual = false) {
  const s = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const types = buildDataTypes(s, 'cleaner', { mode: 'global', allowHistory: true });
  const removalOpts = manual
    ? {}
    : { since: Date.now() - 60000 * Math.max(1, parseInt(s.globalInterval) || 60) };
  try {
    await chrome.browsingData.remove(removalOpts, types);
  } catch (e) {
    console.error('cleanGlobal error:', e);
    return { ok: false, error: String(e.message || e) };
  }
  if (s.cleaner_sessionStorage) await clearSessionStorage();
  return { ok: true };
}

// ===== Domains: targeted cleanup (manual "Clean these now" trigger) =====
async function cleanDomains() {
  const s = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const list = s.domains || [];
  if (!list.length) return { ok: true, count: 0 };

  // Resolve domain → an open tabId (if any) so sessionStorage can be cleared
  // in the right context. Domains without an open tab still get the rest.
  let openTabs = [];
  try { openTabs = await chrome.tabs.query({}); } catch (e) {}
  const tabFor = (domain) => {
    const t = openTabs.find(t => {
      if (!t.url) return false;
      try {
        const h = new URL(t.url).hostname.toLowerCase();
        return h === domain || h.endsWith('.' + domain);
      } catch { return false; }
    });
    return t ? t.id : null;
  };

  let cleaned = 0;
  for (const raw of list) {
    const domain = normalizeDomain(raw);
    if (!domain) continue;
    try {
      await cleanSingleDomain(s, domain, tabFor(domain));
      cleaned++;
    } catch (e) {
      console.error(`cleanDomains[${domain}]:`, e);
    }
  }
  return { ok: true, count: cleaned };
}

// ===== Panic: wipe everything the user selected, all time =====
async function panic() {
  const s = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const types = buildDataTypes(s, 'panic', { mode: 'global', allowHistory: true });
  try {
    await chrome.browsingData.remove({}, types);
  } catch (e) {
    console.error('panic error:', e);
    return { ok: false, error: String(e.message || e) };
  }
  if (s.panic_sessionStorage) await clearSessionStorage();
  return { ok: true };
}

// ===== Alarms =====
// Domains are now cleaned on navigation (see tabs.onUpdated below), so no
// domainAlarm — only the global rolling sweep remains.
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'globalAlarm') cleanGlobal(false);
});

async function setupAlarms() {
  const s = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const minutes = Math.max(1, parseInt(s.globalInterval) || 60);
  await chrome.alarms.clearAll();
  chrome.alarms.create('globalAlarm', { periodInMinutes: minutes });
  await chrome.storage.sync.set({ cleanerActive: true });
  return { ok: true };
}

async function turnOffCleaner() {
  await chrome.alarms.clearAll();
  await chrome.storage.sync.set({ cleanerActive: false });
  return { ok: true };
}

// ===== Per-domain cleaner (used by both the manual button and the visit trigger) =====
async function cleanSingleDomain(s, domain, tabId) {
  const types = buildDataTypes(s, 'domains', { mode: 'origins' });
  const origins = [
    `https://${domain}`,
    `http://${domain}`,
    `https://www.${domain}`,
    `http://www.${domain}`
  ];

  const hasAny = Object.values(types).some(Boolean);
  if (hasAny) {
    try {
      await chrome.browsingData.remove({ origins }, types);
    } catch (e) {
      console.error(`cleanSingleDomain[${domain}]:`, e);
    }
  }

  if (s.domains_history) {
    try {
      const items = await chrome.history.search({
        text: domain, startTime: 0, maxResults: 1000
      });
      for (const item of items) {
        if (item.url && item.url.toLowerCase().includes(domain)) {
          try { await chrome.history.deleteUrl({ url: item.url }); } catch (e) {}
        }
      }
    } catch (e) {
      console.warn(`cleanSingleDomain[${domain}] history:`, e);
    }
  }

  if (s.domains_sessionStorage && tabId != null) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { try { sessionStorage.clear(); } catch (e) {} }
      });
    } catch (e) { /* chrome:// etc. */ }
  }
}

// ===== "Clean on visit" trigger =====
// Per-domain throttle so SPA URL changes (pushState) don't cause runaway
// cleans. The Map is in service-worker memory only — if the SW is killed
// and re-spawned, worst case we clean once more than strictly needed.
const lastCleanedAt = new Map();
const VISIT_THROTTLE_MS = 3000;

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;

  let url;
  try { url = new URL(changeInfo.url); } catch { return; }
  if (!/^https?:$/.test(url.protocol)) return;

  const s = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const list = s.domains || [];
  if (!list.length) return;

  const hostname = url.hostname.toLowerCase();

  // Match user's domain entry against the visited hostname (covers exact
  // match and subdomains, e.g. "google.com" matches "mail.google.com").
  const matchedRaw = list.find(raw => {
    const d = normalizeDomain(raw);
    if (!d) return false;
    return hostname === d || hostname.endsWith('.' + d);
  });
  if (!matchedRaw) return;

  const domain = normalizeDomain(matchedRaw);
  const now = Date.now();
  if (now - (lastCleanedAt.get(domain) || 0) < VISIT_THROTTLE_MS) return;
  lastCleanedAt.set(domain, now);

  await cleanSingleDomain(s, domain, tabId);
});

// ===== Message router =====
// Returning `true` keeps the channel open for async sendResponse, so the
// popup can show real success/failure feedback instead of guessing.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return false;

  let p;
  if (msg.action === 'panic') p = panic();
  else if (msg.action === 'cleanNow') p = cleanGlobal(true);
  else if (msg.action === 'cleanDomainsNow') p = cleanDomains();
  else if (msg.action === 'cleanDomain') p = cleanOneDomainAction(msg.domain);
  else if (msg.action === 'setupAlarms') p = setupAlarms();
  else if (msg.action === 'turnOffCleaner') p = turnOffCleaner();
  else return false;

  p.then(r => sendResponse(r))
   .catch(e => sendResponse({ ok: false, error: String(e.message || e) }));
  return true;
});

// One-shot per-domain clean (used right after the user adds a new domain).
async function cleanOneDomainAction(rawDomain) {
  const domain = normalizeDomain(rawDomain);
  if (!domain) return { ok: false, error: 'invalid domain' };
  const s = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  let tabId = null;
  try {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find(t => {
      if (!t.url) return false;
      try {
        const h = new URL(t.url).hostname.toLowerCase();
        return h === domain || h.endsWith('.' + domain);
      } catch { return false; }
    });
    if (t) tabId = t.id;
  } catch (e) { /* ignore */ }
  await cleanSingleDomain(s, domain, tabId);
  return { ok: true, domain };
}

// ===== Re-arm alarms after install / browser start =====
// Only re-arm if the user had auto-cleaning ENABLED before. Default off so a
// fresh install doesn't silently start deleting data.
async function maybeRearmAlarms() {
  const s = await chrome.storage.sync.get({ cleanerActive: false });
  if (s.cleanerActive) await setupAlarms();
}
chrome.runtime.onInstalled.addListener(maybeRearmAlarms);
chrome.runtime.onStartup.addListener(maybeRearmAlarms);
