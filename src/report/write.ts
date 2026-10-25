import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Report } from '../core/types.js';
import { renderHtml } from './html.js';
import { renderMarkdown } from './markdown.js';

/** Write report.html, report.json and report.md into runDir; returns absolute paths. */
export async function writeReport(report: Report, runDir: string): Promise<{ html: string; json: string; md: string }> {
  const dir = resolve(runDir);
  await mkdir(dir, { recursive: true });
  const paths = { html: join(dir, 'report.html'), json: join(dir, 'report.json'), md: join(dir, 'report.md') };
  await Promise.all([
    writeFile(paths.html, renderHtml(report, dir), 'utf8'),
    writeFile(paths.json, JSON.stringify(report, null, 2) + '\n', 'utf8'),
    writeFile(paths.md, renderMarkdown(report), 'utf8'),
  ]);
  return paths;
}
