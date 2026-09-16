import { describe, expect, it } from 'vitest';
import { getRowActions, parseBranchActions } from '@/modules/areas/work-actions';
import type { AreaWorkRow } from '@/modules/areas/area-work-row';
import { MANUFACTURING_COMMANDS } from '@/modules/manufacturing/manufacturing-types';
import {
  OPERATION_ROW_ACTIONS,
  ORDER_ROW_ACTIONS,
  actionsForStatus,
  manufacturaRowActions,
  unknownActionStatuses,
} from './row-actions';

/**
 * The catalogue must only ever offer real commands in real states, and it must
 * survive the framework's own validation with the payload each manufacturing
 * command requires — otherwise the button would be rejected as `invalid_payload`
 * the moment somebody pressed it.
 */

const COMMANDS = new Set<string>(Object.values(MANUFACTURING_COMMANDS));

function row(overrides: Partial<AreaWorkRow> = {}): AreaWorkRow {
  return {
    id: 'production_order:op-1',
    rowKind: 'production_order',
    sourceId: 'op-1',
    areaKey: 'manufactura',
    caseId: null,
    caseNumber: null,
    customerName: null,
    title: 'OP-0001 · Tablero',
    status: 'draft',
    statusLabel: 'Borrador',
    statusTone: 'weak',
    priority: 'normal',
    priorityLabel: 'Normal',
    ownerUserId: 'u-1',
    ownerName: 'Ana',
    dueAt: null,
    startedAt: null,
    lastActivityAt: '2026-09-15T15:00:00.000Z',
    escalationLevel: 0,
    waitReason: null,
    objectType: 'production_order',
    objectId: 'op-1',
    counterpartyName: null,
    locationCode: null,
    amount: null,
    quantity: '10',
    version: 4,
    overdue: false,
    open: true,
    extra: {},
    ...overrides,
  };
}

/** Same shape the SQL branch builds: catalogue entry + per-row payload. */
function withPayload(
  actions: readonly (typeof ORDER_ROW_ACTIONS)[number][],
  payload: Record<string, unknown>,
  aggregateId?: string
) {
  return actions.map((action) => ({
    ...action,
    payload,
    ...(aggregateId ? { aggregateId } : {}),
  }));
}

/**
 * What the SQL branch actually puts in `extra.actions` for an order in
 * `status`: the catalogue already filtered by state. `getRowActions` only
 * filters by permission, so a test that hands it the whole catalogue would be
 * testing a row that can never exist.
 */
function orderRowActions(status: string, orderId = 'op-1') {
  return withPayload(actionsForStatus('production_order', status), { productionOrderId: orderId });
}

const planner = {
  id: 'u-1',
  permissionKeys: ['manufacturing.manage_orders'],
  isSuperAdmin: false,
};
const operator = { id: 'u-2', permissionKeys: ['manufacturing.operate'], isSuperAdmin: false };
const visitor = { id: 'u-3', permissionKeys: ['manufacturing.view'], isSuperAdmin: false };

describe('catálogo de acciones de Manufactura', () => {
  it('sólo nombra comandos reales del módulo', () => {
    for (const action of [...ORDER_ROW_ACTIONS, ...OPERATION_ROW_ACTIONS]) {
      expect(COMMANDS.has(action.commandType)).toBe(true);
    }
  });

  it('sólo nombra estados reales', () => {
    expect(unknownActionStatuses()).toStrictEqual([]);
  });

  it('las operaciones actúan sobre la orden, no sobre sí mismas', () => {
    for (const action of OPERATION_ROW_ACTIONS) {
      expect(action.aggregateType).toBe('production_order');
      expect(action.orderStatuses?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('manufacturaRowActions responde por tipo de fila', () => {
    expect(manufacturaRowActions('production_order')).toBe(ORDER_ROW_ACTIONS);
    expect(manufacturaRowActions('production_operation')).toBe(OPERATION_ROW_ACTIONS);
    expect(manufacturaRowActions('work_item')).toStrictEqual([]);
  });
});

describe('contrato con work-actions', () => {
  it('conserva el payload y el agregado que el comando exige', () => {
    const [action] = parseBranchActions(
      withPayload(
        [OPERATION_ROW_ACTIONS[0]],
        { productionOrderId: 'op-1', operationId: 'ope-9' },
        'op-1'
      )
    );
    expect(action.payload).toStrictEqual({ productionOrderId: 'op-1', operationId: 'ope-9' });
    expect(action.aggregateId).toBe('op-1');
  });

  it('descarta payloads que no son objetos planos de escalares', () => {
    const [action] = parseBranchActions([
      { ...ORDER_ROW_ACTIONS[0], payload: { nested: { a: 1 }, ok: 'sí' } },
    ]);
    expect(action.payload).toStrictEqual({ ok: 'sí' });
  });

  it('el estado decide qué acciones lleva la fila (lo mismo que filtra el SQL)', () => {
    expect(actionsForStatus('production_order', 'draft').map((action) => action.id)).toStrictEqual([
      'production_order.reserve_materials',
      'production_order.cancel',
    ]);
    expect(
      actionsForStatus('production_order', 'completed').map((action) => action.id)
    ).toStrictEqual([
      'production_order.request_scrap_review',
      'production_order.release',
      'production_order.cancel',
    ]);
    expect(actionsForStatus('production_order', 'released')).toStrictEqual([]);
    // Una operación necesita además que su orden lo permita.
    expect(actionsForStatus('production_operation', 'pending', 'prepared')).toHaveLength(1);
    expect(actionsForStatus('production_operation', 'pending', 'draft')).toStrictEqual([]);
  });

  it('ofrece al planeador lo que puede hacer con una orden en borrador', () => {
    const actions = getRowActions(row({ extra: { actions: orderRowActions('draft') } }), planner);
    expect(actions.map((action) => action.id)).toStrictEqual([
      'production_order.reserve_materials',
      'production_order.cancel',
    ]);
    expect(actions[0].payload).toStrictEqual({ productionOrderId: 'op-1' });
  });

  it('no ofrece acciones de planeación a quien sólo opera', () => {
    const actions = getRowActions(row({ extra: { actions: orderRowActions('draft') } }), operator);
    expect(actions).toStrictEqual([]);
  });

  it('quien opera sí puede pedir la revisión de merma de una orden en proceso', () => {
    const actions = getRowActions(
      row({ status: 'in_progress', extra: { actions: orderRowActions('in_progress') } }),
      operator
    );
    expect(actions.map((action) => action.id)).toStrictEqual([
      'production_order.request_scrap_review',
    ]);
  });

  it('no ofrece nada a quien sólo puede ver el área', () => {
    const actions = getRowActions(
      row({ status: 'completed', extra: { actions: orderRowActions('completed') } }),
      visitor,
      { actPermissions: ['manufacturing.manage_orders'] }
    );
    expect(actions).toStrictEqual([]);
  });

  it('una orden liberada ya no ofrece acciones', () => {
    const actions = getRowActions(
      row({ status: 'released', extra: { actions: orderRowActions('released') } }),
      planner
    );
    expect(actions).toStrictEqual([]);
  });

  it('el operador inicia una operación pendiente de una orden preparada', () => {
    const offered = OPERATION_ROW_ACTIONS.filter(
      (action) => action.statuses.includes('pending') && action.orderStatuses?.includes('prepared')
    );
    const actions = getRowActions(
      row({
        id: 'production_operation:ope-9',
        rowKind: 'production_operation',
        sourceId: 'ope-9',
        status: 'pending',
        statusLabel: 'Pendiente',
        objectType: 'production_operation',
        extra: {
          actions: withPayload(
            offered,
            { productionOrderId: 'op-1', operationId: 'ope-9' },
            'op-1'
          ),
        },
      }),
      operator
    );
    expect(actions.map((action) => action.id)).toStrictEqual(['production_operation.start']);
    expect(actions[0].aggregateId).toBe('op-1');
  });
});
