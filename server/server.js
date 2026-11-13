/* Self-hosted server for Gr8r Studio: serves the built app and keeps the
   authoritative synced workspace state. See README "Self-hosting".

   GR8R_TOKEN=<secret> npm start
   Environment: PORT (4180), HOST (0.0.0.0), GR8R_TOKEN (required),
   GR8R_DATA (state file), DIST (static directory). */
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function readStore(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && typeof j.rev === 'number') return { rev: j.rev, state: j.state ?? null };
  } catch {
    /* first boot or unreadable file: start empty */
  }
  return { rev: 0, state: null };
}
function writeStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, file);
}

export function startServer({ port = 0, host = '127.0.0.1', token, dataFile, distDir }) {
  if (!token) throw new Error('startServer: token is required');
  const tokenKey = createHash('sha256').update(token).digest();
  const DATA = dataFile || path.join(HERE, 'data', 'state.json');
  const DIST = distDir || path.join(HERE, '..', 'dist');
  let store = readStore(DATA);

  const authorized = req => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return !!m && timingSafeEqual(createHash('sha256').update(m[1]).digest(), tokenKey);
  };
  const send = (res, code, body, type = 'application/json') => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(code, { 'content-type': type, 'content-length': buf.length });
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
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
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
      store = { rev: store.rev + 1, state };
      writeStore(DATA, store);
      return send(res, 200, { rev: store.rev });
    }
    return send(res, 404, { error: 'not found' });
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
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      api(req, res, url).catch(e => {
        console.error(e);
        if (!res.headersSent) send(res, 500, { error: 'internal' });
      });
      return;
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    serveStatic(res, url);
  });

  return new Promise(resolve => {
    server.listen(port, host, () => resolve({ server, port: server.address().port, close: () => new Promise(done => server.close(done)) }));
  });
}

/* CLI entry */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.GR8R_TOKEN) {
    console.error('gr8r-server: GR8R_TOKEN is required (the sync bearer token).');
    process.exit(1);
  }
  const { port } = await startServer({
    port: +(process.env.PORT || 4180),
    host: process.env.HOST || '0.0.0.0',
    token: process.env.GR8R_TOKEN,
  });
  console.log(`gr8r-server: http://localhost:${port} (state in ${path.join(HERE, 'data', 'state.json')})`);
}
