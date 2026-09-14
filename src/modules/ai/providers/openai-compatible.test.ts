import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// A local server that speaks the OpenAI-compatible API Canopy Wave exposes.
const requests: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> | null }> = [];
let baseUrl = '';

vi.mock('../ai-config', () => ({
  getProviderConfig: async () => ({ apiKey: 'cw-test-key', endpoint: baseUrl, model: 'moonshotai/kimi-k2.6', fallbackModel: null }),
}));
vi.mock('../ai-audit', () => ({ recordAiApiCall: async () => undefined }));

const { createOpenAiCompatibleProvider, adaptMessagesForModel } = await import('./openai-compatible');

function sse(res: http.ServerResponse, events: unknown[]) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.end('data: [DONE]\n\n');
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    requests.push({ path: req.url ?? '', auth: req.headers.authorization, body });
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'minimax/minimax-m3', object: 'model' }, { id: 'moonshotai/kimi-k2.6', object: 'model' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions' && body?.stream) {
      const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: body.model };
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        sse(res, [
          { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'querySalesOrders', arguments: '{"dateRange":' } }] } }] },
          { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"this_month"}' } }] } }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          { ...base, choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } },
        ]);
      } else {
        sse(res, [
          { ...base, choices: [{ index: 0, delta: { content: '<thi' } }] },
          { ...base, choices: [{ index: 0, delta: { content: 'nk>calculo el total…</think>\n\nSon ' } }] },
          { ...base, choices: [{ index: 0, delta: { content: '65 órdenes.' }, finish_reason: 'stop' }] },
        ]);
      }
      return;
    }
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'y', object: 'chat.completion', created: 1, model: body?.model, choices: [{ index: 0, message: { role: 'assistant', content: '<think>ok</think>OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const provider = createOpenAiCompatibleProvider({
  id: 'canopywave',
  label: 'Canopy Wave',
  defaultEndpoint: 'https://inference.canopywave.io/v1',
  apiKeyEnv: 'CANOPYWAVE_API_KEY',
  defaultModel: 'moonshotai/kimi-k2.6',
});

describe('OpenAI-compatible provider (Canopy Wave wire format)', () => {
  it('lists the models of the key with a Bearer token against its own base URL', async () => {
    expect(await provider.listRemoteModels()).toEqual(['minimax/minimax-m3', 'moonshotai/kimi-k2.6']);
    expect(requests.at(-1)).toMatchObject({ path: '/v1/models', auth: 'Bearer cw-test-key' });
  });

  it('streams text without the <think> reasoning block', async () => {
    let text = '';
    for await (const chunk of provider.chatCompletionStream({ messages: [{ role: 'user', content: 'ventas' }], model: 'minimax/minimax-m3' })) {
      text += chunk.delta ?? '';
    }
    expect(text).toBe('Son 65 órdenes.');
    expect(requests.at(-1)?.body).toMatchObject({ model: 'minimax/minimax-m3', stream: true });
  });

  it('reassembles streamed tool calls so the orchestrator can run them', async () => {
    const chunks = [];
    for await (const chunk of provider.chatCompletionStream({
      messages: [{ role: 'user', content: 'ventas del mes' }],
      tools: [{ type: 'function', function: { name: 'querySalesOrders', description: 'ventas', parameters: { type: 'object', properties: {} } } }],
    })) {
      chunks.push(chunk);
    }
    const last = chunks.at(-1)!;
    expect(last.toolCalls).toEqual([{ id: 'call_1', name: 'querySalesOrders', arguments: '{"dateRange":"this_month"}' }]);
    expect(last.finishReason).toBe('tool_calls');
    expect(last.usage?.totalTokens).toBe(60);
    expect(requests.at(-1)?.body?.model).toBe('moonshotai/kimi-k2.6');
  });

  it('non-streamed test completion strips reasoning too', async () => {
    const result = await provider.testModel('moonshotai/kimi-k2.6');
    expect(result.success).toBe(true);
  });

  it('replaces PDF file parts, and images for text-only models, with a notice', () => {
    const adapted = adaptMessagesForModel(
      [{ role: 'user', content: [{ type: 'text', text: 'lee esto' }, { type: 'file', file: { filename: 'corte.pdf', file_data: 'data:application/pdf;base64,AA' } }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }],
      false
    );
    const parts = adapted[0].content as Array<{ type: string; text?: string }>;
    expect(parts.map((p) => p.type)).toEqual(['text', 'text', 'text']);
    expect(parts[1].text).toContain('corte.pdf');
    const withVision = adaptMessagesForModel([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }], true);
    expect((withVision[0].content as Array<{ type: string }>)[0].type).toBe('image_url');
  });
});
