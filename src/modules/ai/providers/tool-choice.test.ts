import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionOptions, ToolSpec } from './types';

/**
 * Tool-choice mapping (pure) and what the OpenAI / OpenAI-compatible providers put on the wire.
 * The `openai` SDK is replaced by a recorder, so nothing leaves the process.
 */

const { created } = vi.hoisted(() => ({ created: [] as Array<Record<string, unknown>> }));

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = {
      completions: {
        create: async (params: Record<string, unknown>) => {
          created.push(params);
          const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
          if (params.stream) {
            return (async function* () {
              yield {
                choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
                usage,
              };
            })();
          }
          return {
            choices: [
              { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
            ],
            usage,
          };
        },
      },
    };
  },
}));
vi.mock('../ai-config', () => ({
  getProviderConfig: async () => ({
    apiKey: 'test-key',
    endpoint: null,
    model: 'gpt-4o',
    fallbackModel: null,
  }),
}));
vi.mock('../ai-audit', () => ({ recordAiApiCall: async () => undefined }));

import {
  toAnthropicToolChoice,
  toGeminiToolConfig,
  toOpenAiToolChoice,
  toolNamesOf,
} from './tool-choice';
import { openaiProvider } from './openai';
import { createOpenAiCompatibleProvider } from './openai-compatible';

const tool = (name: string): ToolSpec => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
});
const TOOLS = [tool('createAreaRequest'), tool('concludeAgentTurn')];
const NAMES = ['createAreaRequest', 'concludeAgentTurn'];
const forced = (name: string) => ({ type: 'function' as const, function: { name } });

const compatible = createOpenAiCompatibleProvider({
  id: 'canopywave',
  label: 'Canopy Wave',
  defaultEndpoint: 'https://inference.example.test/v1',
  apiKeyEnv: 'CANOPYWAVE_API_KEY',
  defaultModel: 'moonshotai/kimi-k2.6',
});

async function streamRequest(
  provider: { chatCompletionStream(opts: ChatCompletionOptions): AsyncGenerator<unknown> },
  opts: Partial<ChatCompletionOptions>
): Promise<Record<string, unknown>> {
  for await (const chunk of provider.chatCompletionStream({
    messages: [{ role: 'user', content: 'hola' }],
    ...opts,
  }))
    void chunk;
  return created.at(-1)!;
}

beforeEach(() => {
  created.length = 0;
});

describe('toolNamesOf', () => {
  it('reads only function tools and tolerates missing lists', () => {
    expect(toolNamesOf(TOOLS)).toEqual(NAMES);
    expect(toolNamesOf(undefined)).toEqual([]);
    expect(toolNamesOf([{ type: 'custom', custom: { name: 'x' } }, null])).toEqual([]);
  });
});

describe('toOpenAiToolChoice', () => {
  it('omits the field for auto, for no choice and when no tools are offered', () => {
    expect(toOpenAiToolChoice(undefined, NAMES)).toBeUndefined();
    expect(toOpenAiToolChoice('auto', NAMES)).toBeUndefined();
    expect(toOpenAiToolChoice('required', [])).toBeUndefined();
    expect(toOpenAiToolChoice(forced('concludeAgentTurn'), [])).toBeUndefined();
  });

  it("sends 'required' as is", () => {
    expect(toOpenAiToolChoice('required', NAMES)).toBe('required');
  });

  it('forces a named function only when that tool is offered', () => {
    expect(toOpenAiToolChoice(forced('concludeAgentTurn'), NAMES)).toEqual(
      forced('concludeAgentTurn')
    );
    expect(toOpenAiToolChoice(forced('suggestNextActions'), NAMES)).toBeUndefined();
  });
});

describe('toAnthropicToolChoice', () => {
  it("maps 'required' to any and a forced function to tool", () => {
    expect(toAnthropicToolChoice('required', NAMES)).toEqual({ type: 'any' });
    expect(toAnthropicToolChoice(forced('createAreaRequest'), NAMES)).toEqual({
      type: 'tool',
      name: 'createAreaRequest',
    });
    expect(toAnthropicToolChoice(forced('missing'), NAMES)).toBeUndefined();
    expect(toAnthropicToolChoice('auto', NAMES)).toBeUndefined();
    expect(toAnthropicToolChoice('required', [])).toBeUndefined();
  });
});

describe('toGeminiToolConfig', () => {
  it("maps 'required' to mode ANY and a forced function to ANY restricted to that name", () => {
    expect(toGeminiToolConfig('required', NAMES)).toEqual({
      functionCallingConfig: { mode: 'ANY' },
    });
    expect(toGeminiToolConfig(forced('concludeAgentTurn'), NAMES)).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['concludeAgentTurn'] },
    });
    expect(toGeminiToolConfig(forced('missing'), NAMES)).toBeUndefined();
    expect(toGeminiToolConfig(undefined, NAMES)).toBeUndefined();
    expect(toGeminiToolConfig('required', [])).toBeUndefined();
  });
});

describe('OpenAI provider tool_choice on the wire', () => {
  it("streams with tool_choice 'required' when asked", async () => {
    const body = await streamRequest(openaiProvider, { tools: TOOLS, toolChoice: 'required' });
    expect(body.tool_choice).toBe('required');
    expect(body.stream).toBe(true);
  });

  it('keeps auto and the forced function exactly as before', async () => {
    expect(
      await streamRequest(openaiProvider, { tools: TOOLS, toolChoice: 'auto' })
    ).not.toHaveProperty('tool_choice');
    expect(await streamRequest(openaiProvider, { tools: TOOLS })).not.toHaveProperty('tool_choice');
    expect(
      (
        await streamRequest(openaiProvider, {
          tools: TOOLS,
          toolChoice: forced('concludeAgentTurn'),
        })
      ).tool_choice
    ).toEqual(forced('concludeAgentTurn'));
    expect(
      await streamRequest(openaiProvider, { tools: TOOLS, toolChoice: forced('notOffered') })
    ).not.toHaveProperty('tool_choice');
  });

  it('never sends tool_choice without tools', async () => {
    expect(await streamRequest(openaiProvider, { toolChoice: 'required' })).not.toHaveProperty(
      'tool_choice'
    );
  });

  it('applies the same policy to one-shot completions', async () => {
    await openaiProvider.chatCompletion({
      messages: [{ role: 'user', content: 'hola' }],
      tools: TOOLS,
      toolChoice: 'required',
    });
    expect(created.at(-1)?.tool_choice).toBe('required');
    await openaiProvider.chatCompletion({
      messages: [{ role: 'user', content: 'hola' }],
      tools: TOOLS,
    });
    expect(created.at(-1)).not.toHaveProperty('tool_choice');
  });
});

describe('OpenAI-compatible provider tool_choice on the wire', () => {
  it("streams with tool_choice 'required', the forced function, or nothing for auto", async () => {
    expect(
      (await streamRequest(compatible, { tools: TOOLS, toolChoice: 'required' })).tool_choice
    ).toBe('required');
    expect(
      (await streamRequest(compatible, { tools: TOOLS, toolChoice: forced('createAreaRequest') }))
        .tool_choice
    ).toEqual(forced('createAreaRequest'));
    expect(
      await streamRequest(compatible, { tools: TOOLS, toolChoice: 'auto' })
    ).not.toHaveProperty('tool_choice');
    expect(await streamRequest(compatible, { toolChoice: 'required' })).not.toHaveProperty(
      'tool_choice'
    );
  });

  it('applies the same policy to one-shot completions', async () => {
    await compatible.chatCompletion({
      messages: [{ role: 'user', content: 'hola' }],
      tools: TOOLS,
      toolChoice: 'required',
    });
    expect(created.at(-1)?.tool_choice).toBe('required');
    await compatible.chatCompletion({
      messages: [{ role: 'user', content: 'hola' }],
      tools: TOOLS,
      toolChoice: 'auto',
    });
    expect(created.at(-1)).not.toHaveProperty('tool_choice');
  });
});
