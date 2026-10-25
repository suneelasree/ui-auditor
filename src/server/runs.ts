// Run bookkeeping: on-disk run folders plus the in-process active run and its live progress events.
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { ProgressEvent, Report } from '../core/types.js';
import type { RunMeta } from '../engine/runAudit.js';

export const RUN_ID_RE = /^[A-Za-z0-9-]+$/;

export function isValidRunId(id: string): boolean {
  return RUN_ID_RE.test(id) && id.length <= 100;
}

/** Absolute run dir, or undefined if the id is invalid or escapes reportsDir. */
export function runDirFor(reportsDir: string, id: string): string | undefined {
  if (!isValidRunId(id)) return undefined;
  const root = resolve(reportsDir);
  const dir = resolve(root, id);
  if (!dir.startsWith(root + sep)) return undefined;
  return dir;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function readMeta(runDir: string): RunMeta | undefined {
  return readJson<RunMeta>(join(runDir, 'meta.json'));
}

export function readReport(runDir: string): Report | undefined {
  return readJson<Report>(join(runDir, 'report.json'));
}

export function readProgressFile(runDir: string): ProgressEvent[] {
  const file = join(runDir, 'progress.jsonl');
  if (!existsSync(file)) return [];
  const out: ProgressEvent[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ProgressEvent);
    } catch {
      /* partial line */
    }
  }
  return out;
}

export function listRuns(reportsDir: string): RunMeta[] {
  if (!existsSync(reportsDir)) return [];
  const runs: RunMeta[] = [];
  for (const name of readdirSync(reportsDir)) {
    const dir = runDirFor(reportsDir, name);
    if (!dir) continue;
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const meta = readMeta(dir);
    if (meta) runs.push(meta);
  }
  return runs.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

export function isTerminal(e: ProgressEvent): boolean {
  return e.stage === 'done' || e.stage === 'error';
}

export class ActiveRun extends EventEmitter {
  readonly events: ProgressEvent[] = [];
  finished = false;

  constructor(readonly id: string) {
    super();
    this.setMaxListeners(100);
  }

  push(e: ProgressEvent): void {
    this.events.push(e);
    this.emit('event', e);
    if (isTerminal(e)) this.finish();
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.emit('end');
  }
}
