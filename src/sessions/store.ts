// Saved sign-in sessions, one Playwright storage-state file per site origin.
// They hold cookies, so they live under .auth/ (git-ignored) and can be forgotten from the UI.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface SavedSession {
  origin: string;
  savedAt: string;
}

export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

/** "https://app.example.com" -> "https_app.example.com.json" (ports kept, nothing else). */
function fileName(origin: string): string {
  return origin.replace('://', '_').replace(/[^\w.-]/g, '_') + '.json';
}

export class SessionStore {
  constructor(readonly dir: string) {}

  pathFor(origin: string): string {
    return join(this.dir, fileName(origin));
  }

  /** Path to the saved state for this URL's site, or undefined if none. */
  find(url: string): string | undefined {
    const origin = originOf(url);
    if (!origin) return undefined;
    const p = this.pathFor(origin);
    return existsSync(p) ? p : undefined;
  }

  /** Where a new session for this origin should be written (creates the folder). */
  prepare(origin: string): string {
    mkdirSync(this.dir, { recursive: true });
    return this.pathFor(origin);
  }

  list(): SavedSession[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const origin = f.replace(/\.json$/, '').replace(/^(https?)_/, '$1://');
        return { origin, savedAt: statSync(join(this.dir, f)).mtime.toISOString() };
      })
      .sort((a, b) => a.origin.localeCompare(b.origin));
  }

  forget(origin: string): boolean {
    const p = this.pathFor(origin);
    if (!existsSync(p)) return false;
    rmSync(p, { force: true });
    return true;
  }
}
