// Fastify app for the Web UI. Built by buildServer() so tests can inject a fake engine and fake fetch.
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AuditOptions, type Credentials, type ProgressEvent, type Report } from '../core/types.js';
import { redact } from '../core/redact.js';
import type { RunAuditInput } from '../engine/runAudit.js';
import { ExportError, ExportService } from '../export/service.js';
import { scrubSecrets } from '../export/config.js';
import { ActiveRun, isTerminal, listRuns, readMeta, readProgressFile, readReport, runDirFor } from './runs.js';
import { SessionStore, originOf } from '../sessions/store.js';
import { SignInManager, type SignInLauncher } from '../sessions/signin.js';

export type RunAuditFn = (input: RunAuditInput) => Promise<Report>;
type NewRunIdFn = () => string;

export interface BuildServerOptions {
  reportsDir: string;
  /** Engine entry point; defaults to the real runAudit, imported lazily. */
  runAudit?: RunAuditFn;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Directory with the built frontend; defaults to <repo>/web/dist. */
  webDist?: string;
  logger?: boolean;
  /** Where saved sign-in sessions live; defaults to <cwd>/.auth/sessions. */
  sessionsDir?: string;
  /** Does the page show a sign-in form? Defaults to a headless browser check. */
  checkAccess?: (url: string, sessionPath?: string) => Promise<{ needsSignIn: boolean }>;
  /** Opens a visible window for the user to sign in; defaults to a real Chromium window. */
  signInLauncher?: SignInLauncher;
}

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_DIST = resolve(here, '../../web/dist');

const CredentialsSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
const StartBody = z
  .object({ options: z.unknown().optional(), credentials: CredentialsSchema.optional(), useSession: z.boolean().optional() })
  .passthrough();
const UrlBody = z.object({ url: z.string().url().refine((u) => originOf(u) !== null, 'Must be an http(s) URL') });
const ExportBody = z.object({
  target: z.enum(['github', 'jira']),
  findingIds: z.array(z.string().min(1)).min(1).max(200),
  previewToken: z.string().optional(),
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

function zodIssues(err: z.ZodError) {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

function newRunIdLocal(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${stamp}-${Math.random().toString(16).slice(2, 8)}`;
}

export function buildServer(opts: BuildServerOptions): FastifyInstance {
  const env = opts.env ?? process.env;
  const reportsDir = resolve(opts.reportsDir);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const webDist = opts.webDist ?? DEFAULT_WEB_DIST;
  const exportsSvc = new ExportService(reportsDir, env, fetchImpl);
  mkdirSync(reportsDir, { recursive: true });
  const sessions = new SessionStore(resolve(opts.sessionsDir ?? join(process.cwd(), '.auth', 'sessions')));
  const checkAccess = opts.checkAccess ?? (async (url: string, sessionPath?: string) => (await import('../sessions/browser.js')).checkAccess(url, sessionPath));
  const signIns = new SignInManager(sessions, opts.signInLauncher ?? (async (url) => (await import('../sessions/browser.js')).openSignInWindow(url)));

  const app = Fastify({
    // Only method + URL are ever logged; bodies (which may hold credentials) never are.
    logger: opts.logger
      ? { serializers: { req: (req) => ({ method: req.method, url: req.url }), res: (res) => ({ statusCode: res.statusCode }) } }
      : false,
    bodyLimit: 256 * 1024,
  });

  const clean = (s: string) => redact(scrubSecrets(s, env));

  // The API holds export tokens, so only answer local requests (blocks DNS rebinding) and
  // refuse state-changing calls made from other origins (blocks cross-site requests).
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...(env.UIA_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]);
  app.addHook('onRequest', async (req, reply) => {
    if (!allowedHosts.has(req.hostname.toLowerCase())) return reply.code(403).send({ error: 'Host not allowed' });
    const origin = req.headers.origin;
    if (req.method !== 'GET' && req.method !== 'HEAD' && origin) {
      let ok: boolean;
      try {
        ok = new URL(origin).host === req.host;
      } catch {
        ok = false;
      }
      if (!ok) return reply.code(403).send({ error: 'Cross-origin request refused' });
    }
  });

  app.setErrorHandler((err: { statusCode?: number; message?: string }, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({ error: clean(err.message ?? 'Internal error') });
  });

  let active: ActiveRun | undefined;

  async function resolveEngine(): Promise<{ run: RunAuditFn; newId: NewRunIdFn }> {
    if (opts.runAudit) return { run: opts.runAudit, newId: newRunIdLocal };
    const mod = await import('../engine/runAudit.js');
    return { run: mod.runAudit, newId: mod.newRunId };
  }

  // ---------- API ----------

  app.get('/api/config', async () => ({ targets: exportsSvc.configured() }));

  app.post('/api/audits', async (req, reply) => {
    const body = StartBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Invalid request', issues: zodIssues(body.error) });
    const { credentials: bodyCreds, options: nested, useSession, ...flat } = body.data;
    const parsed = AuditOptions.safeParse(nested ?? flat);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid audit options', issues: zodIssues(parsed.error) });
    const options = parsed.data;

    let credentials: Credentials | undefined;
    if (options.login) {
      credentials = bodyCreds ?? (env.UIA_LOGIN_USER && env.UIA_LOGIN_PASSWORD ? { username: env.UIA_LOGIN_USER, password: env.UIA_LOGIN_PASSWORD } : undefined);
      if (!credentials) {
        return reply.code(400).send({
          error: 'Login is configured but no credentials were given. Enter a username and password or set UIA_LOGIN_USER and UIA_LOGIN_PASSWORD in .env.',
          issues: [{ path: 'credentials', message: 'Required when login is set' }],
        });
      }
    }

    if (active && !active.finished) {
      return reply.code(409).send({ error: 'An audit is already running. Wait for it to finish.', id: active.id });
    }
    // A session the user saved by signing in through the Web UI; a username/password login wins if both are set.
    const sessionStatePath = useSession === false || credentials ? undefined : sessions.find(options.url);

    const engine = await resolveEngine();
    const id = engine.newId();
    const run = new ActiveRun(id);
    active = run;
    const onProgress = (e: ProgressEvent) => run.push(e);
    // Run in the background; credentials stay in this closure only.
    void (async () => {
      try {
        await engine.run({ options, credentials, sessionStatePath, reportsDir, runId: id, onProgress });
        if (!run.finished) run.push({ runId: id, ts: new Date().toISOString(), stage: 'done', status: 'done', message: 'Audit complete', pct: 100 });
      } catch (err) {
        if (!run.finished) {
          run.push({ runId: id, ts: new Date().toISOString(), stage: 'error', status: 'failed', message: clean(err instanceof Error ? err.message : String(err)) });
        }
        app.log.error({ runId: id, err: clean(err instanceof Error ? err.message : String(err)) }, 'audit failed');
      } finally {
        run.finish();
      }
    })();
    return reply.code(202).send({ id, usedSession: Boolean(sessionStatePath) });
  });

  // ---------- Sign-in and saved sessions (see docs/SIGNIN_API.md) ----------

  app.post('/api/check', async (req, reply) => {
    const body = UrlBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Invalid URL', issues: zodIssues(body.error) });
    const { url } = body.data;
    const sessionPath = sessions.find(url);
    try {
      const { needsSignIn } = await checkAccess(url, sessionPath);
      return { origin: originOf(url), needsSignIn, hasSession: Boolean(sessionPath) };
    } catch (err) {
      return reply.code(502).send({ error: `Could not open the page: ${clean(err instanceof Error ? err.message : String(err))}` });
    }
  });

  app.post('/api/signin', async (req, reply) => {
    const body = UrlBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Invalid URL', issues: zodIssues(body.error) });
    try {
      const state = await signIns.start(body.data.url);
      return reply.code(202).send({ id: state.id });
    } catch (err) {
      const running = (err as { running?: string }).running;
      if (running) return reply.code(409).send({ error: 'A sign-in window is already open', id: running });
      return reply.code(500).send({ error: `Could not open a browser window: ${clean(err instanceof Error ? err.message : String(err))}` });
    }
  });

  app.get<{ Params: { id: string } }>('/api/signin/:id', async (req, reply) => signIns.get(req.params.id) ?? reply.code(404).send({ error: 'Not found' }));

  app.post<{ Params: { id: string } }>('/api/signin/:id/done', async (req, reply) => (await signIns.done(req.params.id)) ?? reply.code(404).send({ error: 'Not found' }));

  app.delete<{ Params: { id: string } }>('/api/signin/:id', async (req, reply) => (await signIns.cancel(req.params.id)) ?? reply.code(404).send({ error: 'Not found' }));

  app.get('/api/sessions', async () => ({ sessions: sessions.list() }));

  app.delete<{ Querystring: { origin?: string } }>('/api/sessions', async (req, reply) => {
    const origin = originOf(req.query.origin ?? '');
    if (!origin) return reply.code(400).send({ error: 'origin must be an http(s) origin' });
    return { ok: sessions.forget(origin) };
  });

  app.get('/api/audits', async () => ({ runs: listRuns(reportsDir) }));

  app.get<{ Params: { id: string } }>('/api/audits/:id', async (req, reply) => {
    const dir = runDirFor(reportsDir, req.params.id);
    const meta = dir ? readMeta(dir) : undefined;
    if (!dir || !meta) {
      if (active && active.id === req.params.id && !active.finished) {
        return { meta: { id: active.id, url: '', status: 'running', createdAt: new Date().toISOString() }, report: null, exported: {} };
      }
      return reply.code(404).send({ error: 'Run not found' });
    }
    const report = readReport(dir) ?? null;
    return { meta, report, exported: report ? exportsSvc.exportedFor(report) : {} };
  });

  app.get<{ Params: { id: string } }>('/api/audits/:id/events', async (req, reply) => {
    const id = req.params.id;
    const dir = runDirFor(reportsDir, id);
    const live = active && active.id === id ? active : undefined;
    if (!dir || (!live && !existsSync(join(dir, 'meta.json')))) return reply.code(404).send({ error: 'Run not found' });

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (e: ProgressEvent) => raw.write(`data: ${JSON.stringify(e)}\n\n`);
    const end = () => {
      raw.write(`event: end\ndata: {}\n\n`);
      raw.end();
    };

    if (live && !live.finished) {
      // In-memory events mirror progress.jsonl exactly for the active run.
      for (const e of live.events) send(e);
      const onEvent = (e: ProgressEvent) => send(e);
      const ping = setInterval(() => raw.write(': ping\n\n'), 15000);
      const cleanup = () => {
        clearInterval(ping);
        live.off('event', onEvent);
        live.off('end', onEnd);
      };
      const onEnd = () => {
        cleanup();
        end();
      };
      live.on('event', onEvent);
      live.once('end', onEnd);
      req.raw.on('close', cleanup);
      return;
    }

    const events = live ? live.events : readProgressFile(dir);
    for (const e of events) send(e);
    if (!events.some(isTerminal)) {
      const meta = readMeta(dir);
      if (meta && meta.status !== 'running') {
        send({ runId: id, ts: meta.finishedAt ?? new Date().toISOString(), stage: meta.status === 'done' ? 'done' : 'error', status: meta.status === 'done' ? 'done' : 'failed', message: meta.error ?? `Run ${meta.status}` });
      } else {
        send({ runId: id, ts: new Date().toISOString(), stage: 'error', status: 'failed', message: 'Run is not active in this server (it may have been interrupted).' });
      }
    }
    end();
  });

  app.post<{ Params: { id: string } }>('/api/audits/:id/export/preview', async (req, reply) => {
    const body = ExportBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Invalid request', issues: zodIssues(body.error) });
    const dir = runDirFor(reportsDir, req.params.id);
    const report = dir ? readReport(dir) : undefined;
    if (!dir || !report) return reply.code(404).send({ error: 'Report not found' });
    const reportUrl = `${req.protocol}://${req.host}/reports/${req.params.id}/report.html`;
    try {
      return exportsSvc.preview(report, dir, body.data.target, body.data.findingIds, reportUrl);
    } catch (err) {
      return sendExportError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/api/audits/:id/export/confirm', async (req, reply) => {
    const body = ExportBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Invalid request', issues: zodIssues(body.error) });
    if (!runDirFor(reportsDir, req.params.id)) return reply.code(404).send({ error: 'Report not found' });
    try {
      return await exportsSvc.confirm(req.params.id, body.data.target, body.data.findingIds, body.data.previewToken);
    } catch (err) {
      return sendExportError(reply, err);
    }
  });

  function sendExportError(reply: FastifyReply, err: unknown) {
    if (err instanceof ExportError) return reply.code(err.statusCode).send({ error: clean(err.message) });
    throw err;
  }

  // ---------- Run files (report.html, evidence, designs) ----------

  app.get<{ Params: { id: string; '*': string } }>('/reports/:id/*', async (req, reply) => {
    const dir = runDirFor(reportsDir, req.params.id);
    const rel = req.params['*'] ?? '';
    if (!dir || !rel || rel.includes('\0')) return reply.code(404).send({ error: 'Not found' });
    let decoded: string;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      return reply.code(400).send({ error: 'Bad path' });
    }
    const file = resolve(dir, decoded);
    if (!file.startsWith(dir + sep) || decoded.split(/[\\/]/).some((p) => p === '..' || p.startsWith('.'))) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    let st;
    try {
      st = statSync(file);
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
    if (!st.isFile()) return reply.code(404).send({ error: 'Not found' });
    reply.header('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
    reply.header('Content-Length', st.size);
    reply.header('X-Content-Type-Options', 'nosniff');
    // Run folders hold third-party HTML (DOM snapshots, AI mockups). Sandbox everything so it runs in an
    // opaque origin and can't call this API; only the report itself may run its own filter script.
    reply.header('Content-Security-Policy', decoded === 'report.html' ? 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox' : 'sandbox');
    return reply.send(createReadStream(file));
  });

  // ---------- Frontend ----------

  if (existsSync(join(webDist, 'index.html'))) {
    app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: true });
  } else {
    const msg = 'The web UI has not been built yet. Run "npm run build:web" (or "npm start", which builds it), then reload.';
    app.get('/', async (_req, reply) =>
      reply.type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><title>UI Auditor</title><p style="font-family:system-ui;padding:2rem">${msg}</p>`),
    );
  }

  return app;
}
