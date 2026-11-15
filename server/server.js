/* Self-hosted server for Gr8r Studio: serves the built app and keeps the
   authoritative synced workspace state. See README "Self-hosting".

   GR8R_TOKEN=<secret> npm start
   Environment: PORT (4180), HOST (127.0.0.1), GR8R_TOKEN (required),
   GR8R_TRUST_BOOTSTRAP (tailnet | none | always), GR8R_DATA (state file),
   DIST (static directory). */
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleDomainApi } from './api.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* The workspace blob is ~100 KB; 10 MB bounds request memory while leaving room to grow. */
const MAX_BODY = 10 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

const DIRECT_SOCKET_ALLOWLIST = new net.BlockList();
DIRECT_SOCKET_ALLOWLIST.addSubnet('127.0.0.0', 8, 'ipv4');
DIRECT_SOCKET_ALLOWLIST.addAddress('::1', 'ipv6');
DIRECT_SOCKET_ALLOWLIST.addSubnet('100.64.0.0', 10, 'ipv4');
DIRECT_SOCKET_ALLOWLIST.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');
/* Docker's local bridge gateway when the host publishes 127.0.0.1:4180:4180. */
DIRECT_SOCKET_ALLOWLIST.addSubnet('172.16.0.0', 12, 'ipv4');

const FORWARDED_CLIENT_ALLOWLIST = new net.BlockList();
FORWARDED_CLIENT_ALLOWLIST.addSubnet('127.0.0.0', 8, 'ipv4');
FORWARDED_CLIENT_ALLOWLIST.addAddress('::1', 'ipv6');
FORWARDED_CLIENT_ALLOWLIST.addSubnet('100.64.0.0', 10, 'ipv4');
FORWARDED_CLIENT_ALLOWLIST.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');

const PUBLIC_TUNNEL_HEADERS = [
  'tailscale-funnel-request',
  'cf-connecting-ip',
  'cf-ray',
  'true-client-ip',
  'fly-client-ip',
  'x-vercel-forwarded-for',
  'fastly-client-ip',
];

function normalizeIp(raw) {
  let s = String(raw || '')
    .trim()
    .replace(/^"(.*)"$/, '$1');
  if (!s) return null;
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end === -1) return null;
    s = s.slice(1, end);
  } else if (s.includes('.') && /^[^:]+:\d+$/.test(s)) {
    s = s.slice(0, s.lastIndexOf(':'));
  }
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (/^::ffff:/i.test(s) && s.includes('.')) s = s.slice(7);
  const ver = net.isIP(s);
  if (!ver) return null;
  return { ip: s, family: ver === 6 ? 'ipv6' : 'ipv4' };
}

function checkIp(blockList, raw) {
  const parsed = normalizeIp(raw);
  return !!parsed && blockList.check(parsed.ip, parsed.family);
}

function isTrustedHostname(rawHost) {
  const s = String(rawHost || '').trim();
  if (!s) return false;
  let host = s;
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end === -1) return false;
    host = s.slice(1, end);
  } else {
    const colon = s.indexOf(':');
    if (colon !== -1 && s.indexOf(':', colon + 1) === -1) host = s.slice(0, colon);
  }
  host = host.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.ts.net') || checkIp(FORWARDED_CLIENT_ALLOWLIST, host);
}

function headerList(val) {
  if (val === undefined) return null;
  const raw = Array.isArray(val) ? val.join(',') : String(val);
  return raw
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

export function normalizeTrustBootstrap(val = 'tailnet') {
  const norm = String(val ?? 'tailnet')
    .trim()
    .toLowerCase();
  if (!norm || norm === 'tailnet') return 'tailnet';
  if (['none', 'false', '0', 'off'].includes(norm)) return 'none';
  if (['always', 'all', 'true', '1'].includes(norm)) return 'always';
  throw new Error(`Invalid trustBootstrap "${val}". Expected tailnet, none, or always.`);
}

export function isTrustedPrivateRequest(req) {
  if (!checkIp(DIRECT_SOCKET_ALLOWLIST, req.socket?.remoteAddress)) return false;
  for (const h of PUBLIC_TUNNEL_HEADERS) {
    const v = req.headers[h];
    if (v !== undefined && String(v).trim() !== '') return false;
  }
  const hosts = headerList(req.headers.host);
  if (!hosts?.length || !hosts.every(isTrustedHostname)) return false;
  if (req.headers['x-forwarded-host'] !== undefined) {
    const fwdHosts = headerList(req.headers['x-forwarded-host']);
    if (!fwdHosts?.length || !fwdHosts.every(isTrustedHostname)) return false;
  }
  if (req.headers['x-forwarded-for'] !== undefined) {
    const hops = headerList(req.headers['x-forwarded-for']);
    if (!hops?.length || !hops.every(ip => checkIp(FORWARDED_CLIENT_ALLOWLIST, ip))) return false;
  }
  if (req.headers['x-real-ip'] !== undefined) {
    const ips = headerList(req.headers['x-real-ip']);
    if (!ips?.length || !ips.every(ip => checkIp(FORWARDED_CLIENT_ALLOWLIST, ip))) return false;
  }
  if (req.headers.forwarded !== undefined) {
    const elems = headerList(req.headers.forwarded);
    if (!elems?.length) return false;
    let sawFor = false;
    for (const elem of elems) {
      for (const param of elem.split(';')) {
        const eq = param.indexOf('=');
        if (eq === -1) continue;
        const k = param.slice(0, eq).trim().toLowerCase();
        const v = param
          .slice(eq + 1)
          .trim()
          .replace(/^"(.*)"$/, '$1');
        if (k === 'for') {
          sawFor = true;
          if (!checkIp(FORWARDED_CLIENT_ALLOWLIST, v)) return false;
        } else if (k === 'host' && !isTrustedHostname(v)) {
          return false;
        }
      }
    }
    if (!sawFor) return false;
  }
  return true;
}

function readStore(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j.rev !== 'number') throw new Error(`Invalid workspace file: ${file}`);
    return { rev: j.rev, state: j.state ?? null };
  } catch (error) {
    if (error.code === 'ENOENT') return { rev: 0, state: null };
    throw error;
  }
}
function writeStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, file);
}

export function startServer({ port = 0, host = '127.0.0.1', token, dataFile, distDir, trustBootstrap = process.env.GR8R_TRUST_BOOTSTRAP || 'tailnet' }) {
  if (!token) throw new Error('startServer: token is required');
  const trustMode = normalizeTrustBootstrap(trustBootstrap);
  const tokenKey = createHash('sha256').update(token).digest();
  const matchesToken = candidate =>
    typeof candidate === 'string' && candidate.length > 0 && timingSafeEqual(createHash('sha256').update(candidate).digest(), tokenKey);
  const DATA = dataFile || path.join(HERE, 'data', 'state.json');
  const DIST = distDir || path.join(HERE, '..', 'dist');
  let store = readStore(DATA);
  const subscribers = new Set();

  const broadcastRev = rev => {
    const msg = `event: rev\ndata: ${JSON.stringify({ rev })}\n\n`;
    for (const sub of subscribers) {
      try {
        sub.write(msg);
      } catch {
        subscribers.delete(sub);
      }
    }
  };
  const commitState = state => {
    const next = { rev: store.rev + 1, state };
    writeStore(DATA, next);
    store = next;
    broadcastRev(store.rev);
    return store;
  };

  const authorized = req => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return !!m && matchesToken(m[1]);
  };
  const send = (res, code, body, type = 'application/json', extra = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(code, { 'content-type': type, 'content-length': buf.length, ...extra });
    res.end(buf);
  };
  const readBody = req =>
    new Promise((resolve, reject) => {
      let n = 0;
      const chunks = [];
      req.on('data', c => {
        n += c.length;
        if (n > MAX_BODY) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  async function api(req, res, url) {
    /* On loopback and private Tailscale Serve routes, /api/config bootstraps
       GR8R_TOKEN so browsers on the tailnet need no separate login. Public
       tunnels, Funnel, non-tailnet proxies, or GR8R_TRUST_BOOTSTRAP=none
       withhold the token until the caller presents GR8R_TOKEN explicitly. */
    if (url.pathname === '/api/config') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      const canBootstrap = authorized(req) || trustMode === 'always' || (trustMode === 'tailnet' && isTrustedPrivateRequest(req));
      return send(res, 200, { token: canBootstrap ? token : null, authRequired: !canBootstrap }, 'application/json', {
        'cache-control': 'no-store',
        vary: 'Authorization, Host, X-Forwarded-For, X-Forwarded-Host, Tailscale-Funnel-Request',
      });
    }
    if (url.pathname === '/api/auth') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      let body;
      try {
        const raw = await readBody(req);
        body = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        return send(res, 400, { error: 'invalid body' });
      }
      const ok = authorized(req) || matchesToken(body?.token);
      if (!ok) return send(res, 401, { error: 'unauthorized' }, 'application/json', { 'cache-control': 'no-store' });
      return send(res, 200, { ok: true }, 'application/json', { 'cache-control': 'no-store' });
    }
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.flushHeaders?.();
      res.write(`event: rev\ndata: ${JSON.stringify({ rev: store.rev })}\n\n`);
      subscribers.add(res);
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(ping);
          subscribers.delete(res);
        }
      }, 25000);
      ping.unref();
      req.on('close', () => {
        clearInterval(ping);
        subscribers.delete(res);
      });
      return;
    }
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, store);
    if (url.pathname === '/api/sync' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: 'invalid body' });
      }
      const { baseRev, state } = body || {};
      if (typeof baseRev !== 'number' || !state || !state.data || !Array.isArray(state.data.tasks)) return send(res, 400, { error: 'invalid state' });
      if (baseRev !== store.rev) return send(res, 409, store);
      commitState(state);
      return send(res, 200, { rev: store.rev });
    }
    return handleDomainApi({ req, res, url, getStore: () => store, commitState, readBody, send });
  }

  function serveStatic(res, url) {
    let p = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
    if (!p.startsWith(DIST)) return send(res, 403, { error: 'forbidden' });
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      if (url.pathname.startsWith('/assets/'))
        res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' });
      else res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(p));
      return;
    }
    /* every route is hash-based, so anything unknown falls back to the app */
    const index = path.join(DIST, 'index.html');
    if (fs.existsSync(index)) return send(res, 200, fs.readFileSync(index), 'text/html; charset=utf-8');
    send(res, 404, { error: 'no app build' });
  }

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        api(req, res, url).catch(e => {
          console.error(e);
          if (!res.headersSent && !res.destroyed) send(res, 500, { error: 'internal' });
        });
        return;
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      serveStatic(res, url);
    } catch {
      /* a malformed request target or undecodable path must never take the server down */
      if (!res.headersSent && !res.destroyed) send(res, 400, { error: 'bad request' });
    }
  });

  return new Promise(resolve => {
    server.listen(port, host, () =>
      resolve({
        server,
        port: server.address().port,
        dataFile: DATA,
        distDir: DIST,
        close: () =>
          new Promise(done => {
            for (const sub of subscribers) sub.end();
            subscribers.clear();
            server.close(done);
          }),
      }),
    );
  });
}

/* CLI entry */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.GR8R_TOKEN) {
    console.error('gr8r-server: GR8R_TOKEN is required (the sync bearer token).');
    process.exit(1);
  }
  const { port, dataFile, distDir } = await startServer({
    port: +(process.env.PORT || 4180),
    host: process.env.HOST || '127.0.0.1',
    token: process.env.GR8R_TOKEN,
    dataFile: process.env.GR8R_DATA,
    distDir: process.env.DIST,
  });
  console.log(`gr8r-server: http://localhost:${port} (state in ${dataFile}, app in ${distDir})`);
}
