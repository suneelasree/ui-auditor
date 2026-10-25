// Remembers which findings were exported, so re-exports (even from later runs of the same site) are skipped.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ExportTarget } from './config.js';

export interface ExportRecord {
  key: string;
  url: string;
  exportedAt: string;
  runId: string;
}

export type ExportMap = Record<string, ExportRecord>;

/** scheme://host[:port], lowercased, default ports and a leading "www." dropped. */
export function normaliseOrigin(siteUrl: string): string {
  try {
    const u = new URL(siteUrl);
    return `${u.protocol}//${u.host.replace(/^www\./, '')}`;
  } catch {
    return siteUrl.trim().toLowerCase();
  }
}

export function exportKey(target: ExportTarget, siteUrl: string, fingerprint: string): string {
  return `${target}|${normaliseOrigin(siteUrl)}|${fingerprint}`;
}

export class ExportStore {
  readonly file: string;

  constructor(private readonly reportsDir: string) {
    this.file = join(reportsDir, 'exports.json');
  }

  load(): ExportMap {
    if (!existsSync(this.file)) return {};
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      return data && typeof data === 'object' && !Array.isArray(data) ? (data as ExportMap) : {};
    } catch {
      return {};
    }
  }

  get(target: ExportTarget, siteUrl: string, fingerprint: string): ExportRecord | undefined {
    return this.load()[exportKey(target, siteUrl, fingerprint)];
  }

  record(target: ExportTarget, siteUrl: string, fingerprint: string, rec: ExportRecord): void {
    const map = this.load();
    map[exportKey(target, siteUrl, fingerprint)] = rec;
    mkdirSync(this.reportsDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(map, null, 2));
    renameSync(tmp, this.file);
  }
}
