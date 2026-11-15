/* ---------- optional sync with a self-hosted server (README: Self-hosting) ---------- */
import { diffWorkspacePatch, isWorkspacePatchEmpty } from './domain.js';
import { S, adoptSyncedState, clearSyncedBase, getPendingSave, getRev, getSyncedBase, rebasePendingSave, setOnSave, stampRev } from './store.js';
import { openModal } from '../overlays/modals.js';
import { render } from '../shell/render.js';
import { toast } from '../ui/toast.js';

/* Sync config: VITE_SYNC_URL ('/api' when this server serves the app), unset →
   the app stays standalone. On private loopback / Tailscale Serve routes,
   GET /api/config bootstraps GR8R_TOKEN automatically; on non-Tailscale routes
   it returns { authRequired: true } and prompts once for GR8R_TOKEN, verified
   against POST /api/auth. VITE_SYNC_TOKEN remains as a build-time fallback. */
const TOKEN_KEY = 'gr8r.token';
const BASE = import.meta.env.VITE_SYNC_URL;

function readSavedToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}
function writeSavedToken(tok) {
  try {
    if (tok) localStorage.setItem(TOKEN_KEY, tok);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing or storage blocked */
  }
}

let TOKEN = import.meta.env.VITE_SYNC_TOKEN || readSavedToken() || '';
let auth = TOKEN ? { authorization: 'Bearer ' + TOKEN } : {};
const syncOn = !!BASE;
let authWarned = false;
let promptShown = false;
let awaitingManualToken = false;

export function isSyncEnabled() {
  return syncOn;
}

export async function uploadBlobToServer(file) {
  if (!syncOn) return null;
  const r = await fetch(BASE + '/blobs', {
    method: 'POST',
    headers: {
      ...auth,
      'content-type': file.type || 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name || 'attachment.bin'),
    },
    body: file,
  });
  if (r.status === 401) {
    warnAuth();
    throw new Error('Unauthorized upload');
  }
  if (!r.ok) {
    let msg = `Upload failed (HTTP ${r.status})`;
    try {
      const j = await r.json();
      if (j?.error) msg = j.error;
    } catch {
      /* non-json error */
    }
    throw new Error(msg);
  }
  return r.json();
}

const isTokenModalOpen = () => S.ui.modals.some(m => m.id === 'sync-auth');

function setToken(tok) {
  TOKEN = tok || '';
  auth = TOKEN ? { authorization: 'Bearer ' + TOKEN } : {};
  if (TOKEN) awaitingManualToken = false;
}

function notifySignInNeeded(msg = 'Sync is paused until you sign in.') {
  if (isTokenModalOpen()) return;
  toast(msg, { kind: 'info', action: 'Sign in', onAction: openTokenModal, ms: 10000 });
}

const warnAuth = () => {
  if (authWarned || isTokenModalOpen()) return;
  authWarned = true;
  toast("Sync is off — the server rejected this device's token.", {
    kind: 'err',
    action: 'Sign in',
    onAction: openTokenModal,
  });
};

async function submitToken(raw) {
  const candidate = String(raw || '').trim();
  if (!candidate) {
    toast('Enter your workspace access token.', { kind: 'err', action: 'Sign in', onAction: openTokenModal });
    return;
  }
  try {
    const r = await fetch(BASE + '/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: candidate }),
    });
    if (!r.ok) {
      toast('Access token rejected by server.', { kind: 'err', action: 'Try again', onAction: openTokenModal });
      return;
    }
    writeSavedToken(candidate);
    setToken(candidate);
    authWarned = false;
    promptShown = false;
    toast('Connected to workspace sync');
    pull();
    connectEvents();
  } catch {
    toast('Could not reach server to verify token.', { kind: 'err', action: 'Try again', onAction: openTokenModal });
  }
}

function openTokenModal() {
  if (isTokenModalOpen()) return;
  openModal({
    id: 'sync-auth',
    type: 'prompt',
    title: 'Sign in to workspace sync',
    sub: 'This route requires your GR8R_TOKEN access token.',
    label: 'Access token',
    inputType: 'password',
    autocomplete: 'current-password',
    ok: 'Connect',
    run: submitToken,
    onCancel: () => {
      if (!TOKEN) notifySignInNeeded();
    },
  });
}

function requestTokenIfNeeded({ fromUserSave = false } = {}) {
  if (isTokenModalOpen()) return;
  if (!promptShown && S.ui.modals.length === 0) {
    promptShown = true;
    openTokenModal();
    return;
  }
  if (!promptShown || fromUserSave) {
    promptShown = true;
    notifySignInNeeded('Sign in with GR8R_TOKEN to sync your changes.');
  }
}

let pushing = false;
let pushT = 0;
let eventAbort = null;
let eventRetryT = 0;
let retryDelay = 1000;

function queuePush() {
  if (!syncOn) return;
  clearTimeout(pushT);
  pushT = setTimeout(push, 300);
}

async function loadConfig({ fromUserSave = false } = {}) {
  if (!TOKEN) {
    const saved = readSavedToken();
    if (saved) setToken(saved);
  }
  const sentToken = TOKEN;
  try {
    const r = await fetch(BASE + '/config', { headers: auth });
    if (!r.ok) return false;
    const j = await r.json();
    if (j.authRequired && !j.token) {
      if (TOKEN !== sentToken) return !!TOKEN;
      if (sentToken && readSavedToken() === sentToken) writeSavedToken('');
      setToken('');
      awaitingManualToken = true;
      requestTokenIfNeeded({ fromUserSave });
      return false;
    }
    const t = j.token;
    if (!t) return false;
    setToken(t);
    promptShown = false;
    return true;
  } catch {
    return false;
  }
}

/* Authenticated request: pick up the token if we never got one; on a 401,
   the server may have rotated its token, so refresh it once and try again. */
async function authedFetch(path, opts = {}, { fromUserSave = false } = {}) {
  if (!TOKEN && !(await loadConfig({ fromUserSave }))) return null;
  let r = await fetch(BASE + path, { ...opts, headers: { ...auth, ...(opts.headers || {}) } });
  if (r.status === 401 && (await loadConfig({ fromUserSave }))) r = await fetch(BASE + path, { ...opts, headers: { ...auth, ...(opts.headers || {}) } });
  return r;
}

async function push() {
  if (!syncOn || pushing) return;
  pushing = true;
  try {
    while (getPendingSave()) {
      const blob = getPendingSave();
      const base = getSyncedBase();
      if (getRev() > 0 && base) {
        const patch = diffWorkspacePatch(base, blob);
        if (isWorkspacePatchEmpty(patch)) {
          stampRev(getRev(), blob);
          continue;
        }
        let r;
        try {
          r = await authedFetch(
            '/workspace',
            {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ baseRev: getRev(), patch }),
            },
            { fromUserSave: true },
          );
        } catch {
          return;
        }
        if (!r) return;
        if (r.status === 409) {
          const j = await r.json();
          if (!j.state) {
            /* the server lost its data: fall back to full /sync at rev 0 to re-seed it */
            clearSyncedBase();
            continue;
          }
          if (j.error && j.error !== 'uninitialized') toast(j.error);
          adopt(j.rev, j.state);
          return;
        }
        if (!r.ok) {
          if (r.status === 401) warnAuth();
          return;
        }
        authWarned = false;
        const j = await r.json();
        if (j.merged && j.state) {
          if (getPendingSave() === blob) {
            adopt(j.rev, j.state);
          } else {
            rebasePendingSave(j.rev, j.state, blob);
            render();
          }
        } else {
          stampRev(j.rev, blob);
        }
        continue;
      }

      let r;
      try {
        r = await authedFetch(
          '/sync',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ baseRev: getRev(), state: { data: blob.data, prefs: blob.prefs, views: blob.views, collapsed: blob.collapsed } }),
          },
          { fromUserSave: true },
        );
      } catch {
        /* The store retains the pending snapshot, including across reloads. */
        return;
      }
      if (!r) {
        /* no token yet: the next pull or save re-fetches the config first */
        return;
      }
      if (r.status === 409) {
        const j = await r.json();
        if (!j.state) {
          /* the server lost its data: retry this blob at revision 0 to re-seed it */
          clearSyncedBase();
          continue;
        }
        adopt(j.rev, j.state);
        toast('Loaded a newer version from your other device', { kind: 'info' });
        return;
      }
      if (!r.ok) {
        if (r.status === 401) warnAuth();
        return;
      }
      authWarned = false;
      stampRev((await r.json()).rev, blob);
    }
  } finally {
    pushing = false;
  }
}

async function pull() {
  if (!syncOn || pushing) return;
  if (getPendingSave()) return push();
  try {
    const r = await authedFetch('/state');
    if (!r) return;
    if (!r.ok) {
      if (r.status === 401) warnAuth();
      return;
    }
    authWarned = false;
    const j = await r.json();
    if (getPendingSave() || pushing) return;
    if (j.state && j.rev > getRev()) adopt(j.rev, j.state);
  } catch {
    /* offline: the next interval retries (and re-fetches the config if needed) */
  }
}

function adopt(rev, state) {
  adoptSyncedState(rev, state);
  render();
}

async function connectEvents() {
  if (!syncOn || eventAbort) return;
  clearTimeout(eventRetryT);
  const ctrl = new AbortController();
  eventAbort = ctrl;
  try {
    const r = await authedFetch('/events', {
      headers: { accept: 'text/event-stream' },
      signal: ctrl.signal,
    });
    if (!r || !r.ok || !r.body) {
      if (r?.status === 401) warnAuth();
      return;
    }
    authWarned = false;
    retryDelay = 1000;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r/g, '');
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dataLine = block.split('\n').find(l => l.startsWith('data:'));
        if (!dataLine) continue;
        try {
          const j = JSON.parse(dataLine.slice(5).trim());
          if (typeof j.rev === 'number' && j.rev > getRev()) pull();
        } catch {
          /* ignore malformed event payload */
        }
      }
    }
  } catch {
    /* stream closed or offline: reconnect with bounded backoff */
  } finally {
    if (eventAbort === ctrl) {
      eventAbort = null;
      if (!awaitingManualToken) {
        const wait = retryDelay;
        retryDelay = Math.min(5000, retryDelay * 2);
        eventRetryT = setTimeout(connectEvents, wait);
      }
    }
  }
}

export function initSync() {
  if (!syncOn) return;
  setOnSave(queuePush);
  pull();
  connectEvents();
  setInterval(pull, 30000);
  addEventListener('online', () => {
    pull();
    connectEvents();
  });
  addEventListener('storage', e => {
    if (e.key === TOKEN_KEY) {
      setToken(e.newValue || '');
      if (TOKEN) {
        authWarned = false;
        promptShown = false;
        connectEvents();
      }
    }
    pull();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      pull();
      connectEvents();
    }
  });
}
