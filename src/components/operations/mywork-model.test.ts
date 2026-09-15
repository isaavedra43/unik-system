import { describe, expect, it, vi } from 'vitest';

// evidence-service is a server module: only its label table is compared here.
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import type { SubmitOutcome } from '@/lib/offline-commands';
import { EVIDENCE_KIND_LABELS } from '@/modules/operations/evidence-service';
import {
  EVIDENCE_LABELS,
  MYWORK_CONTEXT_ROWS,
  acceptForEvidenceKind,
  availableActions,
  buildApprovalDecisionCommand,
  buildCompletePayload,
  buildEscalatePayload,
  buildMyWorkCopilotContext,
  buildWaitPayload,
  buildWorkItemCommand,
  defaultUploadKind,
  describeSubmitOutcome,
  evidenceLabel,
  evidenceUploadTargetId,
  formatDueLabel,
  formatElapsed,
  formatMoney,
  interpretProposalDecisionResponse,
  localDay,
  myWorkActivityAt,
  myWorkRole,
  myWorkViewHref,
  parseMyWorkView,
  pickNextAction,
  summarizeMyWork,
  validateEvidenceFiles,
  completionFormError,
  completionRequirements,
  describeProposalDecision,
  myWorkItemAnchorId,
  parseFocusWorkItem,
  type MyWorkItem,
} from './mywork-model';

/** 09:00 in Mexico City (UTC-6). */
const NOW = new Date('2026-09-15T15:00:00.000Z');
const USER = 'u-ana';

function item(overrides: Partial<MyWorkItem> = {}): MyWorkItem {
  return {
    id: 'wi-1',
    caseId: 'case-1',
    caseNumber: 'EXP-1',
    customerName: 'Constructora Norte',
    stepId: null,
    areaKey: 'inventario',
    areaLabel: 'Inventario',
    kind: 'action',
    kindLabel: 'Acción',
    title: 'Verificar existencias',
    description: null,
    status: 'open',
    statusLabel: 'Abierto',
    ownerUserId: USER,
    ownerName: 'Ana',
    backupUserId: null,
    backupName: null,
    dueAt: '2026-09-15T20:00:00.000Z',
    overdue: false,
    escalationLevel: 0,
    escalatedAt: null,
    waitReason: null,
    waitUntil: null,
    objectType: null,
    objectId: null,
    requiredEvidence: [],
    result: null,
    completedBy: null,
    completedAt: null,
    version: 3,
    createdAt: '2026-09-14T15:00:00.000Z',
    updatedAt: '2026-09-15T14:00:00.000Z',
    role: 'owner',
    permissions: { canStart: true, canWait: true, canComplete: true, canReassign: true, canEscalate: true },
    missingEvidence: [],
    ...overrides,
  };
}

function completed(status: 'completed' | 'accepted' | 'pending_external' | 'rejected' | 'failed', extra: Record<string, unknown> = {}): SubmitOutcome<unknown> {
  return {
    queued: false,
    commandId: 'c1',
    result: {
      commandId: 'c1',
      type: 'workitem.start',
      status,
      aggregateVersion: 4,
      emittedEventIds: [],
      createdWorkItemIds: [],
      ...extra,
    },
  };
}

describe('vista y rol', () => {
  it('sólo "cerrados" abre la vista de terminados', () => {
    expect(parseMyWorkView('cerrados')).toBe('closed');
    expect(parseMyWorkView('closed')).toBe('closed');
    expect(parseMyWorkView(undefined)).toBe('open');
    expect(parseMyWorkView('<script>')).toBe('open');
    expect(myWorkViewHref('closed')).toBe('/app/mywork?vista=cerrados');
    expect(myWorkViewHref('open')).toBe('/app/mywork');
  });

  it('distingue dueño y suplente', () => {
    expect(myWorkRole(item(), USER)).toBe('owner');
    expect(myWorkRole(item({ ownerUserId: 'u-luis', backupUserId: USER }), USER)).toBe('backup');
  });
});

describe('pickNextAction', () => {
  it('prefiere lo propio en curso aunque haya vencidos', () => {
    const overdue = item({ id: 'a', dueAt: '2026-09-15T10:00:00.000Z' });
    const inProgress = item({ id: 'b', status: 'in_progress', dueAt: '2026-09-17T10:00:00.000Z' });
    expect(pickNextAction([overdue, inProgress], USER, NOW)).toEqual({ item: inProgress, reason: 'in_progress' });
  });

  it('sin trabajo en curso toma lo propio que vence primero', () => {
    const later = item({ id: 'a', status: 'escalated', dueAt: '2026-09-16T10:00:00.000Z' });
    const overdue = item({ id: 'b', dueAt: '2026-09-15T14:00:00.000Z' });
    expect(pickNextAction([later, overdue], USER, NOW)).toEqual({ item: overdue, reason: 'overdue' });
    expect(pickNextAction([later], USER, NOW)).toEqual({ item: later, reason: 'next_due' });
  });

  it('una espera terminada vuelve a ser la siguiente acción; una espera sin fecha no', () => {
    const waitOver = item({ id: 'w', status: 'waiting', waitUntil: '2026-09-15T14:30:00.000Z', dueAt: '2026-09-15T16:00:00.000Z' });
    const waiting = item({ id: 'x', status: 'waiting', waitUntil: null, dueAt: '2026-09-15T12:00:00.000Z' });
    const open = item({ id: 'o', dueAt: '2026-09-15T20:00:00.000Z' });
    expect(pickNextAction([open, waiting, waitOver], USER, NOW)).toEqual({ item: waitOver, reason: 'wait_over' });
    expect(pickNextAction([waiting], USER, NOW)).toBeNull();
  });

  it('como suplente sólo propone lo vencido', () => {
    const covered = item({ id: 's', ownerUserId: 'u-luis', backupUserId: USER, dueAt: '2026-09-15T13:00:00.000Z' });
    const notDue = item({ id: 't', ownerUserId: 'u-luis', backupUserId: USER, dueAt: '2026-09-15T18:00:00.000Z' });
    expect(pickNextAction([notDue, covered], USER, NOW)).toEqual({ item: covered, reason: 'backup_overdue' });
    expect(pickNextAction([notDue], USER, NOW)).toBeNull();
  });

  it('ignora trabajos cerrados', () => {
    expect(pickNextAction([item({ status: 'done' }), item({ id: 'c', status: 'cancelled' })], USER, NOW)).toBeNull();
  });
});

describe('summarizeMyWork y actividad', () => {
  it('cuenta vencidos, hoy (hora de México), en curso, en espera y suplencias', () => {
    const summary = summarizeMyWork(
      [
        item({ id: '1', dueAt: '2026-09-15T14:00:00.000Z' }),
        item({ id: '2', dueAt: '2026-09-15T23:00:00.000Z', status: 'in_progress' }),
        item({ id: '3', dueAt: '2026-09-16T05:30:00.000Z', status: 'waiting' }),
        item({ id: '4', dueAt: '2026-09-16T06:30:00.000Z', ownerUserId: 'u-luis', backupUserId: USER }),
        item({ id: '5', status: 'done', dueAt: '2026-09-15T10:00:00.000Z' }),
      ],
      USER,
      NOW
    );
    expect(summary).toEqual({ total: 4, overdue: 1, inProgress: 1, waiting: 1, dueToday: 2, asBackup: 1 });
  });

  it('localDay usa la zona y cae a UTC si la zona es inválida', () => {
    expect(localDay(new Date('2026-09-16T05:30:00.000Z'))).toBe('2026-09-15');
    expect(localDay(new Date('2026-09-16T05:30:00.000Z'), 'Zona/Inexistente')).toBe('2026-09-16');
  });

  it('la actividad es el updatedAt más reciente', () => {
    expect(myWorkActivityAt([])).toBeNull();
    expect(
      myWorkActivityAt([
        item({ updatedAt: '2026-09-15T10:00:00.000Z' }),
        item({ updatedAt: '2026-09-15T12:00:00.000Z' }),
      ])
    ).toBe('2026-09-15T12:00:00.000Z');
  });

  it('el contexto del copiloto lleva a lo más 25 filas acotadas', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      item({ id: `wi-${i}`, title: 'x'.repeat(200), dueAt: i === 0 ? '2026-09-15T10:00:00.000Z' : '2026-09-20T10:00:00.000Z' })
    );
    const context = buildMyWorkCopilotContext(many, 'open', NOW) as { total: number; overdue: number; rows: Array<{ title: string; overdue: boolean }> };
    expect(context.total).toBe(30);
    expect(context.overdue).toBe(1);
    expect(context.rows).toHaveLength(MYWORK_CONTEXT_ROWS);
    expect(context.rows[0].title.length).toBe(120);
    expect(context.rows[0].overdue).toBe(true);
  });
});

describe('fechas', () => {
  it('etiqueta vencidos, próximos, hoy y mañana', () => {
    expect(formatDueLabel('2026-09-15T13:00:00.000Z', NOW)).toMatchObject({ label: 'Vencido hace 2 h', tone: 'danger' });
    expect(formatDueLabel('2026-09-15T15:30:00.000Z', NOW)).toMatchObject({ label: 'Vence en 30 min', tone: 'warning' });
    expect(formatDueLabel('2026-09-15T23:00:00.000Z', NOW)).toMatchObject({ label: 'Hoy 17:00', tone: 'warning' });
    expect(formatDueLabel('2026-09-16T06:30:00.000Z', NOW)).toMatchObject({ label: 'Mañana 00:30', tone: 'default' });
    const later = formatDueLabel('2026-09-20T18:00:00.000Z', NOW);
    expect(later.label).toMatch(/^20 sept? 12:00$/);
    expect(later.title).toBe(later.label);
  });

  it('cerrados y fechas inválidas', () => {
    expect(formatDueLabel('2026-09-15T13:00:00.000Z', NOW, { closed: true }).tone).toBe('default');
    expect(formatDueLabel('no-es-fecha', NOW)).toEqual({ label: 'Sin fecha', tone: 'default', title: '' });
  });

  it('formatElapsed', () => {
    expect(formatElapsed(59_000)).toBe('1 min');
    expect(formatElapsed(-3 * 3_600_000)).toBe('3 h');
    expect(formatElapsed(72 * 3_600_000)).toBe('3 d');
  });
});

describe('comandos', () => {
  it('ofrece sólo acciones permitidas y ninguna para aprobaciones o cerrados', () => {
    expect(availableActions(item())).toEqual(['start', 'complete', 'wait', 'escalate']);
    expect(availableActions(item({ status: 'in_progress' }))).toEqual(['complete', 'wait', 'escalate']);
    expect(availableActions(item({ status: 'waiting' }))).toEqual(['start', 'complete', 'escalate']);
    expect(
      availableActions(item({ permissions: { canStart: false, canWait: false, canComplete: true, canReassign: false, canEscalate: false } }))
    ).toEqual(['complete']);
    expect(availableActions(item({ objectType: 'approval_request' }))).toEqual([]);
    expect(availableActions(item({ status: 'done' }))).toEqual([]);
  });

  it('arma el comando con la versión esperada', () => {
    expect(buildWorkItemCommand('wait', item(), { reason: 'Proveedor' })).toEqual({
      type: 'workitem.wait',
      aggregate: { type: 'work_item', id: 'wi-1' },
      payload: { reason: 'Proveedor' },
      expectedVersion: 3,
    });
  });

  it('valida la espera', () => {
    expect(buildWaitPayload('ok', '', NOW)).toMatchObject({ ok: false });
    expect(buildWaitPayload('  Espero al proveedor  ', '', NOW)).toEqual({ ok: true, payload: { reason: 'Espero al proveedor' } });
    expect(buildWaitPayload('Espero al proveedor', '2020-01-01T10:00', NOW)).toEqual({ ok: false, error: 'La espera debe terminar en el futuro' });
    expect(buildWaitPayload('Espero al proveedor', 'mañana', NOW)).toMatchObject({ ok: false });
    const future = buildWaitPayload('Espero al proveedor', '2099-01-01T10:00', NOW);
    expect(future.ok && future.payload.until).toBe(new Date('2099-01-01T10:00').toISOString());
  });

  it('completar una solicitud exige la respuesta', () => {
    expect(buildCompletePayload(item({ objectType: 'area_request' }), '  ')).toMatchObject({ ok: false });
    expect(buildCompletePayload(item({ objectType: 'area_request' }), ' Hay 15 m² ')).toEqual({ ok: true, payload: { note: 'Hay 15 m²' } });
    expect(buildCompletePayload(item(), '')).toEqual({ ok: true, payload: {} });
    expect(buildCompletePayload(item(), 'x'.repeat(2001))).toMatchObject({ ok: false });
    expect(buildEscalatePayload('')).toEqual({ ok: true, payload: {} });
    expect(buildEscalatePayload('x'.repeat(501))).toMatchObject({ ok: false });
  });
});

describe('evidencia', () => {
  it('usa las mismas etiquetas que el núcleo', () => {
    expect(EVIDENCE_LABELS).toEqual(EVIDENCE_KIND_LABELS);
    expect(evidenceLabel('signature')).toBe('Firma');
    expect(evidenceLabel('customer_ok')).toBe('customer ok');
  });

  it('destino de subida, tipo por defecto y archivos permitidos', () => {
    expect(evidenceUploadTargetId('wi-9', 'photo')).toBe('work_item:wi-9#photo');
    expect(defaultUploadKind(['note', 'signature'])).toBe('signature');
    expect(defaultUploadKind(['count'])).toBe('photo');
    expect(acceptForEvidenceKind('document')).toContain('application/pdf');
    expect(validateEvidenceFiles([{ name: 'a.jpg', size: 10 }])).toBeNull();
    expect(validateEvidenceFiles([{ name: 'a.jpg', size: 16 * 1024 * 1024 }])).toContain('15 MB');
    expect(validateEvidenceFiles([{ name: 'a.jpg', size: 0 }])).toContain('vacío');
    expect(validateEvidenceFiles(Array.from({ length: 6 }, (_, i) => ({ name: `${i}.jpg`, size: 1 })))).toContain('5 archivos');
  });
});

describe('describeSubmitOutcome', () => {
  it('encolado sin conexión', () => {
    expect(describeSubmitOutcome({ queued: true, commandId: 'c1', reason: 'offline' }, 'Listo')).toEqual({
      kind: 'queued',
      message: expect.stringContaining('Sin conexión'),
      refresh: false,
    });
  });

  it('completado, aceptado y pendiente de Zoho recargan', () => {
    expect(describeSubmitOutcome(completed('completed'), 'Listo')).toEqual({ kind: 'success', message: 'Listo', refresh: true });
    expect(describeSubmitOutcome(completed('accepted'), 'Listo').kind).toBe('success');
    expect(describeSubmitOutcome(completed('pending_external'), 'Listo').message).toBe('Listo · sincronizando');
  });

  it('conflicto de versión, rechazo y fallo', () => {
    expect(describeSubmitOutcome(completed('rejected', { errorCode: 'version_conflict' }), 'Listo')).toMatchObject({ kind: 'conflict', refresh: true });
    expect(describeSubmitOutcome(completed('rejected', { errorCode: 'forbidden', message: 'Sin permiso' }), 'Listo')).toEqual({
      kind: 'error',
      message: 'Sin permiso',
      refresh: false,
    });
    expect(describeSubmitOutcome(completed('rejected', { errorCode: 'not_found' }), 'Listo')).toMatchObject({ kind: 'error', refresh: true });
    expect(describeSubmitOutcome(completed('failed'), 'Listo')).toMatchObject({ kind: 'error', refresh: false });
  });
});

describe('aprobaciones', () => {
  it('interpreta la respuesta de la ruta de propuestas', () => {
    expect(interpretProposalDecisionResponse({ proposal: { status: 'awaiting_second_approval' } })).toEqual({
      awaitingSecondApproval: true,
      result: { success: true },
    });
    expect(
      interpretProposalDecisionResponse({ proposal: { status: 'pending' }, execution: { success: false, errorCode: 'awaiting_second_approval' } })
        .awaitingSecondApproval
    ).toBe(true);
    expect(interpretProposalDecisionResponse({ proposal: {}, execution: { success: false, error: 'Zoho caído', uncertain: true } })).toEqual({
      awaitingSecondApproval: false,
      result: { success: false, error: 'Zoho caído', uncertain: true },
    });
    expect(interpretProposalDecisionResponse({ proposal: { status: 'rejected' } }).result).toEqual({ success: true });
    expect(interpretProposalDecisionResponse('basura').result).toEqual({ success: true });
  });

  it('arma approval.decide con versión y nota recortada', () => {
    expect(buildApprovalDecisionCommand({ id: 'ap-1', version: 2 }, 'reject', '  No procede ')).toEqual({
      type: 'approval.decide',
      aggregate: { type: 'approval_request', id: 'ap-1' },
      payload: { approvalRequestId: 'ap-1', decision: 'reject', note: 'No procede' },
      expectedVersion: 2,
    });
    expect(buildApprovalDecisionCommand({ id: 'ap-1', version: 2 }, 'approve', '   ').payload).toEqual({
      approvalRequestId: 'ap-1',
      decision: 'approve',
    });
  });

  it('formatea importes', () => {
    expect(formatMoney('1500.5', 'MXN')).toMatch(/1,500\.50/);
    expect(formatMoney('abc', 'MXN')).toBe('abc MXN');
    expect(formatMoney('10', 'XXX-INVALID')).toContain('10');
  });
});

describe('completar con evidencia', () => {
  it('bloquea Completar con evidencia estructurada y explica en español qué flujo la produce', () => {
    const verify = item({ requiredEvidence: ['availability_result'], missingEvidence: ['availability_result'] });
    const req = completionRequirements(verify);
    expect(req.blockedBy).toEqual(['availability_result']);
    expect(req.blockedReason).toContain('Falta Resultado de disponibilidad');
    expect(req.blockedReason).toContain('verificar la existencia');
    expect(req.blockedReason).not.toMatch(/availability/);
    expect(completionFormError(req, { note: 'ok', filesSelected: 0, selectedKind: 'photo' })).toBe(req.blockedReason);
    expect(evidenceLabel('delivery_evidence')).toBe('Evidencia de entrega');
    expect(evidenceLabel('count')).toBe('Conteo');
  });

  it('pide los archivos y la nota obligatorios y permite completar cuando están', () => {
    const delivery = item({ requiredEvidence: ['photo', 'signature', 'note'], missingEvidence: ['photo', 'signature', 'note'] });
    const req = completionRequirements(delivery);
    expect(req).toMatchObject({ blockedBy: [], blockedReason: null, files: ['photo', 'signature'], noteRequired: true });
    expect(completionFormError(req, { note: '', filesSelected: 1, selectedKind: 'photo' })).toMatch(/nota/);
    expect(completionFormError(req, { note: 'Entregado', filesSelected: 1, selectedKind: 'photo' })).toMatch(/Falta adjuntar: Firma/);
    const afterUpload = completionRequirements(delivery, ['photo']);
    expect(completionFormError(afterUpload, { note: 'Entregado', filesSelected: 1, selectedKind: 'signature' })).toBeNull();
    expect(completionRequirements(item()).noteRequired).toBe(false);
    expect(completionRequirements(item({ objectType: 'area_request' })).noteRequired).toBe(true);
  });
});

describe('aprobaciones y avisos de Mi trabajo', () => {
  it('avisa del resultado de aprobar una propuesta, incluido cuando la acción falla', () => {
    expect(describeProposalDecision('approve', { awaitingSecondApproval: false, result: { success: true } })).toMatchObject({ kind: 'success', closedNotice: null });
    expect(describeProposalDecision('approve', { awaitingSecondApproval: true, result: { success: true } })).toMatchObject({ kind: 'info' });
    expect(describeProposalDecision('approve', { awaitingSecondApproval: false, result: { success: false, error: 'Sin existencia' } })).toEqual({
      kind: 'error',
      message: 'La acción aprobada falló: Sin existencia',
      closedNotice: 'La acción aprobada falló: Sin existencia',
    });
    expect(describeProposalDecision('approve', { awaitingSecondApproval: false, result: { success: true, uncertain: true } })).toMatchObject({ kind: 'warning' });
    expect(describeProposalDecision('reject', { awaitingSecondApproval: false, result: { success: true } })).toMatchObject({ kind: 'success', message: 'Propuesta rechazada' });
  });

  it('lee el trabajo de la notificación y lo ancla en la lista', () => {
    expect(parseFocusWorkItem('wi_123')).toBe('wi_123');
    expect(parseFocusWorkItem(['wi_1', 'wi_2'])).toBe('wi_1');
    expect(parseFocusWorkItem('../x')).toBeNull();
    expect(parseFocusWorkItem(undefined)).toBeNull();
    expect(myWorkItemAnchorId('wi_1')).toBe('trabajo-wi_1');
  });
});
