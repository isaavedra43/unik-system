import { describe, expect, it } from 'vitest';
import type { RadarSignalDTO } from '@/modules/crm/crm-dto';
import {
  buildConvertCommand,
  buildDismissCommand,
  buildSnoozeCommand,
  canPrepareMessage,
  convertError,
  defaultTaskTitle,
  dismissError,
  EMPTY_RADAR_FILTERS,
  filterSignals,
  groupSignalsByKind,
  hasDraft,
  radarCopilotContext,
  radarScoreTone,
  radarStarters,
  RADAR_CONTEXT_SIGNALS,
  scoreWidth,
  signalLink,
  signalNextAction,
  snoozeError,
  snoozeOptions,
} from './radar-model';

const NOW = new Date('2026-09-15T18:00:00.000Z');
const USER_ID = 'u-ana';

function signal(overrides: Partial<RadarSignalDTO> = {}): RadarSignalDTO {
  return {
    id: 'sig-1',
    kind: 'no_followup',
    kindLabel: 'Sin seguimiento',
    subjectKey: 'conv-1',
    opportunityId: null,
    conversationId: 'conv-1',
    quoteId: null,
    zohoContactId: null,
    commContactId: null,
    customerName: 'Aceros del Norte',
    salespersonUserId: USER_ID,
    salespersonName: 'Ana',
    score: 62,
    reason: 'El cliente escribió hace 2 días y nadie le ha dado seguimiento.',
    data: null,
    computedAt: '2026-09-15T17:00:00.000Z',
    expiresAt: '2026-09-15T19:00:00.000Z',
    status: 'active',
    statusLabel: 'Activa',
    snoozedUntil: null,
    aiExplanation: null,
    aiSuggestedMessage: null,
    aiGeneratedAt: null,
    version: 3,
    ...overrides,
  };
}

describe('groupSignalsByKind', () => {
  it('ordena los grupos por urgencia y las señales por puntaje', () => {
    const groups = groupSignalsByKind([
      signal({ id: 'a', kind: 'no_followup', score: 40 }),
      signal({ id: 'b', kind: 'delivery_incident', score: 80 }),
      signal({ id: 'c', kind: 'no_followup', score: 70 }),
      signal({ id: 'd', kind: 'quote_expiring', score: 55 }),
    ]);
    expect(groups.map((group) => group.kind)).toStrictEqual([
      'delivery_incident',
      'quote_expiring',
      'no_followup',
    ]);
    const followup = groups.find((group) => group.kind === 'no_followup');
    expect(followup?.signals.map((row) => row.id)).toStrictEqual(['c', 'a']);
    expect(followup?.topScore).toBe(70);
    expect(followup?.hint.length).toBeGreaterThan(0);
  });

  it('un tipo desconocido no rompe el orden: va al final', () => {
    const groups = groupSignalsByKind([
      signal({ id: 'x', kind: 'tipo_nuevo', score: 99 }),
      signal({ id: 'y', kind: 'no_first_reply', score: 10 }),
    ]);
    expect(groups.map((group) => group.kind)).toStrictEqual(['no_first_reply', 'tipo_nuevo']);
    expect(groups[1].label).toBe('tipo_nuevo');
  });
});

describe('filterSignals', () => {
  const rows = [
    signal({ id: 'mine', salespersonUserId: USER_ID, customerName: 'Aceros del Norte' }),
    signal({ id: 'other', salespersonUserId: 'u-beto', customerName: 'Constructora Sur' }),
    signal({ id: 'free', salespersonUserId: null, customerName: 'Vidrios del Bajío' }),
  ];

  it('filtra por vendedor propio, sin asignar o uno concreto', () => {
    expect(
      filterSignals(rows, { ...EMPTY_RADAR_FILTERS, salesperson: 'me' }, USER_ID).map((r) => r.id)
    ).toStrictEqual(['mine']);
    expect(
      filterSignals(rows, { ...EMPTY_RADAR_FILTERS, salesperson: 'unassigned' }, USER_ID).map(
        (r) => r.id
      )
    ).toStrictEqual(['free']);
    expect(
      filterSignals(rows, { ...EMPTY_RADAR_FILTERS, salesperson: 'u-beto' }, USER_ID).map(
        (r) => r.id
      )
    ).toStrictEqual(['other']);
    expect(filterSignals(rows, EMPTY_RADAR_FILTERS, USER_ID)).toHaveLength(3);
  });

  it('filtra por tipo y por texto del cliente o del motivo', () => {
    const mixed = [...rows, signal({ id: 'quote', kind: 'quote_expiring' })];
    expect(
      filterSignals(mixed, { ...EMPTY_RADAR_FILTERS, kinds: ['quote_expiring'] }, USER_ID).map(
        (r) => r.id
      )
    ).toStrictEqual(['quote']);
    expect(
      filterSignals(rows, { ...EMPTY_RADAR_FILTERS, search: '  constructora ' }, USER_ID).map(
        (r) => r.id
      )
    ).toStrictEqual(['other']);
    expect(
      filterSignals(rows, { ...EMPTY_RADAR_FILTERS, search: 'seguimiento' }, USER_ID)
    ).toHaveLength(3);
  });
});

describe('presentación', () => {
  it('el tono y el ancho de la barra siguen el puntaje y toleran datos raros', () => {
    expect(radarScoreTone(90)).toBe('danger');
    expect(radarScoreTone(60)).toBe('warning');
    expect(radarScoreTone(10)).toBe('default');
    expect(radarScoreTone(Number.NaN)).toBe('default');
    expect(scoreWidth(140)).toBe(100);
    expect(scoreWidth(-5)).toBe(0);
    expect(scoreWidth(Number.NaN)).toBe(0);
  });

  it('cada tipo tiene una siguiente acción accionable y en español', () => {
    expect(signalNextAction(signal({ kind: 'quote_expiring' }))).toContain('cotización');
    expect(signalNextAction(signal({ kind: 'delivery_incident' }))).toContain('Avisa');
    expect(signalNextAction(signal({ kind: 'desconocido' }))).toContain('Revisa');
  });

  it('el enlace apunta primero a la oportunidad, luego a la cotización y al final a la bandeja', () => {
    expect(signalLink(signal({ opportunityId: 'opp-1', quoteId: 'q-1' }))?.href).toBe(
      '/app/areas/ventas/oportunidades/opp-1'
    );
    expect(signalLink(signal({ quoteId: 'q-1' }))?.href).toBe('/app/quotes/q-1');
    expect(signalLink(signal())?.href).toBe('/app/inbox');
    expect(
      signalLink(signal({ conversationId: null, opportunityId: null, quoteId: null }))
    ).toBeNull();
  });

  it('sabe cuándo hay borrador y cuándo se puede preparar un mensaje', () => {
    expect(hasDraft(signal())).toBe(false);
    expect(hasDraft(signal({ aiSuggestedMessage: '   ' }))).toBe(false);
    expect(hasDraft(signal({ aiSuggestedMessage: 'Hola, ¿seguimos?' }))).toBe(true);
    expect(canPrepareMessage(signal())).toBe(true);
    expect(
      canPrepareMessage(signal({ conversationId: null, commContactId: null, opportunityId: null }))
    ).toBe(false);
  });

  it('los arranques del copiloto cambian cuando hay una señal seleccionada', () => {
    expect(radarStarters(null)[0]).toContain('señales');
    expect(radarStarters(signal())[0]).toContain('Aceros del Norte');
  });
});

describe('decisiones', () => {
  it('las opciones de posponer salen de la hora del servidor y son válidas', () => {
    const options = snoozeOptions(NOW);
    expect(options.map((option) => option.id)).toStrictEqual(['4h', '1d', '3d', '7d']);
    for (const option of options) expect(snoozeError(option.until, NOW)).toBeNull();
  });

  it('rechaza posponer menos de 5 minutos o más de 30 días', () => {
    expect(snoozeError(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toContain('5 minutos');
    expect(snoozeError(new Date(NOW.getTime() + 40 * 86_400_000).toISOString(), NOW)).toContain(
      '30 días'
    );
    expect(snoozeError('no-es-fecha', NOW)).toContain('no es válida');
  });

  it('valida el motivo de descarte y los datos de la tarea', () => {
    expect(dismissError('Ya compró en otro lado')).toBeNull();
    expect(dismissError('x'.repeat(501))).toContain('500');
    expect(convertError({ title: '', dueAt: '' }, NOW)).toBeNull();
    expect(convertError({ title: 'a', dueAt: '' }, NOW)).toContain('2 caracteres');
    expect(convertError({ title: 'ok', dueAt: '2026-09-14T10:00:00.000Z' }, NOW)).toContain(
      'futuro'
    );
  });

  it('el título por defecto de la tarea describe la señal y respeta el máximo', () => {
    expect(defaultTaskTitle(signal())).toBe('Sin seguimiento: Aceros del Norte');
    expect(defaultTaskTitle(signal({ customerName: 'C'.repeat(300) })).length).toBe(160);
    expect(defaultTaskTitle(signal({ customerName: null }))).toContain('Cliente sin nombre');
  });

  it('cada decisión viaja como comando del motor con la versión de la señal', () => {
    const snooze = buildSnoozeCommand(signal(), '2026-09-16T18:00:00.000Z', '  espera precio  ');
    expect(snooze).toStrictEqual({
      type: 'crm.radar.snooze',
      aggregate: { type: 'radar_signal', id: 'sig-1' },
      payload: { signalId: 'sig-1', until: '2026-09-16T18:00:00.000Z', note: 'espera precio' },
      expectedVersion: 3,
    });
    expect(buildDismissCommand(signal(), '   ').payload).toStrictEqual({ signalId: 'sig-1' });
    expect(buildDismissCommand(signal(), 'No aplica').type).toBe('crm.radar.dismiss');
    const convert = buildConvertCommand(signal(), {
      title: ' Llamar al cliente ',
      dueAt: '2026-09-17T10:00:00.000Z',
    });
    expect(convert.type).toBe('crm.radar.convert_to_task');
    expect(convert.payload).toStrictEqual({
      signalId: 'sig-1',
      title: 'Llamar al cliente',
      dueAt: '2026-09-17T10:00:00.000Z',
    });
    expect(buildConvertCommand(signal()).payload).toStrictEqual({ signalId: 'sig-1' });
  });
});

describe('radarCopilotContext', () => {
  it('acota las filas, conserva los filtros y nombra la señal seleccionada', () => {
    const signals = Array.from({ length: 30 }, (_, index) =>
      signal({ id: `s-${index}`, score: index })
    );
    const context = radarCopilotContext({
      signals,
      filters: { salesperson: 'me', kinds: ['no_followup'], search: '  norte ' },
      selected: signal({ id: 's-7' }),
      total: 120,
    });
    expect(context.total).toBe(120);
    expect(context.visible).toBe(RADAR_CONTEXT_SIGNALS);
    expect((context.signals as unknown[]).length).toBe(RADAR_CONTEXT_SIGNALS);
    expect(context.signalId).toBe('s-7');
    expect(context.filters).toStrictEqual({
      salesperson: 'me',
      kinds: ['no_followup'],
      search: 'norte',
    });
    expect(context.space).toBe('radar');
  });

  it('sin selección no manda señal y el buscador vacío viaja como null', () => {
    const context = radarCopilotContext({
      signals: [],
      filters: EMPTY_RADAR_FILTERS,
      selected: null,
      total: 0,
    });
    expect(context.signalId).toBeUndefined();
    expect((context.filters as { search: string | null }).search).toBeNull();
  });
});
