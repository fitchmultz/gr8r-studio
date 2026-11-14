import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../../cli/gr8r.js';
import { startServer } from '../server.js';

async function startConnectProxy() {
  let connects = 0;
  const proxy = http.createServer((_req, res) => {
    res.writeHead(405).end();
  });
  proxy.on('connect', (req, clientSocket, head) => {
    connects += 1;
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
    get connects() {
      return connects;
    },
    close: () => new Promise(resolve => proxy.close(resolve)),
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
  const proxy = await startConnectProxy();

  t.after(async () => {
    await proxy.close();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const env = {
    HOME: dir,
    GR8R_CONFIG: path.join(dir, 'config.json'),
  };

  let r = await invoke(['config', 'set', '--url', baseUrl, '--proxy', proxy.url], { env });
  assert.equal(r.code, 0);

  r = await invoke(['config', 'show', '--json'], { env });
  assert.equal(r.code, 0);
  const cfgInfo = JSON.parse(r.stdout);
  assert.equal(cfgInfo.reachable, true);
  assert.equal(cfgInfo.proxy, proxy.url);
  assert.ok(proxy.connects >= 2);

  r = await invoke(['project', 'create', 'Pi Durable', '--key', 'PID', '--status', 'active', '--json'], { env });
  const createdProj = JSON.parse(r.stdout);
  assert.equal(createdProj.project.key, 'PID');

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

  r = await invoke(['activity', '-p', 'PID', '--limit', '5', '--json'], { env });
  assert.ok(JSON.parse(r.stdout).activity.length >= 4);
});
