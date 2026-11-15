import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Gr8rClient, runCli } from '../../cli/gr8r.js';
import { startServer } from '../server.js';

async function startHttpProxy() {
  let hits = 0;
  const proxy = http.createServer((req, res) => {
    hits += 1;
    const u = new URL(req.url);
    const up = http.request(u, { method: req.method, headers: req.headers }, upRes => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  });
  proxy.on('connect', (req, clientSocket, head) => {
    hits += 1;
    const [host, portStr] = req.url.split(':');
    const upstream = net.connect(Number(portStr), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${proxy.address().port}`,
    get hits() {
      return hits;
    },
    close: () => {
      proxy.closeAllConnections();
      return new Promise(resolve => proxy.close(resolve));
    },
  };
}

async function invoke(args, { env, stdin = '' } = {}) {
  const out = [];
  const err = [];
  const code = await runCli(args, {
    env,
    readStdin: () => stdin,
    stdout: s => out.push(s),
    stderr: s => err.push(s),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('gr8r CLI manages config, projects, tasks, Markdown stdin, subtasks, comments, and HTTP CONNECT proxy', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr8r-cli-'));
  const distDir = path.join(dir, 'dist');
  fs.mkdirSync(distDir);
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>gr8r</title>');

  const srv = await startServer({ dataFile: path.join(dir, 'state.json'), distDir, token: 'cli-secret' });
  const baseUrl = `http://127.0.0.1:${srv.port}`;
  const proxy = await startHttpProxy();

  t.after(async () => {
    await proxy.close();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const env = {
    HOME: dir,
    GR8R_CONFIG: path.join(dir, 'config.json'),
  };

  const unconfigured = new Gr8rClient({ env });
  assert.equal(unconfigured.apiBase, 'https://alienarchy.tail854973.ts.net:8443/api');

  // Pre-connect timeout stamps ETIMEDOUT and enters the .ts.net auto-proxy check.
  const blackholeClient = new Gr8rClient({ url: 'http://100.64.0.1:8443', proxy: '', env });
  await assert.rejects(
    () => blackholeClient.sendRaw('/health', { timeoutMs: 40 }),
    err => {
      assert.ok(['ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED'].includes(err?.code));
      return true;
    },
  );

  const slowSrv = http.createServer(() => {});
  await new Promise(resolve => slowSrv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => slowSrv.close(resolve)));
  const slowClient = new Gr8rClient({ url: `http://127.0.0.1:${slowSrv.address().port}`, proxy: '', env });
  await assert.rejects(
    () => slowClient.sendRaw('/health', { timeoutMs: 40 }),
    err => err?.code === 'ERR_HTTP_REQUEST_TIMEOUT',
  );

  let r = await invoke(['config', 'set', '--url', baseUrl, '--proxy', proxy.url], { env });
  assert.equal(r.code, 0);

  r = await invoke(['config', 'show', '--json'], { env });
  assert.equal(r.code, 0);
  const cfgInfo = JSON.parse(r.stdout);
  assert.equal(cfgInfo.reachable, true);
  assert.equal(cfgInfo.proxy, proxy.url);
  assert.ok(proxy.hits >= 2);

  r = await invoke(['project', 'create', 'Pi Durable', '--key', 'PID', '--status', 'active', '--json'], { env });
  const createdProj = JSON.parse(r.stdout);
  assert.equal(createdProj.project.key, 'PID');

  r = await invoke(['project', 'update', 'PID', '--add-milestone', 'GA@2026-11-30', '--json'], { env });
  assert.deepEqual(JSON.parse(r.stdout).project.milestones, [{ name: 'GA', date: '2026-11-30' }]);

  r = await invoke(['project', 'update', 'PID', '--remove-milestone', 'GA@2026-11-30', '--json'], { env });
  assert.deepEqual(JSON.parse(r.stdout).project.milestones, []);

  const md = '#### Goal\n\nWire **UsageDoc** in `chat-projection.ts`.\n\n- Root turns\n- Child runs';
  r = await invoke(
    [
      'task',
      'create',
      'Slice 1: Usage Ledger',
      '-p',
      'PID',
      '--priority',
      'high',
      '-a',
      'me',
      '-l',
      'backend,frontend',
      '--due',
      '2026-11-16',
      '--subtask',
      'Wire projection',
      '--subtask',
      'Verify live',
      '--desc',
      '-',
      '--json',
    ],
    { env, stdin: md },
  );
  const createdTask = JSON.parse(r.stdout);
  assert.equal(createdTask.task.key, 'PID-201');
  assert.deepEqual(createdTask.task.labels, ['backend', 'frontend']);
  assert.equal(createdTask.task.subtasks.length, 2);

  r = await invoke(['task', 'view', 'PID-201'], { env });
  assert.match(r.stdout, /PID-201\s+Slice 1: Usage Ledger/);
  assert.match(r.stdout, /Wire \*\*UsageDoc\*\* in `chat-projection\.ts`\./);

  const [sub1, sub2] = createdTask.task.subtasks;
  r = await invoke(['subtask', 'done', 'PID-201', sub1.id, '--note', 'Shipped in PR #42', '--json'], { env });
  assert.equal(JSON.parse(r.stdout).subtask.done, true);

  r = await invoke(['subtask', 'promote', 'PID-201', sub2.id, '--json'], { env });
  assert.equal(JSON.parse(r.stdout).task.key, 'PID-202');

  r = await invoke(['task', 'done', 'PID-201', '--comment', 'Merged sha abc1234 and verified live', '--json'], { env });
  const donePayload = JSON.parse(r.stdout);
  assert.equal(donePayload.task.status, 'done');
  assert.equal(donePayload.comment.text, 'Merged sha abc1234 and verified live');

  r = await invoke(['search', 'UsageDoc', '--json'], { env });
  assert.equal(JSON.parse(r.stdout).tasks[0].key, 'PID-201');

  r = await invoke(['search', 'Mitch'], { env });
  assert.match(r.stdout, /People \(1\):/);

  r = await invoke(['activity', '-p', 'PID', '--limit', '5', '--json'], { env });
  assert.ok(JSON.parse(r.stdout).activity.length >= 4);

  // Closed consumer pipe before output write triggers EPIPE and exits 0 cleanly.
  const cliPath = fileURLToPath(new URL('../../cli/gr8r.js', import.meta.url));
  const child = spawn(process.execPath, [cliPath, 'tasks', '--json'], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.destroy();
  let stderrText = '';
  child.stderr.on('data', d => {
    stderrText += String(d);
  });
  const exitCode = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(exitCode, 0, stderrText);
  assert.equal(stderrText, '');
});

test('gr8r CLI guides user to GR8R_TOKEN when /api/config bootstrap is disabled, and works with explicit GR8R_TOKEN', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr8r-cli-strict-'));
  const srv = await startServer({ dataFile: path.join(dir, 'state.json'), distDir: dir, token: 'strict-secret', trustBootstrap: 'none' });
  t.after(async () => {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const baseEnv = {
    HOME: dir,
    GR8R_CONFIG: path.join(dir, 'config.json'),
    GR8R_URL: `http://127.0.0.1:${srv.port}`,
  };
  await assert.rejects(() => invoke(['status'], { env: baseEnv }), /requires an explicit token on non-Tailscale routes/);

  const allowed = await invoke(['status', '--json'], { env: { ...baseEnv, GR8R_TOKEN: 'strict-secret' } });
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(JSON.parse(allowed.stdout).rev, 0);

  await invoke(['project', 'create', 'Pi Durable', '--key', 'PID'], { env: { ...baseEnv, GR8R_TOKEN: 'strict-secret' } });
  await invoke(['task', 'create', 'Autofix slice', '-p', 'PID'], { env: { ...baseEnv, GR8R_TOKEN: 'strict-secret' } });
  const syncOut = await invoke(['pr-sync', '--repo', 'fitchmultz/pi-durable', '--pr', '447', '--title', 'feat: autofix (PID-201)', '--state', 'open'], {
    env: { ...baseEnv, GR8R_TOKEN: 'strict-secret' },
  });
  assert.match(syncOut.stdout, /Synced PID-201 -> review/);
  const detailOut = await invoke(['task', 'view', 'PID-201'], { env: { ...baseEnv, GR8R_TOKEN: 'strict-secret' } });
  assert.match(detailOut.stdout, /Pull requests:\n\s+\[open\] fitchmultz\/pi-durable#447/);

  const cancelOut = await invoke(['task', 'cancel', 'PID-201', '--comment', 'Superseded by PID-202'], {
    env: { ...baseEnv, GR8R_TOKEN: 'strict-secret' },
  });
  assert.match(cancelOut.stdout, /Updated PID-201 -> canceled/);
  const openAfterCancel = await invoke(['tasks', '-p', 'PID', '-s', 'open', '--json'], {
    env: { ...baseEnv, GR8R_TOKEN: 'strict-secret' },
  });
  assert.equal(JSON.parse(openAfterCancel.stdout).tasks.length, 0);
});
