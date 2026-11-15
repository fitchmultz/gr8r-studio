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

const TAILNET_IPS = new net.BlockList();
TAILNET_IPS.addSubnet('100.64.0.0', 10, 'ipv4');
TAILNET_IPS.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');

function stripV4Mapped(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/%[^%]+$/, '');
  return /^::ffff:/i.test(s) && s.includes('.') ? s.slice(7) : s;
}

function isTailnetIp(raw) {
  const ip = stripV4Mapped(raw);
  const ver = net.isIP(ip);
  return !!ver && TAILNET_IPS.check(ip, ver === 6 ? 'ipv6' : 'ipv4');
}

function readLinuxDefaultGateway() {
  try {
    for (const line of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols[1] === '00000000' && /^[0-9A-Fa-f]{8}$/.test(cols[2])) {
        const n = Number.parseInt(cols[2], 16);
        return `${n & 255}.${(n >>> 8) & 255}.${(n >>> 16) & 255}.${(n >>> 24) & 255}`;
      }
    }
  } catch {
    /* non-Linux host */
  }
  return null;
}

const DOCKER_LOOPBACK_GW = process.env.GR8R_DOCKER_LOOPBACK === '1' ? readLinuxDefaultGateway() : null;

function isLocalOrTailnetSocket(raw) {
  const ip = stripV4Mapped(raw);
  return ip === '127.0.0.1' || ip === '::1' || (DOCKER_LOOPBACK_GW !== null && ip === DOCKER_LOOPBACK_GW) || isTailnetIp(ip);
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

/* Direct loopback / direct tailnet sockets bootstrap without extra headers.
   Proxied requests only bootstrap when Tailscale Serve injects Tailscale-User-Login
   (which Serve strips from incoming traffic and never sets on Funnel) over a single
   tailnet X-Forwarded-For hop. */
export function isTrustedPrivateRequest(req) {
  if (!isLocalOrTailnetSocket(req.socket?.remoteAddress)) return false;
  const forwarded = Boolean(
    req.headers['x-forwarded-for'] ||
    req.headers['x-forwarded-proto'] ||
    req.headers['x-forwarded-host'] ||
    req.headers['x-real-ip'] ||
    req.headers.forwarded ||
    req.headers['tailscale-funnel-request'] ||
    req.headers['cf-connecting-ip'],
  );
  if (!forwarded) {
    const rawHost = String(req.headers.host || '')
      .trim()
      .toLowerCase();
    const host = rawHost.startsWith('[') ? rawHost.slice(1, rawHost.indexOf(']')) : rawHost.replace(/:\d+$/, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || isTailnetIp(host);
  }
  if (!String(req.headers['tailscale-user-login'] || '').trim() || req.headers['tailscale-funnel-request']) return false;
  const hops = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return hops.length === 1 && isTailnetIp(hops[0]);
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
        vary: 'Authorization, Host, Tailscale-User-Login, X-Forwarded-For',
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
