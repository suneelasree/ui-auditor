import { afterEach, describe, expect, it } from 'vitest';
import { redact, redactDeep, registerSecret, unregisterSecret } from '../../src/core/redact.js';

const used: string[] = [];
const secret = (s: string) => {
  used.push(s);
  registerSecret(s);
};
afterEach(() => used.splice(0).forEach(unregisterSecret));

describe('redaction', () => {
  it('redacts secrets containing quotes and backslashes', () => {
    secret('pa"ss\\word');
    expect(redactDeep({ msg: 'login with pa"ss\\word failed' })).toEqual({ msg: 'login with [REDACTED] failed' });
  });

  it('leaves keys and numbers alone when a secret matches them', () => {
    secret('page');
    secret('100');
    expect(redactDeep({ page: '/a', score: 100, note: 'page 100' })).toEqual({ page: '/a', score: 100, note: '[REDACTED] [REDACTED]' });
  });

  it('redacts nested arrays and plain strings', () => {
    secret('hunter22');
    expect(redactDeep({ a: [{ b: 'x hunter22' }] })).toEqual({ a: [{ b: 'x [REDACTED]' }] });
    expect(redact('hunter22!')).toBe('[REDACTED]!');
  });
});
