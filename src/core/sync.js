/* ---------- optional sync with a self-hosted server (README: Self-hosting) ---------- */
import { getRev, hydrate, setOnSave, stampRev } from './store.js';
import { render } from '../shell/render.js';
import { toast } from '../ui/toast.js';

/* Sync config: VITE_SYNC_URL ('/api' when this server serves the app), unset →
   the app stays standalone. The token comes from GET /api/config: fetched
   lazily before the first request and refreshed once on a 401, so a failed
   boot fetch or a server-side token rotation recovers on the next pull
   instead of stranding the page unauthenticated. VITE_SYNC_TOKEN remains as
   a build-time fallback. */
const BASE = import.meta.env.VITE_SYNC_URL;
let TOKEN = import.meta.env.VITE_SYNC_TOKEN || '';
let auth = TOKEN ? { authorization: 'Bearer ' + TOKEN } : {};
const syncOn = !!BASE;
let authWarned = false;
const warnAuth = () => {
  if (authWarned) return;
  authWarned = true;
  toast("Sync is off — the server rejected this device's token. Check GR8R_TOKEN.", { kind: 'err' });
};

let pending = null;
let pushing = false;
let pushT = 0;

export function queuePush(blob) {
  if (!syncOn) return;
  pending = blob;
  clearTimeout(pushT);
  pushT = setTimeout(push, 1000);
}

async function loadConfig() {
  try {
    const r = await fetch(BASE + '/config');
    if (!r.ok) return false;
    const t = (await r.json()).token;
    if (!t) return false;
    TOKEN = t;
    auth = { authorization: 'Bearer ' + TOKEN };
    return true;
  } catch {
    return false;
  }
}

/* Authenticated request: pick up the token if we never got one; on a 401,
   the server may have rotated its token, so refresh it once and try again. */
async function authedFetch(path, opts = {}) {
  if (!TOKEN && !(await loadConfig())) return null;
  let r = await fetch(BASE + path, { ...opts, headers: { ...auth, ...(opts.headers || {}) } });
  if (r.status === 401 && (await loadConfig())) r = await fetch(BASE + path, { ...opts, headers: { ...auth, ...(opts.headers || {}) } });
  return r;
}

async function push() {
  if (!syncOn || pushing) return;
  pushing = true;
  try {
    while (pending) {
      const blob = pending;
      pending = null;
      let r;
      try {
        r = await authedFetch('/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ baseRev: getRev(), state: { data: blob.data, prefs: blob.prefs, views: blob.views, collapsed: blob.collapsed } }),
        });
      } catch {
        /* offline or server down: keep the blob queued; the next pull or save retries it */
        pending = pending || blob;
        return;
      }
      if (!r) {
        /* no token yet: the next pull or save re-fetches the config first */
        pending = pending || blob;
        return;
      }
      if (r.status === 409) {
        const j = await r.json();
        if (!j.state) {
          /* the server lost its data: retry this blob at revision 0 to re-seed it */
          stampRev(0, blob);
          pending = pending || blob;
          continue;
        }
        pending = null; /* last writer wins: anything queued mid-flight is stale */
        adopt(j.rev, j.state);
        toast('Loaded a newer version from your other device', { kind: 'info' });
        return;
      }
      if (!r.ok) {
        if (r.status === 401) warnAuth();
        pending = pending || blob;
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
  if (!syncOn) return;
  try {
    const r = await authedFetch('/state');
    if (!r) return;
    if (!r.ok) {
      if (r.status === 401) warnAuth();
      return;
    }
    authWarned = false;
    const j = await r.json();
    if (j.state && j.rev > getRev()) adopt(j.rev, j.state);
    if (pending) {
      clearTimeout(pushT);
      pushT = setTimeout(push, 500);
    }
  } catch {
    /* offline: the next interval retries (and re-fetches the config if needed) */
  }
}

function adopt(rev, state) {
  hydrate(state);
  stampRev(rev);
  render();
}

export function initSync() {
  if (!syncOn) return;
  setOnSave(queuePush);
  pull();
  setInterval(pull, 30000);
  addEventListener('online', pull);
  addEventListener('storage', pull);
}
