import { describe, expect, it } from 'vitest';
import {
  AUTO_EVENT_KINDS,
  AUTO_EVENT_LABELS,
  DEFAULT_SURFACE_ACCESS,
  autoKind,
  isNewerActivity,
  preferencePatchFor,
  proposalTitle,
  toolLabel,
  visibleSurfaceRows,
} from './copilot-types';

describe('proposalTitle', () => {
  it('titles every approval card in Spanish, never with the identifier of the tool', () => {
    for (const [tool, title] of [
      ['respondAreaRequest', 'Responder solicitud de área'],
      ['reserveStock', 'Apartar material'],
      ['createPurchaseRequest', 'Crear solicitud de compra'],
      ['assignCarrier', 'Asignar transportista'],
      ['recordExpense', 'Registrar gasto'],
      ['authorizePayment', 'Autorizar pago'],
      ['recordCount', 'Registrar conteo'],
      ['completeWorkItem', 'Completar trabajo'],
      ['createProductionOrder', 'Crear orden de producción'],
    ] as const) {
      expect(proposalTitle(tool)).toBe(title);
    }
    expect(proposalTitle('createQuote')).toBe('Crear cotización en Zoho Books');
    expect(proposalTitle('Propuesta de la IA')).toBe('Propuesta de la IA');
    expect(proposalTitle('someNewTool')).toBe('Acción propuesta por la IA');
    expect(proposalTitle('someNewTool')).not.toMatch(/[a-z][A-Z]/);
  });
});

describe('isNewerActivity', () => {
  it('re-analyzes only when the activity moves forward', () => {
    expect(isNewerActivity(null, '2026-09-15T10:00:00.000Z')).toBe(true);
    expect(isNewerActivity('2026-09-15T10:00:00.000Z', '2026-09-15T10:05:00.000Z')).toBe(true);
    expect(isNewerActivity('2026-09-15T10:05:00.000Z', '2026-09-15T10:00:00.000Z')).toBe(false);
    expect(isNewerActivity('2026-09-15T10:00:00.000Z', '2026-09-15T10:00:00.000Z')).toBe(false);
    expect(isNewerActivity('a', 'b')).toBe(true);
  });
});

describe('visibleSurfaceRows', () => {
  const rows = [{ key: 'mywork' as const }, { key: 'area' as const }, { key: 'case' as const }, { key: 'control_tower' as const }];
  it('shows Control Tower only with operations.admin and areas only once their work center exists', () => {
    expect(visibleSurfaceRows(rows, DEFAULT_SURFACE_ACCESS).map((r) => r.key)).toEqual(['mywork', 'case']);
    expect(visibleSurfaceRows(rows, { ...DEFAULT_SURFACE_ACCESS, controlTower: true }).map((r) => r.key)).toEqual(['mywork', 'case', 'control_tower']);
  });
});

describe('autoKind', () => {
  it('recognizes every automatic event and keeps the historical fallback', () => {
    for (const kind of AUTO_EVENT_KINDS) {
      expect(autoKind(`⟦auto:${kind}⟧ algo`)).toBe(kind);
      expect(AUTO_EVENT_LABELS[kind]).toBeTruthy();
    }
    expect(autoKind('⟦auto:whatever⟧ algo')).toBe('open');
    expect(autoKind('⟦auto:')).toBe('open');
    expect(autoKind('hola')).toBeNull();
    expect(autoKind(null)).toBeNull();
  });
});

describe('preferencePatchFor', () => {
  it('writes the literal columns for inbox/chat', () => {
    expect(preferencePatchFor('inboxCopilotMode', 'paused')).toEqual({ inboxCopilotMode: 'paused' });
    expect(preferencePatchFor('chatCopilotMode', 'active')).toEqual({ chatCopilotMode: 'active' });
  });

  it('writes only this surface inside surfaceModes', () => {
    expect(preferencePatchFor('surfaceModes.mywork', 'on_demand')).toEqual({ surfaceModes: { mywork: 'on_demand' } });
    expect(preferencePatchFor('surfaceModes.control_tower', 'active')).toEqual({ surfaceModes: { control_tower: 'active' } });
  });
});

describe('toolLabel', () => {
  it('labels the operations tools in Spanish', () => {
    expect(toolLabel('createAreaRequest', 'running')).toBe('Enviando solicitud a otra área');
    expect(toolLabel('findStuckCases')).toBe('Expedientes atorados revisados');
  });
});
