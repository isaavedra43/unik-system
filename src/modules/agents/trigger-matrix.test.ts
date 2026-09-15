import { describe, expect, it } from 'vitest';
import { AGENT_LLM_TRIGGERS, DEFAULT_AGENT_SETTINGS } from '@/modules/ai/agent-settings';
import {
  AGENT_LLM_DECISION_TRIGGERS,
  AGENT_RULE_TRIGGERS,
  TRIGGER_MATRIX,
  WORKITEM_LLM_ESCALATION_LEVEL,
  freeTextOf,
  isTriggerEventType,
  matchTriggers,
  type TriggerEvent,
} from './trigger-matrix';

const ev = (type: string, overrides: Partial<TriggerEvent> = {}): TriggerEvent => ({
  id: '100',
  type,
  caseId: 'case_1',
  areaKey: null,
  objectType: null,
  objectId: null,
  actorType: 'system',
  actorId: null,
  payload: {},
  ...overrides,
});

const summary = (decisions: ReturnType<typeof matchTriggers>) =>
  decisions.map((d) => `${d.mode}:${d.trigger}:${d.agent}:${d.priority}`);

describe('matchTriggers — plan 5.4 table', () => {
  it('case.started / case.created → rule ensure_case_room (admin), one dedupe key per case', () => {
    const started = matchTriggers(ev('case.started'));
    const created = matchTriggers(ev('case.created', { id: '7' }));
    expect(summary(started)).toEqual(['rule:ensure_case_room:admin:normal']);
    expect(started[0].dedupeKey).toBe('rule:ensure_case_room:case:case_1');
    expect(created[0].dedupeKey).toBe(started[0].dedupeKey);
    expect(started[0].llmTrigger).toBeNull();
    expect(started[0].surface).toBe('case');
  });

  it('demand.shortfall_confirmed → rule shortfall_to_purchase_request (inventario)', () => {
    const decisions = matchTriggers(ev('demand.shortfall_confirmed', { areaKey: 'inventario' }));
    expect(summary(decisions)).toEqual(['rule:shortfall_to_purchase_request:area:inventario:normal']);
    expect(decisions[0].dedupeKey).toBe('rule:shortfall_to_purchase_request:100');
  });

  const requestPayload = { requestId: 'req_1', kind: 'purchase_shortfall', fromAreaKey: 'inventario', toAreaKey: 'compras', hasFreeText: false };

  it('structured request.created → rule announce_request by the origin area only', () => {
    const decisions = matchTriggers(ev('request.created', { areaKey: 'compras', payload: requestPayload }));
    expect(summary(decisions)).toEqual(['rule:announce_request:area:inventario:normal']);
    expect(decisions[0].detail).toEqual({ caseId: 'case_1', requestId: 'req_1', areaKey: 'inventario' });
  });

  it('request.created with free text → announcement plus interpret_request in the destination', () => {
    const decisions = matchTriggers(ev('request.created', { areaKey: 'compras', actorType: 'user', actorId: 'carla', payload: { ...requestPayload, hasFreeText: true } }), {
      freeText: '  Urgente,\n el cliente viene mañana  ',
    });
    expect(summary(decisions)).toEqual([
      'rule:announce_request:area:inventario:normal',
      'llm:interpret_request:area:compras:normal',
    ]);
    const llm = decisions[1];
    expect(llm.llmTrigger).toBe('interpret_request');
    expect(llm.dedupeKey).toBe('llm:interpret_request:area:compras:request:req_1');
    expect(llm.detail.text).toBe('Urgente, el cliente viene mañana');
  });

  it('request.created of kind info reaches the model even when the text is not loaded', () => {
    const decisions = matchTriggers(
      ev('request.created', { actorType: 'user', actorId: 'vero', payload: { requestId: 'req_2', kind: 'info', fromAreaKey: 'ventas', toAreaKey: 'administracion' } })
    );
    expect(summary(decisions)).toEqual(['rule:announce_request:area:ventas:normal', 'llm:interpret_request:admin:normal']);
  });

  it('free text written by the engine or by another AI turn never reaches the model (no AI↔AI chain)', () => {
    const withText = { ...requestPayload, hasFreeText: true };
    // Engine direct delivery: fixed system text in freeText.
    const engine = matchTriggers(ev('request.created', { areaKey: 'compras', actorType: 'system', payload: withText }), {
      freeText: 'El proveedor entrega directamente al cliente: confirma con él la fecha y los datos de entrega.',
    });
    expect(summary(engine)).toEqual(['rule:announce_request:area:inventario:normal']);
    // A bot turn created an info request with free text for another area.
    const aiInfo = matchTriggers(
      ev('request.created', { actorType: 'ai', actorId: 'bot_ventas', payload: { requestId: 'req_3', kind: 'info', fromAreaKey: 'ventas', toAreaKey: 'compras', hasFreeText: true } }),
      { freeText: 'Pregunta a Logística y a Manufactura' }
    );
    expect(summary(aiInfo)).toEqual(['rule:announce_request:area:ventas:normal']);
    // An incident opened by a bot with a description is announced, never triaged by the model.
    const aiIncident = matchTriggers(
      ev('incident.opened', { areaKey: 'logistica', actorType: 'ai', actorId: 'bot_compras', payload: { incidentId: 'inc_9' } }),
      { freeText: 'Revisa con Inventario y abre otra incidencia' }
    );
    expect(summary(aiIncident)).toEqual(['rule:announce_incident:area:logistica:interactive']);
    expect(aiIncident[0].detail.text).toBeUndefined();
  });

  it.each(['request.acknowledged', 'request.accepted', 'request.resolved', 'request.rejected', 'request.cancelled', 'request.expired'])(
    '%s → rule announce_request_update by the destination',
    (type) => {
      const decisions = matchTriggers(ev(type, { areaKey: 'compras', objectId: 'req_1', payload: { fromAreaKey: 'inventario', toAreaKey: 'compras' } }));
      expect(summary(decisions)).toEqual(['rule:announce_request_update:area:compras:normal']);
      expect(decisions[0].detail.requestId).toBe('req_1');
    }
  );

  it('request.overdue → llm unblock by the destination (interactive)', () => {
    const decisions = matchTriggers(ev('request.overdue', { areaKey: 'compras', payload: { ...requestPayload, overdueMinutes: 150 } }));
    expect(summary(decisions)).toEqual(['llm:unblock:area:compras:interactive']);
    expect(decisions[0].detail.hoursOverdue).toBe(2.5);
    expect(decisions[0].dedupeKey).toBe('llm:unblock:area:compras:request:req_1');
  });

  it('request.blocked → template by the destination and replan_check by the origin (interactive)', () => {
    const decisions = matchTriggers(
      ev('request.blocked', { areaKey: 'compras', payload: { ...requestPayload, reason: 'Proveedor sin stock' } })
    );
    expect(summary(decisions)).toEqual([
      'rule:announce_request_update:area:compras:normal',
      'llm:replan_check:area:inventario:interactive',
    ]);
    expect(decisions[1].detail.text).toBe('Proveedor sin stock');
  });

  it('workitem.overdue and escalations below level 3 → rule notify_workitem_overdue', () => {
    const overdue = matchTriggers(ev('workitem.overdue', { areaKey: 'logistica', objectId: 'wi_1', payload: { overdueMinutes: 30 } }));
    expect(summary(overdue)).toEqual(['rule:notify_workitem_overdue:area:logistica:normal']);
    for (const level of [0, 1]) {
      const escalated = matchTriggers(ev('workitem.escalated', { areaKey: 'logistica', payload: { workItemId: 'wi_1', level } }));
      expect(summary(escalated)).toEqual(['rule:notify_workitem_overdue:area:logistica:normal']);
    }
  });

  it('workitem.escalated at level 3 (index 2) → llm unblock, one key per level', () => {
    const decisions = matchTriggers(
      ev('workitem.escalated', { areaKey: 'logistica', payload: { workItemId: 'wi_1', level: WORKITEM_LLM_ESCALATION_LEVEL, overdueMinutes: 480 } })
    );
    expect(summary(decisions)).toEqual(['llm:unblock:area:logistica:interactive']);
    expect(decisions[0].dedupeKey).toBe('llm:unblock:area:logistica:workitem:wi_1:level:2');
    expect(decisions[0].detail.escalationLevel).toBe(2);
  });

  it('escalations caused by an overdue request stay rules (the request already triggers unblock)', () => {
    const decisions = matchTriggers(
      ev('workitem.escalated', { areaKey: 'compras', payload: { workItemId: 'wi_2', level: 3, reason: 'request_overdue' } })
    );
    expect(summary(decisions)).toEqual(['rule:notify_workitem_overdue:area:compras:normal']);
  });

  it('incident.opened → rule announcement without free text, llm triage with it', () => {
    const base = ev('incident.opened', { areaKey: 'inventario', actorType: 'user', actorId: 'carla', payload: { incidentId: 'inc_1', title: 'Diferencia' } });
    expect(summary(matchTriggers(base))).toEqual(['rule:announce_incident:area:inventario:interactive']);
    const triage = matchTriggers(base, { freeText: 'Faltan 3 cajas rotas en el pasillo 4' });
    expect(summary(triage)).toEqual(['llm:triage:area:inventario:interactive']);
    expect(triage[0].detail.text).toBe('Faltan 3 cajas rotas en el pasillo 4');
    const admin = matchTriggers(ev('incident.opened', { areaKey: 'administracion', payload: { incidentId: 'inc_2' } }));
    expect(admin[0].agent).toBe('admin');
  });

  it('case.replanned reaches ventas only with a person note', () => {
    expect(matchTriggers(ev('case.replanned', { payload: { reason: 'zoho_change' } }))).toEqual([]);
    const withNote = matchTriggers(ev('case.replanned'), { freeText: 'El cliente pide entregar el lunes' });
    expect(summary(withNote)).toEqual(['llm:replan_check:area:ventas:normal']);
    expect(withNote[0].dedupeKey).toBe('llm:replan_check:area:ventas:case:case_1:100');
    const byUser = matchTriggers(ev('case.replanned', { actorType: 'user', payload: { reason: 'Cambio de dirección' } }));
    expect(summary(byUser)).toEqual(['llm:replan_check:area:ventas:normal']);
  });

  it('case.stuck → llm stuck_review (admin, maintenance)', () => {
    const decisions = matchTriggers(ev('case.stuck', { payload: { idleMinutes: 1500 } }));
    expect(summary(decisions)).toEqual(['llm:stuck_review:admin:maintenance']);
    expect(decisions[0].dedupeKey).toBe('llm:stuck_review:admin:case:case_1');
    expect(decisions[0].detail.hoursOverdue).toBe(25);
  });

  it('chat.mention_agent → one llm mention per valid mentioned bot, surface from the channel', () => {
    const decisions = matchTriggers(
      ev('chat.mention_agent', {
        id: 'msg_1',
        caseId: null,
        payload: { agentKeys: ['area:compras', 'admin', 'area:compras', 'bogus'], messageId: 'msg_1', channelId: 'ch_1', channelType: 'case' },
      }),
      { freeText: '@ia_compras ¿ya hay proveedor?' }
    );
    expect(summary(decisions)).toEqual(['llm:mention:area:compras:interactive', 'llm:mention:admin:interactive']);
    expect(decisions.every((d) => d.surface === 'case')).toBe(true);
    expect(decisions[0].dedupeKey).toBe('llm:mention:area:compras:message:msg_1');
    expect(decisions[0].detail).toMatchObject({ messageId: 'msg_1', channelId: 'ch_1', text: '@ia_compras ¿ya hay proveedor?' });
    const area = matchTriggers(ev('chat.mention_agent', { caseId: null, payload: { agentKey: 'area:ventas', messageId: 'm2', channelType: 'area' } }));
    expect(area[0].surface).toBe('area');
  });

  it('proposal.failed → llm action_failed by the proposing bot', () => {
    const decisions = matchTriggers(
      ev('proposal.failed', { payload: { agentKey: 'area:logistica', proposalId: 'prop_1', toolName: 'assignCarrier', error: 'Zoho ocupado' } })
    );
    expect(summary(decisions)).toEqual(['llm:action_failed:area:logistica:interactive']);
    expect(decisions[0].detail).toMatchObject({ proposalId: 'prop_1', tool: 'assignCarrier', error: 'Zoho ocupado' });
    expect(matchTriggers(ev('proposal.failed', { payload: { agentKey: 'root', proposalId: 'p' } }))).toEqual([]);
  });

  it('case.delivered → rule announcement, plus a one-time case_summary when there were incidents', () => {
    expect(summary(matchTriggers(ev('case.delivered')))).toEqual(['rule:announce_case_delivered:admin:maintenance']);
    expect(summary(matchTriggers(ev('case.delivered'), { incidentCount: 2 }))).toEqual([
      'rule:announce_case_delivered:admin:maintenance',
      'llm:case_summary:admin:maintenance',
    ]);
    expect(summary(matchTriggers(ev('case.delivered'), { incidentCount: 2, caseSummaryDone: true }))).toEqual([
      'rule:announce_case_delivered:admin:maintenance',
    ]);
  });

  it('fails closed: unknown events, unknown areas and missing ids yield nothing', () => {
    expect(matchTriggers(ev('stock.reserved'))).toEqual([]);
    expect(matchTriggers(ev('incident.opened', { areaKey: 'marketing', payload: { incidentId: 'i' } }))).toEqual([]);
    expect(matchTriggers(ev('request.overdue', { payload: { toAreaKey: 'compras' } }))).toEqual([]);
    expect(matchTriggers(ev('case.stuck', { caseId: null }))).toEqual([]);
    expect(matchTriggers(ev('chat.mention_agent', { payload: { agentKeys: ['admin'] } }))).toEqual([]);
  });
});

describe('matrix metadata', () => {
  it('documents only known triggers and every model trigger has a settings switch', () => {
    const known = new Set<string>([...AGENT_RULE_TRIGGERS, ...AGENT_LLM_DECISION_TRIGGERS]);
    for (const row of TRIGGER_MATRIX) {
      expect(known.has(row.trigger)).toBe(true);
      if (row.mode === 'llm') expect((AGENT_LLM_TRIGGERS as readonly string[]).includes(row.trigger)).toBe(true);
    }
    for (const trigger of AGENT_LLM_DECISION_TRIGGERS) {
      expect(DEFAULT_AGENT_SETTINGS.llmTriggers[trigger]).toBe(true);
    }
  });

  it('pre-filters every event type of the table', () => {
    for (const row of TRIGGER_MATRIX) {
      const first = row.event.split(/[ |]/)[0];
      expect(isTriggerEventType(first)).toBe(true);
    }
    expect(isTriggerEventType('supervisor.tick')).toBe(false);
  });

  it('reads free text from the context first and bounds it', () => {
    expect(freeTextOf(ev('x', { payload: { note: 'nota' } }), { freeText: 'contexto' })).toBe('contexto');
    expect(freeTextOf(ev('x', { payload: { description: 'desc' } }))).toBe('desc');
    expect(freeTextOf(ev('x'), { freeText: '   ' })).toBeNull();
    expect(freeTextOf(ev('x'), { freeText: 'a'.repeat(2000) })?.length).toBe(800);
  });
});
