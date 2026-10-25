import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';

const parse = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    beta = { messages: { parse } };
  },
}));
const { createLlmClient, LlmRefusalError } = await import('../../src/agents/claude.js');

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

describe('createLlmClient', () => {
  let dir: string;
  beforeEach(() => {
    parse.mockReset();
    dir = mkdtempSync(join(tmpdir(), 'uia-claude-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null without a key or with the .env.example placeholder', () => {
    expect(createLlmClient({})).toBeNull();
    expect(createLlmClient({ ANTHROPIC_API_KEY: 'your-anthropic-api-key' })).toBeNull();
  });

  it('defaults to claude-opus-5-5, adaptive thinking, high effort, structured output and server fallback', async () => {
    parse.mockResolvedValue({ stop_reason: 'end_turn', parsed_output: { ok: true } });
    const llm = createLlmClient({ ANTHROPIC_API_KEY: 'sk-test', UIA_EFFORT: 'bogus' })!;
    expect(llm.model).toBe('claude-opus-5-5');
    await expect(llm.json({ system: 's', content: [{ type: 'text', text: 'hi' }], schema: z.object({ ok: z.boolean() }) })).resolves.toEqual({ ok: true });
    const req = parse.mock.calls[0][0];
    expect(req).toMatchObject({ model: 'claude-opus-5-5', thinking: { type: 'adaptive' }, fallbacks: 'default', output_config: { effort: 'high' } });
    expect(req.output_config.format).toBeTruthy();
  });

  it('throws on refusal and on max_tokens', async () => {
    const llm = createLlmClient({ ANTHROPIC_API_KEY: 'sk-test' })!;
    const req = { system: 's', content: [{ type: 'text' as const, text: 'x' }], schema: z.object({}) };
    parse.mockResolvedValueOnce({ stop_reason: 'refusal', parsed_output: null });
    await expect(llm.json(req)).rejects.toBeInstanceOf(LlmRefusalError);
    parse.mockResolvedValueOnce({ stop_reason: 'max_tokens', parsed_output: null });
    await expect(llm.json(req)).rejects.toThrow(/max_tokens/);
  });

  it('sends normal screenshots as images and replaces oversized ones with a note', async () => {
    writeFileSync(join(dir, 'ok.png'), png(1440, 900));
    writeFileSync(join(dir, 'tall.png'), png(1440, 12000));
    parse.mockResolvedValue({ stop_reason: 'end_turn', parsed_output: {} });
    const llm = createLlmClient({ ANTHROPIC_API_KEY: 'sk-test' })!;
    await llm.json({ system: 's', content: [{ type: 'image', path: join(dir, 'ok.png') }, { type: 'image', path: join(dir, 'tall.png') }], schema: z.object({}) });
    const blocks = parse.mock.calls[0][0].messages[0].content;
    expect(blocks[0].type).toBe('image');
    expect(blocks[1]).toEqual({ type: 'text', text: expect.stringContaining('omitted') });
  });
});
