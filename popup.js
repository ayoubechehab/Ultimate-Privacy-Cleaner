// ===== Constants =====
const DATA_TYPES = ['cookies', 'cache', 'localStorage', 'sessionStorage', 'indexedDB', 'history'];
const TABS = ['cleaner', 'domains', 'panic'];

const DEFAULT_SETTINGS = {
  globalInterval: 60,
  domains: []
};
TABS.forEach(t => DATA_TYPES.forEach(d => { DEFAULT_SETTINGS[`${t}_${d}`] = true; }));

// ===== Tab navigation =====
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => {
      v.classList.remove('active');
      v.classList.add('hidden');
    });
    btn.classList.add('active');
    const target = document.getElementById(btn.dataset.target);
    target.classList.add('active');
    target.classList.remove('hidden');
  });
});

// ===== Load / save =====
async function loadSettings() {
  const s = await chrome.storage.sync.get({ ...DEFAULT_SETTINGS, cleanerActive: false });

  document.getElementById('globalInterval').value = s.globalInterval;

  document.querySelectorAll('input[type="checkbox"][data-tab]').forEach(cb => {
    const key = `${cb.dataset.tab}_${cb.dataset.type}`;
    cb.checked = s[key] !== false; // default true if undefined
    cb.addEventListener('change', saveSettings);
  });

  document.getElementById('globalInterval').addEventListener('change', saveSettings);

  renderDomains(s.domains);
  reflectCleanerState(s.cleanerActive, s.globalInterval);
}

// Toggle the visibility of the "Turn off" button + the status text based
// on whether auto-cleaning is currently active.
function reflectCleanerState(active, minutes) {
  const stopBtn = document.getElementById('btn-turn-off');
  const status = document.getElementById('cleaner-status');
  if (active) {
    stopBtn.classList.remove('hidden');
    status.textContent = `✅ Auto every ${minutes || 60} min`;
  } else {
    stopBtn.classList.add('hidden');
    status.textContent = '🛡️ Auto-cleaning ready';
  }
}

async function saveSettings() {
  const out = {
    globalInterval: parseInt(document.getElementById('globalInterval').value) || 60
  };
  document.querySelectorAll('input[type="checkbox"][data-tab]').forEach(cb => {
    out[`${cb.dataset.tab}_${cb.dataset.type}`] = cb.checked;
  });
  await chrome.storage.sync.set(out);
}

// ===== Domain list =====
function renderDomains(domains) {
  const list = document.getElementById('domain-list');
  list.innerHTML = '';
  if (!domains || !domains.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No domains added yet.';
    list.appendChild(empty);
    return;
  }
  domains.forEach(d => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = d;
    const btn = document.createElement('button');
    btn.className = 'remove-domain';
    btn.textContent = '✕';
    btn.title = 'Remove';
    btn.addEventListener('click', async () => {
      const s = await chrome.storage.sync.get({ domains: [] });
      const next = (s.domains || []).filter(x => x !== d);
      await chrome.storage.sync.set({ domains: next });
      renderDomains(next);
    });
    li.appendChild(span);
    li.appendChild(btn);
    list.appendChild(li);
  });
}

// ===== Helper: send message and await structured response =====
function send(action, extras = {}) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ action, ...extras }, r => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(r || { ok: false, error: 'no response' });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: String(e.message || e) });
    }
  });
}

// ===== Cleaner: CLEAN & AUTO =====
// Runs an immediate full-time clean AND sets up the recurring alarm.
// (Replaces the old confirm() dialog, which is unreliable in MV3 popups.)
document.getElementById('btn-save-interval').addEventListener('click', async () => {
  const val = Math.max(1, parseInt(document.getElementById('globalInterval').value) || 60);
  document.getElementById('globalInterval').value = val;
  await saveSettings();

  const status = document.getElementById('cleaner-status');
  status.textContent = '🧹 Cleaning…';

  await send('setupAlarms');
  const r = await send('cleanNow');

  if (r.ok) {
    reflectCleanerState(true, val);
    // Briefly flash a "cleaned" confirmation, then settle into the steady state.
    status.textContent = `✅ Cleaned. Auto every ${val} min`;
    setTimeout(() => reflectCleanerState(true, val), 2500);
  } else {
    status.textContent = `⚠️ ${r.error || 'clean failed'}`;
  }
});

// ===== Cleaner: TURN OFF AUTO =====
document.getElementById('btn-turn-off').addEventListener('click', async () => {
  const r = await send('turnOffCleaner');
  if (r.ok) {
    reflectCleanerState(false);
    document.getElementById('cleaner-status').textContent = '🛑 Auto-cleaning OFF';
    setTimeout(() => reflectCleanerState(false), 2500);
  }
});

// ===== Domains: add =====
document.getElementById('btn-add-domain').addEventListener('click', addDomain);
document.getElementById('new-domain').addEventListener('keypress', e => {
  if (e.key === 'Enter') addDomain();
});

async function addDomain() {
  const input = document.getElementById('new-domain');
  const val = input.value.trim();
  if (!val) return;

  const s = await chrome.storage.sync.get({ domains: [] });
  const list = s.domains || [];
  if (list.includes(val)) {
    input.value = '';
    return;
  }

  list.push(val);
  await chrome.storage.sync.set({ domains: list });
  renderDomains(list);
  input.value = '';

  // Also auto-clean the domain right now so the user sees an immediate effect.
  await saveSettings(); // make sure checkbox state is persisted before the clean
  const status = document.getElementById('domains-status');
  if (status) status.textContent = `🧹 Cleaning ${val}…`;
  const r = await send('cleanDomain', { domain: val });
  if (status) {
    status.textContent = r.ok
      ? `✅ Added & cleaned ${val}`
      : `⚠️ Added, but clean failed: ${r.error || ''}`;
    setTimeout(() => { status.textContent = ''; }, 3000);
  }
}

// ===== Domains: clean now (manual trigger) =====
document.getElementById('btn-clean-domains').addEventListener('click', async () => {
  await saveSettings();
  const btn = document.getElementById('btn-clean-domains');
  const status = document.getElementById('domains-status');
  const orig = btn.textContent;

  btn.textContent = 'Cleaning…';
  btn.disabled = true;
  status.textContent = '';

  const r = await send('cleanDomainsNow');

  if (r.ok) {
    btn.textContent = '✓ Done';
    status.textContent = r.count
      ? `✅ Cleaned ${r.count} domain${r.count === 1 ? '' : 's'}`
      : 'No domains in list';
  } else {
    btn.textContent = '⚠ Error';
    status.textContent = r.error || 'clean failed';
  }
  setTimeout(() => {
    btn.textContent = orig;
    btn.disabled = false;
    status.textContent = '';
  }, 2500);
});

// ===== Panic =====
document.getElementById('btn-panic').addEventListener('click', async () => {
  await saveSettings();
  const btn = document.getElementById('btn-panic');
  const original = btn.innerHTML;

  btn.innerHTML = '<span class="panic-icon">⏳</span><span class="panic-text">WIPING…</span>';
  const r = await send('panic');

  btn.innerHTML = r.ok
    ? '<span class="panic-icon">✓</span><span class="panic-text">WIPED!</span>'
    : '<span class="panic-icon">!</span><span class="panic-text">FAILED</span>';
  btn.classList.add('done');
  setTimeout(() => {
    btn.innerHTML = original;
    btn.classList.remove('done');
  }, 1800);
});

loadSettings();
