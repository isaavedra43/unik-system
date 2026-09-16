import { describe, expect, it } from 'vitest';
import type { OpportunityDTO, PipelineStageDTO } from '@/modules/crm/crm-dto';
import type { PipelineBoard } from '@/modules/crm/crm-queries';
import {
  activeStageIds,
  boardColumns,
  boardTotals,
  buildActivityCommand,
  buildCreateFromConversationCommand,
  buildCreateStageCommand,
  buildMoveStageCommand,
  buildNextActionCommand,
  buildReorderStagesCommand,
  buildUpdateStageCommand,
  deactivateStageIssue,
  lostReasonError,
  moveStageInOrder,
  moveTargets,
  openStageCounts,
  planStageMove,
  stageFormIssues,
  stageTone,
  toCard,
} from './pipeline-model';

function stage(overrides: Partial<PipelineStageDTO> = {}): PipelineStageDTO {
  return {
    id: 'stage-open',
    key: 'nuevo',
    name: 'Nuevo',
    order: 1,
    probabilityDefault: 0.2,
    kind: 'open',
    slaHours: 48,
    active: true,
    ...overrides,
  };
}

function opportunity(overrides: Partial<OpportunityDTO> = {}): OpportunityDTO {
  return {
    id: 'opp-1',
    number: 'OPP-000123',
    title: 'Estructura para nave',
    commContactId: null,
    zohoContactId: null,
    contactName: 'Aceros del Norte',
    salespersonUserId: 'u-ana',
    salespersonName: 'Ana',
    stageId: 'stage-open',
    stageKey: 'nuevo',
    stageName: 'Nuevo',
    stageKind: 'open',
    stageEnteredAt: '2026-09-10T10:00:00.000Z',
    stageSlaExceededHours: 12,
    estimatedValue: '125000',
    currency: 'MXN',
    probability: null,
    effectiveProbability: 0.35,
    expectedCloseAt: null,
    nextActionAt: '2026-09-14T10:00:00.000Z',
    nextActionText: 'Llamar para confirmar medidas',
    nextActionOverdue: true,
    source: 'inbox',
    conversationIds: ['conv-1'],
    voiceCallIds: [],
    zohoEstimateIds: [],
    zohoSalesOrderIds: [],
    caseIds: [],
    status: 'open',
    statusLabel: 'Abierta',
    lostReason: null,
    wonAt: null,
    lostAt: null,
    lastActivityAt: '2026-09-13T10:00:00.000Z',
    lastInboundAt: null,
    lastOutboundAt: null,
    tags: [],
    version: 4,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-13T10:00:00.000Z',
    ...overrides,
  };
}

function board(): PipelineBoard {
  return {
    columns: [
      {
        stage: stage(),
        count: 2,
        totalValue: '250000.00',
        weightedValue: '87500.00',
        opportunities: [opportunity(), opportunity({ id: 'opp-2', number: 'OPP-000124' })],
      },
      {
        stage: stage({ id: 'stage-won', key: 'ganado', name: 'Ganado', kind: 'won', order: 9 }),
        count: 1,
        totalValue: '90000.00',
        weightedValue: '90000.00',
        opportunities: [
          opportunity({ id: 'opp-3', stageId: 'stage-won', status: 'won', statusLabel: 'Ganada' }),
        ],
      },
    ],
    totals: { open: 2, openValue: '250000.00', weightedValue: '87500.00' },
    closedWithinDays: 30,
  };
}

describe('columnas y tarjetas', () => {
  it('convierte el tablero en columnas con totales ya formateados', () => {
    const columns = boardColumns(board());
    expect(columns.map((column) => column.stageKey)).toStrictEqual(['nuevo', 'ganado']);
    expect(columns[0].cards).toHaveLength(2);
    expect(columns[0].totalLabel).toContain('250,000');
    expect(columns[1].tone).toBe('success');
    const totals = boardTotals(board());
    expect(totals.openLabel).toBe('2');
    expect(totals.valueLabel).toContain('250,000');
  });

  it('la tarjeta lleva lo que se lee de un vistazo, incluido el SLA excedido', () => {
    const card = toCard(opportunity());
    expect(card).toMatchObject({
      number: 'OPP-000123',
      customerName: 'Aceros del Norte',
      probabilityLabel: '35 %',
      nextActionOverdue: true,
      stageSlaExceededHours: 12,
      version: 4,
    });
    expect(card.valueLabel).toContain('125,000');
  });

  it('el tono de la etapa distingue ganado, perdido y abierto', () => {
    expect(stageTone('won')).toBe('success');
    expect(stageTone('lost')).toBe('danger');
    expect(stageTone('open')).toBe('default');
    expect(stageTone(null)).toBe('default');
  });
});

describe('mover de etapa', () => {
  const stages = [
    stage(),
    stage({ id: 'stage-quote', key: 'cotizado', name: 'Cotizado', order: 2 }),
    stage({ id: 'stage-won', key: 'ganado', name: 'Ganado', kind: 'won', order: 9 }),
    stage({ id: 'stage-lost', key: 'perdido', name: 'Perdido', kind: 'lost', order: 10 }),
    stage({ id: 'stage-old', key: 'viejo', name: 'Viejo', active: false, order: 11 }),
  ];

  it('ofrece las etapas activas menos la actual', () => {
    expect(moveTargets(stages, 'stage-open').map((row) => row.key)).toStrictEqual([
      'cotizado',
      'ganado',
      'perdido',
    ]);
  });

  it('soltar en la misma etapa o en una desactivada no hace nada', () => {
    const card = toCard(opportunity());
    expect(planStageMove(card, stage())).toMatchObject({ kind: 'noop' });
    expect(planStageMove(card, stage({ id: 'stage-old', active: false }))).toMatchObject({
      kind: 'noop',
    });
  });

  it('mover a perdido exige motivo y mover a ganado confirma', () => {
    const card = toCard(opportunity());
    const lost = planStageMove(
      card,
      stage({ id: 'stage-lost', key: 'perdido', name: 'Perdido', kind: 'lost' })
    );
    expect(lost.kind).toBe('needs_reason');
    if (lost.kind === 'needs_reason') expect(lost.message).toContain('OPP-000123');
    const won = planStageMove(
      card,
      stage({ id: 'stage-won', key: 'ganado', name: 'Ganado', kind: 'won' })
    );
    expect(won.kind).toBe('ready');
    if (won.kind === 'ready') expect(won.confirm).toContain('ganada');
    const open = planStageMove(
      card,
      stage({ id: 'stage-quote', key: 'cotizado', name: 'Cotizado' })
    );
    if (open.kind === 'ready') expect(open.confirm).toBeNull();
  });

  it('valida el motivo de la pérdida con las mismas reglas del comando', () => {
    expect(lostReasonError('  ')).toContain('mínimo 3');
    expect(lostReasonError('Precio')).toBeNull();
    expect(lostReasonError('x'.repeat(501))).toContain('500');
  });

  it('el comando lleva la clave de la etapa, el motivo y la versión', () => {
    const card = toCard(opportunity());
    const command = buildMoveStageCommand(
      card,
      stage({ id: 'stage-lost', key: 'perdido', name: 'Perdido', kind: 'lost' }),
      '  Se fue con la competencia  '
    );
    expect(command).toStrictEqual({
      type: 'crm.opportunity.move_stage',
      aggregate: { type: 'opportunity', id: 'opp-1' },
      payload: {
        opportunityId: 'opp-1',
        stageKey: 'perdido',
        lostReason: 'Se fue con la competencia',
      },
      expectedVersion: 4,
    });
  });
});

describe('otros comandos de la oportunidad', () => {
  it('la siguiente acción viaja con fecha ISO y versión optimista', () => {
    const command = buildNextActionCommand({
      opportunityId: 'opp-1',
      version: 4,
      nextActionText: '  Enviar cotización ',
      nextActionAt: '2026-09-20T15:00:00.000Z',
    });
    expect(command.type).toBe('crm.opportunity.update');
    expect(command.expectedVersion).toBe(4);
    expect(command.payload).toStrictEqual({
      opportunityId: 'opp-1',
      nextActionText: 'Enviar cotización',
      nextActionAt: '2026-09-20T15:00:00.000Z',
    });
  });

  it('la actividad manual usa un agregado sin versión y limpia los campos vacíos', () => {
    const command = buildActivityCommand({
      opportunityId: 'opp-1',
      kind: 'call',
      summary: '  Llamada de seguimiento  ',
      nextActionText: '   ',
    });
    expect(command.aggregate).toStrictEqual({ type: 'opportunity', id: 'activity:opp-1' });
    expect(command.expectedVersion).toBeUndefined();
    expect(command.payload).toStrictEqual({
      opportunityId: 'opp-1',
      kind: 'call',
      summary: 'Llamada de seguimiento',
    });
  });

  it('crear desde una conversación usa el id determinista y descarta títulos demasiado cortos', () => {
    const command = buildCreateFromConversationCommand({ conversationId: 'conv-9', title: 'a' });
    expect(command.aggregate).toStrictEqual({
      type: 'opportunity',
      id: 'opportunity:conversation:conv-9',
    });
    expect(command.payload).toStrictEqual({ conversationId: 'conv-9' });
    expect(
      buildCreateFromConversationCommand({ conversationId: 'conv-9', title: ' Nave industrial ' })
        .payload
    ).toStrictEqual({ conversationId: 'conv-9', title: 'Nave industrial' });
  });
});

/**
 * Plan 6.5: «Seed of an empty pipeline (editable afterwards with
 * `crm.manage_stages`)». Los tres comandos existían con su permiso desde el
 * principio, pero ninguna pantalla los invocaba: la única forma de crear o
 * reordenar una etapa era POSTear a mano a la API de comandos. Aquí se prueba
 * el modelo puro que ahora arma esos comandos y sus avisos en español.
 */
describe('administración de etapas', () => {
  const pipeline: PipelineStageDTO[] = [
    stage({ id: 's1', key: 'nuevo', name: 'Nuevo', order: 1 }),
    stage({ id: 's2', key: 'cotizado', name: 'Cotizado', order: 2 }),
    stage({ id: 's3', key: 'ganado', name: 'Ganado', kind: 'won', order: 3, slaHours: null }),
    stage({ id: 's4', key: 'perdido', name: 'Perdido', kind: 'lost', order: 4, slaHours: null }),
    stage({ id: 's5', key: 'viejo', name: 'Etapa vieja', order: 5, active: false }),
  ];

  it('el alta manda nombre, tipo, probabilidad en fracción y SLA en horas', () => {
    const command = buildCreateStageCommand({
      name: '  Visita técnica ',
      kind: 'open',
      probabilityPct: '35',
      slaHours: '48',
    });
    expect(command.type).toBe('crm.stage.create');
    expect(command.aggregate).toStrictEqual({ type: 'pipeline_stage', id: 'pipeline' });
    expect(command.payload).toStrictEqual({
      name: 'Visita técnica',
      kind: 'open',
      probabilityDefault: 0.35,
      slaHours: 48,
    });
    // Vacíos: el motor pone la probabilidad del tipo y la etapa queda sin SLA.
    expect(
      buildCreateStageCommand({ name: 'Visita', kind: 'won', probabilityPct: '', slaHours: '' })
        .payload
    ).toStrictEqual({ name: 'Visita', kind: 'won' });
  });

  it('avisa en español de lo que el motor rechazaría antes de mandarlo', () => {
    expect(
      stageFormIssues(
        { name: 'Visita técnica', kind: 'open', probabilityPct: '', slaHours: '' },
        pipeline
      )
    ).toStrictEqual([]);
    expect(
      stageFormIssues({ name: 'a', kind: 'open', probabilityPct: '', slaHours: '' }, pipeline)[0]
    ).toMatch(/entre 2 y 60/);
    expect(
      stageFormIssues(
        { name: ' cotizado ', kind: 'open', probabilityPct: '', slaHours: '' },
        pipeline
      )[0]
    ).toMatch(/Ya existe una etapa activa/);
    // Una etapa APAGADA con el mismo nombre no estorba: el motor sólo mira las activas.
    expect(
      stageFormIssues(
        { name: 'Etapa vieja', kind: 'open', probabilityPct: '', slaHours: '' },
        pipeline
      )
    ).toStrictEqual([]);
    expect(
      stageFormIssues(
        { name: 'Visita', kind: 'abierta', probabilityPct: '120', slaHours: '0' },
        pipeline
      )
    ).toStrictEqual([
      'Elige si la etapa es abierta, ganada o perdida',
      'La probabilidad va de 0 a 100',
      'El SLA son horas enteras entre 1 y 8760',
    ]);
  });

  it('la edición distingue quitar el SLA de no tocarlo', () => {
    expect(
      buildUpdateStageCommand({
        stageId: 's1',
        name: ' Nuevo nombre ',
        probabilityPct: '15',
        slaHours: '24',
      }).payload
    ).toStrictEqual({
      stageId: 's1',
      name: 'Nuevo nombre',
      probabilityDefault: 0.15,
      slaHours: 24,
    });
    expect(buildUpdateStageCommand({ stageId: 's1', slaHours: null }).payload).toStrictEqual({
      stageId: 's1',
      slaHours: null,
    });
    expect(buildUpdateStageCommand({ stageId: 's1', active: false }).payload).toStrictEqual({
      stageId: 's1',
      active: false,
    });
  });

  it('el reordenamiento lista sólo las etapas activas y el movimiento imposible no cambia nada', () => {
    const ids = activeStageIds(pipeline);
    expect(ids).toStrictEqual(['s1', 's2', 's3', 's4']);
    expect(moveStageInOrder(ids, 's2', 'up')).toStrictEqual(['s2', 's1', 's3', 's4']);
    expect(moveStageInOrder(ids, 's1', 'up')).toStrictEqual(ids);
    expect(moveStageInOrder(ids, 's4', 'down')).toStrictEqual(ids);
    expect(moveStageInOrder(ids, 's5', 'up')).toStrictEqual(ids);
    const command = buildReorderStagesCommand(moveStageInOrder(ids, 's2', 'up'));
    expect(command.type).toBe('crm.stage.reorder');
    expect(command.payload).toStrictEqual({ stageIds: ['s2', 's1', 's3', 's4'] });
  });

  it('no deja apagar la última etapa de un tipo ni una con oportunidades vivas', () => {
    expect(deactivateStageIssue(pipeline, 's1', 0)).toBeNull();
    expect(deactivateStageIssue(pipeline, 's1', 1)).toMatch(/la oportunidad abierta/);
    expect(deactivateStageIssue(pipeline, 's1', 4)).toMatch(/las 4 oportunidades abiertas/);
    expect(deactivateStageIssue(pipeline, 's3', 0)).toMatch(
      /al menos una etapa activa de este tipo/
    );
    expect(deactivateStageIssue(pipeline, 'inventada', 0)).toBe('La etapa ya no existe');
  });

  it('cuenta como vivas sólo las oportunidades abiertas o dormidas del tablero', () => {
    expect(openStageCounts(board())).toStrictEqual({ 'stage-open': 2, 'stage-won': 0 });
  });
});
