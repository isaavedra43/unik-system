import { describe, expect, it } from 'vitest';
import {
  formatMoney,
  mergeIds,
  messageActivitySummary,
  openObjections,
  planConversationTouch,
  planStageMove,
  quoteStatusActivityKind,
  shouldAdvanceToQuoted,
  toNumber,
  truncateText,
  type StageRef,
} from './opportunity-rules';

/** Opportunity rules: stage moves, touches from messages, quote activities, objections and helpers. */

const NOW = new Date('2026-09-15T18:00:00.000Z');
const stage = (key: string, kind: string, order: number, active = true): StageRef => ({ id: `s-${key}`, key, name: key[0].toUpperCase() + key.slice(1), order, kind, active });
const contactado = stage('contactado', 'open', 2);
const cotizado = stage('cotizado', 'open', 3);
const ganado = stage('ganado', 'won', 5);
const perdido = stage('perdido', 'lost', 6);

describe('planStageMove', () => {
  it('wins an opportunity', () => {
    expect(planStageMove({ status: 'open', stageId: contactado.id }, ganado, { now: NOW })).toEqual({
      ok: true,
      transition: 'won',
      data: { stageId: ganado.id, stageEnteredAt: NOW, status: 'won', wonAt: NOW, lostAt: null, lostReason: null },
    });
  });

  it('requires and normalizes the lost reason', () => {
    expect(planStageMove({ status: 'open', stageId: contactado.id }, perdido, { now: NOW, lostReason: ' ' })).toMatchObject({ ok: false, code: 'invalid_payload' });
    expect(planStageMove({ status: 'open', stageId: contactado.id }, perdido, { now: NOW, lostReason: '  Precio   muy alto ' })).toMatchObject({
      ok: true,
      transition: 'lost',
      data: { status: 'lost', lostAt: NOW, lostReason: 'Precio muy alto', wonAt: null },
    });
  });

  it('moves between open stages and reopens closed or dormant opportunities', () => {
    expect(planStageMove({ status: 'open', stageId: contactado.id }, cotizado, { now: NOW })).toMatchObject({ ok: true, transition: null, data: { status: 'open' } });
    expect(planStageMove({ status: 'lost', stageId: perdido.id }, contactado, { now: NOW })).toMatchObject({
      ok: true,
      transition: 'reopened',
      data: { status: 'open', lostAt: null, lostReason: null, wonAt: null },
    });
    expect(planStageMove({ status: 'dormant', stageId: contactado.id }, contactado, { now: NOW })).toMatchObject({ ok: true, transition: 'reopened' });
  });

  it('rejects the same stage and inactive targets', () => {
    expect(planStageMove({ status: 'open', stageId: contactado.id }, contactado, { now: NOW })).toEqual({
      ok: false,
      code: 'invalid_state',
      message: 'La oportunidad ya está en la etapa «Contactado»',
    });
    expect(planStageMove({ status: 'won', stageId: ganado.id }, ganado, { now: NOW })).toMatchObject({ ok: false });
    expect(planStageMove({ status: 'open', stageId: contactado.id }, stage('visita', 'open', 4, false), { now: NOW })).toMatchObject({
      ok: false,
      message: 'La etapa «Visita» está desactivada',
    });
  });
});

describe('quotes', () => {
  it('maps quote statuses to activity kinds', () => {
    expect(quoteStatusActivityKind('sent')).toBe('quote_sent');
    expect(quoteStatusActivityKind('Viewed')).toBe('quote_viewed');
    expect(quoteStatusActivityKind('accepted')).toBe('quote_accepted');
    expect(quoteStatusActivityKind('invoiced')).toBe('quote_accepted');
    expect(quoteStatusActivityKind('declined')).toBe('quote_declined');
    expect(quoteStatusActivityKind('draft')).toBe('note');
    expect(quoteStatusActivityKind(null)).toBe('note');
  });

  it('advances only open opportunities before the quoted stage', () => {
    expect(shouldAdvanceToQuoted('open', contactado, cotizado)).toBe(true);
    expect(shouldAdvanceToQuoted('open', cotizado, cotizado)).toBe(false);
    expect(shouldAdvanceToQuoted('open', stage('negociacion', 'open', 4), cotizado)).toBe(false);
    expect(shouldAdvanceToQuoted('dormant', contactado, cotizado)).toBe(false);
    expect(shouldAdvanceToQuoted('open', contactado, { ...cotizado, active: false })).toBe(false);
    expect(shouldAdvanceToQuoted('open', contactado, null)).toBe(false);
  });
});

describe('planConversationTouch', () => {
  const state = {
    status: 'open',
    lastActivityAt: new Date('2026-09-15T10:00:00.000Z'),
    lastInboundAt: new Date('2026-09-15T09:00:00.000Z'),
    lastOutboundAt: null,
    conversationIds: ['conv-1'],
  };

  it('moves the inbound timestamps forward', () => {
    expect(planConversationTouch(state, { direction: 'inbound', status: 'received', createdAt: NOW }, 'conv-1')).toEqual({
      skip: null,
      activityKind: 'message_in',
      reactivate: false,
      data: { lastActivityAt: NOW, lastInboundAt: NOW },
    });
  });

  it('records outbound messages and links a new conversation', () => {
    expect(planConversationTouch(state, { direction: 'outbound', status: 'sent', createdAt: NOW }, 'conv-2')).toEqual({
      skip: null,
      activityKind: 'message_out',
      reactivate: false,
      data: { lastActivityAt: NOW, lastOutboundAt: NOW, conversationIds: ['conv-1', 'conv-2'] },
    });
  });

  it('never rewinds timestamps with an out-of-order message', () => {
    const old = new Date('2026-09-15T08:00:00.000Z');
    const plan = planConversationTouch(state, { direction: 'inbound', status: 'received', createdAt: old }, 'conv-1');
    expect(plan).toMatchObject({ skip: null, data: { lastActivityAt: state.lastActivityAt, lastInboundAt: state.lastInboundAt } });
  });

  it('skips failed outbound messages, closed opportunities and unknown directions', () => {
    expect(planConversationTouch(state, { direction: 'outbound', status: 'failed', createdAt: NOW }, 'conv-1')).toEqual({ skip: 'failed_outbound' });
    expect(planConversationTouch(state, { direction: 'outbound', status: 'undelivered', createdAt: NOW }, 'conv-1')).toEqual({ skip: 'failed_outbound' });
    expect(planConversationTouch({ ...state, status: 'won' }, { direction: 'inbound', status: 'received', createdAt: NOW }, 'conv-1')).toEqual({ skip: 'closed' });
    expect(planConversationTouch(state, { direction: 'internal', status: 'x', createdAt: NOW }, 'conv-1')).toEqual({ skip: 'unknown_direction' });
  });

  it('wakes a dormant opportunity with an inbound message only', () => {
    const dormant = { ...state, status: 'dormant' };
    expect(planConversationTouch(dormant, { direction: 'inbound', status: 'received', createdAt: NOW }, 'conv-1')).toMatchObject({
      reactivate: true,
      data: { status: 'open' },
    });
    expect(planConversationTouch(dormant, { direction: 'outbound', status: 'sent', createdAt: NOW }, 'conv-1')).toMatchObject({ reactivate: false });
  });

  it('summarizes messages for the timeline', () => {
    expect(messageActivitySummary('inbound', '  ¿Tienen   porcelanato 60x60? ')).toBe('Cliente: «¿Tienen porcelanato 60x60?»');
    expect(messageActivitySummary('outbound', 'Sí, le envío la cotización')).toBe('Enviado: «Sí, le envío la cotización»');
    expect(messageActivitySummary('inbound', null, 2)).toBe('El cliente envió un adjunto');
    expect(messageActivitySummary('outbound', '', 0)).toBe('Mensaje enviado');
    // "Cliente: «" (10) + 160 truncated characters (ending in "…") + "»" (1)
    expect(messageActivitySummary('inbound', 'x'.repeat(300))).toHaveLength(171);
  });
});

describe('openObjections', () => {
  const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

  it('closes referenced objections and earlier ones on a generic resolution', () => {
    const list = [
      { id: 'o1', kind: 'objection', at: at(90), summary: 'Precio' },
      { id: 'o2', kind: 'objection', at: at(80), summary: 'Plazo' },
      { id: 'r1', kind: 'objection_resolved', refType: 'opportunity_activity', refId: 'o2', at: at(70), summary: 'Se aceleró' },
      { id: 'o3', kind: 'objection', at: at(60), summary: 'Color' },
      { id: 'n1', kind: 'note', at: at(50), summary: 'Nota' },
    ];
    expect(openObjections(list).map((o) => o.id)).toEqual(['o1', 'o3']);
    expect(openObjections([...list, { id: 'r2', kind: 'objection_resolved', at: at(65), summary: 'Todo resuelto' }]).map((o) => o.id)).toEqual(['o3']);
  });
});

describe('helpers', () => {
  it('merges ids without duplicates', () => {
    expect(mergeIds(['a', 'b'], ['b', null, 'c', undefined, ''])).toEqual(['a', 'b', 'c']);
  });

  it('truncates and formats', () => {
    expect(truncateText('  hola   mundo ', 20)).toBe('hola mundo');
    expect(truncateText('abcdefghij', 5)).toBe('abcd…');
    expect(formatMoney(12_500)).toBe('$12,500.00');
    expect(formatMoney('1500.5', 'USD')).toContain('1,500.50');
    expect(formatMoney(10, 'XXXX')).toBe('10.00 XXXX');
    expect(toNumber('12.5')).toBe(12.5);
    expect(toNumber('')).toBeNull();
    expect(toNumber({ toString: () => '7' })).toBe(7);
  });
});
