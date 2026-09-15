import { describe, expect, it } from 'vitest';
import {
  clampScore,
  daysBetweenKeys,
  evaluateRadar,
  formatElapsed,
  localDateKey,
  median,
  radarScore,
  repurchaseStats,
  ruleDeliveryIncident,
  ruleHighIntent,
  ruleNextActionOverdue,
  ruleNoFirstReply,
  ruleNoFollowup,
  ruleObjectionOpen,
  ruleQuoteExpiring,
  ruleRepurchaseOverdue,
  stageWeight,
  topSignalsPerSalesperson,
  valueWeight,
  type ConversationFacts,
  type CustomerOrderFacts,
  type DeliveryIncidentFacts,
  type OpportunityFacts,
  type QuoteFacts,
  type RadarOpportunityRef,
} from './radar-rules';

/**
 * Radar rules (plan 6.5): one block per rule with its formula, the stage and
 * value weights, the clamp to 0–100 and the batch evaluation. The clock is
 * fixed at 2026-09-15 12:00 in Mexico City (18:00 UTC).
 */

const NOW = new Date('2026-09-15T18:00:00.000Z');
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const dateOnly = (key: string) => new Date(`${key}T00:00:00.000Z`);

const negotiationOpp = (overrides: Partial<RadarOpportunityRef> = {}): RadarOpportunityRef => ({
  id: 'opp-1',
  number: 'OPP-000012',
  salespersonUserId: 'u-luis',
  stage: { key: 'negociacion', kind: 'open', name: 'Negociación' },
  estimatedValue: 250_000,
  ...overrides,
});

const conversation = (overrides: Partial<ConversationFacts> = {}): ConversationFacts => ({
  conversationId: 'conv-1',
  commContactId: 'cc-1',
  zohoContactId: null,
  customerName: 'Constructora Norte',
  assignedToUserId: 'u-ana',
  status: 'open',
  snoozedUntil: null,
  firstInboundAt: null,
  lastInboundAt: null,
  lastOutboundAt: null,
  opportunity: null,
  ...overrides,
});

const quote = (overrides: Partial<QuoteFacts> = {}): QuoteFacts => ({
  quoteId: 'q-1',
  zohoEstimateId: '4600009001',
  estimateNumber: 'COT-00042',
  status: 'sent',
  expiryDate: dateOnly('2026-09-17'),
  isViewedByClient: false,
  total: null,
  currencyCode: 'MXN',
  customerName: 'Constructora Norte',
  zohoCustomerId: 'zc-1',
  ownerUserId: 'u-ana',
  opportunity: null,
  ...overrides,
});

const opportunity = (overrides: Partial<OpportunityFacts> = {}): OpportunityFacts => ({
  id: 'opp-1',
  number: 'OPP-000012',
  title: 'Piso para bodega',
  contactName: 'Constructora Norte',
  salespersonUserId: 'u-luis',
  zohoContactId: 'zc-1',
  commContactId: 'cc-1',
  conversationId: 'conv-1',
  status: 'open',
  stage: { key: 'contactado', kind: 'open', name: 'Contactado' },
  probability: 0.25,
  estimatedValue: null,
  currencyCode: 'MXN',
  nextActionAt: null,
  nextActionText: null,
  lastInboundAt: null,
  hasQuote: false,
  objectionActivities: [],
  ...overrides,
});

describe('weights and score', () => {
  it('weighs the stages of the default pipeline', () => {
    expect(stageWeight(null)).toBe(1);
    expect(stageWeight({ key: 'nuevo', kind: 'open' })).toBe(1);
    expect(stageWeight({ key: 'contactado', kind: 'open' })).toBe(1);
    expect(stageWeight({ key: 'cotizado', kind: 'open' })).toBe(1.1);
    expect(stageWeight({ key: 'negociacion', kind: 'open' })).toBe(1.2);
    expect(stageWeight({ key: 'visita_obra', kind: 'open' })).toBe(1);
    expect(stageWeight({ key: 'ganado', kind: 'won' })).toBe(0.9);
    expect(stageWeight({ key: 'perdido', kind: 'lost' })).toBe(0.6);
  });

  it('weighs the value by MXN band (upper bound exclusive)', () => {
    expect(valueWeight(null)).toBe(1);
    expect(valueWeight(0)).toBe(1);
    expect(valueWeight(Number.NaN)).toBe(1);
    expect(valueWeight(9_999.99)).toBe(0.9);
    expect(valueWeight(10_000)).toBe(1);
    expect(valueWeight(49_999)).toBe(1);
    expect(valueWeight(50_000)).toBe(1.1);
    expect(valueWeight(199_999)).toBe(1.1);
    expect(valueWeight(200_000)).toBe(1.2);
  });

  it('clamps and rounds the score to 0–100', () => {
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(49.5)).toBe(50);
    expect(clampScore(100.4)).toBe(100);
    expect(clampScore(150)).toBe(100);
    expect(clampScore(Number.NaN)).toBe(0);
    expect(radarScore(90, { key: 'negociacion', kind: 'open' }, 250_000)).toBe(100);
    expect(radarScore(55, { key: 'perdido', kind: 'lost' }, 5_000)).toBe(30);
  });
});

describe('no_first_reply: 60 + min(30, h/2) when nobody answered for ≥ 2 h', () => {
  it('scores a conversation waiting 10 hours', () => {
    const signal = ruleNoFirstReply(conversation({ firstInboundAt: ago(10 * H), lastInboundAt: ago(9 * H) }), NOW);
    expect(signal).toMatchObject({
      kind: 'no_first_reply',
      subjectKey: 'conv-1',
      score: 65,
      conversationId: 'conv-1',
      salespersonUserId: 'u-ana',
      expiresAt: new Date(NOW.getTime() + H),
    });
    expect(signal?.reason).toBe('Constructora Norte escribió hace 10 h y todavía no recibe una primera respuesta.');
  });

  it('starts exactly at 2 hours and caps the bonus at 30', () => {
    expect(ruleNoFirstReply(conversation({ firstInboundAt: ago(1.9 * H) }), NOW)).toBeNull();
    expect(ruleNoFirstReply(conversation({ firstInboundAt: ago(2 * H) }), NOW)?.score).toBe(61);
    expect(ruleNoFirstReply(conversation({ firstInboundAt: ago(100 * H) }), NOW)?.score).toBe(90);
  });

  it('ignores answered, resolved and snoozed conversations', () => {
    const waiting = { firstInboundAt: ago(10 * H) };
    expect(ruleNoFirstReply(conversation({ ...waiting, lastOutboundAt: ago(9 * H) }), NOW)).toBeNull();
    expect(ruleNoFirstReply(conversation({ ...waiting, status: 'resolved' }), NOW)).toBeNull();
    expect(ruleNoFirstReply(conversation({ ...waiting, status: 'snoozed', snoozedUntil: new Date(NOW.getTime() + H) }), NOW)).toBeNull();
    expect(ruleNoFirstReply(conversation({ ...waiting, status: 'snoozed', snoozedUntil: ago(H) }), NOW)?.score).toBe(65);
  });

  it('applies the opportunity weights and salesperson', () => {
    const signal = ruleNoFirstReply(conversation({ firstInboundAt: ago(10 * H), opportunity: negotiationOpp() }), NOW);
    expect(signal).toMatchObject({ score: 94, opportunityId: 'opp-1', salespersonUserId: 'u-luis' });
    expect(signal?.data).toMatchObject({ base: 65, stageWeight: 1.2, valueWeight: 1.2 });
  });
});

describe('no_followup: 40 + min(45, h/6) when the customer wrote last ≥ 24 h ago', () => {
  const replied = { firstInboundAt: ago(10 * D), lastOutboundAt: ago(40 * H) };

  it('scores 30 hours of silence', () => {
    const signal = ruleNoFollowup(conversation({ ...replied, lastInboundAt: ago(30 * H) }), NOW);
    expect(signal).toMatchObject({ kind: 'no_followup', subjectKey: 'conv-1', score: 45 });
    expect(signal?.reason).toBe('Constructora Norte escribió por última vez hace 30 h y nadie le ha dado seguimiento.');
  });

  it('needs 24 hours, caps the bonus at 45 and prints days after 48 h', () => {
    expect(ruleNoFollowup(conversation({ ...replied, lastInboundAt: ago(23.9 * H) }), NOW)).toBeNull();
    const long = ruleNoFollowup(conversation({ ...replied, lastOutboundAt: ago(400 * H), lastInboundAt: ago(300 * H) }), NOW);
    expect(long?.score).toBe(85);
    expect(long?.reason).toContain('hace 12 días');
  });

  it('does not fire when we answered last or never answered', () => {
    expect(ruleNoFollowup(conversation({ ...replied, lastInboundAt: ago(50 * H) }), NOW)).toBeNull();
    expect(ruleNoFollowup(conversation({ firstInboundAt: ago(30 * H), lastInboundAt: ago(30 * H) }), NOW)).toBeNull();
  });
});

describe('quote_expiring: 50 + (3−d)·15, +10 if viewed, for d ≤ 3 calendar days', () => {
  it('scores a sent quote that expires in 2 days', () => {
    const signal = ruleQuoteExpiring(quote(), NOW);
    expect(signal).toMatchObject({ kind: 'quote_expiring', subjectKey: 'q-1', score: 65, quoteId: 'q-1', salespersonUserId: 'u-ana' });
    expect(signal?.reason).toBe('La cotización COT-00042 de Constructora Norte vence en 2 días.');
    expect(signal?.data).toMatchObject({ daysToExpiry: 2, viewed: false });
  });

  it('adds 10 when the customer viewed it and weighs the total', () => {
    expect(ruleQuoteExpiring(quote({ isViewedByClient: true }), NOW)?.score).toBe(75);
    expect(ruleQuoteExpiring(quote({ status: 'viewed' }), NOW)?.reason).toContain('y el cliente ya la vio');
    const withTotal = ruleQuoteExpiring(quote({ total: 60_000 }), NOW);
    expect(withTotal?.score).toBe(72);
    expect(withTotal?.reason).toContain('por $60,000.00');
  });

  it('clamps a viewed quote expiring today to 100', () => {
    const signal = ruleQuoteExpiring(quote({ expiryDate: dateOnly('2026-09-15'), isViewedByClient: true }), NOW);
    expect(signal?.score).toBe(100);
    expect(signal?.reason).toContain('vence hoy');
  });

  it('ignores quotes beyond 3 days, already expired or not open', () => {
    expect(ruleQuoteExpiring(quote({ expiryDate: dateOnly('2026-09-19') }), NOW)).toBeNull();
    expect(ruleQuoteExpiring(quote({ expiryDate: dateOnly('2026-09-14') }), NOW)).toBeNull();
    expect(ruleQuoteExpiring(quote({ status: 'accepted' }), NOW)).toBeNull();
    expect(ruleQuoteExpiring(quote({ expiryDate: null }), NOW)).toBeNull();
  });

  it('counts calendar days in Mexico City and ends with the expiry day', () => {
    const lateEvening = new Date('2026-09-16T03:00:00.000Z'); // 21:00 of the 15th in Mexico City
    expect(ruleQuoteExpiring(quote({ expiryDate: dateOnly('2026-09-16') }), lateEvening)?.reason).toContain('vence mañana');
    const nearMidnight = new Date('2026-09-16T05:30:00.000Z'); // 23:30 of the 15th
    const signal = ruleQuoteExpiring(quote({ expiryDate: dateOnly('2026-09-15') }), nearMidnight);
    expect(signal?.expiresAt.toISOString()).toBe('2026-09-16T06:00:00.000Z');
  });
});

describe('next_action_overdue: 50 + min(40, days·5)', () => {
  it('scores 3 whole days overdue with the opportunity weights', () => {
    const plain = ruleNextActionOverdue(opportunity({ nextActionAt: ago(3.5 * D), nextActionText: 'Llamar para confirmar medidas' }), NOW);
    expect(plain).toMatchObject({ kind: 'next_action_overdue', subjectKey: 'opp-1', score: 65, opportunityId: 'opp-1', salespersonUserId: 'u-luis' });
    expect(plain?.reason).toBe('La siguiente acción de OPP-000012 («Llamar para confirmar medidas») con Constructora Norte venció hace 3 días.');
    const weighted = ruleNextActionOverdue(
      opportunity({ nextActionAt: ago(3.5 * D), stage: { key: 'negociacion', kind: 'open' }, estimatedValue: 250_000 }),
      NOW
    );
    expect(weighted?.score).toBe(94);
  });

  it('says "hoy" under one day and caps at 90', () => {
    const today = ruleNextActionOverdue(opportunity({ nextActionAt: ago(2 * H) }), NOW);
    expect(today?.score).toBe(50);
    expect(today?.reason).toContain('venció hoy');
    expect(ruleNextActionOverdue(opportunity({ nextActionAt: ago(10 * D) }), NOW)?.score).toBe(90);
  });

  it('ignores future actions and closed opportunities', () => {
    expect(ruleNextActionOverdue(opportunity({ nextActionAt: new Date(NOW.getTime() + H) }), NOW)).toBeNull();
    expect(ruleNextActionOverdue(opportunity({ nextActionAt: ago(D), status: 'won' }), NOW)).toBeNull();
  });
});

describe('objection_open: 55 after 48 h without resolution', () => {
  const objection = (id: string, at: Date, summary = 'El precio es alto') => ({ id, kind: 'objection', at, summary });

  it('scores a stale objection', () => {
    const signal = ruleObjectionOpen(opportunity({ objectionActivities: [objection('a1', ago(50 * H))] }), NOW);
    expect(signal).toMatchObject({ kind: 'objection_open', score: 55, subjectKey: 'opp-1' });
    expect(signal?.reason).toBe('OPP-000012 con Constructora Norte tiene una objeción sin resolver; la más antigua («El precio es alto») lleva 2 días.');
  });

  it('waits 48 hours and respects resolutions', () => {
    expect(ruleObjectionOpen(opportunity({ objectionActivities: [objection('a1', ago(10 * H))] }), NOW)).toBeNull();
    expect(
      ruleObjectionOpen(
        opportunity({
          objectionActivities: [
            objection('a1', ago(60 * H)),
            { id: 'a2', kind: 'objection_resolved', refType: 'opportunity_activity', refId: 'a1', at: ago(20 * H), summary: 'Se ofreció otro acabado' },
          ],
        }),
        NOW
      )
    ).toBeNull();
    expect(
      ruleObjectionOpen(
        opportunity({
          objectionActivities: [objection('a1', ago(60 * H)), { id: 'a2', kind: 'objection_resolved', at: ago(55 * H), summary: 'Resuelto' }],
        }),
        NOW
      )
    ).toBeNull();
  });

  it('counts every stale objection', () => {
    const signal = ruleObjectionOpen(
      opportunity({ objectionActivities: [objection('a1', ago(80 * H), 'Tiempo de entrega'), objection('a2', ago(50 * H))] }),
      NOW
    );
    expect(signal?.reason).toContain('tiene 2 objeciones sin resolver');
    expect(signal?.reason).toContain('«Tiempo de entrega»');
  });
});

describe('high_intent: 70 for probability ≥ .6, inbound in 48 h and no quote', () => {
  const hot = { probability: 0.7, lastInboundAt: ago(5 * H), stage: { key: 'contactado', kind: 'open', name: 'Contactado' } };

  it('scores a hot opportunity without quote', () => {
    const signal = ruleHighIntent(opportunity(hot), NOW);
    expect(signal).toMatchObject({ kind: 'high_intent', score: 70, subjectKey: 'opp-1' });
    expect(signal?.reason).toBe('Constructora Norte escribió hace 5 h; OPP-000012 está en Contactado con 70 % de probabilidad y aún no tiene cotización.');
    expect(ruleHighIntent(opportunity({ ...hot, stage: { key: 'cotizado', kind: 'open', name: 'Cotizado' } }), NOW)?.score).toBe(77);
  });

  it('requires the probability, the recent message and no quote', () => {
    expect(ruleHighIntent(opportunity({ ...hot, probability: 0.59 }), NOW)).toBeNull();
    expect(ruleHighIntent(opportunity({ ...hot, hasQuote: true }), NOW)).toBeNull();
    expect(ruleHighIntent(opportunity({ ...hot, lastInboundAt: ago(49 * H) }), NOW)).toBeNull();
  });

  it('expires when the 48-hour window closes', () => {
    const signal = ruleHighIntent(opportunity({ ...hot, lastInboundAt: ago(47.5 * H) }), NOW);
    expect(signal?.expiresAt).toEqual(new Date(NOW.getTime() + 0.5 * H));
  });
});

describe('repurchase_overdue: 45 + min(40, (days/m − 1.3)·50)', () => {
  const customer = (keys: string[], overrides: Partial<CustomerOrderFacts> = {}): CustomerOrderFacts => ({
    zohoContactId: 'zc-1',
    customerName: 'Acabados del Bajío',
    orders: keys.map((key) => ({ orderDate: dateOnly(key), total: null })),
    salespersonUserId: null,
    commContactId: null,
    opportunity: null,
    ...overrides,
  });

  it('scores a customer that buys every 20 days and has not bought in 66', () => {
    const signal = ruleRepurchaseOverdue(customer(['2026-06-01', '2026-06-21', '2026-07-11']), NOW);
    expect(signal).toMatchObject({ kind: 'repurchase_overdue', subjectKey: 'zc-1', score: 85, zohoContactId: 'zc-1' });
    expect(signal?.reason).toBe('Acabados del Bajío suele comprar cada 20 días (mediana de 3 órdenes) y su última orden fue hace 66 días.');
  });

  it('scores a small delay proportionally', () => {
    expect(ruleRepurchaseOverdue(customer(['2026-06-02', '2026-07-02', '2026-08-01']), NOW)?.score).toBe(55);
  });

  it('weighs the median order total', () => {
    const signal = ruleRepurchaseOverdue(
      customer([], {
        orders: [
          { orderDate: dateOnly('2026-06-01'), total: 8_000 },
          { orderDate: dateOnly('2026-06-21'), total: 9_000 },
          { orderDate: dateOnly('2026-07-11'), total: 7_000 },
        ],
      }),
      NOW
    );
    expect(signal?.score).toBe(77);
  });

  it('needs 3 distinct order days and a delay above 1.3·m', () => {
    expect(ruleRepurchaseOverdue(customer(['2026-06-11', '2026-07-11', '2026-08-11']), NOW)).toBeNull();
    expect(ruleRepurchaseOverdue(customer(['2026-06-01', '2026-06-21']), NOW)).toBeNull();
    expect(ruleRepurchaseOverdue(customer(['2026-06-01', '2026-06-01', '2026-06-21']), NOW)).toBeNull();
  });

  it('exposes the statistics', () => {
    expect(repurchaseStats([dateOnly('2026-06-01'), dateOnly('2026-06-21'), dateOnly('2026-07-11')], NOW)).toEqual({
      orderCount: 3,
      medianIntervalDays: 20,
      daysSinceLast: 66,
      lastOrderDate: '2026-07-11',
    });
  });
});

describe('delivery_incident: 75 for a high/critical incident in a case of the customer', () => {
  const incident = (overrides: Partial<DeliveryIncidentFacts> = {}): DeliveryIncidentFacts => ({
    incidentId: 'inc-1',
    severity: 'high',
    title: 'El material llegó dañado',
    openedAt: ago(3 * H),
    caseId: 'case-1',
    caseNumber: 'EXP-000045',
    salesOrderNumber: 'SO-00123',
    zohoCustomerId: 'zc-1',
    customerName: 'Constructora Norte',
    salespersonUserId: null,
    opportunity: null,
    ...overrides,
  });

  it('scores a high incident per customer', () => {
    const signal = ruleDeliveryIncident([incident()], NOW);
    expect(signal).toMatchObject({ kind: 'delivery_incident', subjectKey: 'zc-1', score: 75 });
    expect(signal?.reason).toBe(
      'El expediente EXP-000045 (orden SO-00123) de Constructora Norte tiene una incidencia alta: «El material llegó dañado». Avisa al cliente antes de que pregunte.'
    );
  });

  it('picks the most severe incident and counts the rest', () => {
    const signal = ruleDeliveryIncident(
      [incident(), incident({ incidentId: 'inc-2', severity: 'critical', caseNumber: 'EXP-000046', title: 'Entrega fallida' }), incident({ incidentId: 'inc-3', severity: 'medium' })],
      NOW
    );
    expect(signal?.data).toMatchObject({ incidentId: 'inc-2', incidents: 2 });
    expect(signal?.reason).toContain('incidencia crítica: «Entrega fallida» y otra más');
  });

  it('ignores low severities and falls back to the case without customer', () => {
    expect(ruleDeliveryIncident([incident({ severity: 'medium' })], NOW)).toBeNull();
    expect(ruleDeliveryIncident([incident({ zohoCustomerId: null })], NOW)?.subjectKey).toBe('case:case-1');
  });
});

describe('evaluateRadar', () => {
  it('keeps the best draft per kind and subject and sorts by score', () => {
    const drafts = evaluateRadar(
      {
        conversations: [conversation({ firstInboundAt: ago(10 * H) })],
        quotes: [quote(), quote({ total: 60_000 })],
        opportunities: [opportunity({ nextActionAt: ago(10 * D) })],
        customers: [],
        incidents: [],
      },
      NOW
    );
    expect(drafts.map((d) => [d.kind, d.score])).toEqual([
      ['next_action_overdue', 90],
      ['quote_expiring', 72],
      ['no_first_reply', 65],
    ]);
  });

  it('groups incidents of the same customer into one signal', () => {
    const base = {
      severity: 'high',
      title: 'Faltante',
      openedAt: ago(H),
      caseNumber: 'EXP-1',
      salesOrderNumber: null,
      zohoCustomerId: 'zc-9',
      customerName: 'Cliente',
      salespersonUserId: null,
      opportunity: null,
    };
    const drafts = evaluateRadar(
      {
        conversations: [],
        quotes: [],
        opportunities: [],
        customers: [],
        incidents: [
          { ...base, incidentId: 'i1', caseId: 'c1' },
          { ...base, incidentId: 'i2', caseId: 'c2' },
        ],
      },
      NOW
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].data).toMatchObject({ incidents: 2 });
  });

  it('ranks the best signals per salesperson', () => {
    const top = topSignalsPerSalesperson(
      [
        { id: 'a', salespersonUserId: 'u1', score: 40 },
        { id: 'b', salespersonUserId: 'u1', score: 90 },
        { id: 'c', salespersonUserId: 'u1', score: 70 },
        { id: 'd', salespersonUserId: null, score: 99 },
        { id: 'e', salespersonUserId: 'u2', score: 10 },
      ],
      2
    );
    expect(top.get('u1')?.map((s) => s.id)).toEqual(['b', 'c']);
    expect(top.get('u2')?.map((s) => s.id)).toEqual(['e']);
    expect(top.size).toBe(2);
  });
});

describe('helpers', () => {
  it('formats elapsed time', () => {
    expect(formatElapsed(0.4)).toBe('menos de 1 h');
    expect(formatElapsed(5.7)).toBe('5 h');
    expect(formatElapsed(47.9)).toBe('47 h');
    expect(formatElapsed(48)).toBe('2 días');
    expect(formatElapsed(24 * 30)).toBe('30 días');
  });

  it('computes local days and medians', () => {
    expect(localDateKey(new Date('2026-09-16T05:59:00.000Z'))).toBe('2026-09-15');
    expect(localDateKey(new Date('2026-09-16T06:00:00.000Z'))).toBe('2026-09-16');
    expect(daysBetweenKeys('2026-07-11', '2026-09-15')).toBe(66);
    expect(daysBetweenKeys('2026-09-15', '2026-09-14')).toBe(-1);
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe('topSignalsPerSalesperson (stable ties)', () => {
  it('breaks score ties by kind, subject and id, whatever the input order', async () => {
    const { topSignalsPerSalesperson } = await import('./radar-rules');
    const signals = [
      { id: 's3', salespersonUserId: 'u1', score: 80, kind: 'no_followup', subjectKey: 'conv:b' },
      { id: 's1', salespersonUserId: 'u1', score: 80, kind: 'no_first_reply', subjectKey: 'conv:z' },
      { id: 's2', salespersonUserId: 'u1', score: 80, kind: 'no_followup', subjectKey: 'conv:a' },
      { id: 's4', salespersonUserId: 'u1', score: 90, kind: 'quote_expiring', subjectKey: 'quote:1' },
    ];
    const first = topSignalsPerSalesperson(signals, 3).get('u1')!.map((s) => s.id);
    const reversed = topSignalsPerSalesperson([...signals].reverse(), 3).get('u1')!.map((s) => s.id);
    expect(first).toEqual(['s4', 's1', 's2']);
    expect(reversed).toEqual(first);
  });
});
