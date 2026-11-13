import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  t.after(() => srv.close());
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
