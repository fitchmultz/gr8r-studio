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
  assert.equal(unconfigured.apiBase, 'https://m1-mbp.tail854973.ts.net:8443/api');

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

  const beforeCancelNotifs = JSON.parse((await invoke(['inbox', '-t', 'PID-201', '--json'], { env: { ...baseEnv, GR8R_TOKEN: 'strict-secret' } })).stdout)
    .notifications.length;
  const cancelOut = await invoke(['task', 'cancel', 'PID-201', '--comment', 'Superseded by PID-202'], {
    env: { ...baseEnv, GR8R_TOKEN: 'strict-secret', PI_SESSION_NAME: 'cancel-worker' },
  });
  assert.match(cancelOut.stdout, /Updated PID-201 -> canceled/);
  const cancelInbox = JSON.parse((await invoke(['inbox', '-t', 'PID-201', '--json'], { env: { ...baseEnv, GR8R_TOKEN: 'strict-secret' } })).stdout);
  assert.equal(cancelInbox.notifications.length, beforeCancelNotifs + 1);
  assert.equal(cancelInbox.notifications[0].type, 'comment');
  assert.equal(cancelInbox.notifications[0].snippet, 'Superseded by PID-202');
  const openAfterCancel = await invoke(['tasks', '-p', 'PID', '-s', 'open', '--json'], {
    env: { ...baseEnv, GR8R_TOKEN: 'strict-secret' },
  });
  assert.equal(JSON.parse(openAfterCancel.stdout).tasks.length, 0);

  const lblCreate = await invoke(['label', 'create', 'Infra', '--color', 'indigo'], {
    env: { ...baseEnv, GR8R_TOKEN: 'strict-secret' },
  });
  assert.match(lblCreate.stdout, /Created label infra/);
  await invoke(['task', 'create', 'Parent initiative', '-p', 'PID', '-l', 'Infra'], {
    env: { ...baseEnv, GR8R_TOKEN: 'strict-secret' },
  });
  await invoke(['task', 'create', 'Child slice', '-p', 'PID', '--parent', 'PID-202'], {
    env: { ...baseEnv, GR8R_TOKEN: 'strict-secret' },
  });
  const parentView = await invoke(['task', 'view', 'PID-202'], {
    env: { ...baseEnv, GR8R_TOKEN: 'strict-secret' },
  });
  assert.match(parentView.stdout, /--- Sub-issues \(0\/1\) ---\n- \[todo\] PID-203\s+Child slice/);

  const claimNext = await invoke(['task', 'claim', '--next', '-p', 'PID', '--agent', 'pi:worker-a'], {
    env: { ...baseEnv, GR8R_TOKEN: 'strict-secret' },
  });
  assert.match(claimNext.stdout, /Claimed PID-202 \[pi:worker-a\] -> progress/);
  await assert.rejects(
    () => invoke(['task', 'claim', 'PID-202', '--agent', 'pi:worker-b'], { env: { ...baseEnv, GR8R_TOKEN: 'strict-secret' } }),
    /already claimed by pi:worker-a/,
  );
  const autoEnv = { ...baseEnv, GR8R_TOKEN: 'strict-secret', PI_SESSION_ID: 'abcdef12-3456-7890-abcd-ef1234567890' };
  await invoke(['comment', 'add', 'PID-202', 'Progress note from Pi session'], { env: autoEnv });
  const viewWithAgent = await invoke(['task', 'view', 'PID-202'], { env: autoEnv });
  assert.match(viewWithAgent.stdout, /Claimed by: pi:worker-a/);
  assert.match(viewWithAgent.stdout, /\[pi:abcdef12\]/);
  const activityOut = await invoke(['activity', '-t', 'PID-202'], { env: autoEnv });
  assert.match(activityOut.stdout, /Mitch Fultz \[pi:abcdef12\] commented on PID-202/);
  await invoke(['task', 'release', 'PID-202', '--status', 'todo'], { env: autoEnv });

  await invoke(['comment', 'add', 'PID-202', 'Need owner sign-off on schema', '--needs-owner'], { env: autoEnv });
  const inboxUnread = await invoke(['inbox', '--unread', '--type', 'blocker'], { env: autoEnv });
  assert.match(inboxUnread.stdout, /Inbox \([1-9]\d* unread\)/);
  assert.match(inboxUnread.stdout, /blocker\s+PID-202/);
  const markRead = await invoke(['inbox', 'read', '--all', '-p', 'PID'], { env: autoEnv });
  assert.match(markRead.stdout, /0 unread remaining/);

  const pngPath = path.join(dir, 'qa-proof.png');
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
  fs.writeFileSync(pngPath, pngBytes);
  const attOut = await invoke(['attach', 'PID-202', pngPath], { env: autoEnv });
  assert.match(attOut.stdout, /Attached qa-proof\.png .* to PID-202/);
  const filesJson = JSON.parse((await invoke(['files', '-t', 'PID-202', '--json'], { env: autoEnv })).stdout);
  assert.equal(filesJson.files.length, 1);
  const viewWithAttachment = await invoke(['task', 'view', 'PID-202'], { env: autoEnv });
  assert.match(viewWithAttachment.stdout, new RegExp(`Attachments \\(1\\): \\[${filesJson.files[0].id}\\] qa-proof\\.png \\([^,]+, persisted\\)`));
  const dlPath = path.join(dir, 'downloaded.png');
  await invoke(['file', 'download', filesJson.files[0].id, '-o', dlPath], { env: autoEnv });
  assert.deepEqual(fs.readFileSync(dlPath), pngBytes);

  await invoke(['doc', 'create', 'Service Runbook', '-p', 'PID', '--pinned', '--body', '-'], {
    env: autoEnv,
    stdin: '#### Verification\n\nVerified live blob upload.',
  });
  const docView = await invoke(['doc', 'view', 'service-runbook', '-p', 'PID'], { env: autoEnv });
  assert.match(docView.stdout, /# Service Runbook/);
  assert.match(docView.stdout, /Verified live blob upload\./);

  const searchOut = await invoke(['search', 'Verified live blob'], { env: autoEnv });
  assert.match(searchOut.stdout, /Docs \(1\):/);
  assert.match(searchOut.stdout, /\[service-runbook\] Service Runbook \(PID\)/);
  const searchFileOut = await invoke(['search', 'qa-proof'], { env: autoEnv });
  assert.match(searchFileOut.stdout, /Files \(1\):\n\s+qa-proof\.png \(PID\)/);

  // Deleting an attachment removes its unreferenced blob from /api/blobs.
  const delBlobId = filesJson.files[0].blobId;
  await invoke(['file', 'delete', filesJson.files[0].id, '--yes'], { env: autoEnv });
  const afterDel = await fetch(`${baseEnv.GR8R_URL}/api/blobs/${delBlobId}`, {
    headers: { authorization: 'Bearer strict-secret' },
  });
  assert.equal(afterDel.status, 404);

  // Failed gr8r attach to a nonexistent task validates target before uploading any blob bytes.
  const blobsDir = path.join(dir, 'blobs');
  const beforeOrphanCount = fs.existsSync(blobsDir) ? fs.readdirSync(blobsDir).length : 0;
  await assert.rejects(() => invoke(['attach', 'PID-999', pngPath], { env: autoEnv }), /Task not found: PID-999/);
  const afterOrphanCount = fs.existsSync(blobsDir) ? fs.readdirSync(blobsDir).length : 0;
  assert.equal(afterOrphanCount, beforeOrphanCount);
});

test('gr8r CLI resolves Pi session identity, supports task create deps, validates per-command flags, and formats inbox/blocks output', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr8r-cli-polish-'));
  const srv = await startServer({ dataFile: path.join(dir, 'state.json'), distDir: dir, token: 'polish-secret' });
  t.after(async () => {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const env = {
    HOME: dir,
    GR8R_CONFIG: path.join(dir, 'config.json'),
    GR8R_URL: `http://127.0.0.1:${srv.port}`,
    GR8R_TOKEN: 'polish-secret',
  };

  // Session identity precedence: --agent / GR8R_AGENT > PI_SESSION_NAME > PI_SESSION_FILE > PI_SESSION_ID (UUID shortened).
  const sessionFile = path.join(dir, 'session.jsonl');
  fs.writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: 'session_info', name: 'old-session-name' }),
      '{not valid json',
      JSON.stringify({ type: 'message', text: 'hello' }),
      JSON.stringify({ type: 'session_info', name: 'latest-dogfood-session' }),
      JSON.stringify({ type: 'session_info', name: '   ' }),
    ].join('\n') + '\n',
  );
  assert.equal(new Gr8rClient({ agent: 'custom-cli', env: { ...env, GR8R_AGENT: 'env-agent', PI_SESSION_NAME: 'named' } }).agent, 'custom-cli');
  assert.equal(new Gr8rClient({ env: { ...env, GR8R_AGENT: 'env-agent', PI_SESSION_NAME: 'named' } }).agent, 'env-agent');
  assert.equal(new Gr8rClient({ env: { ...env, PI_SESSION_NAME: 'named', PI_SESSION_FILE: sessionFile } }).agent, 'pi:named');
  assert.equal(
    new Gr8rClient({ env: { ...env, PI_SESSION_FILE: sessionFile, PI_SESSION_ID: '12345678-aaaa-bbbb-cccc-1234567890ab' } }).agent,
    'pi:latest-dogfood-session',
  );
  assert.equal(
    new Gr8rClient({ env: { ...env, PI_SESSION_FILE: path.join(dir, 'missing.jsonl'), PI_SESSION_ID: '12345678-aaaa-bbbb-cccc-1234567890ab' } }).agent,
    'pi:12345678',
  );
  assert.equal(new Gr8rClient({ env: { ...env, PI_SESSION_ID: 'custom-non-uuid' } }).agent, 'pi:custom-non-uuid');

  // Reject unsupported flags per command/subcommand while allowing global flags and aliases.
  await assert.rejects(
    () => invoke(['task', 'create', 'Bad flag', '-p', 'GS', '--add-milestone', 'M1@2026-12-01'], { env }),
    /Flag --add-milestone is not supported for "task create"/,
  );
  await assert.rejects(
    () => invoke(['project', 'delete', 'GS', '--yes', '--status', 'active'], { env }),
    /Flag --status is not supported for "project delete"/,
  );
  await assert.rejects(() => invoke(['task', 'done', 'GS-201', '--status', 'review'], { env }), /Flag --status is not supported for "task done"/);

  await invoke(['project', 'create', 'Dogfood', '--key', 'DOG'], { env });
  await invoke(['task', 'create', 'Base task', '-p', 'DOG'], { env });
  await invoke(['task', 'create', 'Second dep', '-p', 'DOG'], { env });

  // task create accepts --dep, --add-dep, and --deps and populates reverse blocksKeys in task view.
  const depTaskRes = JSON.parse(
    (await invoke(['task', 'create', 'Dependent slice', '-p', 'DOG', '--dep', 'DOG-201', '--add-dep', 'DOG-202', '--json'], { env })).stdout,
  );
  assert.deepEqual(depTaskRes.task.depKeys, ['DOG-201', 'DOG-202']);
  const baseView = await invoke(['task', 'view', 'DOG-201', '--agent', 'pi:viewer'], { env });
  assert.match(baseView.stdout, /Blocks: DOG-203/);

  // Inbox table clips overly long summaries while preserving full text in --json, and omits " — " when snippet is empty.
  const longComment = 'Detailed verification log: ' + 'x'.repeat(140);
  await invoke(['task', 'done', 'DOG-201'], { env: { ...env, PI_SESSION_FILE: sessionFile } });
  await invoke(['comment', 'add', 'DOG-202', longComment], { env: { ...env, PI_SESSION_FILE: sessionFile } });

  const inboxTable = await invoke(['inbox', '-p', 'DOG'], { env });
  assert.match(inboxTable.stdout, /pi:latest-dogfood-session/);
  const doneLine = inboxTable.stdout.split('\n').find(l => l.includes('DOG-201'));
  assert.ok(doneLine);
  assert.doesNotMatch(doneLine, /\s—\s*$/);
  const commentLine = inboxTable.stdout.split('\n').find(l => l.includes('DOG-202'));
  assert.ok(commentLine);
  assert.match(commentLine, /…$/);
  assert.doesNotMatch(commentLine, new RegExp('x'.repeat(130)));

  const inboxJson = JSON.parse((await invoke(['inbox', '-p', 'DOG', '--json'], { env })).stdout);
  assert.equal(inboxJson.notifications.find(n => n.taskKey === 'DOG-202').snippet, longComment);
});
