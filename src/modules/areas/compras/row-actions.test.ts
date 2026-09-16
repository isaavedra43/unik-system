import { describe, expect, it } from 'vitest';
import { buildRowCommand } from '@/components/areas/area-workspace-model';
import type { AreaWorkRow } from '@/modules/areas/area-work-row';
import { getRowActions, parseBranchActions } from '@/modules/areas/work-actions';
import { AREA_WORK_ROW_COLUMNS, type AreaWorkSqlFilters } from '@/modules/areas/work-rows-sql';
import { PURCHASES_COMMANDS } from '@/modules/purchases/purchases-types';
import { comprasWorkRowBranches } from './compras-rows';
import {
  GOODS_RECEIPT_ROW_ACTIONS,
  ORDER_ROW_ACTIONS,
  PURCHASE_REQUEST_ROW_ACTIONS,
  RFQ_ROW_ACTIONS,
  comprasActionsForStatus,
  comprasRowActions,
  unknownComprasActionStatuses,
  type ComprasBranchAction,
} from './row-actions';

/**
 * Compras era la única área sin ninguna acción de dominio: sus comandos sólo
 * eran alcanzables por las tools de IA. Estas pruebas exigen que el catálogo
 * nombre comandos y estados REALES, que las ramas SQL lo lleven en `extra` como
 * parámetro ligado, y que lo que sale por `getRowActions` sea exactamente el
 * comando que el motor espera (agregado, payload y versión optimista).
 */

const COMMANDS = new Set<string>(Object.values(PURCHASES_COMMANDS));
const NOW = new Date('2026-09-15T18:00:00.000Z');

function filters(overrides: Partial<AreaWorkSqlFilters> = {}): AreaWorkSqlFilters {
  return { areaKey: 'compras', scope: 'open', now: NOW, ...overrides };
}

function branch(rowKind: string) {
  const found = comprasWorkRowBranches().find((entry) => entry.rowKind === rowKind);
  if (!found) throw new Error(`Falta la rama ${rowKind}`);
  return found;
}

function row(overrides: Partial<AreaWorkRow> = {}): AreaWorkRow {
  return {
    id: 'procurement_order:oc-1',
    rowKind: 'procurement_order',
    sourceId: 'oc-1',
    areaKey: 'compras',
    caseId: null,
    caseNumber: null,
    customerName: null,
    title: 'OC-0001 · Proveedor',
    status: 'draft',
    statusLabel: 'Borrador',
    statusTone: 'weak',
    priority: 'normal',
    priorityLabel: 'Normal',
    ownerUserId: 'u-1',
    ownerName: 'Ana',
    dueAt: null,
    startedAt: null,
    lastActivityAt: NOW.toISOString(),
    escalationLevel: 0,
    waitReason: null,
    objectType: 'procurement_order',
    objectId: 'oc-1',
    counterpartyName: 'Proveedor',
    locationCode: null,
    amount: '1000',
    quantity: '4',
    version: 7,
    overdue: false,
    open: true,
    extra: {},
    ...overrides,
  };
}

/** La misma forma que arma la rama SQL: entrada del catálogo + payload por fila. */
function withPayload(
  actions: readonly ComprasBranchAction[],
  payload: Record<string, unknown>,
  aggregateId?: string
) {
  return actions.map((action) => ({
    ...action,
    payload: { ...(action.payload ?? {}), ...payload },
    ...(aggregateId ? { aggregateId } : {}),
  }));
}

const buyer = { id: 'u-2', permissionKeys: ['purchases.manage_orders'], isSuperAdmin: false };
const requester = { id: 'u-3', permissionKeys: ['purchases.request'], isSuperAdmin: false };
const receiver = { id: 'u-4', permissionKeys: ['purchases.receive'], isSuperAdmin: false };
const visitor = { id: 'u-5', permissionKeys: ['purchases.view'], isSuperAdmin: false };

describe('catálogo de acciones de Compras', () => {
  it('sólo nombra comandos reales del módulo', () => {
    for (const action of [
      ...PURCHASE_REQUEST_ROW_ACTIONS,
      ...RFQ_ROW_ACTIONS,
      ...ORDER_ROW_ACTIONS,
      ...GOODS_RECEIPT_ROW_ACTIONS,
    ]) {
      expect(COMMANDS.has(action.commandType), action.id).toBe(true);
      expect(action.permissions.length, action.id).toBeGreaterThan(0);
    }
  });

  it('sólo nombra estados reales', () => {
    expect(unknownComprasActionStatuses()).toStrictEqual([]);
  });

  it('responde por clase de fila y no inventa acciones para el proveedor', () => {
    expect(comprasRowActions('procurement_order')).toBe(ORDER_ROW_ACTIONS);
    expect(comprasRowActions('rfq')).toBe(RFQ_ROW_ACTIONS);
    expect(comprasRowActions('purchase_request')).toBe(PURCHASE_REQUEST_ROW_ACTIONS);
    expect(comprasRowActions('goods_receipt')).toBe(GOODS_RECEIPT_ROW_ACTIONS);
    expect(comprasRowActions('supplier')).toStrictEqual([]);
  });

  it('la recepción actúa sobre la orden, no sobre sí misma', () => {
    for (const action of GOODS_RECEIPT_ROW_ACTIONS) {
      expect(action.aggregateType).toBe('procurement_order');
    }
  });

  it('el estado decide qué acciones lleva la fila (lo mismo que filtra el SQL)', () => {
    expect(
      comprasActionsForStatus('procurement_order', 'draft').map((action) => action.id)
    ).toStrictEqual(['procurement_order.submit', 'procurement_order.cancel']);
    expect(
      comprasActionsForStatus('procurement_order', 'received').map((action) => action.id)
    ).toStrictEqual(['procurement_order.request_payment', 'procurement_order.close']);
    expect(
      comprasActionsForStatus('procurement_order', 'partially_received').map((action) => action.id)
    ).toStrictEqual([
      'procurement_order.request_payment',
      'procurement_order.close_accepting_shortage',
    ]);
    // Con material ya recibido la orden se cierra, nunca se cancela.
    expect(
      comprasActionsForStatus('procurement_order', 'partially_received').map((action) => action.id)
    ).not.toContain('procurement_order.cancel');
    expect(comprasActionsForStatus('procurement_order', 'closed')).toStrictEqual([]);
    expect(comprasActionsForStatus('rfq', 'cancelled')).toStrictEqual([]);
    expect(comprasActionsForStatus('goods_receipt', 'posted')).toStrictEqual([]);
  });
});

describe('ramas SQL de Compras', () => {
  it('cada rama sigue proyectando las columnas canónicas en el mismo orden', () => {
    for (const entry of comprasWorkRowBranches()) {
      const aliases = [
        ...entry.sql(filters({ scope: 'all' })).text.matchAll(/AS "([A-Za-z]+)"/g),
      ].map((match) => match[1]);
      expect(aliases, entry.rowKind).toStrictEqual([...AREA_WORK_ROW_COLUMNS]);
    }
  });

  it('las cuatro ramas de dominio adjuntan sus acciones; el proveedor no', () => {
    const withActions = comprasWorkRowBranches().filter((entry) =>
      entry.sql(filters()).text.includes(`'actions'`)
    );
    expect(withActions.map((entry) => entry.rowKind)).toStrictEqual([
      'purchase_request',
      'rfq',
      'procurement_order',
      'goods_receipt',
    ]);
  });

  it('el catálogo viaja como parámetro ligado, nunca en el texto de la sentencia', () => {
    for (const rowKind of ['purchase_request', 'rfq', 'procurement_order', 'goods_receipt']) {
      const sql = branch(rowKind).sql(filters());
      expect(sql.text, rowKind).not.toContain('commandType');
      const catalogs = sql.values.filter(
        (value): value is string => typeof value === 'string' && value.includes('"commandType"')
      );
      expect(catalogs, rowKind).toHaveLength(1);
      const parsed = JSON.parse(catalogs[0]) as ComprasBranchAction[];
      expect(parsed.map((action) => action.id)).toStrictEqual(
        comprasRowActions(rowKind).map((action) => action.id)
      );
    }
  });

  it('cada acción condicionada lleva su regla de negocio dentro del SQL', () => {
    const orders = branch('procurement_order').sql(filters());
    expect(orders.text).toContain('rc.posted = 0');
    expect(orders.text).toContain('diff.open_differences = 0');
    expect(orders.values).toContain('procurement_order.cancel');
    const rfq = branch('rfq').sql(filters());
    expect(rfq.text).toContain('res.responses > 0');
    expect(rfq.values).toContain('rfq.compare');
    const requests = branch('purchase_request').sql(filters());
    expect(requests.text).toContain('agg.ordered_lines = 0');
    const receipts = branch('goods_receipt').sql(filters());
    expect(receipts.text).toContain(`g."mode" = 'warehouse'`);
  });

  it('la recepción expone la versión optimista de SU ORDEN, que es contra la que corre el comando', () => {
    const sql = branch('goods_receipt').sql(filters()).text;
    expect(sql).toContain('o."version" AS "version"');
    expect(sql).not.toContain('g."version" AS "version"');
  });

  it('un identificador escrito por una persona nunca se interpola', () => {
    const attack = 'u-1\'; DROP TABLE "ProcurementOrder"; --';
    for (const entry of comprasWorkRowBranches()) {
      const sql = entry.sql(filters({ ownerUserId: attack, caseId: attack }));
      expect(sql.text, entry.rowKind).not.toContain('DROP TABLE');
    }
  });
});

describe('contrato con work-actions y con el motor', () => {
  it('ofrece al comprador lo que puede hacer con una orden en borrador', () => {
    const actions = getRowActions(
      row({
        extra: {
          actions: withPayload(comprasActionsForStatus('procurement_order', 'draft'), {
            orderId: 'oc-1',
          }),
        },
      }),
      buyer
    );
    expect(actions.map((action) => action.id)).toStrictEqual([
      'procurement_order.submit',
      'procurement_order.cancel',
    ]);
    expect(actions[0].payload).toStrictEqual({ orderId: 'oc-1' });
  });

  it('no ofrece nada a quien sólo puede ver el área, ni siquiera con permiso de actuar del área', () => {
    const actions = getRowActions(
      row({
        extra: {
          actions: withPayload(comprasActionsForStatus('procurement_order', 'draft'), {
            orderId: 'oc-1',
          }),
        },
      }),
      visitor,
      { actPermissions: ['purchases.manage_orders'] }
    );
    expect(actions).toStrictEqual([]);
  });

  it('quien sólo recibe no firma órdenes, y quien sólo compra no registra recepciones', () => {
    const orderActions = getRowActions(
      row({
        extra: {
          actions: withPayload(comprasActionsForStatus('procurement_order', 'draft'), {
            orderId: 'oc-1',
          }),
        },
      }),
      receiver
    );
    expect(orderActions).toStrictEqual([]);

    const receiptRow = row({
      id: 'goods_receipt:rc-1',
      rowKind: 'goods_receipt',
      sourceId: 'rc-1',
      status: 'draft',
      objectType: 'goods_receipt',
      objectId: 'rc-1',
      version: 7,
      extra: {
        actions: withPayload(
          comprasActionsForStatus('goods_receipt', 'draft'),
          { receiptId: 'rc-1' },
          'oc-1'
        ),
      },
    });
    expect(getRowActions(receiptRow, buyer)).toStrictEqual([]);
    const [post] = getRowActions(receiptRow, receiver);
    expect(post.id).toBe('goods_receipt.post');
    // El comando corre contra la ORDEN con la versión de la orden.
    expect(buildRowCommand(post, receiptRow, {})).toStrictEqual({
      type: PURCHASES_COMMANDS.receiptPost,
      aggregate: { type: 'procurement_order', id: 'oc-1' },
      payload: { receiptId: 'rc-1' },
      expectedVersion: 7,
    });
  });

  it('el cierre con faltante conserva su bandera fija y añade el motivo que escribe la persona', () => {
    const shortage = ORDER_ROW_ACTIONS.find(
      (action) => action.id === 'procurement_order.close_accepting_shortage'
    )!;
    const [action] = parseBranchActions(withPayload([shortage], { orderId: 'oc-1' }));
    expect(action.payload).toStrictEqual({ acceptShortages: true, orderId: 'oc-1' });
    expect(
      buildRowCommand(action, row({ status: 'partially_received' }), { reason: 'Ya no lo traen' })
    ).toStrictEqual({
      type: PURCHASES_COMMANDS.orderClose,
      aggregate: { type: 'procurement_order', id: 'oc-1' },
      payload: { acceptShortages: true, orderId: 'oc-1', reason: 'Ya no lo traen' },
      expectedVersion: 7,
    });
  });

  it('quien solicita puede cancelar su solicitud de compra', () => {
    const requestRow = row({
      id: 'purchase_request:sc-1',
      rowKind: 'purchase_request',
      sourceId: 'sc-1',
      status: 'open',
      objectType: 'purchase_request',
      objectId: 'sc-1',
      extra: {
        actions: withPayload(comprasActionsForStatus('purchase_request', 'open'), {
          requestId: 'sc-1',
        }),
      },
    });
    const [cancel] = getRowActions(requestRow, requester);
    expect(cancel.commandType).toBe(PURCHASES_COMMANDS.requestCancel);
    expect(cancel.form).toBe('reason');
    expect(buildRowCommand(cancel, requestRow, { reason: 'Ya no se necesita' })).toStrictEqual({
      type: PURCHASES_COMMANDS.requestCancel,
      aggregate: { type: 'purchase_request', id: 'sc-1' },
      payload: { requestId: 'sc-1', reason: 'Ya no se necesita' },
      expectedVersion: 7,
    });
  });

  it('la comparación de una cotización la puede pedir quien cotiza desde el laboratorio', () => {
    const rfqRow = row({
      id: 'rfq:rfq-1',
      rowKind: 'rfq',
      sourceId: 'rfq-1',
      status: 'collecting',
      objectType: 'rfq',
      objectId: 'rfq-1',
      extra: {
        actions: withPayload(comprasActionsForStatus('rfq', 'collecting'), { rfqId: 'rfq-1' }),
      },
    });
    const sourcer = { id: 'u-6', permissionKeys: ['purchases.sourcing'], isSuperAdmin: false };
    expect(getRowActions(rfqRow, sourcer).map((action) => action.id)).toStrictEqual([
      'rfq.compare',
    ]);
    expect(getRowActions(rfqRow, buyer).map((action) => action.id)).toStrictEqual([
      'rfq.compare',
      'rfq.cancel',
    ]);
  });

  it('una fila cerrada no ofrece nada aunque el catálogo viaje en el extra', () => {
    const closed = row({
      status: 'closed',
      open: false,
      extra: { actions: withPayload([...ORDER_ROW_ACTIONS], { orderId: 'oc-1' }) },
    });
    expect(getRowActions(closed, buyer)).toStrictEqual([]);
  });
});
