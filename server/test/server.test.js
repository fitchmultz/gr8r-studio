import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';

const state = marker => ({ data: { tasks: [{ id: 't1', title: marker }] }, prefs: {}, views: {}, collapsed: false });

async function withServer(t, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gr8r-test-'));
  const srv = await startServer({ token: 'secret', dataFile: path.join(tmp, 'state.json'), distDir: tmp, ...opts });
  t.after(async () => {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return { ...srv, tmp, base: `http://127.0.0.1:${srv.port}` };
}
const auth = { authorization: 'Bearer secret' };

test('rejects requests without a valid token', async t => {
  const { base } = await withServer(t);
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await fetch(base + '/api/state', { headers: { authorization: 'Bearer wrong' } })).status, 401);
});

test('serves the runtime token to unauthenticated clients', async t => {
  const { base } = await withServer(t);
  const r = await fetch(base + '/api/config');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await r.json()).token, 'secret');
});

test('a fresh server starts empty', async t => {
  const { base } = await withServer(t);
  const j = await (await fetch(base + '/api/state', { headers: auth })).json();
  assert.deepEqual(j, { rev: 0, state: null });
});

test('accepts a push at the current revision and returns the next one', async t => {
  const { base } = await withServer(t);
  const push = await fetch(base + '/api/sync', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ baseRev: 0, state: state('first') }),
  });
  assert.equal(push.status, 200);
  assert.equal((await push.json()).rev, 1);
  const j = await (await fetch(base + '/api/state', { headers: auth })).json();
  assert.equal(j.rev, 1);
  assert.equal(j.state.data.tasks[0].title, 'first');
});

test('a failed disk write keeps the last saved state and revision', async t => {
  const { base, tmp, dataFile } = await withServer(t);
  const send = (baseRev, title) =>
    fetch(base + '/api/sync', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ baseRev, state: state(title) }),
    });
  assert.equal((await send(0, 'saved')).status, 200);
  fs.chmodSync(tmp, 0o500);
  try {
    assert.equal((await send(1, 'not saved')).status, 500);
    const current = await (await fetch(base + '/api/state', { headers: auth })).json();
    assert.deepEqual(current, { rev: 1, state: state('saved') });
    assert.deepEqual(JSON.parse(fs.readFileSync(dataFile, 'utf8')), current);
  } finally {
    fs.chmodSync(tmp, 0o700);
  }
  assert.equal((await send(1, 'retried')).status, 200);
  assert.equal((await (await fetch(base + '/api/state', { headers: auth })).json()).rev, 2);
});

test('an unreadable workspace prevents startup instead of starting empty', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gr8r-unreadable-'));
  const dataFile = path.join(tmp, 'state.json');
  const first = await startServer({ token: 'secret', dataFile, distDir: tmp });
  let second;
  try {
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${first.port}/api/sync`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ baseRev: 0, state: state('kept') }),
        })
      ).status,
      200,
    );
    await first.close();
    fs.chmodSync(dataFile, 0o000);
    await assert.rejects(
      async () => {
        second = await startServer({ token: 'secret', dataFile, distDir: tmp });
      },
      { code: 'EACCES' },
    );
  } finally {
    fs.chmodSync(dataFile, 0o600);
    if (first.server.listening) await first.close();
    await second?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('rejects a stale push with the current state', async t => {
  const { base } = await withServer(t);
  const send = body => fetch(base + '/api/sync', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await send({ baseRev: 0, state: state('first') });
  const stale = await send({ baseRev: 0, state: state('stale') });
  assert.equal(stale.status, 409);
  const j = await stale.json();
  assert.equal(j.rev, 1);
  assert.equal(j.state.data.tasks[0].title, 'first');
  const ok = await send({ baseRev: 1, state: state('second') });
  assert.equal((await ok.json()).rev, 2);
});

test('rejects a malformed state', async t => {
  const { base } = await withServer(t);
  const bad = await fetch(base + '/api/sync', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ baseRev: 0, state: { data: {} } }),
  });
  assert.equal(bad.status, 400);
});

test('keeps state across a restart', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gr8r-restart-'));
  const dataFile = path.join(tmp, 'state.json');
  const first = await startServer({ token: 'secret', dataFile, distDir: tmp });
  await fetch(`http://127.0.0.1:${first.port}/api/sync`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ baseRev: 0, state: state('kept') }),
  });
  await first.close();
  const second = await startServer({ token: 'secret', dataFile, distDir: tmp });
  t.after(() => second.close());
  const j = await (await fetch(`http://127.0.0.1:${second.port}/api/state`, { headers: auth })).json();
  assert.equal(j.rev, 1);
  assert.equal(j.state.data.tasks[0].title, 'kept');
});

test('serves the built app with a hash-routing fallback', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gr8r-static-'));
  fs.mkdirSync(path.join(tmp, 'assets'));
  fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><title>gr8r</title>');
  fs.writeFileSync(path.join(tmp, 'assets', 'app.js'), 'console.log(1)');
  const { base } = await withServer(t, { distDir: tmp });
  const index = await fetch(base + '/');
  assert.match(await index.text(), /gr8r/);
  const asset = await fetch(base + '/assets/app.js');
  assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const fallback = await fetch(base + '/anything/else');
  assert.match(await fallback.text(), /gr8r/);
});

test('a malformed request path gets 400 and the server keeps serving', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gr8r-badpath-'));
  fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><title>gr8r</title>');
  const { base } = await withServer(t, { distDir: tmp });
  assert.equal((await fetch(base + '/%')).status, 400);
  const raw = await new Promise((resolve, reject) => {
    const sock = net.connect(+new URL(base).port, '127.0.0.1', () => sock.write('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let data = '';
    sock.on('data', c => (data += c));
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
  assert.match(raw, /^HTTP\/1\.1 400/);
  assert.match(await (await fetch(base + '/')).text(), /gr8r/);
});

test('the CLI requires a token and honors GR8R_DATA, DIST and PORT', async t => {
  const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');
  const noToken = spawn(process.execPath, [serverPath], { env: { ...process.env, GR8R_TOKEN: '' } });
  assert.equal(await new Promise(done => noToken.on('exit', done)), 1);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gr8r-cli-'));
  fs.mkdirSync(path.join(tmp, 'dist'));
  fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<!doctype html><title>cli</title>');
  const dataFile = path.join(tmp, 'data', 'state.json');
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, GR8R_TOKEN: 'secret', PORT: '4191', HOST: '127.0.0.1', GR8R_DATA: dataFile, DIST: path.join(tmp, 'dist') },
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
    child.stdout.on('data', d => {
      if (/gr8r-server:/.test(String(d))) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', d => {
      clearTimeout(timer);
      reject(new Error(String(d)));
    });
  });
  assert.match(await (await fetch('http://127.0.0.1:4191/')).text(), /cli/);
  const push = await fetch('http://127.0.0.1:4191/api/sync', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ baseRev: 0, state: state('cli') }),
  });
  assert.equal(push.status, 200);
  assert.ok(fs.existsSync(dataFile), 'state written at GR8R_DATA');
});

test('domain API applies atomic project, task, subtask, comment, search, and activity operations', async t => {
  const { base } = await withServer(t);
  const call = async (method, p, body) => {
    const r = await fetch(base + p, {
      method,
      headers: { ...auth, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
  };

  const ws0 = await call('GET', '/api/workspace');
  assert.equal(ws0.status, 200);
  assert.equal(ws0.json.rev, 0);
  assert.equal(ws0.json.initialized, false);
  // Reading /api/workspace does not mutate an uninitialized server.
  assert.deepEqual(await (await fetch(base + '/api/state', { headers: auth })).json(), { rev: 0, state: null });

  const createdProj = await call('POST', '/api/projects', { name: 'Pi Durable', key: 'PID', status: 'active' });
  assert.equal(createdProj.status, 201);
  assert.equal(createdProj.json.rev, 1);
  assert.equal(createdProj.json.project.key, 'PID');

  const batch = await call('POST', '/api/tasks', {
    project: 'PID',
    tasks: [
      { title: 'Slice 1', priority: 'high', assignee: 'me', labels: ['backend'], desc: '#### Goal\n\nShip **UsageDoc**.' },
      { title: 'Slice 2', priority: 'medium', deps: ['PID-201'] },
    ],
  });
  assert.equal(batch.status, 201);
  assert.equal(batch.json.rev, 2);
  assert.deepEqual(
    batch.json.tasks.map(x => x.key),
    ['PID-201', 'PID-202'],
  );
  assert.deepEqual(batch.json.tasks[1].depKeys, ['PID-201']);

  // Optional ifRev guard rejects stale mutations without touching state.
  const stale = await call('PATCH', '/api/tasks/PID-201', { ifRev: 1, status: 'done' });
  assert.equal(stale.status, 409);

  // Subtasks, comments, and task patches advance revision atomically.
  const sub = await call('POST', '/api/tasks/PID-201/subtasks', { title: 'Add projection', note: 'Include child runs' });
  assert.equal(sub.status, 201);
  const sid = sub.json.subtask.id;

  const doneSub = await call('PATCH', `/api/tasks/PID-201/subtasks/${sid}`, { done: true });
  assert.equal(doneSub.status, 200);
  assert.equal(doneSub.json.task.subtaskDoneCount, 1);

  const cmt = await call('POST', '/api/tasks/PID-201/comments', { text: 'PR #42 merged and verified live' });
  assert.equal(cmt.status, 201);

  const detail = await call('GET', '/api/tasks/pid-201');
  assert.equal(detail.status, 200);
  assert.equal(detail.json.task.descMarkdown, '#### Goal\n\nShip **UsageDoc**.');
  assert.equal(detail.json.comments.length, 1);
  assert.ok(detail.json.activity.length >= 3);

  const promoted = await call('POST', `/api/tasks/PID-201/subtasks/${sid}/promote`, {});
  assert.equal(promoted.status, 201);
  assert.equal(promoted.json.task.key, 'PID-203');
  assert.equal(promoted.json.parentTask.subtaskCount, 0);

  const search = await call('GET', '/api/search?q=UsageDoc');
  assert.equal(search.status, 200);
  assert.deepEqual(
    search.json.tasks.map(x => x.key),
    ['PID-201'],
  );

  const act = await call('GET', '/api/activity?project=PID&limit=5');
  assert.equal(act.status, 200);
  assert.equal(act.json.activity.length, 5);

  assert.equal((await call('DELETE', `/api/tasks/PID-201/comments/${cmt.json.comment.id}`)).status, 200);
  assert.equal((await call('DELETE', '/api/tasks/PID-201')).status, 200);
  // Deleting PID-201 cascades out of PID-202 deps.
  const t202 = await call('GET', '/api/tasks/PID-202');
  assert.deepEqual(t202.json.task.deps, []);
});

test('a failed disk write on a domain API mutation leaves in-memory state unchanged', async t => {
  const { base, tmp } = await withServer(t);
  const post = (p, body) =>
    fetch(base + p, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await post('/api/projects', { name: 'Pi Durable', key: 'PID' })).status, 201);
  fs.chmodSync(tmp, 0o500);
  try {
    assert.equal((await post('/api/tasks', { project: 'PID', title: 'Should roll back' })).status, 500);
    const list = await (await fetch(base + '/api/tasks?project=PID', { headers: auth })).json();
    assert.equal(list.rev, 1);
    assert.equal(list.tasks.length, 0);
  } finally {
    fs.chmodSync(tmp, 0o700);
  }
});

test('streams revision events over GET /api/events for both domain mutations and /api/sync', async t => {
  const { base } = await withServer(t);
  assert.equal((await fetch(base + '/api/events')).status, 401);

  const ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const streamRes = await fetch(base + '/api/events', { headers: auth, signal: ctrl.signal });
  assert.equal(streamRes.status, 200);
  assert.match(streamRes.headers.get('content-type'), /^text\/event-stream/);

  const reader = streamRes.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const nextRev = async () => {
    for (;;) {
      const idx = buf.indexOf('\n\n');
      if (idx !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split('\n').find(l => l.startsWith('data:'));
        if (dataLine) return JSON.parse(dataLine.slice(5).trim()).rev;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE stream ended unexpectedly');
      buf += dec.decode(value, { stream: true }).replace(/\r/g, '');
    }
  };

  assert.equal(await nextRev(), 0);

  await fetch(base + '/api/projects', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Live SSE', key: 'SSE' }),
  });
  assert.equal(await nextRev(), 1);

  await fetch(base + '/api/tasks', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'SSE', title: 'Instant tab update' }),
  });
  assert.equal(await nextRev(), 2);
});

test('archived project detail and project-scoped task queries keep summary counts and task list aligned', async t => {
  const { base } = await withServer(t);
  await fetch(base + '/api/projects', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Legacy Migration', key: 'LEG' }),
  });
  await fetch(base + '/api/tasks', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'LEG', tasks: [{ title: 'Step 1' }, { title: 'Step 2' }] }),
  });
  await fetch(base + '/api/projects/LEG', {
    method: 'PATCH',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ archived: true }),
  });

  const detail = await (await fetch(base + '/api/projects/LEG', { headers: auth })).json();
  assert.equal(detail.project.archived, true);
  assert.equal(detail.project.taskCount, 2);
  assert.equal(detail.tasks.length, 2);

  const scoped = await (await fetch(base + '/api/tasks?project=LEG', { headers: auth })).json();
  assert.equal(scoped.tasks.length, 2);

  const globalDefault = await (await fetch(base + '/api/tasks', { headers: auth })).json();
  assert.equal(
    globalDefault.tasks.some(t => t.projectKey === 'LEG'),
    false,
  );

  const globalAll = await (await fetch(base + '/api/tasks?archived=ALL', { headers: auth })).json();
  assert.equal(globalAll.tasks.filter(t => t.projectKey === 'LEG').length, 2);
});

function rawGet(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('gates /api/config token bootstrap to loopback and private Tailscale routes, and verifies tokens via /api/auth', async t => {
  const { port, base } = await withServer(t);

  // Private Tailscale Serve route (Tailscale-User-Login + tailnet CGNAT IP) receives bootstrap token.
  const tsServe = await rawGet(port, '/api/config', {
    host: 'alienarchy.tail854973.ts.net:8443',
    'tailscale-user-login': 'mitchfultz@gmail.com',
    'x-forwarded-for': '100.101.102.103',
    'x-forwarded-host': 'alienarchy.tail854973.ts.net:8443',
  });
  assert.deepEqual(tsServe.json, { token: 'secret', authRequired: false });

  // Tailscale IPv6 ULA route also receives bootstrap token.
  const tsV6 = await rawGet(port, '/api/config', {
    host: 'alienarchy.tail854973.ts.net:8443',
    'tailscale-user-login': 'mitchfultz@gmail.com',
    'x-forwarded-for': 'fd7a:115c:a1e0::1234',
  });
  assert.deepEqual(tsV6.json, { token: 'secret', authRequired: false });

  // Public exposure vectors withhold the token unless authenticated.
  for (const headers of [
    // Proxied .ts.net without Tailscale-User-Login (e.g. Funnel or unauthenticated proxy) is rejected.
    { host: 'alienarchy.tail854973.ts.net:8443', 'x-forwarded-for': '100.101.102.103' },
    { host: 'alienarchy.tail854973.ts.net', 'tailscale-funnel-request': '?1', 'x-forwarded-for': '203.0.113.9' },
    // Spoofed Tailscale-User-Login through a public reverse proxy (public X-Forwarded-For) is rejected.
    { host: 'gr8r.example.com', 'tailscale-user-login': 'spoof@example.com', 'x-forwarded-for': '203.0.113.9' },
    // Cloudflare WARP CGNAT (100.96.x.x) + spoofed Tailscale-User-Login through Cloudflare Tunnel is rejected.
    {
      host: 'gr8r.example.com',
      'cf-connecting-ip': '100.96.1.2',
      'x-forwarded-for': '100.96.1.2',
      'tailscale-user-login': 'attacker@example.com',
    },
    // CGNAT client through a non-.ts.net reverse proxy + spoofed Tailscale-User-Login is rejected.
    { host: 'gr8r.example.com', 'x-forwarded-for': '100.96.1.2', 'tailscale-user-login': 'attacker@example.com' },
    { host: 'gr8r.example.com', 'cf-connecting-ip': '203.0.113.9' },
    { host: '127.0.0.1:' + port, 'x-forwarded-for': '203.0.113.9' },
    { host: '127.0.0.1:' + port, 'x-real-ip': '198.51.100.4' },
    { host: 'gr8r.example.com' },
    { host: '127.0.0.1:' + port, 'x-forwarded-host': 'gr8r.example.com' },
    { host: '127.0.0.1:' + port, forwarded: 'for=203.0.113.9;proto=https' },
    { host: '127.0.0.1:' + port, forwarded: 'proto=https;host=gr8r.example.com' },
  ]) {
    const denied = await rawGet(port, '/api/config', headers);
    assert.equal(denied.status, 200);
    assert.deepEqual(denied.json, { token: null, authRequired: true });

    const authed = await rawGet(port, '/api/config', { ...headers, authorization: 'Bearer secret' });
    assert.deepEqual(authed.json, { token: 'secret', authRequired: false });
  }

  // POST /api/auth verifies explicit tokens without exposing the secret.
  assert.equal(
    (await fetch(base + '/api/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }) })).status,
    401,
  );
  const okAuth = await fetch(base + '/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'secret' }),
  });
  assert.equal(okAuth.status, 200);
  assert.deepEqual(await okAuth.json(), { ok: true });

  // Explicit trustBootstrap: 'none' disables unauthenticated bootstrap even on loopback.
  const strict = await withServer(t, { trustBootstrap: 'none' });
  const strictCfg = await (await fetch(strict.base + '/api/config')).json();
  assert.deepEqual(strictCfg, { token: null, authRequired: true });
});

test('PATCH /api/workspace merges concurrent browser deltas with domain API writes and returns 409 when uninitialized', async t => {
  const { createDefaultState, createProject, createTask, diffWorkspacePatch } = await import('../../src/core/domain.js');
  const { base } = await withServer(t);

  // Uninitialized server rejects PATCH /api/workspace with 409 so client falls back to full /api/sync seed.
  const uninit = await fetch(base + '/api/workspace', {
    method: 'PATCH',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ baseRev: 5, patch: { collapsed: true } }),
  });
  assert.equal(uninit.status, 409);
  assert.deepEqual(await uninit.json(), { error: 'uninitialized', rev: 0, state: null });

  // Seed initial state at rev 0 -> rev 1.
  const initial = createDefaultState(1700000000000);
  createProject(initial.data, { name: 'Pi Durable', key: 'PID', status: 'active' });
  const t1 = createTask(initial.data, { project: 'PID', title: 'Initial slice', status: 'todo' });
  const seedRes = await fetch(base + '/api/sync', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ baseRev: 0, state: initial }),
  });
  assert.equal(seedRes.status, 200);

  // Fast-path PATCH at current baseRev=1 returns merged: false without echoing full state.
  const browser1 = structuredClone(initial);
  browser1.collapsed = true;
  const fastRes = await (
    await fetch(base + '/api/workspace', {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ baseRev: 1, patch: diffWorkspacePatch(initial, browser1) }),
    })
  ).json();
  assert.deepEqual(fastRes, { rev: 2, merged: false });

  // Agent creates PID-202 via POST /api/tasks (advancing rev 2 -> 3) while browser at baseRev=2 marks PID-201 done & creates colliding PID-202.
  await fetch(base + '/api/tasks', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'PID', title: 'Agent concurrent task' }),
  });

  const browser2 = structuredClone(browser1);
  browser2.data.tasks.find(x => x.id === t1.id).status = 'done';
  createTask(browser2.data, { project: 'PID', title: 'Browser concurrent task' });

  const mergeRes = await (
    await fetch(base + '/api/workspace', {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ baseRev: 2, patch: diffWorkspacePatch(browser1, browser2) }),
    })
  ).json();
  assert.equal(mergeRes.rev, 4);
  assert.equal(mergeRes.merged, true);
  const pidTasks = mergeRes.state.data.tasks.filter(x => x.key.startsWith('PID-'));
  assert.equal(pidTasks.find(x => x.key === 'PID-201').status, 'done');
  assert.equal(pidTasks.find(x => x.key === 'PID-202').title, 'Agent concurrent task');
  assert.equal(pidTasks.find(x => x.key === 'PID-203').title, 'Browser concurrent task');

  // Browser deleting a commented task via PATCH /api/workspace succeeds cleanly with 200 (cascade already removed comment).
  const { addComment, deleteTasks } = await import('../../src/core/domain.js');
  const state4 = mergeRes.state;
  const browserWithComment = structuredClone(state4);
  addComment(browserWithComment.data, t1.id, 'Note before delete');
  await fetch(base + '/api/workspace', {
    method: 'PATCH',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ baseRev: 4, patch: diffWorkspacePatch(state4, browserWithComment) }),
  });
  const browserDeleted = structuredClone(browserWithComment);
  deleteTasks(browserDeleted.data, [t1.id]);
  const delHttp = await fetch(base + '/api/workspace', {
    method: 'PATCH',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ baseRev: 5, patch: diffWorkspacePatch(browserWithComment, browserDeleted) }),
  });
  assert.equal(delHttp.status, 200);
  assert.deepEqual(await delHttp.json(), { rev: 6, merged: false });
});

test('POST /api/github/pull-requests and HMAC POST /api/webhooks/github link PRs idempotently', async t => {
  const { createHmac } = await import('node:crypto');
  const unconfigured = await withServer(t);
  const res503 = await fetch(unconfigured.base + '/api/webhooks/github', { method: 'POST', body: '{}' });
  assert.equal(res503.status, 503);

  const secret = 'whsec_test_secret';
  const { base } = await withServer(t, { webhookSecret: secret });

  await fetch(base + '/api/projects', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Pi Durable', key: 'PID' }),
  });
  await fetch(base + '/api/tasks', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'PID', title: 'PR Autofix Loop', status: 'progress' }),
  });

  // Invalid HMAC signature is rejected with 401.
  const badSig = await fetch(base + '/api/webhooks/github', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
    body: '{}',
  });
  assert.equal(badSig.status, 401);

  // Valid signed webhook with Unicode payload links PID-201 and moves progress -> review.
  const whBody = JSON.stringify({
    action: 'opened',
    repository: { full_name: 'fitchmultz/pi-durable' },
    pull_request: {
      number: 447,
      title: 'feat(personal): closed-loop PR autofix 🚀 (PID-201)',
      body: 'Closes PID-201',
      html_url: 'https://github.com/fitchmultz/pi-durable/pull/447',
      state: 'open',
      merged: false,
      draft: false,
      updated_at: '2026-11-15T02:00:00Z',
      head: { ref: 'feat/pr-autofix-loop' },
    },
  });
  const sig = 'sha256=' + createHmac('sha256', secret).update(Buffer.from(whBody, 'utf8')).digest('hex');
  const okWh = await fetch(base + '/api/webhooks/github', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': sig },
    body: whBody,
  });
  assert.equal(okWh.status, 200);
  const whJson = await okWh.json();
  assert.equal(whJson.changed, true);
  assert.equal(whJson.updated[0].status, 'review');
  const revAfterOpen = whJson.rev;

  // Re-sending identical PR via POST /api/github/pull-requests is idempotent and does not bump rev.
  const repeatRes = await (
    await fetch(base + '/api/github/pull-requests', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        pullRequests: [
          {
            repo: 'fitchmultz/pi-durable',
            number: 447,
            title: 'feat(personal): closed-loop PR autofix 🚀 (PID-201)',
            body: 'Closes PID-201',
            url: 'https://github.com/fitchmultz/pi-durable/pull/447',
            headRef: 'feat/pr-autofix-loop',
            state: 'open',
            draft: false,
            updatedAt: '2026-11-15T02:00:00Z',
          },
        ],
      }),
    })
  ).json();
  assert.equal(repeatRes.changed, false);
  assert.equal(repeatRes.rev, revAfterOpen);
});

test('/api/blobs enforces auth, cookie-backed <img> reads, CSP sandbox, and attachment disposition for unsafe types', async t => {
  const { base } = await withServer(t, { trustBootstrap: 'none' });

  // Unauthenticated upload and read are rejected when trustBootstrap=none.
  assert.equal((await fetch(base + '/api/blobs', { method: 'POST', body: Buffer.from('abc') })).status, 401);
  assert.equal((await fetch(base + '/api/blobs/' + 'a'.repeat(64))).status, 401);

  // Upload PNG and SVG with Bearer token.
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const upPng = await fetch(base + '/api/blobs', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'image/png', 'x-file-name': 'shot.png' },
    body: pngBytes,
  });
  assert.equal(upPng.status, 201);
  const pngMeta = await upPng.json();

  const upSvg = await fetch(base + '/api/blobs', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'image/svg+xml', 'x-file-name': 'evil.svg' },
    body: Buffer.from('<svg onload="alert(1)"/>'),
  });
  assert.equal(upSvg.status, 201);
  const svgMeta = await upSvg.json();

  // Sign in via POST /api/auth to receive HttpOnly gr8r_blob cookie for browser <img> tags.
  const authRes = await fetch(base + '/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'secret' }),
  });
  const setCookie = authRes.headers.get('set-cookie') || '';
  const cookiePair = setCookie.split(';')[0];
  assert.match(cookiePair, /^gr8r_blob=[0-9a-f]{64}$/);

  // PNG serves inline with sandbox CSP via cookie alone (no Authorization header).
  const getPng = await fetch(base + pngMeta.url, { headers: { cookie: cookiePair } });
  assert.equal(getPng.status, 200);
  assert.match(getPng.headers.get('content-disposition') || '', /^inline; filename="shot\.png"$/);
  assert.match(getPng.headers.get('content-security-policy') || '', /sandbox/);
  assert.deepEqual(Buffer.from(await getPng.arrayBuffer()), pngBytes);

  // SVG is forced to Content-Disposition: attachment to prevent active content execution.
  const getSvg = await fetch(base + svgMeta.url, { headers: { cookie: cookiePair } });
  assert.equal(getSvg.status, 200);
  assert.match(getSvg.headers.get('content-disposition') || '', /^attachment; filename="evil\.svg"$/);

  // Non-ASCII filenames serve 200 with RFC 5987 filename* without throwing ERR_INVALID_CHAR.
  const upUni = await fetch(base + '/api/blobs', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'image/png', 'x-file-name': encodeURIComponent('Übersicht 🙂.png') },
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]),
  });
  assert.equal(upUni.status, 201);
  const uniMeta = await upUni.json();
  const getUni = await fetch(base + `/api/blobs/${uniMeta.blobId}`, { headers: { cookie: cookiePair } });
  assert.equal(getUni.status, 200);
  assert.match(getUni.headers.get('content-disposition') || '', /filename\*=UTF-8''%C3%9Cbersicht%20%F0%9F%99%82\.png/);

  // Identical bytes uploaded under two different names/MIMEs preserve both sidecar fallback and per-attachment URLs.
  const sharedBytes = Buffer.from('%PDF-1.4 shared payload');
  const upFirst = await (
    await fetch(base + '/api/blobs', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/pdf', 'x-file-name': 'spec.pdf' },
      body: sharedBytes,
    })
  ).json();
  const upSecond = await (
    await fetch(base + '/api/blobs', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'text/plain', 'x-file-name': 'notes.txt' },
      body: sharedBytes,
    })
  ).json();
  assert.equal(upFirst.blobId, upSecond.blobId);
  const bareFirst = await fetch(base + `/api/blobs/${upFirst.blobId}`, { headers: auth });
  assert.equal(bareFirst.headers.get('content-type'), 'application/pdf');
  assert.match(bareFirst.headers.get('content-disposition') || '', /filename="spec\.pdf"/);
  const secondByUrl = await fetch(base + upSecond.url, { headers: auth });
  assert.equal(secondByUrl.headers.get('content-type'), 'text/plain');
  assert.match(secondByUrl.headers.get('content-disposition') || '', /filename="notes\.txt"/);

  // Malformed percent-encoding returns 400 cleanly without throwing URIError.
  assert.equal((await fetch(base + '/api/blobs/%E0%A4%A', { headers: auth })).status, 400);

  // Oversized >50 MB uploads return a clean 413 JSON error instead of ECONNRESET.
  const tooBig = await fetch(base + '/api/blobs', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/octet-stream', 'x-file-name': 'oversized.bin' },
    body: Buffer.alloc(50 * 1024 * 1024 + 4096, 0x61),
  });
  assert.equal(tooBig.status, 413);
  assert.deepEqual(await tooBig.json(), { error: 'Blob exceeds 50 MB limit' });
});
