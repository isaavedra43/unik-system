import { z } from 'zod';
import { getProviderConfig } from '../ai-config';
import { recordAiApiCall } from '../ai-audit';

/**
 * Jev client — OpenRouter Decisions API (alpha).
 *
 * Jev (`typesafe/jev-1.13`) is a System One decision model: it never generates
 * prose. You send a `state` (string/object/array) plus typed questions and get
 * back typed answers with probabilities:
 *   - noul:   yes/no → probability of "yes" (0..1)
 *   - choice: picks exactly one of the options you list (+ confidence)
 *   - score:  position on an ordered rubric (+ confidence)
 *
 * Cost is ~$0.042/1M input tokens with free output, so a single request can
 * batch several questions where a chat model would need several calls.
 *
 * This file is the ONLY place that knows the wire format — the API is alpha
 * and may evolve; every call site goes through `decision-engine.ts`.
 */

export const JEV_DECISIONS_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const JEV_DEFAULT_MODEL = 'typesafe/jev-1.13';

export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** option key → human description of what it covers */
  criteria: Record<string, string>;
}

export interface JevScoreQuestion {
  type: 'score';
  instructions: string;
  /** Ordered rubric, worst → best (or vice versa — the point documents it). */
  criteria: string[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

const NoulAnswerSchema = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) });
const ChoiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});
const ScoreAnswerSchema = z.object({
  type: z.literal('score'),
  score: z.number(),
  confidence: z.number().min(0).max(1).optional(),
});
const AnswerSchema = z.union([NoulAnswerSchema, ChoiceAnswerSchema, ScoreAnswerSchema]);

const DecisionsResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), AnswerSchema),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cost: z.number().optional(),
  }),
});

export type JevAnswer = z.infer<typeof AnswerSchema>;
export type JevAnswers = Record<string, JevAnswer>;

export type JevErrorCode =
  | 'no_key'
  | 'auth'
  | 'rate_limit'
  | 'budget'
  | 'timeout'
  | 'server'
  | 'invalid_response';

export class JevError extends Error {
  constructor(
    message: string,
    public readonly code: JevErrorCode,
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = 'JevError';
  }
}

export interface JevDecideResult {
  answers: JevAnswers;
  model: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  durationMs: number;
}

interface RequestOptions {
  model?: string;
  timeoutMs?: number;
  /** For audit correlation. */
  userId?: string;
  conversationId?: string;
}

/** 402 with limit_source "openrouter_in_flight_budget" is transient, not a credit error. */
function isInFlightBudgetError(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { error?: { metadata?: { limit_source?: string } } };
    return parsed?.error?.metadata?.limit_source === 'openrouter_in_flight_budget';
  } catch {
    return false;
  }
}

async function postDecisions(
  apiKey: string,
  payload: Record<string, unknown>,
  timeoutMs: number
): Promise<{ res: Response; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(JEV_DECISIONS_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://unik.com.mx',
        'X-OpenRouter-Title': 'UNIK',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await res.text();
    return { res, body };
  } catch (err) {
    if (controller.signal.aborted) throw new JevError('Jev timeout', 'timeout', true);
    throw new JevError(err instanceof Error ? err.message : 'Error de red', 'timeout', true);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One Decisions request. Retries once on retryable failures (429, 5xx,
 * in-flight budget 402, network). Throws JevError on definitive failure —
 * callers use decision-engine.ts which converts that to a null fallback.
 */
export async function jevDecide(
  state: unknown,
  questions: Record<string, JevQuestion>,
  opts: RequestOptions = {}
): Promise<JevDecideResult> {
  const config = await getProviderConfig('openrouter');
  if (!config.apiKey) {
    throw new JevError('Falta OPENROUTER_API_KEY para usar Jev', 'no_key');
  }
  const model = opts.model ?? JEV_DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const payload = { model, state, questions };

  const startedAt = Date.now();
  let lastError: JevError | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && lastError) {
      await new Promise((r) => setTimeout(r, 400));
    }
    try {
      const { res, body } = await postDecisions(config.apiKey, payload, timeoutMs);
      if (!res.ok) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        if (res.status === 401 || res.status === 403) {
          throw new JevError(`Jev auth (${res.status})`, 'auth');
        }
        if (res.status === 402 && !isInFlightBudgetError(body)) {
          throw new JevError('Sin crédito en OpenRouter', 'budget');
        }
        if (res.status === 429 || res.status >= 500 || res.status === 402) {
          lastError = new JevError(`Jev ${res.status}`, res.status === 429 ? 'rate_limit' : 'server', true);
          if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter < 10) {
            await new Promise((r) => setTimeout(r, retryAfter * 1000));
          }
          continue;
        }
        throw new JevError(`Jev ${res.status}: ${body.slice(0, 300)}`, 'server');
      }

      const parsed = DecisionsResponseSchema.safeParse(JSON.parse(body));
      if (!parsed.success) {
        throw new JevError(`Respuesta inválida de Jev: ${parsed.error.message.slice(0, 200)}`, 'invalid_response');
      }
      const durationMs = Date.now() - startedAt;
      const usage = {
        inputTokens: parsed.data.usage.input_tokens,
        outputTokens: parsed.data.usage.output_tokens,
        costUsd: parsed.data.usage.cost ?? null,
      };
      void recordAiApiCall({
        userId: opts.userId,
        conversationId: opts.conversationId,
        deployment: `jev:${model}`,
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
        totalTokens: usage.inputTokens + usage.outputTokens,
        durationMs,
        success: true,
        finishReason: 'decisions',
      }).catch(() => undefined);
      return { answers: parsed.data.answers, model: parsed.data.model, usage, durationMs };
    } catch (err) {
      if (err instanceof JevError) {
        lastError = err;
        if (!err.retryable) break;
        continue;
      }
      lastError = new JevError(err instanceof Error ? err.message : 'Error desconocido', 'server');
      break;
    }
  }

  const durationMs = Date.now() - startedAt;
  void recordAiApiCall({
    userId: opts.userId,
    conversationId: opts.conversationId,
    deployment: `jev:${model}`,
    durationMs,
    success: false,
    errorCode: lastError?.code ?? 'server',
  }).catch(() => undefined);
  throw lastError ?? new JevError('Jev no disponible', 'server');
}
