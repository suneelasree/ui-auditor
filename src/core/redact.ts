// Keeps secrets out of logs, reports and progress messages.

const secrets = new Set<string>();

/** Register a value that must never be written anywhere. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 3) secrets.add(value);
}

export function unregisterSecret(value: string | undefined | null): void {
  if (value) secrets.delete(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  return out;
}

/** Redact every string value inside a plain JSON-like value. Keys and non-string values are left alone. */
export function redactDeep<T>(value: T): T {
  if (secrets.size === 0) return value;
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
  }
  return value;
}
