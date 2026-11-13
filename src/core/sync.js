/* ---------- optional sync with a self-hosted server (README: Self-hosting) ---------- */
import { getRev, hydrate, setOnSave, stampRev } from './store.js';
import { render } from '../shell/render.js';
import { toast } from '../ui/toast.js';

/* Build-time config: VITE_SYNC_URL ('/api' when this server serves the app) and
   VITE_SYNC_TOKEN. Unset → the app stays standalone. */
const BASE = import.meta.env.VITE_SYNC_URL;
const TOKEN = import.meta.env.VITE_SYNC_TOKEN || '';
const auth = TOKEN ? { authorization: 'Bearer ' + TOKEN } : {};
const syncOn = !!BASE;

let pending = null;
let pushing = false;
let pushT = 0;

export function queuePush(blob) {
  if (!syncOn) return;
  pending = blob;
  clearTimeout(pushT);
  pushT = setTimeout(push, 1000);
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
        r = await fetch(BASE + '/sync', {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ baseRev: getRev(), state: { data: blob.data, prefs: blob.prefs, views: blob.views, collapsed: blob.collapsed } }),
        });
      } catch {
        /* offline or server down: keep the blob queued; the next pull or save retries it */
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
        pending = pending || blob;
        return;
      }
      stampRev((await r.json()).rev, blob);
    }
  } finally {
    pushing = false;
  }
}

async function pull() {
  if (!syncOn) return;
  try {
    const r = await fetch(BASE + '/state', { headers: auth });
    if (!r.ok) return;
    const j = await r.json();
    if (j.state && j.rev > getRev()) adopt(j.rev, j.state);
    if (pending) {
      clearTimeout(pushT);
      pushT = setTimeout(push, 500);
    }
  } catch {
    /* offline: the next interval retries */
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
