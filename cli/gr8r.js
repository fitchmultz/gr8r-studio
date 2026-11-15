#!/usr/bin/env node
/* Zero-dependency CLI for Gr8r Studio's domain API. */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DEFAULT_URL = 'http://127.0.0.1:4180';
const TAILSCALE_PROXY = 'http://127.0.0.1:1055';

export function configFilePath(env = process.env) {
  if (env.GR8R_CONFIG) return env.GR8R_CONFIG;
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'gr8r', 'config.json');
}

export function readUserConfig(env = process.env) {
  const file = configFilePath(env);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}

export function writeUserConfig(next, env = process.env) {
  const file = configFilePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

export function normalizeApiBase(rawUrl) {
  const trimmed = String(rawUrl || DEFAULT_URL)
    .trim()
    .replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

function probeTcpPort(host, port, timeoutMs = 250) {
  return new Promise(resolve => {
    const sock = net.connect({ host, port });
    const done = ok => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function normalizeProxyUrl(raw) {
  const s = String(raw || '').trim();
  if (!s || s.toLowerCase() === 'direct') return '';
  if (/^https?:\/\//i.test(s)) return s;
  const m = /^(?:[a-z0-9]+:\/\/)?([^/]+)$/i.exec(s);
  return m ? `http://${m[1]}` : s;
}

function rawHttpRequest(targetUrl, { method = 'GET', headers = {}, body, proxyUrl, noProxy = '', timeoutMs = 20000 } = {}) {
  const u = new URL(targetUrl);
  const isHttps = u.protocol === 'https:';
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const reqHeaders = {
    accept: 'application/json',
    connection: 'close',
    ...(payload ? { 'content-length': payload.length } : {}),
    ...headers,
  };
  const mod = isHttps ? https : http;
  const agent = proxyUrl
    ? new mod.Agent({
        keepAlive: false,
        proxyEnv: { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: noProxy },
      })
    : false;

  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method,
        headers: reqHeaders,
        timeout: timeoutMs,
        agent,
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* non-JSON response */
          }
          resolve({ status: res.statusCode || 0, headers: res.headers, text, json });
        });
      },
    );
    req.once('timeout', () => req.destroy(new Error(`Request timed out: ${method} ${u.href}`)));
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export class Gr8rClient {
  constructor({ url, token, proxy, env = process.env } = {}) {
    const cfg = readUserConfig(env);
    this.apiBase = normalizeApiBase(url || env.GR8R_URL || cfg.url || DEFAULT_URL);
    this.token = token || env.GR8R_TOKEN || cfg.token || '';
    const explicitProxy = proxy ?? env.GR8R_PROXY ?? cfg.proxy;
    const ambientProxy = env.HTTPS_PROXY ?? env.HTTP_PROXY ?? env.ALL_PROXY ?? '';
    const rawProxy = explicitProxy !== undefined ? explicitProxy : ambientProxy;
    this.proxy = normalizeProxyUrl(rawProxy);
    this.noProxy = explicitProxy !== undefined ? (env.NO_PROXY ?? env.no_proxy ?? '') : (env.NO_PROXY ?? env.no_proxy ?? 'localhost,127.0.0.1,::1');
    this.autoProxyChecked = false;
  }

  async sendRaw(apiPath, opts = {}) {
    const fullUrl = this.apiBase + apiPath;
    try {
      return await rawHttpRequest(fullUrl, { ...opts, proxyUrl: this.proxy || undefined, noProxy: this.noProxy });
    } catch (err) {
      const host = new URL(fullUrl).hostname;
      if (!this.proxy && !this.autoProxyChecked && (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') && host.endsWith('.ts.net')) {
        this.autoProxyChecked = true;
        const p = new URL(TAILSCALE_PROXY);
        if (await probeTcpPort(p.hostname, +p.port)) {
          this.proxy = TAILSCALE_PROXY;
          this.noProxy = '';
          return rawHttpRequest(fullUrl, { ...opts, proxyUrl: this.proxy, noProxy: this.noProxy });
        }
      }
      throw err;
    }
  }

  async ensureToken(force = false) {
    if (this.token && !force) return this.token;
    const res = await this.sendRaw('/config', { method: 'GET' });
    if (res.status !== 200 || !res.json?.token) {
      throw new Error(`Failed to obtain token from ${this.apiBase}/config (HTTP ${res.status})`);
    }
    this.token = res.json.token;
    return this.token;
  }

  async request(method, apiPath, body) {
    await this.ensureToken(false);
    const makeOpts = () => ({
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let res = await this.sendRaw(apiPath, makeOpts());
    if (res.status === 401) {
      await this.ensureToken(true);
      res = await this.sendRaw(apiPath, makeOpts());
    }
    if (res.status < 200 || res.status >= 300) {
      const detail = res.json?.error || res.text?.trim() || `HTTP ${res.status}`;
      const err = new Error(detail);
      err.status = res.status;
      err.payload = res.json;
      throw err;
    }
    return res.json;
  }
}

/* ---------- input & formatting helpers ---------- */
function readStdinText() {
  return fs.readFileSync(0, 'utf8');
}

function resolveTextArg(inlineVal, fileVal, readStdin = readStdinText) {
  if (inlineVal !== undefined && fileVal !== undefined) {
    throw new Error('Pass either inline text or file flag, not both');
  }
  if (fileVal !== undefined) return fs.readFileSync(fileVal, 'utf8');
  if (inlineVal === '-') return readStdin();
  return inlineVal;
}

function splitCsvList(values) {
  if (!values) return undefined;
  const arr = Array.isArray(values) ? values : [values];
  const out = [];
  for (const item of arr) {
    for (const part of String(item).split(',')) {
      const v = part.trim();
      if (v) out.push(v);
    }
  }
  return out;
}

function nullableOpt(val) {
  if (val === undefined) return undefined;
  const s = String(val).trim();
  return !s || s.toLowerCase() === 'none' || s.toLowerCase() === 'null' || s.toLowerCase() === 'clear' ? null : s;
}

function pad(str, width) {
  const s = String(str ?? '');
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function formatTable(rows, columns) {
  if (!rows.length) return '(none)';
  const widths = columns.map(([header, getter]) => Math.min(68, Math.max(header.length, ...rows.map(r => String(getter(r) ?? '').length))));
  const head = columns.map(([h], i) => (i === columns.length - 1 ? h : pad(h, widths[i]))).join('  ');
  const lines = rows.map(r =>
    columns
      .map(([, getter], i) => {
        const raw = String(getter(r) ?? '');
        const clipped = raw.length > 68 && i < columns.length - 1 ? raw.slice(0, 67) + '…' : raw;
        return i === columns.length - 1 ? clipped : pad(clipped, widths[i]);
      })
      .join('  '),
  );
  return [head, ...lines].join('\n');
}

function formatTaskDetail(payload) {
  const { rev, task: t, comments = [] } = payload;
  const lines = [
    `${t.key}  ${t.title}`,
    `Status: ${t.status} | Priority: ${t.priority} | Project: ${t.projectKey || t.project} (${t.projectName || ''}) | Rev: ${rev}`,
    `Assignee: ${t.assigneeName || 'Unassigned'}${t.due ? ` | Due: ${t.due}` : ''}${t.start ? ` | Start: ${t.start}` : ''}${t.estimate ? ` | Est: ${t.estimate}` : ''}`,
  ];
  if (t.labels?.length) lines.push(`Labels: ${t.labels.join(', ')}`);
  if (t.depKeys?.length) lines.push(`Blocked by: ${t.depKeys.join(', ')}`);
  if (t.descMarkdown) lines.push('', '--- Description ---', t.descMarkdown);
  if (t.subtasks?.length) {
    lines.push('', `--- Subtasks (${t.subtaskDoneCount}/${t.subtaskCount}) ---`);
    for (const s of t.subtasks) {
      lines.push(`- [${s.done ? 'x' : ' '}] ${s.id}  ${s.title}${s.due ? ` (due ${s.due})` : ''}`);
      if (s.note) lines.push(`    note: ${s.note}`);
    }
  }
  if (comments.length) {
    lines.push('', `--- Comments (${comments.length}) ---`);
    for (const c of comments) {
      lines.push(`[${c.id}] ${c.byName || c.by} (${new Date(c.at).toISOString()}): ${c.text}`);
    }
  }
  return lines.join('\n');
}

const HELP = `gr8r — CLI for Gr8r Studio

Usage:
  gr8r [--url URL] [--token TOKEN] [--proxy URL] [--json] <command> ...

Commands:
  status                                    Show workspace overview, projects, and vocabulary
  config show                               Show resolved URL, config path, proxy, and connectivity
  config set [--url URL] [--proxy URL]      Save defaults to ~/.config/gr8r/config.json

  projects [--archived]                     List projects
  project view <key-or-id>                  Inspect a project and its tasks
  project create <name> [--key KEY] ...     Create a project
  project update <ref> [--status ...] ...   Update a project or its milestones
  project delete <ref> --yes                Permanently delete a project and its tasks

  tasks [-p PROJECT] [-s STATUS] ...        List/filter tasks (status accepts 'open')
  task view <key-or-id>                     Inspect a task, Markdown description, subtasks, comments
  task create <title> -p PROJECT ...        Create a task (--desc - reads Markdown from stdin)
  task update <ref> [flags]                 Atomically update task fields
  task start <ref> [-a me]                  Move task to 'progress'
  task done <ref> [--comment TEXT]          Complete task (and optionally post a comment)
  task reopen <ref> [--status todo]         Reopen a completed task
  task delete <ref> --yes                   Permanently delete a task

  subtask add <task> <title> [--note TEXT]  Add a subtask
  subtask update <task> <sub-id> [flags]    Update a subtask (--done / --undone / --note / --due)
  subtask done <task> <sub-id> [--note ...] Mark a subtask complete
  subtask undone <task> <sub-id>            Mark a subtask incomplete
  subtask promote <task> <sub-id>           Promote a subtask into a standalone task
  subtask remove <task> <sub-id>            Delete a subtask

  comment list <task>                       List task comments
  comment add <task> [text] [--body -]      Post a comment on a task
  comment delete <task> <comment-id>        Delete a comment

  search <query>                            Search tasks, projects, people, files, and comments
  activity [-p PROJECT] [-t TASK] [--limit] Show recent workspace activity
`;

export async function runCli(argv, io = {}) {
  const stdout = io.stdout || (s => process.stdout.write(s + '\n'));
  const stderr = io.stderr || (s => process.stderr.write(s + '\n'));
  const env = io.env || process.env;
  const readStdin = io.readStdin || readStdinText;

  const { values: opts, positionals: pos } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      url: { type: 'string' },
      token: { type: 'string' },
      proxy: { type: 'string' },
      'clear-token': { type: 'boolean' },
      'clear-proxy': { type: 'boolean' },
      project: { type: 'string', short: 'p' },
      task: { type: 'string', short: 't' },
      status: { type: 'string', short: 's' },
      priority: { type: 'string' },
      assignee: { type: 'string', short: 'a' },
      label: { type: 'string', short: 'l', multiple: true },
      labels: { type: 'string' },
      'add-label': { type: 'string', multiple: true },
      'remove-label': { type: 'string', multiple: true },
      deps: { type: 'string' },
      'add-dep': { type: 'string', multiple: true },
      'remove-dep': { type: 'string', multiple: true },
      due: { type: 'string' },
      start: { type: 'string' },
      estimate: { type: 'string' },
      desc: { type: 'string', short: 'd' },
      'desc-file': { type: 'string' },
      'append-desc': { type: 'string' },
      subtask: { type: 'string', multiple: true },
      note: { type: 'string' },
      body: { type: 'string' },
      'body-file': { type: 'string' },
      comment: { type: 'string' },
      title: { type: 'string' },
      name: { type: 'string' },
      key: { type: 'string' },
      color: { type: 'string' },
      icon: { type: 'string' },
      lead: { type: 'string' },
      team: { type: 'string' },
      recur: { type: 'string' },
      query: { type: 'string', short: 'q' },
      sort: { type: 'string' },
      dir: { type: 'string' },
      limit: { type: 'string' },
      'if-rev': { type: 'string' },
      'add-milestone': { type: 'string', multiple: true },
      'remove-milestone': { type: 'string', multiple: true },
      archived: { type: 'boolean' },
      archive: { type: 'boolean' },
      restore: { type: 'boolean' },
      fav: { type: 'boolean' },
      'no-fav': { type: 'boolean' },
      private: { type: 'boolean' },
      done: { type: 'boolean' },
      undone: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
    },
  });

  if (opts.help || !pos.length) {
    stdout(HELP.trimEnd());
    return 0;
  }

  const outJson = data => {
    stdout(JSON.stringify(data, null, 2));
    return 0;
  };

  const cmd = pos[0];
  const sub = pos[1];

  if (cmd === 'config') {
    if (!sub || sub === 'show') {
      const client = new Gr8rClient({ url: opts.url, token: opts.token, proxy: opts.proxy, env });
      let statusInfo;
      try {
        const ws = await client.request('GET', '/workspace');
        statusInfo = { reachable: true, rev: ws.rev, workspace: ws.ws?.name, projects: ws.projects?.length ?? 0 };
      } catch (err) {
        statusInfo = { reachable: false, error: err.message };
      }
      const info = {
        configFile: configFilePath(env),
        apiBase: client.apiBase,
        proxy: client.proxy || null,
        ...statusInfo,
      };
      if (opts.json) return outJson(info);
      stdout(`API:       ${info.apiBase}`);
      stdout(`Config:    ${info.configFile}`);
      stdout(`Proxy:     ${info.proxy || '(direct)'}`);
      stdout(
        info.reachable
          ? `Status:    connected (workspace "${info.workspace}", rev ${info.rev}, ${info.projects} projects)`
          : `Status:    unreachable (${info.error})`,
      );
      return info.reachable ? 0 : 1;
    }
    if (sub === 'set') {
      const cur = readUserConfig(env);
      if (opts.url) cur.url = opts.url.trim().replace(/\/+$/, '');
      if (opts.token) cur.token = opts.token;
      if (opts['clear-token']) delete cur.token;
      if (opts.proxy) cur.proxy = opts.proxy.trim();
      if (opts['clear-proxy']) delete cur.proxy;
      const savedPath = writeUserConfig(cur, env);
      if (opts.json) return outJson({ saved: savedPath, config: { ...cur, ...(cur.token ? { token: '***' } : {}) } });
      stdout(`Saved configuration to ${savedPath}`);
      return 0;
    }
    throw new Error(`Unknown config subcommand: ${sub}`);
  }

  const client = new Gr8rClient({ url: opts.url, token: opts.token, proxy: opts.proxy, env });

  if (cmd === 'status' || cmd === 'workspace') {
    const ws = await client.request('GET', '/workspace');
    if (opts.json) return outJson(ws);
    stdout(`Workspace: ${ws.ws?.name} (rev ${ws.rev})`);
    stdout(`Statuses:  ${ws.vocab.statuses.map(s => s.id).join(', ')}`);
    stdout(`Labels:    ${ws.vocab.labels.map(l => l.id).join(', ')}`);
    stdout('');
    stdout(
      formatTable(ws.projects, [
        ['KEY', p => p.key],
        ['NAME', p => p.name],
        ['STATUS', p => p.status],
        ['OPEN', p => p.openCount],
        ['DONE', p => p.doneCount],
        ['PROGRESS', p => `${p.progress}%`],
        ['DUE', p => p.due || '-'],
      ]),
    );
    return 0;
  }

  if (cmd === 'projects') {
    const qs = opts.archived ? '?archived=true' : '';
    const res = await client.request('GET', `/projects${qs}`);
    if (opts.json) return outJson(res);
    stdout(
      formatTable(res.projects, [
        ['KEY', p => p.key],
        ['ID', p => p.id],
        ['NAME', p => p.name],
        ['STATUS', p => (p.archived ? `${p.status} (archived)` : p.status)],
        ['TASKS', p => `${p.doneCount}/${p.taskCount}`],
        ['DUE', p => p.due || '-'],
      ]),
    );
    return 0;
  }

  if (cmd === 'project') {
    if (sub === 'view' || sub === 'get' || sub === 'show') {
      const ref = pos[2];
      if (!ref) throw new Error('Usage: gr8r project view <key-or-id>');
      const res = await client.request('GET', `/projects/${encodeURIComponent(ref)}${opts.archived ? '?archived=true' : ''}`);
      if (opts.json) return outJson(res);
      const p = res.project;
      stdout(`${p.key}  ${p.name} (${p.status}) — ${p.progress}% (${p.doneCount}/${p.taskCount} done) | rev ${res.rev}`);
      if (p.desc) stdout(p.desc);
      if (p.milestones?.length) {
        stdout('\nMilestones:');
        for (const m of p.milestones) stdout(`- ${m.date}  ${m.name}`);
      }
      stdout('\nTasks:');
      stdout(
        formatTable(res.tasks, [
          ['KEY', t => t.key],
          ['STATUS', t => t.status],
          ['PRIO', t => t.priority],
          ['SUBS', t => (t.subtaskCount ? `${t.subtaskDoneCount}/${t.subtaskCount}` : '-')],
          ['DUE', t => t.due || '-'],
          ['TITLE', t => t.title],
        ]),
      );
      return 0;
    }
    if (sub === 'create') {
      const name = opts.name ?? pos[2];
      if (!name) throw new Error('Usage: gr8r project create <name> [--key KEY] ...');
      const body = { name };
      if (opts.key) body.key = opts.key;
      if (opts.desc !== undefined || opts['desc-file'] !== undefined) body.desc = resolveTextArg(opts.desc, opts['desc-file'], readStdin);
      if (opts.status) body.status = opts.status;
      if (opts.color) body.color = opts.color;
      if (opts.icon) body.icon = opts.icon;
      if (opts.lead) body.lead = opts.lead;
      if (opts.team !== undefined) body.team = opts.team;
      if (opts.start !== undefined) body.start = nullableOpt(opts.start);
      if (opts.due !== undefined) body.due = nullableOpt(opts.due);
      if (opts.fav) body.fav = true;
      if (opts.private) body.private = true;
      if (opts['add-milestone']) {
        body.milestones = opts['add-milestone'].map(raw => {
          const at = raw.lastIndexOf('@');
          if (at <= 0) throw new Error(`Invalid milestone "${raw}". Expected "Name@YYYY-MM-DD"`);
          return { name: raw.slice(0, at).trim(), date: raw.slice(at + 1).trim() };
        });
      }
      const res = await client.request('POST', '/projects', body);
      if (opts.json) return outJson(res);
      stdout(`Created project ${res.project.key} (${res.project.id}): ${res.project.name} [rev ${res.rev}]`);
      return 0;
    }
    if (sub === 'update') {
      const ref = pos[2];
      if (!ref) throw new Error('Usage: gr8r project update <ref> [flags]');
      if (opts.fav && opts['no-fav']) throw new Error('Cannot combine --fav and --no-fav');
      if (opts.archive && opts.restore) throw new Error('Cannot combine --archive and --restore');
      const body = {};
      if (opts.name !== undefined) body.name = opts.name;
      if (opts.desc !== undefined || opts['desc-file'] !== undefined) body.desc = resolveTextArg(opts.desc, opts['desc-file'], readStdin);
      if (opts.status !== undefined) body.status = opts.status;
      if (opts.color !== undefined) body.color = opts.color;
      if (opts.icon !== undefined) body.icon = opts.icon;
      if (opts.lead !== undefined) body.lead = opts.lead;
      if (opts.team !== undefined) body.team = opts.team;
      if (opts.start !== undefined) body.start = nullableOpt(opts.start);
      if (opts.due !== undefined) body.due = nullableOpt(opts.due);
      if (opts.fav) body.fav = true;
      if (opts['no-fav']) body.fav = false;
      if (opts.archive) body.archived = true;
      if (opts.restore) body.archived = false;
      if (opts['remove-milestone']) body.removeMilestones = opts['remove-milestone'].map(s => s.trim()).filter(Boolean);
      if (opts['add-milestone']) {
        body.addMilestones = opts['add-milestone'].map(raw => {
          const at = raw.lastIndexOf('@');
          if (at <= 0) throw new Error(`Invalid milestone "${raw}". Expected "Name@YYYY-MM-DD"`);
          return { name: raw.slice(0, at).trim(), date: raw.slice(at + 1).trim() };
        });
      }
      if (opts['if-rev'] !== undefined) {
        const rev = Number(opts['if-rev']);
        if (!Number.isInteger(rev) || rev < 0) throw new Error(`Invalid --if-rev "${opts['if-rev']}": expected non-negative integer`);
        body.ifRev = rev;
      }
      const res = await client.request('PATCH', `/projects/${encodeURIComponent(ref)}`, body);
      if (opts.json) return outJson(res);
      stdout(`Updated project ${res.project.key}: ${res.project.name} (${res.project.status}) [rev ${res.rev}]`);
      return 0;
    }
    if (sub === 'delete') {
      const ref = pos[2];
      if (!ref) throw new Error('Usage: gr8r project delete <ref> --yes');
      if (!opts.yes) throw new Error('Deleting a project deletes all its tasks. Pass --yes to confirm.');
      const res = await client.request('DELETE', `/projects/${encodeURIComponent(ref)}`);
      if (opts.json) return outJson(res);
      stdout(`Deleted project ${res.key} (${res.deleted}) [rev ${res.rev}]`);
      return 0;
    }
    throw new Error(`Unknown project subcommand: ${sub}`);
  }

  if (cmd === 'tasks') {
    const params = new URLSearchParams();
    if (opts.project) params.set('project', opts.project);
    if (opts.status) params.set('status', opts.status);
    if (opts.priority) params.set('priority', opts.priority);
    if (opts.assignee) params.set('assignee', opts.assignee);
    const lbls = splitCsvList(opts.label || opts.labels);
    if (lbls?.length) params.set('label', lbls.join(','));
    if (opts.due) params.set('due', opts.due);
    if (opts.query) params.set('q', opts.query);
    if (opts.sort) params.set('sort', opts.sort);
    if (opts.dir) params.set('dir', opts.dir);
    if (opts.limit) params.set('limit', opts.limit);
    if (opts.archived) params.set('archived', 'true');
    const qs = params.toString();
    const res = await client.request('GET', `/tasks${qs ? '?' + qs : ''}`);
    if (opts.json) return outJson(res);
    stdout(
      formatTable(res.tasks, [
        ['KEY', t => t.key],
        ['STATUS', t => t.status],
        ['PRIO', t => t.priority],
        ['ASSIGNEE', t => t.assigneeName || '-'],
        ['SUBS', t => (t.subtaskCount ? `${t.subtaskDoneCount}/${t.subtaskCount}` : '-')],
        ['DUE', t => t.due || '-'],
        ['TITLE', t => t.title],
      ]),
    );
    return 0;
  }

  if (cmd === 'task') {
    if (sub === 'view' || sub === 'get' || sub === 'show') {
      const ref = pos[2];
      if (!ref) throw new Error('Usage: gr8r task view <key-or-id>');
      const res = await client.request('GET', `/tasks/${encodeURIComponent(ref)}`);
      if (opts.json) return outJson(res);
      stdout(formatTaskDetail(res));
      return 0;
    }
    if (sub === 'create') {
      const title = opts.title ?? pos[2];
      if (!title) throw new Error('Usage: gr8r task create <title> -p <project> [flags]');
      const body = { title };
      if (opts.project) body.project = opts.project;
      if (opts.status) body.status = opts.status;
      if (opts.priority) body.priority = opts.priority;
      if (opts.assignee !== undefined) body.assignee = nullableOpt(opts.assignee);
      if (opts.due !== undefined) body.due = nullableOpt(opts.due);
      if (opts.start !== undefined) body.start = nullableOpt(opts.start);
      if (opts.estimate !== undefined) body.estimate = nullableOpt(opts.estimate);
      const lbls = splitCsvList(opts.label || opts.labels);
      if (lbls) body.labels = lbls;
      const deps = splitCsvList(opts.deps);
      if (deps) body.deps = deps;
      if (opts.desc !== undefined || opts['desc-file'] !== undefined) body.desc = resolveTextArg(opts.desc, opts['desc-file'], readStdin);
      if (opts.subtask?.length) body.subtasks = opts.subtask;
      if (opts.recur !== undefined) body.recur = nullableOpt(opts.recur);
      if (opts.fav) body.fav = true;
      const res = await client.request('POST', '/tasks', body);
      if (opts.json) return outJson(res);
      stdout(`Created ${res.task.key}: ${res.task.title} [rev ${res.rev}]`);
      return 0;
    }
    if (sub === 'update' || sub === 'start' || sub === 'done' || sub === 'reopen') {
      const ref = pos[2];
      if (!ref) throw new Error(`Usage: gr8r task ${sub} <key-or-id> [flags]`);
      if (opts.fav && opts['no-fav']) throw new Error('Cannot combine --fav and --no-fav');
      if (opts.archive && opts.restore) throw new Error('Cannot combine --archive and --restore');
      if ((opts.desc !== undefined || opts['desc-file'] !== undefined) && opts['append-desc'] !== undefined) {
        throw new Error('Cannot combine --desc/--desc-file with --append-desc');
      }
      const commentText = opts.comment !== undefined ? opts.comment.trim() : undefined;
      if (commentText !== undefined && !commentText) throw new Error('--comment cannot be empty');
      const body = {};
      if (sub === 'start') body.status = 'progress';
      if (sub === 'done') body.status = 'done';
      if (sub === 'reopen') body.status = opts.status || 'todo';
      if (opts.title !== undefined) body.title = opts.title;
      if (opts.status !== undefined && sub === 'update') body.status = opts.status;
      if (opts.priority !== undefined) body.priority = opts.priority;
      if (opts.assignee !== undefined) body.assignee = nullableOpt(opts.assignee);
      if (opts.project !== undefined) body.project = opts.project;
      if (opts.due !== undefined) body.due = nullableOpt(opts.due);
      if (opts.start !== undefined) body.start = nullableOpt(opts.start);
      if (opts.estimate !== undefined) body.estimate = nullableOpt(opts.estimate);
      if (opts.labels !== undefined) body.labels = opts.labels === 'none' || opts.labels === '' ? [] : splitCsvList(opts.labels);
      else if (opts.label !== undefined) body.labels = splitCsvList(opts.label);
      if (opts['add-label']) body.addLabels = splitCsvList(opts['add-label']);
      if (opts['remove-label']) body.removeLabels = splitCsvList(opts['remove-label']);
      if (opts.deps !== undefined) body.deps = opts.deps === 'none' || opts.deps === '' ? [] : splitCsvList(opts.deps);
      if (opts['add-dep']) body.addDeps = splitCsvList(opts['add-dep']);
      if (opts['remove-dep']) body.removeDeps = splitCsvList(opts['remove-dep']);
      if (opts.desc !== undefined || opts['desc-file'] !== undefined) body.desc = resolveTextArg(opts.desc, opts['desc-file'], readStdin);
      if (opts['append-desc'] !== undefined) body.appendDesc = opts['append-desc'] === '-' ? readStdin() : opts['append-desc'];
      if (opts.recur !== undefined) body.recur = nullableOpt(opts.recur);
      if (opts.fav) body.fav = true;
      if (opts['no-fav']) body.fav = false;
      if (opts.archive) body.archived = true;
      if (opts.restore) body.archived = false;
      if (opts['if-rev'] !== undefined) {
        const rev = Number(opts['if-rev']);
        if (!Number.isInteger(rev) || rev < 0) throw new Error(`Invalid --if-rev "${opts['if-rev']}": expected non-negative integer`);
        body.ifRev = rev;
      }
      let res = await client.request('PATCH', `/tasks/${encodeURIComponent(ref)}`, body);
      if (commentText) {
        const cmt = await client.request('POST', `/tasks/${encodeURIComponent(res.task.id)}/comments`, { text: commentText });
        res = { ...res, rev: cmt.rev, task: cmt.task, comment: cmt.comment };
      }
      if (opts.json) return outJson(res);
      stdout(`Updated ${res.task.key} -> ${res.task.status}: ${res.task.title} [rev ${res.rev}]`);
      if (res.spawned) stdout(`Spawned next occurrence ${res.spawned.key} (due ${res.spawned.due})`);
      return 0;
    }
    if (sub === 'delete') {
      const ref = pos[2];
      if (!ref) throw new Error('Usage: gr8r task delete <key-or-id> --yes');
      if (!opts.yes) throw new Error('Pass --yes to permanently delete a task (or use --archive on task update).');
      const res = await client.request('DELETE', `/tasks/${encodeURIComponent(ref)}`);
      if (opts.json) return outJson(res);
      stdout(`Deleted ${res.key} (${res.deleted}) [rev ${res.rev}]`);
      return 0;
    }
    throw new Error(`Unknown task subcommand: ${sub}`);
  }

  if (cmd === 'subtask') {
    const taskRef = pos[2];
    if (!taskRef) throw new Error('Usage: gr8r subtask <add|update|done|undone|promote|remove> <task-ref> ...');
    if (sub === 'add') {
      const title = opts.title ?? pos[3];
      if (!title) throw new Error('Usage: gr8r subtask add <task-ref> <title> [--note TEXT]');
      const body = { title };
      if (opts.note !== undefined) body.note = opts.note === '-' ? readStdin() : opts.note;
      if (opts.due !== undefined) body.due = nullableOpt(opts.due);
      if (opts.assignee !== undefined) body.assignee = nullableOpt(opts.assignee);
      if (opts.done) body.done = true;
      const res = await client.request('POST', `/tasks/${encodeURIComponent(taskRef)}/subtasks`, body);
      if (opts.json) return outJson(res);
      stdout(`Added subtask ${res.subtask.id} on ${res.task.key}: ${res.subtask.title} [rev ${res.rev}]`);
      return 0;
    }
    const subRef = pos[3];
    if (!subRef) throw new Error(`Usage: gr8r subtask ${sub} <task-ref> <subtask-id>`);
    if (sub === 'update' || sub === 'done' || sub === 'undone') {
      if (opts.done && opts.undone) throw new Error('Cannot combine --done and --undone');
      const body = {};
      if (sub === 'done' || opts.done) body.done = true;
      if (sub === 'undone' || opts.undone) body.done = false;
      if (opts.title !== undefined) body.title = opts.title;
      if (opts.note !== undefined) body.note = opts.note === '-' ? readStdin() : opts.note;
      if (opts.due !== undefined) body.due = nullableOpt(opts.due);
      if (opts.assignee !== undefined) body.assignee = nullableOpt(opts.assignee);
      const res = await client.request('PATCH', `/tasks/${encodeURIComponent(taskRef)}/subtasks/${encodeURIComponent(subRef)}`, body);
      if (opts.json) return outJson(res);
      stdout(
        `Subtask ${res.subtask.id} [${res.subtask.done ? 'x' : ' '}] on ${res.task.key} (${res.task.subtaskDoneCount}/${res.task.subtaskCount}) [rev ${res.rev}]`,
      );
      return 0;
    }
    if (sub === 'promote') {
      const res = await client.request('POST', `/tasks/${encodeURIComponent(taskRef)}/subtasks/${encodeURIComponent(subRef)}/promote`, {});
      if (opts.json) return outJson(res);
      stdout(`Promoted subtask ${subRef} to ${res.task.key}: ${res.task.title} [rev ${res.rev}]`);
      return 0;
    }
    if (sub === 'remove' || sub === 'delete') {
      const res = await client.request('DELETE', `/tasks/${encodeURIComponent(taskRef)}/subtasks/${encodeURIComponent(subRef)}`);
      if (opts.json) return outJson(res);
      stdout(`Removed subtask ${res.deleted} from ${res.task.key} [rev ${res.rev}]`);
      return 0;
    }
    throw new Error(`Unknown subtask subcommand: ${sub}`);
  }

  if (cmd === 'comment') {
    const taskRef = pos[2];
    if (!taskRef) throw new Error('Usage: gr8r comment <list|add|delete> <task-ref> ...');
    if (sub === 'list') {
      const res = await client.request('GET', `/tasks/${encodeURIComponent(taskRef)}/comments`);
      if (opts.json) return outJson(res);
      if (!res.comments.length) {
        stdout('(no comments)');
        return 0;
      }
      for (const c of res.comments) stdout(`[${c.id}] ${c.byName || c.by} (${new Date(c.at).toISOString()}): ${c.text}`);
      return 0;
    }
    if (sub === 'add') {
      const text = resolveTextArg(opts.body ?? pos[3], opts['body-file'], readStdin);
      if (!text || !text.trim()) throw new Error('Usage: gr8r comment add <task-ref> <text> (or --body -)');
      const res = await client.request('POST', `/tasks/${encodeURIComponent(taskRef)}/comments`, { text });
      if (opts.json) return outJson(res);
      stdout(`Posted comment ${res.comment.id} on ${res.task.key} [rev ${res.rev}]`);
      return 0;
    }
    if (sub === 'delete' || sub === 'remove') {
      const cid = pos[3];
      if (!cid) throw new Error('Usage: gr8r comment delete <task-ref> <comment-id>');
      const res = await client.request('DELETE', `/tasks/${encodeURIComponent(taskRef)}/comments/${encodeURIComponent(cid)}`);
      if (opts.json) return outJson(res);
      stdout(`Deleted comment ${res.deleted} [rev ${res.rev}]`);
      return 0;
    }
    throw new Error(`Unknown comment subcommand: ${sub}`);
  }

  if (cmd === 'search') {
    const q = opts.query ?? pos.slice(1).join(' ');
    if (!q) throw new Error('Usage: gr8r search <query>');
    const res = await client.request('GET', `/search?q=${encodeURIComponent(q)}`);
    if (opts.json) return outJson(res);
    stdout(`Projects (${res.projects.length}):`);
    for (const p of res.projects) stdout(`  ${p.key}  ${p.name} (${p.status})`);
    stdout(`Tasks (${res.tasks.length}):`);
    for (const t of res.tasks) stdout(`  ${t.key}  [${t.status}] ${t.title}`);
    if (res.people?.length) {
      stdout(`People (${res.people.length}):`);
      for (const m of res.people) stdout(`  ${m.id}  ${m.name}${m.role ? ` (${m.role})` : ''}`);
    }
    if (res.files?.length) {
      stdout(`Files (${res.files.length}):`);
      for (const f of res.files) stdout(`  ${f.name}${f.project ? ` (${f.project})` : ''}`);
    }
    if (res.comments.length) {
      stdout(`Comments (${res.comments.length}):`);
      for (const c of res.comments) stdout(`  [${c.taskKey}] ${c.byName || c.by}: ${c.text}`);
    }
    return 0;
  }

  if (cmd === 'activity') {
    const params = new URLSearchParams();
    if (opts.project) params.set('project', opts.project);
    if (opts.task) params.set('task', opts.task);
    if (opts.limit) params.set('limit', opts.limit);
    const qs = params.toString();
    const res = await client.request('GET', `/activity${qs ? '?' + qs : ''}`);
    if (opts.json) return outJson(res);
    if (!res.activity.length) {
      stdout('(no activity)');
      return 0;
    }
    for (const a of res.activity) {
      const target = a.taskKey ? `${a.taskKey} (${a.taskTitle})` : a.projectName || '';
      stdout(`${new Date(a.at).toISOString()}  ${a.byName || a.by} ${a.verb} ${target}${a.extra ? ' ' + a.extra : ''}`);
    }
    return 0;
  }

  stderr(`Unknown command: ${cmd}. Run "gr8r --help" for usage.`);
  return 1;
}

function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

if (process.argv[1] && safeRealpath(process.argv[1]) === safeRealpath(fileURLToPath(import.meta.url))) {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', err => {
      if (err?.code === 'EPIPE') process.exit(0);
      throw err;
    });
  }
  runCli(process.argv.slice(2)).then(
    code => {
      process.exitCode = code;
    },
    err => {
      process.stderr.write(`gr8r: ${err.message}\n`);
      process.exitCode = 1;
    },
  );
}
