import { describe, expect, it } from 'vitest';
import { mergeAssistantRuns } from './turns';
import type { MessageData } from './types';

const at = '2026-09-26T10:36:00.000Z';
const rec = (id: string, toolName: string) => ({
  id,
  toolName,
  args: {},
  result: {},
  success: true,
  durationMs: 10,
});

describe('mergeAssistantRuns', () => {
  it('shows one answer per turn instead of a stack of "1 paso" blocks', () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'Tablero de ventas', createdAt: at },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCallRecords: [rec('r1', 'querySalesOrders')],
        createdAt: at,
      },
      { id: 't1', role: 'tool', content: '{}', createdAt: at },
      {
        id: 'a2',
        role: 'assistant',
        content: null,
        toolCallRecords: [rec('r2', 'renderUi')],
        createdAt: at,
      },
      {
        id: 'a3',
        role: 'assistant',
        content: 'Listo: ventas por sucursal.',
        meta: { model: 'gpt-5' },
        createdAt: at,
      },
      { id: 'u2', role: 'user', content: 'Gracias', createdAt: at },
    ] as unknown as MessageData[];
    const shown = mergeAssistantRuns(messages);
    expect(shown.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const answer = shown[1];
    expect(answer.id).toBe('a3');
    expect(answer.mergedIds).toEqual(['a1', 'a2', 'a3']);
    expect(answer.toolCallRecords?.map((r) => r.toolName)).toEqual([
      'querySalesOrders',
      'renderUi',
    ]);
    expect(answer.content).toBe('Listo: ventas por sucursal.');
    expect(answer.meta?.model).toBe('gpt-5');
  });

  it('keeps answers of different agents apart', () => {
    const messages = [
      { id: 'a1', role: 'assistant', content: 'Delegué', createdAt: at },
      {
        id: 'a2',
        role: 'assistant',
        content: 'Reporte',
        meta: { agent: { name: 'Prospector' } },
        createdAt: at,
      },
    ] as unknown as MessageData[];
    expect(mergeAssistantRuns(messages)).toHaveLength(2);
  });
});
