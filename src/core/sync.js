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
      const r = await fetch(BASE + '/sync', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ baseRev: getRev(), state: { data: blob.data, prefs: blob.prefs, views: blob.views, collapsed: blob.collapsed } }),
      });
      if (r.status === 409) {
        const j = await r.json();
        if (!j.state) {
          /* the server lost its data (fresh install): re-seed it from this device */
          stampRev(0, blob);
          continue;
        }
        adopt(j.rev, j.state);
        toast('Loaded a newer version from your other device', { kind: 'info' });
        return;
      }
      if (!r.ok) throw new Error('push failed: ' + r.status);
      stampRev((await r.json()).rev, blob);
    }
  } catch {
    /* offline or server down: local state is safe in localStorage; the next save or poll retries */
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
