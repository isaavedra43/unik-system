import { describe, expect, it } from 'vitest';
import { OPS_EVENT_TYPES } from '@/modules/operations/types';
import {
  AGENT_MESSAGE_KINDS,
  cleanText,
  formatClock,
  formatDueLabel,
  formatDuration,
  formatQuantity,
  formatShortDate,
  formatTimelineLine,
  renderAgentMessage,
  type AgentMessageKind,
} from './templates';

// 15 sep 2026 09:29 in Mexico City (UTC-6, no daylight saving time).
const NOW = new Date('2026-09-15T15:29:00.000Z');

const BROKEN = /undefined|null|NaN|\[object/;

describe('timeline of the AI layer', () => {
  it('names the AI facts in Spanish and the proposal card line matches its timeline event', () => {
    const at = { occurredAt: NOW };
    expect(formatTimelineLine({ type: 'ai.proposal_created', ...at, payload: { agentKey: 'area:compras', summary: 'Reservar 15 m²' } })).toBe(
      '09:29 IA de Compras propuso: Reservar 15 m² · falta aprobación'
    );
    expect(formatTimelineLine({ type: 'ai.budget_exhausted', ...at, payload: { agentKey: 'admin' } })).toBe('09:29 IA administradora quedó en pausa por presupuesto');
    expect(formatTimelineLine({ type: 'ai.turn_skipped', ...at, payload: { agentKey: 'area:inventario', trigger: 'triage' } })).toBe(
      '09:29 IA de Inventario no tomó turno (una incidencia)'
    );
    expect(formatTimelineLine({ type: 'ai.turn_failed', ...at, payload: { agentKey: 'area:logistica', trigger: 'unblock' } })).not.toMatch(/turn|undefined/);
    const card = renderAgentMessage('proposal.created', { now: NOW, occurredAt: NOW, agentName: 'IA de Compras', proposalSummary: 'Reservar 15 m²' });
    expect(card.timelineLine).toBe('09:29 IA de Compras propuso: Reservar 15 m² · falta aprobación');
  });
});

describe('renderAgentMessage', () => {
  it('renders the request announcement of the plan exactly', () => {
    const out = renderAgentMessage('request.created', {
      now: NOW,
      occurredAt: NOW,
      salesOrderNumber: 'OV-23131',
      caseNumber: 'EXP-7',
      fromAreaKey: 'inventario',
      toAreaKey: 'compras',
      requestKind: 'purchase_shortfall',
      quantity: 15,
      unit: 'm2',
      productName: 'Loseta Perla',
      sku: 'LP-01',
      neededBy: '2026-09-18',
      ownerName: 'Ana',
      backupName: 'Luis',
      dueAt: '2026-09-15T23:00:00.000Z',
    });
    expect(out.text).toBe(
      '📦 Solicitud a Compras · OV-23131 — Faltan 15 m² de Loseta Perla (LP-01) para entregar el 18 sep. Responsable: Ana (respaldo Luis) · Vence hoy 17:00'
    );
    expect(out.timelineLine).toBe('09:29 Compras recibió solicitud por 15 m²');
  });

  it.each(AGENT_MESSAGE_KINDS)('%s renders with an empty context (optional fields never break it)', (kind) => {
    const out = renderAgentMessage(kind as AgentMessageKind, {});
    expect(out.text.length).toBeGreaterThan(3);
    expect(out.text).not.toMatch(BROKEN);
    expect(out.timelineLine).toMatch(/^\d{2}:\d{2} \S/);
    expect(out.timelineLine).not.toMatch(BROKEN);
  });

  it.each(AGENT_MESSAGE_KINDS)('%s renders with a full context', (kind) => {
    const out = renderAgentMessage(kind as AgentMessageKind, {
      now: NOW,
      occurredAt: NOW,
      caseNumber: 'EXP-7',
      salesOrderNumber: 'OV-1',
      customerName: 'Constructora Norte',
      areaKey: 'logistica',
      fromAreaKey: 'inventario',
      toAreaKey: 'compras',
      requestKind: 'info',
      title: 'Confirmar disponibilidad',
      ownerName: 'Ana',
      backupName: 'Luis',
      dueAt: '2026-09-16T15:00:00.000Z',
      actorName: 'Marta',
      reason: 'Proveedor sin existencias',
      note: 'Llega el viernes',
      workItemTitle: 'Preparar pedido',
      overdueMinutes: 150,
      escalationLevel: 1,
      incidentTitle: 'Diferencia de conteo',
      incidentKind: 'count_dispute',
      severity: 'high',
      resolution: 'Se recontó',
      toolName: 'reserveStock',
      proposalSummary: 'Reservar 10 m² de LP-01',
      expiresAt: '2026-09-15T20:00:00.000Z',
      approverName: 'Ana',
      error: 'Existencia insuficiente',
      agentName: 'IA de Compras',
      responsibleName: 'Ana',
      promisedAt: '2026-09-18',
      deliveredAt: NOW,
      incidentCount: 2,
    });
    expect(out.text).not.toMatch(BROKEN);
    expect(out.timelineLine.startsWith('09:29 ')).toBe(true);
  });

  it('uses the plan wording for the budget pause', () => {
    const out = renderAgentMessage('budget.exhausted', { agentName: 'IA de Compras', responsibleName: 'Ana', now: NOW });
    expect(out.text).toBe('⏸️ IA de Compras en pausa por presupuesto, atiende Ana');
  });

  it('describes overdue work with its duration, responsible and 1-based escalation level', () => {
    const out = renderAgentMessage('workitem.overdue', {
      now: NOW,
      areaKey: 'compras',
      workItemTitle: 'Cotizar con proveedor',
      overdueMinutes: 135,
      escalationLevel: 0,
      ownerName: 'Marta',
    });
    expect(out.text).toBe(
      '⏰ Trabajo vencido en Compras — Cotizar con proveedor. Vencido hace 2 h 15 min · Responsable: Marta · Escalación nivel 1'
    );
  });

  it('never creates chat mentions from free text', () => {
    const out = renderAgentMessage('request.blocked', { toAreaKey: 'compras', reason: 'pregúntale a @marta', now: NOW });
    expect(out.text).not.toMatch(/@\w/);
    expect(out.text).toContain('Motivo:');
  });

  it('collapses and truncates long free text', () => {
    const out = renderAgentMessage('request.rejected', { toAreaKey: 'ventas', reason: `a\n\n${'x'.repeat(500)}`, now: NOW });
    expect(out.text).not.toContain('\n');
    expect(out.text.length).toBeLessThan(320);
    expect(out.text).toContain('…');
  });

  it('counts delivered incidents in singular and plural', () => {
    expect(renderAgentMessage('case.delivered', { incidentCount: 1, now: NOW }).text).toContain('Con 1 incidencia');
    expect(renderAgentMessage('case.delivered', { incidentCount: 3, now: NOW }).text).toContain('Con 3 incidencias');
    expect(renderAgentMessage('case.delivered', { incidentCount: 0, now: NOW }).text).not.toContain('incidencia');
  });

  it('rejects unknown kinds', () => {
    expect(() => renderAgentMessage('request.lost' as AgentMessageKind)).toThrow(/Unknown agent message kind/);
  });
});

describe('formatTimelineLine', () => {
  it('renders every core event type without broken parts', () => {
    for (const type of OPS_EVENT_TYPES) {
      const line = formatTimelineLine({ type, occurredAt: NOW, areaKey: 'inventario', payload: {} });
      expect(line.startsWith('09:29 ')).toBe(true);
      expect(line).not.toMatch(BROKEN);
    }
  });

  it('uses the event payload', () => {
    expect(
      formatTimelineLine({
        type: 'request.blocked',
        occurredAt: NOW,
        areaKey: 'compras',
        payload: { fromAreaKey: 'inventario', toAreaKey: 'compras', reason: 'Sin crédito con el proveedor' },
      })
    ).toBe('09:29 Compras bloqueó la solicitud de Inventario: Sin crédito con el proveedor');
    expect(
      formatTimelineLine({ type: 'case.created', occurredAt: NOW, payload: { caseNumber: 'EXP-9', salesOrderNumber: 'OV-9' } })
    ).toBe('09:29 Se abrió el expediente EXP-9 de OV-9');
    expect(formatTimelineLine({ type: 'case.stuck', occurredAt: NOW, payload: { idleMinutes: 1500 } })).toBe(
      '09:29 El expediente lleva 1 d 1 h sin avance'
    );
    expect(
      formatTimelineLine({ type: 'workitem.escalated', occurredAt: NOW, areaKey: 'logistica', payload: { level: 2 } })
    ).toBe('09:29 Se escaló un trabajo de Logística (nivel 3)');
  });

  it('falls back to a readable line for module-specific events', () => {
    expect(formatTimelineLine({ type: 'purchases.order_sent', occurredAt: NOW, areaKey: 'compras' })).toBe(
      '09:29 Compras: purchases order sent'
    );
  });

  it('accepts the OperationalEvent record shape (ISO strings)', () => {
    expect(formatTimelineLine({ id: '12', type: 'delivery.confirmed', occurredAt: NOW.toISOString() })).toBe(
      '09:29 Se confirmó la entrega'
    );
  });
});

describe('formatting helpers', () => {
  it('formats clock, dates and relative due dates in Mexico City time', () => {
    expect(formatClock('2026-09-16T05:05:00.000Z')).toBe('23:05');
    expect(formatClock('not a date')).toBe('--:--');
    expect(formatShortDate('2026-12-01')).toBe('1 dic');
    expect(formatShortDate(new Date('2026-09-18T12:00:00.000Z'))).toBe('18 sep');
    expect(formatDueLabel('2026-09-16T15:00:00.000Z', NOW)).toBe('mañana 09:00');
    expect(formatDueLabel('2026-09-14T15:00:00.000Z', NOW)).toBe('ayer 09:00');
    expect(formatDueLabel('2026-09-20T15:00:00.000Z', NOW)).toBe('20 sep 09:00');
    expect(formatDueLabel('2027-01-05T18:00:00.000Z', NOW)).toBe('5 ene 2027 12:00');
    expect(formatDueLabel(null, NOW)).toBe('');
  });

  it('formats durations and quantities', () => {
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(120)).toBe('2 h');
    expect(formatDuration(2 * 1440 + 60)).toBe('2 d 1 h');
    expect(formatDuration(0)).toBe('');
    expect(formatQuantity(1250.5, 'kg')).toBe('1,250.5 kg');
    expect(formatQuantity('15', 'M2')).toBe('15 m²');
    expect(formatQuantity('abc', 'pz')).toBe('');
    expect(formatQuantity(3, null)).toBe('3');
  });

  it('cleans text', () => {
    expect(cleanText('  hola\n\tmundo  ')).toBe('hola mundo');
    expect(cleanText(undefined)).toBe('');
    expect(cleanText('abcdef', 4)).toBe('abc…');
  });
});
