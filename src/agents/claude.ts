// Thin wrapper around the Anthropic SDK. Agents depend on the LlmClient interface,
// so tests can pass a fake and the engine runs without an API key.
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';

export type LlmContent =
  | { type: 'text'; text: string }
  | { type: 'image'; path: string };

export interface LlmJsonRequest<S extends z.ZodType> {
  system: string;
  content: LlmContent[];
  schema: S;
  maxTokens?: number;
}

export interface LlmClient {
  readonly model: string;
  json<S extends z.ZodType>(req: LlmJsonRequest<S>): Promise<z.infer<S>>;
}

export class LlmRefusalError extends Error {}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

/** Placeholder values copied from .env.example count as "no key". */
function realKey(v: string | undefined): boolean {
  return !!v && !/^your[-_]/i.test(v);
}

/** Returns null when no Anthropic credentials are configured; callers then skip AI agents. */
export function createLlmClient(env: NodeJS.ProcessEnv = process.env): LlmClient | null {
  if (!realKey(env.ANTHROPIC_API_KEY) && !realKey(env.ANTHROPIC_AUTH_TOKEN)) return null;
  const model = env.UIA_MODEL || 'claude-opus-5-5';
  const effort: Effort = EFFORTS.includes(env.UIA_EFFORT as Effort) ? (env.UIA_EFFORT as Effort) : 'high';
  const client = new Anthropic();

  return {
    model,
    async json(req) {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: req.maxTokens ?? 16000,
        // Server-side fallback: if a safety classifier declines, the API re-runs on a recommended model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort, format: betaZodOutputFormat(req.schema) },
        system: req.system,
        messages: [{ role: 'user', content: req.content.map(toBlock) }],
      } as Parameters<typeof client.beta.messages.parse>[0]);

      if (response.stop_reason === 'refusal') throw new LlmRefusalError('Model declined the request');
      if (response.stop_reason === 'max_tokens') throw new Error('Response hit max_tokens before finishing; raise maxTokens or lower UIA_EFFORT');
      if (response.parsed_output == null) throw new Error(`No parseable output (stop_reason: ${response.stop_reason})`);
      return response.parsed_output as z.infer<typeof req.schema>;
    },
  };
}

// The API rejects images over 8000px on a side or 5 MB; skip those rather than fail the whole agent.
const MAX_IMAGE_SIDE = 8000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function toBlock(c: LlmContent): Anthropic.Beta.BetaContentBlockParam {
  if (c.type === 'text') return { type: 'text', text: c.text };
  const data = readFileSync(c.path);
  const isPng = data.length > 24 && data.readUInt32BE(12) === 0x49484452; // "IHDR"
  const tooBig = data.length > MAX_IMAGE_BYTES || (isPng && Math.max(data.readUInt32BE(16), data.readUInt32BE(20)) > MAX_IMAGE_SIDE);
  if (tooBig) return { type: 'text', text: '(Screenshot omitted: larger than the image size limit.)' };
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: data.toString('base64') } };
}
