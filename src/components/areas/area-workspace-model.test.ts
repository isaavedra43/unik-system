import { describe, expect, it } from 'vitest';
import type { AreaWorkRow } from '@/modules/areas/area-work-row';
import type { AreaRowAction } from '@/modules/areas/work-actions';
import { parseAreaWorkQuery } from '@/modules/areas/work-filters';
import { AREA_REGISTRY } from '@/modules/areas/area-registry';
import {
  AREA_CONTEXT_ROWS,
  AREA_CONTEXT_SELECTION,
  actionFieldLabel,
  actionFieldRequired,
  areaActivityAt,
  buildActionPayload,
  buildAreaCopilotContext,
  buildRowCommand,
  rowKindChips,
  scopeChips,
} from './area-workspace-model';

const NOW = new Date('2026-09-15T18:00:00.000Z');

function row(index: number, overrides: Partial<AreaWorkRow> = {}): AreaWorkRow {
  return {
    id: `work_item:wi-${index}`,
    rowKind: 'work_item',
    sourceId: `wi-${index}`,
    areaKey: 'compras',
    caseId: 'case-1',
    caseNumber: 'EXP-9',
    customerName: 'Constructora del Norte',
    title: `Pendiente ${index}`,
    status: 'open',
    statusLabel: 'Abierto',
    statusTone: 'default',
    priority: 'normal',
    priorityLabel: 'Normal',
    ownerUserId: 'u-1',
    ownerName: 'Ana',
    dueAt: '2026-09-16T18:00:00.000Z',
    startedAt: null,
    lastActivityAt: `2026-09-1${(index % 5) + 1}T10:00:00.000Z`,
    escalationLevel: 0,
    waitReason: null,
    objectType: null,
    objectId: null,
    counterpartyName: null,
    locationCode: null,
    amount: null,
    quantity: null,
    version: 1,
    overdue: false,
    open: true,
    extra: {},
    ...overrides,
  };
}

const query = parseAreaWorkQuery(
  { scope: 'open', kind: ['work_item'], search: 'loseta', page: 2 },
  AREA_REGISTRY.compras
);

describe('contexto del copiloto', () => {
  it('resume la tabla visible sin pasarse de los topes', () => {
    const rows = Array.from({ length: 60 }, (_, index) => row(index));
    const selected = rows.map((entry) => entry.id);
    const context = buildAreaCopilotContext({
      areaKey: 'compras',
      rows,
      total: 128,
      query,
      selectedIds: selected,
    });
    expect(context.surface).toBe('area');
    expect(context.areaKey).toBe('compras');
    expect(context.total).toBe(128);
    expect((context.rows as unknown[]).length).toBe(AREA_CONTEXT_ROWS);
    expect((context.selectedIds as unknown[]).length).toBe(AREA_CONTEXT_SELECTION);
    expect(context.query).toMatchObject({ search: 'loseta', scope: 'open', page: 2 });
  });

  it('recorta títulos largos y cuenta los vencidos', () => {
    const long = 'x'.repeat(400);
    const context = buildAreaCopilotContext({
      areaKey: 'ventas',
      rows: [row(1, { title: long, overdue: true }), row(2)],
      total: 2,
      query,
      selectedIds: [],
    });
    const first = (context.rows as Array<{ title: string }>)[0];
    expect(first.title.length).toBeLessThanOrEqual(120);
    expect(context.overdue).toBe(1);
  });

  it('la actividad más reciente manda el reanálisis', () => {
    expect(areaActivityAt([row(1), row(4), row(2)])).toBe('2026-09-15T10:00:00.000Z');
    expect(areaActivityAt([])).toBeNull();
  });
});

describe('chips', () => {
  const base = {
    basePath: '/app/areas/compras/trabajo',
    rowKinds: ['work_item', 'request_in', 'procurement_order'],
    current: { kind: null, scope: 'open' as const, mine: false, overdue: false },
  };

  it('ofrece Todo más un chip por tipo con enlaces limpios', () => {
    const chips = rowKindChips(base);
    expect(chips.map((chip) => chip.id)).toStrictEqual([
      'all',
      'work_item',
      'request_in',
      'procurement_order',
    ]);
    expect(chips[0].active).toBe(true);
    expect(chips[0].href).toBe('/app/areas/compras/trabajo');
    expect(chips[1].href).toBe('/app/areas/compras/trabajo?kind=work_item');
    expect(chips[1].label).toBe('Trabajos');
  });

  it('marca el tipo activo y conserva el resto del estado', () => {
    const chips = rowKindChips({
      ...base,
      current: { kind: 'request_in', scope: 'closed', mine: true, overdue: false },
    });
    const active = chips.find((chip) => chip.id === 'request_in');
    expect(active?.active).toBe(true);
    expect(chips[0].href).toContain('scope=closed');
    expect(chips[0].href).toContain('mios=1');
  });

  it('los chips de alcance alternan míos y vencidos', () => {
    const chips = scopeChips(base);
    expect(chips.map((chip) => chip.id)).toStrictEqual([
      'open',
      'closed',
      'all',
      'mine',
      'overdue',
    ]);
    expect(chips.find((chip) => chip.id === 'mine')?.href).toContain('mios=1');
    const active = scopeChips({ ...base, current: { ...base.current, mine: true } });
    expect(active.find((chip) => chip.id === 'mine')?.active).toBe(true);
    expect(active.find((chip) => chip.id === 'mine')?.href).not.toContain('mios=1');
  });
});

describe('cargas de las acciones', () => {
  const action = (form: AreaRowAction['form']): AreaRowAction => ({
    id: 'x',
    label: 'Acción',
    commandType: 'workitem.complete',
    aggregateType: 'work_item',
    form,
    tone: 'default',
    confirm: null,
    successMessage: 'Listo',
    hint: null,
  });

  it('sin formulario manda una carga vacía', () => {
    expect(buildActionPayload(action('none'), { text: '' }, NOW)).toStrictEqual({
      ok: true,
      payload: {},
    });
  });

  it('la nota es opcional pero acotada', () => {
    expect(buildActionPayload(action('note'), { text: '  ' }, NOW)).toStrictEqual({
      ok: true,
      payload: {},
    });
    expect(buildActionPayload(action('note'), { text: 'Listo' }, NOW)).toStrictEqual({
      ok: true,
      payload: { note: 'Listo' },
    });
    const long = buildActionPayload(action('note'), { text: 'x'.repeat(2100) }, NOW);
    expect(long.ok).toBe(false);
  });

  it('el motivo exige al menos tres caracteres, como el núcleo', () => {
    expect(buildActionPayload(action('reason'), { text: 'ab' }, NOW).ok).toBe(false);
    expect(buildActionPayload(action('reason'), { text: 'Falta material' }, NOW)).toStrictEqual({
      ok: true,
      payload: { reason: 'Falta material' },
    });
  });

  it('la respuesta no puede ir vacía', () => {
    expect(buildActionPayload(action('answer'), { text: '' }, NOW).ok).toBe(false);
    expect(
      buildActionPayload(action('answer'), { text: 'Se entrega el jueves' }, NOW)
    ).toStrictEqual({ ok: true, payload: { answer: 'Se entrega el jueves' } });
  });

  it('la espera valida motivo y fecha futura', () => {
    expect(buildActionPayload(action('wait'), { text: 'ab', until: '' }, NOW).ok).toBe(false);
    expect(
      buildActionPayload(action('wait'), { text: 'Espero al proveedor', until: '' }, NOW)
    ).toStrictEqual({ ok: true, payload: { reason: 'Espero al proveedor' } });
    expect(
      buildActionPayload(action('wait'), { text: 'Espero al proveedor', until: 'no-es-fecha' }, NOW)
        .ok
    ).toBe(false);
    expect(
      buildActionPayload(
        action('wait'),
        { text: 'Espero al proveedor', until: '2020-01-01T10:00' },
        NOW
      ).ok
    ).toBe(false);
    const future = buildActionPayload(
      action('wait'),
      { text: 'Espero al proveedor', until: '2026-09-20T10:00' },
      NOW
    );
    expect(future.ok).toBe(true);
    if (future.ok) expect(typeof future.payload.until).toBe('string');
  });

  it('el comando lleva el agregado y la versión optimista de la fila', () => {
    const command = buildRowCommand(action('note'), row(1, { version: 7 }), { note: 'x' });
    expect(command).toStrictEqual({
      type: 'workitem.complete',
      aggregate: { type: 'work_item', id: 'wi-1' },
      payload: { note: 'x' },
      expectedVersion: 7,
    });
  });

  it('etiqueta cada formulario en español', () => {
    expect(actionFieldLabel('reason')).toBe('Motivo');
    expect(actionFieldLabel('answer')).toBe('Respuesta');
    expect(actionFieldLabel('wait')).toBe('Motivo de la espera');
    expect(actionFieldLabel('note')).toBe('Nota');
    expect(actionFieldRequired('note')).toBe(false);
    expect(actionFieldRequired('answer')).toBe(true);
  });
});
