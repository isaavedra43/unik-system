import { describe, expect, it } from 'vitest';
import {
  evaluateStartPolicy,
  isCancelledOrderStatus,
  orderReferenceDate,
  type StartPolicyConfig,
  type StartPolicyOrder,
} from './start-policy';

const config: StartPolicyConfig = {
  isEnabled: true,
  flags: { salesToCase: true },
  cutoverDate: '2026-09-01T00:00:00.000Z',
  pilotLocationIds: [],
};

function order(overrides: Partial<StartPolicyOrder> = {}): StartPolicyOrder {
  return {
    status: 'confirmed',
    shippedStatus: 'pending',
    createdTime: new Date('2026-09-10T12:00:00.000Z'),
    orderDate: new Date('2026-09-10T00:00:00.000Z'),
    locationId: 'loc-1',
    ...overrides,
  };
}

describe('evaluateStartPolicy (arranque automático)', () => {
  it('una orden confirmada después del corte es elegible por su fecha de creación', () => {
    expect(evaluateStartPolicy(order(), config)).toEqual({ eligible: true, basis: 'created_time' });
  });

  it('usa la fecha de la orden cuando Zoho no trae fecha de creación', () => {
    expect(evaluateStartPolicy(order({ createdTime: null }), config)).toEqual({
      eligible: true,
      basis: 'order_date',
    });
    expect(
      evaluateStartPolicy(order({ createdTime: null, orderDate: null }), config)
    ).toMatchObject({
      eligible: false,
      reason: 'missing_date',
    });
  });

  it.each(['draft', 'void', 'closed', 'cancelled', 'VOID'])('excluye el estado %s', (status) => {
    expect(evaluateStartPolicy(order({ status }), config)).toMatchObject({
      eligible: false,
      reason: 'status_excluded',
    });
  });

  it.each(['fulfilled', 'delivered'])('excluye órdenes ya entregadas (%s)', (shippedStatus) => {
    expect(evaluateStartPolicy(order({ shippedStatus }), config)).toMatchObject({
      eligible: false,
      reason: 'already_fulfilled',
    });
  });

  it('excluye órdenes anteriores al corte', () => {
    expect(
      evaluateStartPolicy(order({ createdTime: new Date('2026-08-31T23:59:59.000Z') }), config)
    ).toMatchObject({
      eligible: false,
      reason: 'before_cutover',
    });
  });

  it('con piloto sólo arrancan las ubicaciones listadas', () => {
    const pilot = { ...config, pilotLocationIds: ['loc-2'] };
    expect(evaluateStartPolicy(order(), pilot)).toMatchObject({
      eligible: false,
      reason: 'location_not_in_pilot',
    });
    expect(evaluateStartPolicy(order({ locationId: null }), pilot)).toMatchObject({
      eligible: false,
    });
    expect(evaluateStartPolicy(order({ locationId: 'loc-2' }), pilot)).toMatchObject({
      eligible: true,
    });
  });

  it('respeta el flag salesToCase, el interruptor del núcleo y un corte inválido', () => {
    expect(
      evaluateStartPolicy(order(), { ...config, flags: { salesToCase: false } })
    ).toMatchObject({
      eligible: false,
      reason: 'flag_disabled',
    });
    expect(evaluateStartPolicy(order(), { ...config, isEnabled: false })).toMatchObject({
      eligible: false,
      reason: 'core_disabled',
    });
    expect(evaluateStartPolicy(order(), { ...config, cutoverDate: 'nunca' })).toMatchObject({
      eligible: false,
      reason: 'invalid_cutover',
    });
  });
});

describe('evaluateStartPolicy (Iniciar seguimiento manual)', () => {
  it('salta corte, piloto y flag', () => {
    const strict = { ...config, flags: { salesToCase: false }, pilotLocationIds: ['loc-9'] };
    expect(
      evaluateStartPolicy(
        order({ createdTime: new Date('2025-01-01T00:00:00.000Z'), locationId: null }),
        strict,
        {
          manual: true,
        }
      )
    ).toEqual({ eligible: true, basis: 'manual' });
  });

  it('nunca salta los filtros de estado ni el interruptor del núcleo', () => {
    expect(evaluateStartPolicy(order({ status: 'void' }), config, { manual: true })).toMatchObject({
      eligible: false,
    });
    expect(
      evaluateStartPolicy(order({ shippedStatus: 'fulfilled' }), config, { manual: true })
    ).toMatchObject({
      eligible: false,
    });
    expect(
      evaluateStartPolicy(order(), { ...config, isEnabled: false }, { manual: true })
    ).toMatchObject({
      eligible: false,
      reason: 'core_disabled',
    });
  });
});

describe('utilidades', () => {
  it('isCancelledOrderStatus reconoce void y cancelled', () => {
    expect(isCancelledOrderStatus('void')).toBe(true);
    expect(isCancelledOrderStatus(' Cancelled ')).toBe(true);
    expect(isCancelledOrderStatus('closed')).toBe(false);
    expect(isCancelledOrderStatus(null)).toBe(false);
  });

  it('orderReferenceDate prefiere la fecha de creación', () => {
    expect(orderReferenceDate(order())?.basis).toBe('created_time');
    expect(orderReferenceDate({ createdTime: null, orderDate: null })).toBeNull();
  });
});
