// Local fixture sites with seeded defects. `npm run fixtures` starts them on 4100/4200.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import type { AddressInfo } from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
const RE_ROOT = join(HERE, 'real-estate-site');
const COMP_ROOT = join(HERE, 'competitor-site');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

/** Clean URL -> file for the real-estate site. */
const RE_ROUTES: Record<string, string> = {
  '/': 'index.html',
  '/listings': 'listings.html',
  '/listings/42-harbor-view-drive': 'listing.html',
  '/about': 'about.html',
  '/contact': 'contact.html',
  '/privacy': 'privacy.html',
  '/login': 'login.html',
};

const COMP_ROUTES: Record<string, string> = {
  '/': 'index.html',
  '/listings': 'listings.html',
  '/mortgage-calculator': 'mortgage-calculator.html',
  '/about': 'about.html',
  '/contact': 'contact.html',
};

export const FIXTURE_LOGIN = JSON.parse(readFileSync(join(RE_ROOT, 'fixture-login.json'), 'utf8')) as {
  username: string;
  password: string;
};

// ---- Oversized PNG (SD-11), generated once at runtime so the repo stays small ----
let teamPhoto: Buffer | null = null;
function makePng(width: number, height: number): Buffer {
  const rowLen = width * 3 + 1;
  const raw = Buffer.alloc(rowLen * height);
  let seed = 1234567;
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0;
    for (let x = 0; x < width; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const noise = seed & 0x3f;
      const o = y * rowLen + 1 + x * 3;
      raw[o] = (60 + ((x * 120) / width) + noise) & 0xff;
      raw[o + 1] = (90 + ((y * 100) / height) + noise) & 0xff;
      raw[o + 2] = (150 + noise) & 0xff;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function send(req: IncomingMessage, res: ServerResponse, status: number, body: Buffer | string, type: string, extra: Record<string, string> = {}) {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': String(buf.length), ...extra });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function redirect(res: ServerResponse, location: string, status = 302, extra: Record<string, string> = {}) {
  res.writeHead(status, { Location: location, 'Content-Length': '0', ...extra });
  res.end();
}

function notFound(req: IncomingMessage, res: ServerResponse) {
  send(req, res, 404, '<!doctype html><html lang="en"><head><title>Not found</title></head><body><h1>404 Not found</h1></body></html>', MIME['.html']!);
}

/** Serve `root/<rel>` if it exists and stays inside root. */
function serveFile(req: IncomingMessage, res: ServerResponse, root: string, rel: string, extra: Record<string, string> = {}): boolean {
  const file = resolve(root, normalize(rel).replace(/^([/\\])+/, ''));
  if (!(file + sep).startsWith(resolve(root) + sep) && file !== resolve(root)) return false;
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  send(req, res, 200, readFileSync(file), MIME[extname(file)] ?? 'application/octet-stream', extra);
  return true;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c.toString('utf8');
      if (data.length > 1e5) req.destroy();
    });
    req.on('end', () => resolveBody(data));
    req.on('error', reject);
  });
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = v.join('=');
  }
  return out;
}

/** rotateSessions: like many real apps, each signed-in page view issues a new session token and invalidates the old one. */
function realEstateHandler(rotateSessions = false) {
  const sessions = new Set<string>();
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const authed = sessions.has(cookies(req)['hh_session'] ?? '');

    if (req.method === 'POST' && path === '/login') {
      const form = new URLSearchParams(await readBody(req));
      if (form.get('username') === FIXTURE_LOGIN.username && form.get('password') === FIXTURE_LOGIN.password) {
        const token = randomBytes(16).toString('hex');
        sessions.add(token);
        return redirect(res, '/account', 303, { 'Set-Cookie': `hh_session=${token}; HttpOnly; Path=/; SameSite=Lax` });
      }
      return redirect(res, '/login?error=1', 303);
    }
    if (req.method === 'POST' && path === '/contact') {
      await readBody(req);
      return redirect(res, '/contact?sent=1', 303);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Method not allowed', MIME['.txt']!);

    if (path === '/logout') {
      sessions.delete(cookies(req)['hh_session'] ?? '');
      return redirect(res, '/', 302, { 'Set-Cookie': 'hh_session=; HttpOnly; Path=/; Max-Age=0' });
    }
    if (path === '/account') {
      if (!authed) return redirect(res, '/login');
      const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
      if (rotateSessions) {
        sessions.delete(cookies(req)['hh_session'] ?? '');
        const next = randomBytes(16).toString('hex');
        sessions.add(next);
        headers['Set-Cookie'] = `hh_session=${next}; HttpOnly; Path=/; SameSite=Lax`;
      }
      if (serveFile(req, res, RE_ROOT, 'account.html', headers)) return;
    }
    if (path === '/admin') return send(req, res, 200, '<!doctype html><html lang="en"><head><title>Staff</title></head><body><h1>Staff portal</h1></body></html>', MIME['.html']!);
    if (path === '/images/team-photo.png') {
      teamPhoto ??= makePng(2400, 1600);
      return send(req, res, 200, teamPhoto, MIME['.png']!);
    }
    if (RE_ROUTES[path] && serveFile(req, res, RE_ROOT, RE_ROUTES[path]!)) return;
    if (path === '/robots.txt' || /^\/(css|js|images)\//.test(path)) {
      if (serveFile(req, res, RE_ROOT, path)) return;
    }
    notFound(req, res);
  };
}

function competitorHandler() {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    if (req.method === 'POST') {
      await readBody(req);
      return redirect(res, path + '?sent=1', 303);
    }
    if (COMP_ROUTES[path] && serveFile(req, res, COMP_ROOT, COMP_ROUTES[path]!, headers)) return;
    if (/^\/(css|images)\//.test(path) && serveFile(req, res, COMP_ROOT, path, headers)) return;
    if (path === '/robots.txt') return send(req, res, 200, 'User-agent: *\nAllow: /\n', MIME['.txt']!);
    notFound(req, res);
  };
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>, port: number): Promise<Server> {
  return new Promise((resolveServer, reject) => {
    const server = createServer((req, res) => {
      handler(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolveServer(server));
  });
}

export async function startFixtures(opts: { realEstatePort?: number; competitorPort?: number; rotateSessions?: boolean } = {}): Promise<{
  realEstateUrl: string;
  competitorUrl: string;
  close(): Promise<void>;
}> {
  const re = await listen(realEstateHandler(opts.rotateSessions), opts.realEstatePort ?? 0);
  const comp = await listen(competitorHandler(), opts.competitorPort ?? 0);
  const url = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return {
    realEstateUrl: url(re),
    competitorUrl: url(comp),
    close: async () => {
      const stop = (s: Server) =>
        new Promise<void>((r) => {
          s.closeAllConnections?.();
          s.close(() => r());
        });
      await Promise.all([stop(re), stop(comp)]);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const f = await startFixtures({ realEstatePort: 4100, competitorPort: 4200 });
  console.log(`Harbor Homes (real-estate fixture): ${f.realEstateUrl}`);
  console.log(`Bayview Realty (competitor fixture): ${f.competitorUrl}`);
  console.log('Press Ctrl+C to stop.');
}
