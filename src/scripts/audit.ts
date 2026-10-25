// Internal headless runner for the GitHub Action and Claude Code /audit. Not a published CLI.
// Usage: npm run audit -- <url> [--depth 2] [--max-pages 15] [--domain auto] [--viewports desktop,tablet,mobile]
//        [--competitor <url>]... [--allow-forms] [--no-lighthouse] [--login-url <url>] [--login-choose <text>]...
//        [--login-success-url <text>] [--login-success-selector <css>] [--out ./reports] [--] <url>
import 'dotenv/config';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AuditOptions, type Credentials } from '../core/types.js';
import { runAudit } from '../engine/runAudit.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    depth: { type: 'string' },
    'max-pages': { type: 'string' },
    domain: { type: 'string' },
    viewports: { type: 'string' },
    competitor: { type: 'string', multiple: true },
    'allow-forms': { type: 'boolean' },
    'no-lighthouse': { type: 'boolean' },
    'login-url': { type: 'string' },
    'login-choose': { type: 'string', multiple: true },
    'login-success-url': { type: 'string' },
    'login-success-selector': { type: 'string' },
    out: { type: 'string' },
  },
});

const url = positionals[0];
if (!url) {
  console.error('Usage: npm run audit -- <url> [options]');
  process.exit(2);
}

const parsed = AuditOptions.safeParse({
  url,
  depth: values.depth ? Number(values.depth) : undefined,
  maxPages: values['max-pages'] ? Number(values['max-pages']) : undefined,
  domain: values.domain,
  viewports: values.viewports?.split(',').map((v) => v.trim()).filter(Boolean),
  competitors: (values.competitor ?? []).flatMap((c) => c.split(',')).map((c) => c.trim()).filter(Boolean),
  allowForms: values['allow-forms'] ?? false,
  lighthouse: !values['no-lighthouse'],
  login: values['login-url']
    ? {
        loginUrl: values['login-url'],
        afterLoginChoose: values['login-choose']?.flatMap((c) => c.split(',')).map((c) => c.trim()).filter(Boolean),
        successUrlContains: values['login-success-url'],
        successSelector: values['login-success-selector'],
      }
    : undefined,
});
if (!parsed.success) {
  console.error('Invalid options:\n' + parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(2);
}

let credentials: Credentials | undefined;
if (parsed.data.login) {
  const { UIA_LOGIN_USER: username, UIA_LOGIN_PASSWORD: password } = process.env;
  if (!username || !password) {
    console.error('--login-url needs UIA_LOGIN_USER and UIA_LOGIN_PASSWORD in the environment.');
    process.exit(2);
  }
  credentials = { username, password };
}

const reportsDir = resolve(values.out ?? 'reports');
try {
  const report = await runAudit({
    options: parsed.data,
    credentials,
    reportsDir,
    onProgress: (e) => console.log(`[${e.stage}]${e.agent ? ` ${e.agent}:` : ''} ${e.message}`),
  });
  const dir = resolve(reportsDir, report.id);
  console.log(`\nScore ${report.scores.overall}/100, ${report.findings.length} findings.`);
  console.log(`Report: ${resolve(dir, 'report.html')}`);
  console.log(`JSON:   ${resolve(dir, 'report.json')}`);
  console.log(`MD:     ${resolve(dir, 'report.md')}`);
} catch (err) {
  console.error(`Audit failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
