/* Self-hosted server for Gr8r Studio: serves the built app and keeps the
   authoritative synced workspace state. See README "Self-hosting".

   GR8R_TOKEN=<secret> npm start
   Environment: PORT (4180), HOST (127.0.0.1), GR8R_TOKEN (required),
   GR8R_TRUST_BOOTSTRAP (tailnet | none | always), GR8R_GITHUB_WEBHOOK_SECRET (optional),
   GR8R_DATA (state file), DIST (static directory). */
import { createServer } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DomainError, formatTaskForApi, syncGitHubPullRequests } from '../src/core/domain.js';
import { handleDomainApi } from './api.js';
import { blobRefCounts, sanitizeStateBlobs } from './blobs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* The workspace blob is ~100 KB; 10 MB bounds request memory while leaving room to grow. */
const MAX_BODY = 10 * 1024 * 1024;
/* Binary attachments (screenshots, recordings, PDFs) are stored out-of-line on disk up to 50 MB. */
const MAX_BLOB_BYTES = 50 * 1024 * 1024;
const PENDING_BLOB_TTL_MS = 5 * 60 * 1000;
const SAFE_INLINE_BLOB_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);
const EXT_BLOB_MIMES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
  '.zip': 'application/zip',
};
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
   (which Serve strips from incoming traffic and never sets on Funnel) on a .ts.net
   Host over a single tailnet X-Forwarded-For hop, with no public edge/Funnel headers. */
function bareHost(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!s) return '';
  return s.startsWith('[') ? s.slice(1, s.indexOf(']')) : s.replace(/:\d+$/, '');
}

export function isTrustedPrivateRequest(req) {
  if (!isLocalOrTailnetSocket(req.socket?.remoteAddress)) return false;
  if (
    req.headers['tailscale-funnel-request'] ||
    req.headers['cf-connecting-ip'] ||
    req.headers['cf-ray'] ||
    req.headers['true-client-ip'] ||
    req.headers['cdn-loop']
  ) {
    return false;
  }
  const host = bareHost(req.headers.host);
  if (!host) return false;
  const forwarded = Boolean(
    req.headers['x-forwarded-for'] || req.headers['x-forwarded-proto'] || req.headers['x-forwarded-host'] || req.headers['x-real-ip'] || req.headers.forwarded,
  );
  if (!forwarded) {
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || isTailnetIp(host);
  }
  const fwdHost = req.headers['x-forwarded-host'] ? bareHost(req.headers['x-forwarded-host']) : host;
  if (!host.endsWith('.ts.net') || !fwdHost.endsWith('.ts.net')) return false;
  if (!String(req.headers['tailscale-user-login'] || '').trim()) return false;
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

function verifyGitHubSignature(rawBuf, sigHeader, secret) {
  if (!secret || typeof sigHeader !== 'string' || !/^sha256=[0-9a-f]{64}$/i.test(sigHeader)) return false;
  const expected = createHmac('sha256', secret).update(rawBuf).digest();
  const actual = Buffer.from(sigHeader.slice(7), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function startServer({
  port = 0,
  host = '127.0.0.1',
  token,
  dataFile,
  distDir,
  trustBootstrap = process.env.GR8R_TRUST_BOOTSTRAP || 'tailnet',
  webhookSecret = process.env.GR8R_GITHUB_WEBHOOK_SECRET || '',
  blobLeaseMs = PENDING_BLOB_TTL_MS,
}) {
  if (!token) throw new Error('startServer: token is required');
  const trustMode = normalizeTrustBootstrap(trustBootstrap);
  const ghWebhookSecret = String(webhookSecret || '').trim();
  const tokenKey = createHash('sha256').update(token).digest();
  const blobSessionCookie = createHmac('sha256', tokenKey).update('gr8r-blob-read-v1').digest('hex');
  const matchesToken = candidate =>
    typeof candidate === 'string' && candidate.length > 0 && timingSafeEqual(createHash('sha256').update(candidate).digest(), tokenKey);
  const hasValidBlobCookie = req => {
    const raw = String(req.headers.cookie || '');
    for (const part of raw.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (k === 'gr8r_blob' && v.length === blobSessionCookie.length) {
        const a = Buffer.from(v);
        const b = Buffer.from(blobSessionCookie);
        if (a.length === b.length && timingSafeEqual(a, b)) return true;
      }
    }
    return false;
  };
  const DATA = dataFile || path.join(HERE, 'data', 'state.json');
  const BLOBS_DIR = path.join(path.dirname(DATA), 'blobs');
  const DIST = distDir || path.join(HERE, '..', 'dist');
  let store = readStore(DATA);
  const subscribers = new Set();
  const sweepTimers = new Set();

  const hasBlob = blobId => /^[0-9a-f]{64}$/.test(String(blobId || '')) && fs.existsSync(path.join(BLOBS_DIR, blobId));
  const readBlobMeta = blobId => {
    try {
      return JSON.parse(fs.readFileSync(path.join(BLOBS_DIR, `${blobId}.json`), 'utf8'));
    } catch {
      return null;
    }
  };
  const writeBlobMeta = (blobId, meta) => {
    const dest = path.join(BLOBS_DIR, blobId);
    if (!fs.existsSync(dest)) return;
    const tmp = `${dest}.json.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta));
    fs.renameSync(tmp, `${dest}.json`);
  };
  const unlinkBlob = blobId => {
    try {
      fs.rmSync(path.join(BLOBS_DIR, blobId), { force: true });
      fs.rmSync(path.join(BLOBS_DIR, `${blobId}.json`), { force: true });
    } catch {
      /* best-effort unreferenced blob cleanup */
    }
  };
  const scheduleSweep = delayMs => {
    const tm = setTimeout(
      () => {
        sweepTimers.delete(tm);
        sweepPendingBlobs();
      },
      Math.max(1, delayMs) + 25,
    );
    tm.unref?.();
    sweepTimers.add(tm);
  };
  function sweepPendingBlobs(now = Date.now(), { sweepAllUnreferenced = false, armTimers = false } = {}) {
    if (!fs.existsSync(BLOBS_DIR)) return;
    const refCounts = blobRefCounts(store.state?.data);
    for (const entry of fs.readdirSync(BLOBS_DIR)) {
      if (!/^[0-9a-f]{64}$/.test(entry) || refCounts.has(entry)) continue;
      const meta = readBlobMeta(entry);
      let liveLeases = Array.isArray(meta?.leases) ? meta.leases.filter(exp => exp > now) : [];
      let isPending = meta?.pending === true;
      if (!meta) {
        try {
          const exp = fs.statSync(path.join(BLOBS_DIR, entry)).mtimeMs + blobLeaseMs;
          isPending = true;
          if (exp > now) liveLeases = [exp];
        } catch {
          continue;
        }
      }
      if (liveLeases.length > 0) {
        if (armTimers) scheduleSweep(Math.max(...liveLeases) - now);
        continue;
      }
      if (sweepAllUnreferenced || isPending) {
        unlinkBlob(entry);
      }
    }
  }
  sweepPendingBlobs(Date.now(), { armTimers: true });

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
  const commitState = (state, { isFullSync = false } = {}) => {
    const prevCounts = blobRefCounts(store.state?.data);
    const next = { rev: store.rev + 1, state };
    writeStore(DATA, next);
    store = next;
    const now = Date.now();
    const nextCounts = blobRefCounts(state?.data);
    for (const [bid, nextCount] of nextCounts) {
      const prevCount = prevCounts.get(bid) || 0;
      const meta = readBlobMeta(bid);
      if (meta) {
        const liveLeases = Array.isArray(meta.leases) ? meta.leases.filter(exp => exp > now) : [];
        if (nextCount > prevCount) liveLeases.splice(0, nextCount - prevCount);
        if (meta.pending !== false || !Array.isArray(meta.leases) || meta.leases.length !== liveLeases.length) {
          writeBlobMeta(bid, { ...meta, pending: false, leases: liveLeases });
        }
      }
    }
    for (const [bid] of prevCounts) {
      if (!nextCounts.has(bid)) {
        const meta = readBlobMeta(bid);
        const liveLeases = Array.isArray(meta?.leases) ? meta.leases.filter(exp => exp > now) : [];
        if (liveLeases.length > 0 && meta) {
          writeBlobMeta(bid, { ...meta, pending: true, leases: liveLeases });
          scheduleSweep(Math.max(...liveLeases) - now);
        } else {
          unlinkBlob(bid);
        }
      }
    }
    sweepPendingBlobs(now, { sweepAllUnreferenced: isFullSync });
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
  const readRawBody = (req, limit = MAX_BODY) =>
    new Promise((resolve, reject) => {
      let n = 0;
      let overLimit = false;
      let settled = false;
      const hardCap = limit + 16 * 1024 * 1024;
      const chunks = [];
      const failTooLarge = () => {
        if (settled) return;
        settled = true;
        const err = new Error('body too large');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
      };
      req.on('data', c => {
        n += c.length;
        if (n > limit) {
          if (!overLimit) {
            overLimit = true;
            chunks.length = 0;
          }
          if (n > hardCap) {
            req.pause();
            failTooLarge();
          }
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (settled) return;
        if (overLimit) {
          failTooLarge();
          return;
        }
        settled = true;
        resolve(Buffer.concat(chunks));
      });
      req.on('error', err => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
  const readBody = req => readRawBody(req).then(buf => buf.toString('utf8'));
  const setBlobCookieHeader = res => {
    res.setHeader('set-cookie', `gr8r_blob=${blobSessionCookie}; Path=/api/blobs; Max-Age=2592000; HttpOnly; SameSite=Strict`);
  };

  async function api(req, res, url) {
    /* On loopback and private Tailscale Serve routes, /api/config bootstraps
       GR8R_TOKEN so browsers on the tailnet need no separate login. Public
       tunnels, Funnel, non-tailnet proxies, or GR8R_TRUST_BOOTSTRAP=none
       withhold the token until the caller presents GR8R_TOKEN explicitly. */
    if (url.pathname === '/api/config') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      const canBootstrap = authorized(req) || trustMode === 'always' || (trustMode === 'tailnet' && isTrustedPrivateRequest(req));
      if (canBootstrap) setBlobCookieHeader(res);
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
      setBlobCookieHeader(res);
      return send(res, 200, { ok: true }, 'application/json', { 'cache-control': 'no-store' });
    }
    if (url.pathname.startsWith('/api/blobs/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const canRead = authorized(req) || hasValidBlobCookie(req) || trustMode === 'always' || (trustMode === 'tailnet' && isTrustedPrivateRequest(req));
      if (!canRead) return send(res, 401, { error: 'unauthorized' });
      const blobId = url.pathname.slice('/api/blobs/'.length).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(blobId)) return send(res, 400, { error: 'invalid blob id' });
      const blobPath = path.join(BLOBS_DIR, blobId);
      if (!fs.existsSync(blobPath)) return send(res, 404, { error: 'blob not found' });
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(blobPath + '.json', 'utf8'));
      } catch {
        /* optional metadata */
      }
      const requestedMime = String(url.searchParams.get('mime') || '').trim();
      const validRequestedMime = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;\s*charset=[a-z0-9._-]+)?$/i.test(requestedMime) ? requestedMime : '';
      const effectiveMime = validRequestedMime || meta.mime || 'application/octet-stream';
      const rawMime = String(effectiveMime).split(';')[0].trim().toLowerCase();
      const forceDownload = url.searchParams.get('download') === '1' || !SAFE_INLINE_BLOB_MIMES.has(rawMime);
      const effectiveName =
        String(url.searchParams.get('name') || meta.name || blobId)
          .replace(/[/\\\r\n]/g, '_')
          .trim() || blobId;
      const asciiName =
        effectiveName
          .normalize('NFKD')
          .replace(/[^\x20-\x7e]/g, '_')
          .replace(/["\\;]/g, '_')
          .trim() || blobId;
      const utf8Star = encodeURIComponent(effectiveName).replace(/['()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
      const disposition =
        asciiName === effectiveName
          ? `${forceDownload ? 'attachment' : 'inline'}; filename="${asciiName}"`
          : `${forceDownload ? 'attachment' : 'inline'}; filename="${asciiName}"; filename*=UTF-8''${utf8Star}`;
      const headers = {
        'content-type': effectiveMime,
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
        'content-disposition': disposition,
      };
      if (req.method === 'HEAD') {
        const st = fs.statSync(blobPath);
        res.writeHead(200, { ...headers, 'content-length': st.size });
        res.end();
        return;
      }
      return send(res, 200, fs.readFileSync(blobPath), headers['content-type'], headers);
    }
    if (url.pathname === '/api/webhooks/github') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      if (!ghWebhookSecret) return send(res, 503, { error: 'github webhook is not configured' });
      const rawBuf = await readRawBody(req);
      if (!verifyGitHubSignature(rawBuf, req.headers['x-hub-signature-256'], ghWebhookSecret)) {
        return send(res, 401, { error: 'invalid signature' });
      }
      const event = String(req.headers['x-github-event'] || '').trim();
      if (event === 'ping') return send(res, 200, { ok: true, event: 'ping' });
      if (event !== 'pull_request') return send(res, 202, { accepted: false, event });
      let payload;
      try {
        payload = JSON.parse(rawBuf.toString('utf8'));
      } catch {
        return send(res, 400, { error: 'invalid body' });
      }
      if (!store.state) return send(res, 202, { accepted: false, reason: 'uninitialized', rev: store.rev });
      try {
        const draft = structuredClone(store.state);
        const { changed, updatedTasks } = syncGitHubPullRequests(draft.data, [payload]);
        const rev = changed ? commitState(draft).rev : store.rev;
        return send(res, 200, {
          ok: true,
          changed,
          rev,
          updated: updatedTasks.map(t => formatTaskForApi(draft.data, t)),
        });
      } catch (err) {
        if (err instanceof DomainError) return send(res, err.status || 400, { error: err.message });
        throw err;
      }
    }
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
    setBlobCookieHeader(res);
    if (url.pathname === '/api/blobs' && req.method === 'POST') {
      let buf;
      try {
        buf = await readRawBody(req, MAX_BLOB_BYTES);
      } catch (err) {
        if (err?.code === 'PAYLOAD_TOO_LARGE') {
          res.once('finish', () => {
            if (!req.complete) req.destroy();
          });
          return send(res, 413, { error: 'Blob exceeds 50 MB limit' }, 'application/json', { connection: 'close' });
        }
        throw err;
      }
      if (!buf.length) return send(res, 400, { error: 'Empty blob upload' });
      let rawName = '';
      const hdrName = req.headers['x-file-name'];
      if (hdrName) {
        try {
          rawName = decodeURIComponent(Array.isArray(hdrName) ? hdrName[0] : hdrName);
        } catch {
          rawName = String(Array.isArray(hdrName) ? hdrName[0] : hdrName);
        }
      }
      const name = (rawName || url.searchParams.get('name') || 'attachment.bin').replace(/[/\\]/g, '_').trim();
      const hdrType = String(req.headers['content-type'] || '').trim();
      const extMime = EXT_BLOB_MIMES[path.extname(name).toLowerCase()];
      const mime = !hdrType || hdrType === 'application/octet-stream' ? extMime || 'application/octet-stream' : hdrType;
      const blobId = createHash('sha256').update(buf).digest('hex');
      fs.mkdirSync(BLOBS_DIR, { recursive: true });
      const dest = path.join(BLOBS_DIR, blobId);
      if (!fs.existsSync(dest)) {
        const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, dest);
      }
      const now = Date.now();
      const refCounts = blobRefCounts(store.state?.data);
      const prevMeta = readBlobMeta(blobId);
      const liveLeases = Array.isArray(prevMeta?.leases) ? prevMeta.leases.filter(exp => exp > now) : [];
      liveLeases.push(now + blobLeaseMs);
      const pending = refCounts.has(blobId) ? false : prevMeta ? prevMeta.pending !== false : true;
      writeBlobMeta(blobId, {
        name: prevMeta?.name || name,
        mime: prevMeta?.mime || mime,
        sizeBytes: buf.length,
        pending,
        leases: liveLeases,
      });
      scheduleSweep(blobLeaseMs);
      const qp = new URLSearchParams({ name, mime });
      return send(res, 201, {
        blobId,
        url: `/api/blobs/${blobId}?${qp.toString()}`,
        name,
        mime,
        sizeBytes: buf.length,
      });
    }
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
      const prevCounts = blobRefCounts(store.state?.data);
      const nextState = structuredClone(state);
      const { changed: blobSanitized, droppedFiles } = sanitizeStateBlobs(nextState.data, prevCounts, hasBlob);
      commitState(nextState, { isFullSync: true });
      return send(res, 200, {
        rev: store.rev,
        ...(blobSanitized ? { merged: true, state: store.state } : {}),
        ...(droppedFiles.length ? { droppedFiles } : {}),
      });
    }
    return handleDomainApi({ req, res, url, getStore: () => store, commitState, readBody, send, hasBlob });
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
            for (const tm of sweepTimers) clearTimeout(tm);
            sweepTimers.clear();
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
