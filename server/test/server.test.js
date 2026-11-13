import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
