// Web UI server entry point: `tsx src/server/index.ts` (npm start).
import 'dotenv/config';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildServer } from './app.js';

export { buildServer } from './app.js';
export type { BuildServerOptions, RunAuditFn } from './app.js';

async function main(): Promise<void> {
  const port = Number(process.env.PORT) || 3000;
  const reportsDir = resolve(process.env.REPORTS_DIR || resolve(process.cwd(), 'reports'));
  const { runAudit } = await import('../engine/runAudit.js');
  const app = buildServer({ reportsDir, runAudit, logger: true });
  await app.listen({ port, host: '127.0.0.1' });
  console.log(`UI Auditor running at http://localhost:${port}  (reports: ${reportsDir})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
