import { describe, expect, it } from 'vitest';
import {
  CASE_RISK_LABELS,
  buildCaseCommand,
  buildCaseReasonPayload,
  buildCaseCopilotContext,
  buildCaseWorkItemCommand,
  buildReassignPayload,
  caseActions,
  caseHref,
  caseNextAction,
  caseProgress,
  caseRisk,
  caseWorkItemActions,
  filterTimeline,
  groupStepsByArea,
  isOpenCaseStatus,
  mergeTimeline,
  needsEvidenceElsewhere,
  requestAnswerHref,
  stepTone,
  timelineAreaFilters,
  type CaseRequestView,
  type CaseStepView,
  type CaseTimelineEntry,
  type CaseWorkItemView,
} from './case-model';

const NOW = new Date('2026-09-15T18:00:00.000Z');
const PHASE_LABELS = {
  planning: 'Planeación',
  sourcing: 'Abastecimiento',
  preparing: 'Preparación',
  delivering: 'Entrega',
  closing: 'Cierre',
};

function step(overrides: Partial<CaseStepView> = {}): CaseStepView {
  return {
    id: 's1',
    stepKey: 'verificar_disponibilidad',
    label: 'Verificar disponibilidad',
    areaKey: 'inventario',
    areaLabel: 'Inventario',
    scopeKey: '',
    scopeLabel: null,
    kind: 'verification',
    kindLabel: 'Verificación',
    status: 'active',
    statusLabel: 'Activo',
    phase: 'planning',
    order: 0,
    slaMinutes: 120,
    dueAt: '2026-09-15T20:00:00.000Z',
    startedAt: null,
    completedAt: null,
    overdue: false,
    ...overrides,
  };
}

function workItem(overrides: Partial<CaseWorkItemView> = {}): CaseWorkItemView {
  return {
    id: 'w1',
    title: 'Verificar 15 m² de mármol',
    areaKey: 'inventario',
    areaLabel: 'Inventario',
    kind: 'verification',
    kindLabel: 'Verificación',
    status: 'open',
    statusLabel: 'Abierto',
    ownerUserId: 'u1',
    ownerName: 'Ana',
    backupUserId: null,
    backupName: null,
    dueAt: '2026-09-15T20:00:00.000Z',
    overdue: false,
    escalationLevel: 0,
    waitReason: null,
    stepId: 's1',
    objectType: null,
    objectId: null,
    requiredEvidence: [],
    missingEvidence: [],
    version: 3,
    permissions: {
      canStart: true,
      canWait: true,
      canComplete: true,
      canReassign: true,
      canEscalate: true,
    },
    ...overrides,
  };
}

function request(overrides: Partial<CaseRequestView> = {}): CaseRequestView {
  return {
    id: 'r1',
    kind: 'purchase_shortfall',
    kindLabel: 'Faltante de compra',
    title: 'Comprar 5 m² de mármol',
    fromAreaKey: 'inventario',
    fromAreaLabel: 'Inventario',
    toAreaKey: 'compras',
    toAreaLabel: 'Compras',
    status: 'sent',
    statusLabel: 'Enviada',
    blocksDelivery: true,
    dueAt: '2026-09-16T18:00:00.000Z',
    overdue: false,
    ownerUserId: 'u2',
    ownerName: 'Beto',
    workItemId: 'w-req',
    freeText: null,
    open: true,
    ...overrides,
  };
}

describe('riesgo del expediente', () => {
  it('un expediente cerrado no tiene riesgo', () => {
    expect(
      caseRisk(
        {
          status: 'closed',
          promisedAt: '2020-01-01T00:00:00.000Z',
          overdueWorkItems: 3,
          openIncidents: 2,
        },
        NOW
      )
    ).toBe('ok');
    expect(isOpenCaseStatus('closed')).toBe(false);
    expect(isOpenCaseStatus('blocked')).toBe(true);
  });

  it('la promesa vencida manda sobre todo lo demás', () => {
    expect(
      caseRisk(
        {
          status: 'open',
          promisedAt: '2026-09-14T18:00:00.000Z',
          overdueWorkItems: 0,
          openIncidents: 0,
        },
        NOW
      )
    ).toBe('late');
  });

  it('bloqueo, trabajo vencido, incidencia o solicitud que frena la entrega son riesgo', () => {
    const base = { promisedAt: null, overdueWorkItems: 0, openIncidents: 0 };
    expect(caseRisk({ ...base, status: 'blocked' }, NOW)).toBe('risk');
    expect(caseRisk({ ...base, status: 'open', overdueWorkItems: 1 }, NOW)).toBe('risk');
    expect(caseRisk({ ...base, status: 'open', openIncidents: 1 }, NOW)).toBe('risk');
    expect(caseRisk({ ...base, status: 'open', blockingRequests: 1 }, NOW)).toBe('risk');
  });

  it('una promesa a menos de 48 h está por vencer y más lejos está en tiempo', () => {
    expect(
      caseRisk(
        {
          status: 'open',
          promisedAt: '2026-09-16T18:00:00.000Z',
          overdueWorkItems: 0,
          openIncidents: 0,
        },
        NOW
      )
    ).toBe('watch');
    expect(
      caseRisk(
        {
          status: 'open',
          promisedAt: '2026-09-30T18:00:00.000Z',
          overdueWorkItems: 0,
          openIncidents: 0,
        },
        NOW
      )
    ).toBe('ok');
    expect(
      caseRisk({ status: 'open', promisedAt: null, overdueWorkItems: 0, openIncidents: 0 }, NOW)
    ).toBe('ok');
  });

  it('cada nivel tiene etiqueta en español', () => {
    expect(CASE_RISK_LABELS.late).toBe('Vencido');
    expect(CASE_RISK_LABELS.ok).toBe('En tiempo');
  });
});

describe('progreso de los pasos', () => {
  const steps = [
    step({
      id: 'a',
      stepKey: 'verificar_disponibilidad',
      order: 0,
      status: 'done',
      phase: 'planning',
    }),
    step({ id: 'b', stepKey: 'plan_abastecimiento', order: 1, status: 'done', phase: 'planning' }),
    step({ id: 'c', stepKey: 'reservar_stock', order: 2, status: 'active', phase: 'sourcing' }),
    step({
      id: 'd',
      stepKey: 'solicitar_compra',
      order: 3,
      status: 'waiting',
      phase: 'sourcing',
      overdue: true,
    }),
  ];

  it('cuenta un paso del proceso una sola vez aunque se repita por necesidad', () => {
    const repeated = [
      ...steps,
      step({
        id: 'c2',
        stepKey: 'reservar_stock',
        scopeKey: 'demand-2',
        order: 2,
        status: 'done',
        phase: 'sourcing',
      }),
    ];
    const progress = caseProgress(repeated, PHASE_LABELS, 'sourcing');
    expect(progress.total).toBe(4);
    expect(progress.done).toBe(2);
    expect(progress.percent).toBe(50);
  });

  it('un paso repetido sólo está listo cuando todas sus instancias cerraron', () => {
    const done = [
      step({
        id: 'x',
        stepKey: 'reservar_stock',
        scopeKey: 'd1',
        status: 'done',
        phase: 'sourcing',
      }),
      step({
        id: 'y',
        stepKey: 'reservar_stock',
        scopeKey: 'd2',
        status: 'skipped',
        phase: 'sourcing',
      }),
    ];
    expect(caseProgress(done, PHASE_LABELS, 'sourcing').done).toBe(1);
  });

  it('marca las fases anteriores como terminadas y la actual como current', () => {
    const progress = caseProgress(steps, PHASE_LABELS, 'sourcing');
    const planning = progress.phases.find((phase) => phase.key === 'planning');
    const sourcing = progress.phases.find((phase) => phase.key === 'sourcing');
    expect(planning?.state).toBe('done');
    expect(planning?.done).toBe(2);
    expect(sourcing?.state).toBe('current');
    expect(progress.overdue).toBe(1);
    // Las fases sin pasos instanciados no se muestran.
    expect(progress.phases.map((phase) => phase.key)).toStrictEqual(['planning', 'sourcing']);
  });

  it('sin pasos el porcentaje es 0 y no divide entre cero', () => {
    const progress = caseProgress([], PHASE_LABELS, 'planning');
    expect(progress).toMatchObject({ total: 0, done: 0, percent: 0 });
    expect(progress.phases.map((phase) => phase.key)).toStrictEqual(['planning']);
  });

  it('el tono del paso distingue vencido, fallido y terminado', () => {
    expect(stepTone({ status: 'done', overdue: false })).toBe('success');
    expect(stepTone({ status: 'failed', overdue: false })).toBe('danger');
    expect(stepTone({ status: 'active', overdue: true })).toBe('danger');
    expect(stepTone({ status: 'waiting', overdue: false })).toBe('warning');
    expect(stepTone({ status: 'skipped', overdue: false })).toBe('weak');
  });
});

describe('pasos agrupados por área', () => {
  it('ordena las áreas por su primer paso del proceso y cuenta lo abierto', () => {
    const groups = groupStepsByArea([
      step({ id: '1', areaKey: 'logistica', areaLabel: 'Logística', order: 9, status: 'pending' }),
      step({ id: '2', areaKey: 'inventario', areaLabel: 'Inventario', order: 0, status: 'active' }),
      step({
        id: '3',
        areaKey: 'inventario',
        areaLabel: 'Inventario',
        order: 4,
        status: 'waiting',
        overdue: true,
      }),
    ]);
    expect(groups.map((group) => group.areaKey)).toStrictEqual(['inventario', 'logistica']);
    expect(groups[0]).toMatchObject({ open: 2, overdue: 1 });
    expect(groups[1].open).toBe(0);
  });
});

describe('siguiente paso y responsable', () => {
  it('prefiere el trabajo en curso sobre el abierto', () => {
    const next = caseNextAction({
      workItems: [
        workItem({ id: 'a', status: 'open', dueAt: '2026-09-15T19:00:00.000Z' }),
        workItem({
          id: 'b',
          status: 'in_progress',
          dueAt: '2026-09-16T19:00:00.000Z',
          ownerName: 'Ana',
        }),
      ],
      requests: [],
      steps: [],
    });
    expect(next.kind).toBe('work_item');
    expect(next.workItem?.id).toBe('b');
    expect(next.reason).toBe('En curso');
    expect(next.ownerName).toBe('Ana');
  });

  it('entre dos abiertos toma el que vence primero y explica la espera', () => {
    const next = caseNextAction({
      workItems: [
        workItem({ id: 'a', status: 'waiting', waitReason: 'Esperando al proveedor' }),
        workItem({ id: 'b', status: 'open', dueAt: '2026-09-15T23:00:00.000Z' }),
      ],
      requests: [],
      steps: [],
    });
    expect(next.workItem?.id).toBe('b');
    const waiting = caseNextAction({
      workItems: [workItem({ status: 'waiting', waitReason: 'Esperando al proveedor' })],
      requests: [],
      steps: [],
    });
    expect(waiting.reason).toBe('En espera: Esperando al proveedor');
  });

  it('sin trabajos toma la solicitud que bloquea la entrega', () => {
    const next = caseNextAction({
      workItems: [],
      requests: [
        request({ id: 'r-libre', blocksDelivery: false, dueAt: '2026-09-15T19:00:00.000Z' }),
        request({ id: 'r-bloquea', blocksDelivery: true, dueAt: '2026-09-17T19:00:00.000Z' }),
      ],
      steps: [],
    });
    expect(next.kind).toBe('request');
    expect(next.requestId).toBe('r-bloquea');
    expect(next.areaLabel).toBe('Compras');
  });

  it('sin trabajos ni solicitudes abiertas toma el paso activo del proceso', () => {
    const next = caseNextAction({
      workItems: [],
      requests: [request({ open: false })],
      steps: [
        step({ order: 5, status: 'ready', areaLabel: 'Inventario' }),
        step({ id: 's9', order: 9, status: 'pending' }),
      ],
    });
    expect(next.kind).toBe('step');
    expect(next.title).toBe('Verificar disponibilidad');
    expect(next.reason).toContain('Inventario');
  });

  it('un expediente sin nada abierto lo dice en lugar de inventar un responsable', () => {
    const next = caseNextAction({ workItems: [], requests: [], steps: [] });
    expect(next).toMatchObject({ kind: 'none', ownerName: null, dueAt: null });
  });
});

describe('acciones sobre los trabajos del expediente', () => {
  it('ofrece las cuatro de Mi trabajo más reasignar', () => {
    expect(caseWorkItemActions(workItem())).toStrictEqual([
      'start',
      'complete',
      'wait',
      'escalate',
      'reassign',
    ]);
  });

  it('no ofrece completar cuando falta evidencia: eso se hace en Mi trabajo', () => {
    const item = workItem({ requiredEvidence: ['photo'], missingEvidence: ['photo'] });
    expect(caseWorkItemActions(item)).not.toContain('complete');
    expect(needsEvidenceElsewhere(item)).toBe(true);
    expect(needsEvidenceElsewhere(workItem())).toBe(false);
  });

  it('sin permisos no ofrece nada y un trabajo cerrado tampoco', () => {
    const sinPermisos = workItem({
      permissions: {
        canStart: false,
        canWait: false,
        canComplete: false,
        canReassign: false,
        canEscalate: false,
      },
    });
    expect(caseWorkItemActions(sinPermisos)).toStrictEqual([]);
    expect(caseWorkItemActions(workItem({ status: 'done' }))).toStrictEqual([]);
  });

  it('una aprobación de negocio se firma en Mi trabajo, no aquí', () => {
    expect(caseWorkItemActions(workItem({ objectType: 'approval_request' }))).toStrictEqual([
      'reassign',
    ]);
  });

  it('el comando lleva el agregado, la versión y el tipo real del núcleo', () => {
    expect(buildCaseWorkItemCommand('start', { id: 'w1', version: 3 })).toStrictEqual({
      type: 'workitem.start',
      aggregate: { type: 'work_item', id: 'w1' },
      payload: {},
      expectedVersion: 3,
    });
    expect(
      buildCaseWorkItemCommand('reassign', { id: 'w1', version: 3 }, { ownerUserId: 'u9' })
    ).toStrictEqual({
      type: 'workitem.reassign',
      aggregate: { type: 'work_item', id: 'w1' },
      payload: { ownerUserId: 'u9' },
      expectedVersion: 3,
    });
  });

  it('reasignar exige a quién y limita el motivo', () => {
    expect(buildReassignPayload({ ownerUserId: '  ', reason: '' })).toStrictEqual({
      ok: false,
      error: 'Elige a quién le toca este trabajo',
    });
    expect(
      buildReassignPayload({ ownerUserId: 'u9', reason: '  Se fue de vacaciones ' })
    ).toStrictEqual({
      ok: true,
      payload: { ownerUserId: 'u9', reason: 'Se fue de vacaciones' },
    });
    expect(buildReassignPayload({ ownerUserId: 'u9', reason: '' })).toStrictEqual({
      ok: true,
      payload: { ownerUserId: 'u9' },
    });
    expect(buildReassignPayload({ ownerUserId: 'u9', reason: 'x'.repeat(501) }).ok).toBe(false);
  });
});

describe('acciones del expediente', () => {
  it('sólo se ofrecen con operations.manage y con el expediente abierto', () => {
    expect(caseActions('open', { canManage: true })).toStrictEqual(['replan', 'cancel']);
    expect(caseActions('open', { canManage: false })).toStrictEqual([]);
    expect(caseActions('closed', { canManage: true })).toStrictEqual([]);
  });

  it('cancelar exige motivo y replanificar no', () => {
    expect(buildCaseReasonPayload('cancel', ' ok ')).toStrictEqual({
      ok: false,
      error: 'Escribe el motivo de la cancelación (mínimo 3 caracteres)',
    });
    expect(buildCaseReasonPayload('cancel', 'El cliente canceló')).toStrictEqual({
      ok: true,
      payload: { reason: 'El cliente canceló' },
    });
    expect(buildCaseReasonPayload('replan', '')).toStrictEqual({ ok: true, payload: {} });
    expect(buildCaseReasonPayload('replan', 'x'.repeat(501)).ok).toBe(false);
  });

  it('el comando del expediente usa el agregado y la versión optimista', () => {
    expect(
      buildCaseCommand('cancel', { id: 'c1', version: 7 }, { reason: 'Se canceló' })
    ).toStrictEqual({
      type: 'case.cancel',
      aggregate: { type: 'operational_case', id: 'c1' },
      payload: { reason: 'Se canceló' },
      expectedVersion: 7,
    });
  });

  it('el enlace del expediente codifica el identificador', () => {
    expect(caseHref('a/b')).toBe('/app/operations/cases/a%2Fb');
  });
});

describe('cronología', () => {
  const entries: CaseTimelineEntry[] = [
    {
      id: '3',
      line: '09:29 Compras recibió la solicitud',
      type: 'request.acknowledged',
      areaKey: 'compras',
      areaLabel: 'Compras',
      actorType: 'user',
      occurredAt: '2026-09-15T15:29:00.000Z',
    },
    {
      id: '2',
      line: '09:20 Inventario confirmó el faltante',
      type: 'demand.shortfall_confirmed',
      areaKey: 'inventario',
      areaLabel: 'Inventario',
      actorType: 'user',
      occurredAt: '2026-09-15T15:20:00.000Z',
    },
    {
      id: '1',
      line: '09:00 Se abrió el expediente',
      type: 'case.started',
      areaKey: null,
      areaLabel: null,
      actorType: 'system',
      occurredAt: '2026-09-15T15:00:00.000Z',
    },
  ];

  it('los filtros cuentan por área y "Todo" incluye lo que no tiene área', () => {
    expect(timelineAreaFilters(entries)).toStrictEqual([
      { key: 'all', label: 'Todo', count: 3 },
      { key: 'compras', label: 'Compras', count: 1 },
      { key: 'inventario', label: 'Inventario', count: 1 },
    ]);
  });

  it('filtrar por área deja sólo sus entradas', () => {
    expect(filterTimeline(entries, 'compras').map((entry) => entry.id)).toStrictEqual(['3']);
    expect(filterTimeline(entries, 'all')).toHaveLength(3);
  });

  it('cargar más añade sólo lo que no estaba', () => {
    const older: CaseTimelineEntry[] = [
      entries[2],
      { ...entries[2], id: '0', line: '08:55 Se creó el expediente' },
    ];
    expect(mergeTimeline(entries, older).map((entry) => entry.id)).toStrictEqual([
      '3',
      '2',
      '1',
      '0',
    ]);
  });
});

describe('contexto para el copiloto', () => {
  it('manda datos acotados de la página, no instrucciones', () => {
    const context = buildCaseCopilotContext({
      caseId: 'c1',
      caseNumber: 'EXP-12',
      status: 'blocked',
      phase: 'sourcing',
      promisedAt: '2026-09-18T18:00:00.000Z',
      risk: 'risk',
      progress: caseProgress([step()], PHASE_LABELS, 'planning'),
      next: caseNextAction({ workItems: [workItem()], requests: [], steps: [] }),
      workItems: [workItem({ title: 'x'.repeat(200) })],
      requests: [request(), request({ id: 'r2', open: false })],
      incidents: 2,
      timelineFilter: 'compras',
    });
    expect(context.surface).toBe('case');
    expect(context.riskLabel).toBe('En riesgo');
    expect(context.openIncidents).toBe(2);
    expect(context.timelineFilter).toBe('compras');
    const items = context.openWorkItems as Array<{ title: string }>;
    expect(items[0].title).toHaveLength(120);
    // Sólo viajan las solicitudes abiertas.
    expect(context.openRequests).toHaveLength(1);
  });
});

describe('dónde se responde una solicitud', () => {
  it('su responsable la contesta en Mi trabajo, con el trabajo enfocado', () => {
    expect(
      requestAnswerHref(request({ ownerUserId: 'u2', workItemId: 'w 9' }), 'u2')
    ).toStrictEqual({ href: '/app/mywork?workItem=w%209', label: 'Responder en Mi trabajo' });
  });

  it('cualquier otra persona va al centro de trabajo del área destino', () => {
    expect(requestAnswerHref(request({ toAreaKey: 'compras' }), 'otro')).toStrictEqual({
      href: '/app/areas/compras/trabajo',
      label: 'Abrir en el área',
    });
  });

  it('una solicitud cerrada no ofrece a dónde ir', () => {
    expect(requestAnswerHref(request({ open: false }), 'u2')).toBeNull();
  });
});
