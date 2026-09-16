import { describe, expect, it } from 'vitest';
import type { CtExceptionRow } from '@/modules/control-tower/exceptions-service';
import { INCIDENT_COMMANDS } from '@/modules/operations/incidents-service';
import { AREA_REQUEST_COMMANDS } from '@/modules/operations/area-requests-service';
import { WORK_ITEM_COMMANDS } from '@/modules/operations/work-items-service';
import {
  OPERATIONS_MANAGE_PERMISSION,
  OPERATIONS_OPERATOR_PERMISSIONS,
  buildExceptionCommand,
  buildExceptionPayload,
  canActOnException,
  exceptionActions,
  findExceptionAction,
  noExceptionActionsReason,
  type ExceptionActor,
} from './exception-actions';

const manager: ExceptionActor = {
  id: 'u-manager',
  permissionKeys: [OPERATIONS_MANAGE_PERMISSION],
  isSuperAdmin: false,
};
const admin: ExceptionActor = {
  id: 'u-admin',
  permissionKeys: ['operations.admin'],
  isSuperAdmin: false,
};
const owner: ExceptionActor = { id: 'u-owner', permissionKeys: [], isSuperAdmin: false };

function row(overrides: Partial<CtExceptionRow> = {}): CtExceptionRow {
  return {
    id: 'work_overdue:w1',
    kind: 'work_overdue',
    kindLabel: 'Trabajo vencido',
    areaKey: 'ventas',
    areaLabel: 'Ventas',
    caseId: 'c1',
    caseNumber: 'EXP-1',
    customerName: 'Cliente',
    title: 'Preparar entrega',
    detail: null,
    status: 'open',
    severity: 'high',
    severityLabel: 'Alta',
    ownerUserId: 'u-owner',
    ownerName: 'Dueño',
    dueAt: '2026-09-15T10:00:00.000Z',
    since: '2026-09-15T10:00:00.000Z',
    ageMinutes: 120,
    objectType: 'work_item',
    objectId: 'w1',
    version: 4,
    extra: {},
    ...overrides,
  };
}

describe('exception-actions · quién puede actuar', () => {
  it('deja actuar a quien gestiona operaciones', () => {
    expect(canActOnException(row(), manager)).toBe(true);
  });

  /**
   * El plan abre la Torre con `operations.admin` (7.7) y su espacio `excepciones`
   * declara acciones. Mientras esto devolvió false, quien administraba operaciones
   * veía TODAS las excepciones y no tenía ni un botón — y `work-actions.ts` sí se
   * los pintaba en el centro de trabajo del área, así que el motor contestaba 403
   * a un botón que la propia app acababa de dibujar.
   */
  it('deja actuar con operations.admin: es el permiso con el que el plan abre la Torre', () => {
    expect(canActOnException(row(), admin)).toBe(true);
    expect(exceptionActions(row(), admin).map((action) => action.id)).toEqual([
      'reassign',
      'escalate',
      'complete',
    ]);
    expect(noExceptionActionsReason(row(), admin)).toBeNull();
    expect(canActOnException(row({ objectType: 'incident', status: 'open' }), admin)).toBe(true);
    expect(canActOnException(row({ objectType: 'area_request', status: 'sent' }), admin)).toBe(
      true
    );
  });

  it('operar el núcleo son exactamente dos permisos, ni uno más', () => {
    expect([...OPERATIONS_OPERATOR_PERMISSIONS]).toEqual(['operations.manage', 'operations.admin']);
    const viewer: ExceptionActor = {
      id: 'u-view',
      permissionKeys: ['operations.view'],
      isSuperAdmin: false,
    };
    expect(canActOnException(row({ ownerUserId: 'otro' }), viewer)).toBe(false);
    expect(noExceptionActionsReason(row({ ownerUserId: 'otro' }), viewer)).toContain(
      'administrar operaciones'
    );
  });

  it('deja actuar al responsable y a su suplente del trabajo', () => {
    expect(canActOnException(row(), owner)).toBe(true);
    const backup: ExceptionActor = { id: 'u-backup', permissionKeys: [], isSuperAdmin: false };
    expect(canActOnException(row({ extra: { backupUserId: 'u-backup' } }), backup)).toBe(true);
    expect(canActOnException(row(), backup)).toBe(false);
  });

  it('deja actuar a un super admin', () => {
    expect(canActOnException(row(), { id: 'u-su', permissionKeys: [], isSuperAdmin: true })).toBe(
      true
    );
  });

  it('no ofrece acciones a quien sólo mira una solicitud de otra área', () => {
    const request = row({ objectType: 'area_request', ownerUserId: 'u-owner', status: 'sent' });
    expect(canActOnException(request, owner)).toBe(false);
  });
});

describe('exception-actions · catálogo por tipo', () => {
  it('ofrece reasignar, escalar y cerrar sobre un trabajo', () => {
    const actions = exceptionActions(row(), manager);
    expect(actions.map((action) => action.id)).toEqual(['reassign', 'escalate', 'complete']);
    expect(actions.map((action) => action.commandType)).toEqual([
      WORK_ITEM_COMMANDS.reassign,
      WORK_ITEM_COMMANDS.escalate,
      WORK_ITEM_COMMANDS.complete,
    ]);
  });

  it('ofrece atender sólo mientras la incidencia está abierta', () => {
    const open = exceptionActions(
      row({ objectType: 'incident', status: 'open', kind: 'incident' }),
      manager
    );
    expect(open.map((action) => action.id)).toEqual(['acknowledge', 'resolve', 'dismiss']);
    expect(open[0].commandType).toBe(INCIDENT_COMMANDS.acknowledge);

    const acknowledged = exceptionActions(
      row({ objectType: 'incident', status: 'acknowledged', kind: 'incident' }),
      manager
    );
    expect(acknowledged.map((action) => action.id)).toEqual(['resolve', 'dismiss']);
  });

  it('ofrece acusar recibo sólo mientras la solicitud está enviada', () => {
    const sent = exceptionActions(
      row({ objectType: 'area_request', status: 'sent', kind: 'request_overdue' }),
      manager
    );
    expect(sent.map((action) => action.commandType)).toEqual([
      AREA_REQUEST_COMMANDS.acknowledge,
      AREA_REQUEST_COMMANDS.resolve,
      AREA_REQUEST_COMMANDS.reject,
    ]);

    const blocked = exceptionActions(
      row({ objectType: 'area_request', status: 'blocked', kind: 'request_blocked' }),
      manager
    );
    expect(blocked.map((action) => action.id)).toEqual(['resolve', 'reject']);
  });

  it('no inventa acciones para entregas ni expedientes, y explica dónde se atienden', () => {
    const delivery = row({ objectType: 'delivery_order', kind: 'delivery_conflict' });
    expect(exceptionActions(delivery, manager)).toEqual([]);
    expect(noExceptionActionsReason(delivery, manager)).toContain('Logística');

    const blockedCase = row({ objectType: 'operational_case', kind: 'case_blocked' });
    expect(exceptionActions(blockedCase, manager)).toEqual([]);
    expect(noExceptionActionsReason(blockedCase, manager)).toContain('expediente');
  });

  it('encuentra una acción por id y devuelve null si no se ofrece', () => {
    expect(findExceptionAction(row(), manager, 'escalate')?.id).toBe('escalate');
    expect(findExceptionAction(row(), manager, 'resolve')).toBeNull();
    // Quien sólo mira no obtiene la acción aunque la nombre por id.
    const viewer: ExceptionActor = {
      id: 'u-view',
      permissionKeys: ['operations.view'],
      isSuperAdmin: false,
    };
    expect(findExceptionAction(row({ ownerUserId: 'otro' }), viewer, 'escalate')).toBeNull();
  });
});

describe('exception-actions · payload y comando', () => {
  const actions = exceptionActions(row(), manager);
  const reassign = actions[0];
  const escalate = actions[1];

  it('exige elegir persona al reasignar', () => {
    const result = buildExceptionPayload(reassign, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Elige');
  });

  it('manda ownerUserId y el motivo opcional', () => {
    const result = buildExceptionPayload(reassign, { ownerUserId: 'u-2', text: '  urge  ' });
    expect(result).toEqual({ ok: true, payload: { ownerUserId: 'u-2', reason: 'urge' } });
  });

  it('conserva el payload fijo de la acción (escalar es manual)', () => {
    const result = buildExceptionPayload(escalate, { text: '' });
    expect(result).toEqual({ ok: true, payload: { reason: 'manual' } });
  });

  it('nombra `resolution` al resolver una incidencia y `reason` al descartarla', () => {
    const incident = exceptionActions(
      row({ objectType: 'incident', status: 'acknowledged', kind: 'incident' }),
      manager
    );
    const resolve = buildExceptionPayload(incident[0], { text: 'Se repuso la pieza' });
    expect(resolve).toEqual({ ok: true, payload: { resolution: 'Se repuso la pieza' } });
    const dismiss = buildExceptionPayload(incident[1], { text: 'Duplicada' });
    expect(dismiss).toEqual({ ok: true, payload: { reason: 'Duplicada' } });
  });

  it('exige texto cuando el comando lo exige y acepta vacío cuando no', () => {
    const incident = exceptionActions(
      row({ objectType: 'incident', status: 'acknowledged', kind: 'incident' }),
      manager
    );
    expect(buildExceptionPayload(incident[0], { text: '  ' }).ok).toBe(false);
    expect(buildExceptionPayload(incident[0], { text: 'ab' }).ok).toBe(false);
    expect(buildExceptionPayload(actions[2], { text: '' }).ok).toBe(true);
  });

  it('arma el comando con el agregado y la versión de la fila', () => {
    const payload = buildExceptionPayload(escalate, {});
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;
    expect(buildExceptionCommand(escalate, row(), payload.payload)).toEqual({
      type: WORK_ITEM_COMMANDS.escalate,
      aggregate: { type: 'work_item', id: 'w1' },
      payload: { reason: 'manual' },
      expectedVersion: 4,
    });
  });
});
