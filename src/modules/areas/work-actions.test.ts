import { describe, expect, it } from 'vitest';
import type { AreaWorkRow } from './area-work-row';
import {
  findRowAction,
  getRowActions,
  isRowParticipant,
  noActionsReason,
  parseBranchActions,
  primaryRowAction,
  type RowActionActor,
} from './work-actions';

/**
 * Exhaustive rules of the row actions: the UI must never offer a command the
 * engine would reject, and must never hide one the person can actually run.
 */

function row(overrides: Partial<AreaWorkRow> = {}): AreaWorkRow {
  const extra = { backupUserId: 'u-backup', ...(overrides.extra ?? {}) };
  return {
    id: 'work_item:wi-1',
    rowKind: 'work_item',
    sourceId: 'wi-1',
    areaKey: 'compras',
    caseId: 'case-1',
    caseNumber: 'EXP-1',
    customerName: 'Cliente',
    title: 'Solicitar compra',
    status: 'open',
    statusLabel: 'Abierto',
    statusTone: 'default',
    priority: 'normal',
    priorityLabel: 'Normal',
    ownerUserId: 'u-owner',
    ownerName: 'Ana',
    dueAt: '2026-09-15T18:00:00.000Z',
    startedAt: null,
    lastActivityAt: '2026-09-15T12:00:00.000Z',
    escalationLevel: 0,
    waitReason: null,
    objectType: null,
    objectId: null,
    counterpartyName: null,
    locationCode: null,
    amount: null,
    quantity: null,
    version: 3,
    overdue: false,
    open: true,
    ...overrides,
    extra,
  };
}

const owner: RowActionActor = { id: 'u-owner', permissionKeys: [], isSuperAdmin: false };
const backup: RowActionActor = { id: 'u-backup', permissionKeys: [], isSuperAdmin: false };
const stranger: RowActionActor = { id: 'u-other', permissionKeys: [], isSuperAdmin: false };
const manager: RowActionActor = {
  id: 'u-manager',
  permissionKeys: ['operations.manage'],
  isSuperAdmin: false,
};
const superAdmin: RowActionActor = { id: 'u-root', permissionKeys: [], isSuperAdmin: true };

const ids = (actions: ReturnType<typeof getRowActions>) => actions.map((action) => action.id);

describe('getRowActions · work items', () => {
  const cases: Array<[string, string[]]> = [
    ['open', ['workitem.start', 'workitem.complete', 'workitem.wait', 'workitem.escalate']],
    ['in_progress', ['workitem.complete', 'workitem.wait', 'workitem.escalate']],
    ['waiting', ['workitem.start', 'workitem.complete', 'workitem.escalate']],
    ['escalated', ['workitem.start', 'workitem.complete', 'workitem.wait', 'workitem.escalate']],
    ['done', []],
    ['cancelled', []],
  ];

  it.each(cases)('estado %s ofrece las acciones válidas al dueño', (status, expected) => {
    expect(ids(getRowActions(row({ status }), owner))).toStrictEqual(expected);
  });

  it.each(cases)('el suplente ve lo mismo que el dueño (%s)', (status, expected) => {
    expect(ids(getRowActions(row({ status }), backup))).toStrictEqual(expected);
  });

  it.each(cases)('un gestor de operaciones ve lo mismo (%s)', (status, expected) => {
    expect(ids(getRowActions(row({ status }), manager))).toStrictEqual(expected);
  });

  it('quien no participa no ve acciones', () => {
    for (const [status] of cases) {
      expect(getRowActions(row({ status }), stranger)).toStrictEqual([]);
    }
  });

  it('super admin actúa sobre cualquier trabajo abierto', () => {
    expect(ids(getRowActions(row({ status: 'open' }), superAdmin))).toContain('workitem.start');
  });

  it('las aprobaciones de negocio no se deciden desde la tabla', () => {
    const approval = row({ objectType: 'approval_request' });
    expect(getRowActions(approval, owner)).toStrictEqual([]);
    expect(noActionsReason(approval, owner)).toContain('Mi trabajo');
  });

  it('completar un trabajo que responde una solicitud pide la respuesta', () => {
    const actions = getRowActions(row({ objectType: 'area_request', objectId: 'req-1' }), owner);
    const complete = actions.find((action) => action.id === 'workitem.complete');
    expect(complete?.form).toBe('note');
    expect(complete?.hint).toContain('respuesta');
  });

  it('replaces free-text completion with the guided issue command for preparation', () => {
    const preparation = row({
      areaKey: 'inventario',
      extra: { stepKey: 'preparar_pedido' },
    });
    const actions = getRowActions(preparation, owner);
    expect(ids(actions)).toContain('workitem.issue_case_material');
    expect(ids(actions)).not.toContain('workitem.complete');
    expect(actions.find((action) => action.id === 'workitem.issue_case_material')).toMatchObject({
      commandType: 'stock.issue_case_material',
      aggregateType: 'work_item',
      payload: { workItemId: 'wi-1' },
    });
  });

  it('cada acción apunta al agregado y al comando del núcleo', () => {
    for (const action of getRowActions(row(), owner)) {
      expect(action.aggregateType).toBe('work_item');
      expect(action.commandType.startsWith('workitem.')).toBe(true);
      expect(action.successMessage.length).toBeGreaterThan(0);
    }
  });
});

describe('getRowActions · solicitudes recibidas', () => {
  const request = (status: string, overrides: Partial<AreaWorkRow> = {}) =>
    row({
      id: `request_in:req-1`,
      rowKind: 'request_in',
      sourceId: 'req-1',
      status,
      title: 'Faltan 15 m² de Loseta',
      ...overrides,
    });

  const cases: Array<[string, string[]]> = [
    [
      'sent',
      [
        'request.acknowledge',
        'request.accept',
        'request.resolve',
        'request.block',
        'request.reject',
      ],
    ],
    ['acknowledged', ['request.accept', 'request.resolve', 'request.block', 'request.reject']],
    ['accepted', ['request.resolve', 'request.block', 'request.reject']],
    ['blocked', ['request.accept', 'request.resolve', 'request.reject']],
    ['resolved', []],
    ['rejected', []],
    ['cancelled', []],
    ['expired', []],
  ];

  it.each(cases)('estado %s ofrece las transiciones válidas', (status, expected) => {
    expect(ids(getRowActions(request(status), owner))).toStrictEqual(expected);
  });

  it('sólo el responsable (o un gestor) decide', () => {
    expect(getRowActions(request('sent'), stranger)).toStrictEqual([]);
    expect(ids(getRowActions(request('sent'), backup))).toContain('request.accept');
    expect(ids(getRowActions(request('sent'), manager))).toContain('request.accept');
  });

  it('rechazar confirma y bloquear pide motivo', () => {
    const actions = getRowActions(request('acknowledged'), owner);
    const reject = actions.find((action) => action.id === 'request.reject');
    const block = actions.find((action) => action.id === 'request.block');
    expect(reject?.confirm).toContain('Rechazar');
    expect(reject?.tone).toBe('danger');
    expect(block?.form).toBe('reason');
  });

  it('resolver pide la respuesta que verá el área que la envió', () => {
    const resolve = getRowActions(request('accepted'), owner).find(
      (action) => action.id === 'request.resolve'
    );
    expect(resolve?.form).toBe('answer');
    expect(resolve?.aggregateType).toBe('area_request');
  });
});

describe('getRowActions · solicitudes enviadas', () => {
  const sent = (status: string, extra: Record<string, unknown> = {}) =>
    row({
      id: 'request_out:req-2',
      rowKind: 'request_out',
      sourceId: 'req-2',
      status,
      ownerUserId: 'u-dest',
      extra: { createdById: 'u-creator', ...extra },
    });

  it('quien la creó puede cancelarla mientras siga abierta', () => {
    const creator: RowActionActor = { id: 'u-creator', permissionKeys: [], isSuperAdmin: false };
    for (const status of ['sent', 'acknowledged', 'accepted', 'blocked']) {
      expect(ids(getRowActions(sent(status), creator))).toStrictEqual(['request.cancel']);
    }
    for (const status of ['resolved', 'rejected', 'cancelled', 'expired']) {
      expect(getRowActions(sent(status), creator)).toStrictEqual([]);
    }
  });

  it('cancelar confirma y pide motivo', () => {
    const creator: RowActionActor = { id: 'u-creator', permissionKeys: [], isSuperAdmin: false };
    const [cancel] = getRowActions(sent('sent'), creator);
    expect(cancel.form).toBe('reason');
    expect(cancel.confirm).toContain('Cancelar');
  });

  it('un tercero no cancela solicitudes ajenas', () => {
    expect(getRowActions(sent('sent'), stranger)).toStrictEqual([]);
  });
});

describe('getRowActions · filas de dominio', () => {
  const orderRow = (actions: unknown, status = 'awaiting_receipt') =>
    row({
      id: 'procurement_order:oc-1',
      rowKind: 'procurement_order',
      sourceId: 'oc-1',
      status,
      ownerUserId: 'u-owner',
      extra: { actions },
    });

  const valid = [
    {
      id: 'purchases.receipt',
      label: 'Registrar recepción',
      commandType: 'purchases.receipt.post',
      aggregateType: 'procurement_order',
      form: 'note',
      tone: 'primary',
      successMessage: 'Recepción registrada',
      permissions: ['purchases.receive'],
    },
  ];

  it('ofrece las acciones de la rama a quien tiene su permiso', () => {
    const receiver: RowActionActor = {
      id: 'u-owner',
      permissionKeys: ['purchases.receive'],
      isSuperAdmin: false,
    };
    expect(ids(getRowActions(orderRow(valid), receiver))).toStrictEqual(['purchases.receipt']);
  });

  it('las oculta a quien no tiene el permiso declarado', () => {
    expect(getRowActions(orderRow(valid), owner)).toStrictEqual([]);
  });

  it('sin permisos declarados usa los permisos de acción del área', () => {
    const actions = [{ ...valid[0], permissions: undefined }];
    const buyer: RowActionActor = {
      id: 'u-buyer',
      permissionKeys: ['purchases.manage_orders'],
      isSuperAdmin: false,
    };
    expect(
      ids(getRowActions(orderRow(actions), buyer, { actPermissions: ['purchases.manage_orders'] }))
    ).toStrictEqual(['purchases.receipt']);
    expect(
      getRowActions(orderRow(actions), stranger, { actPermissions: ['purchases.manage_orders'] })
    ).toStrictEqual([]);
  });

  it('descarta entradas mal formadas y comandos con nombre inválido', () => {
    const dirty = [
      { id: '', label: 'Sin id', commandType: 'x.y', aggregateType: 'a' },
      { id: 'a', label: 'Sin comando', aggregateType: 'a' },
      { id: 'b', label: 'Comando inválido', commandType: 'DROP TABLE', aggregateType: 'a' },
      'texto suelto',
      null,
    ];
    expect(parseBranchActions(dirty)).toStrictEqual([]);
    expect(parseBranchActions(undefined)).toStrictEqual([]);
    expect(parseBranchActions({ not: 'an array' })).toStrictEqual([]);
  });

  it('normaliza forma y tono desconocidos', () => {
    const [action] = parseBranchActions([
      {
        id: 'x',
        label: 'Acción',
        commandType: 'dominio.accion',
        aggregateType: 'obj',
        form: 'raro',
        tone: 'fucsia',
      },
    ]);
    expect(action.form).toBe('none');
    expect(action.tone).toBe('default');
    expect(action.successMessage).toBe('Acción registrada');
  });

  it('una fila cerrada no ofrece nada aunque la rama declare acciones', () => {
    expect(getRowActions(orderRow(valid, 'closed'), superAdmin)).toStrictEqual([]);
  });
});

describe('helpers', () => {
  it('reconoce al dueño y al suplente', () => {
    expect(isRowParticipant(row(), owner)).toBe(true);
    expect(isRowParticipant(row(), backup)).toBe(true);
    expect(isRowParticipant(row(), stranger)).toBe(false);
  });

  it('primaryRowAction prefiere la acción primaria', () => {
    const actions = getRowActions(row({ status: 'in_progress' }), owner);
    expect(primaryRowAction(actions)?.id).toBe('workitem.complete');
    expect(primaryRowAction([])).toBeNull();
  });

  it('findRowAction sólo devuelve acciones permitidas', () => {
    expect(findRowAction(row(), owner, 'workitem.start')?.commandType).toBe('workitem.start');
    expect(findRowAction(row(), stranger, 'workitem.start')).toBeNull();
    expect(findRowAction(row(), owner, 'workitem.inventado')).toBeNull();
  });

  it('explica en español por qué no hay acciones', () => {
    expect(noActionsReason(row({ status: 'done' }), owner)).toContain('cerrado');
    expect(noActionsReason(row(), stranger)).toContain('responsable');
    expect(noActionsReason(row({ status: 'in_progress' }), owner)).toContain('No hay acciones');
  });
});
