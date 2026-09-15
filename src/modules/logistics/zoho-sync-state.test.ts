import { describe, expect, it } from 'vitest';
import {
  compareShipment,
  describeDifferences,
  evaluateShipmentReadback,
  failedZohoOperation,
  needsZohoReadback,
  normalizeCarrier,
  normalizeTracking,
  pendingZohoOperation,
  readbackSource,
  toIsoDay,
  transitionZohoSync,
  ZOHO_SYNC_EVENTS,
  ZOHO_SYNC_STATES,
  ZOHO_SYNC_TRANSITIONS,
  type ShipmentExpectation,
  type ShipmentReadback,
} from './zoho-sync-state';

const expected: ShipmentExpectation = {
  carrier: 'Paquetexpress',
  shipmentDate: '2026-09-15',
  trackingNumber: 'PX123',
};

const readback = (overrides: Partial<ShipmentReadback> = {}): ShipmentReadback => ({
  carrier: 'Paquetexpress',
  shipmentDate: '2026-09-15',
  trackingNumber: 'PX123',
  zohoShipmentId: '4600000999',
  shipmentNumber: 'NE-28815',
  status: 'shipped',
  ...overrides,
});

describe('transitionZohoSync', () => {
  it('follows write → local patch → read-back → delivery', () => {
    const steps = [
      ['not_required', 'ship_requested', 'pending_write'],
      ['pending_write', 'write_applied_locally', 'written'],
      ['written', 'readback_matched', 'readback_ok'],
      ['readback_ok', 'delivery_write_requested', 'delivered_pending_write'],
      ['delivered_pending_write', 'delivery_written', 'delivered_written'],
    ] as const;
    for (const [from, event, to] of steps) {
      expect(transitionZohoSync(from, event)).toEqual({ ok: true, state: to, changed: true });
    }
  });

  it('reports unchanged transitions', () => {
    expect(transitionZohoSync('readback_ok', 'readback_matched')).toEqual({
      ok: true,
      state: 'readback_ok',
      changed: false,
    });
  });

  it('rejects impossible transitions with a Spanish message', () => {
    const result = transitionZohoSync('not_required', 'readback_matched');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Sin escritura en Zoho');
    expect(transitionZohoSync('delivered_written', 'ship_requested').ok).toBe(false);
    expect(transitionZohoSync('unknown', 'ship_requested').ok).toBe(false);
  });

  it('allows mismatch, failure, retry, cancellation and recovery paths', () => {
    expect(transitionZohoSync('pending_write', 'readback_mismatched')).toMatchObject({
      state: 'readback_mismatch',
    });
    expect(transitionZohoSync('readback_mismatch', 'ship_requested')).toMatchObject({
      state: 'pending_write',
    });
    expect(transitionZohoSync('pending_write', 'write_failed')).toMatchObject({ state: 'failed' });
    expect(transitionZohoSync('failed', 'readback_matched')).toMatchObject({
      state: 'readback_ok',
    });
    expect(transitionZohoSync('readback_ok', 'cancel_requested')).toMatchObject({
      state: 'pending_write',
    });
    expect(transitionZohoSync('pending_write', 'shipment_cancelled')).toMatchObject({
      state: 'not_required',
    });
    expect(transitionZohoSync('delivered_pending_write', 'write_failed')).toMatchObject({
      state: 'failed',
    });
    expect(transitionZohoSync('failed', 'delivery_written')).toMatchObject({
      state: 'delivered_written',
    });
    // A shipment created by hand in Zoho can still be marked delivered.
    expect(transitionZohoSync('not_required', 'delivery_write_requested')).toMatchObject({
      state: 'delivered_pending_write',
    });
    expect(transitionZohoSync('not_required', 'cancel_requested').ok).toBe(false);
  });

  it('only targets and accepts known states', () => {
    for (const event of ZOHO_SYNC_EVENTS) {
      const rule = ZOHO_SYNC_TRANSITIONS[event];
      expect(ZOHO_SYNC_STATES).toContain(rule.to);
      for (const from of rule.from) expect(ZOHO_SYNC_STATES).toContain(from);
    }
  });
});

describe('pending / failed operations', () => {
  it('derives the write owed to Zoho', () => {
    expect(pendingZohoOperation('pending_external', 'pending_write')).toBe('ship');
    expect(pendingZohoOperation('cancelled', 'pending_write')).toBe('cancel_shipment');
    expect(pendingZohoOperation('delivered', 'delivered_pending_write')).toBe('mark_delivered');
    expect(pendingZohoOperation('assigned', 'readback_ok')).toBeNull();
  });

  it('derives which write failed', () => {
    expect(failedZohoOperation('failed', 'failed')).toBe('ship');
    expect(failedZohoOperation('partially_delivered', 'failed')).toBe('mark_delivered');
    expect(failedZohoOperation('cancelled', 'failed')).toBe('cancel_shipment');
    expect(failedZohoOperation('assigned', 'readback_ok')).toBeNull();
  });

  it('re-reads only unconfirmed states', () => {
    expect(needsZohoReadback('written')).toBe(true);
    expect(needsZohoReadback('readback_mismatch')).toBe(true);
    expect(needsZohoReadback('failed')).toBe(true);
    expect(needsZohoReadback('pending_write')).toBe(false);
    expect(needsZohoReadback('readback_ok')).toBe(false);
  });
});

describe('read-back comparison', () => {
  it('normalizes carrier accents/case/spaces and tracking spaces', () => {
    expect(normalizeCarrier('  Estafeta   México ')).toBe('estafeta mexico');
    expect(normalizeTracking(' px 123 ')).toBe('PX123');
    expect(normalizeTracking('   ')).toBeNull();
  });

  it('extracts the UTC day', () => {
    expect(toIsoDay(new Date('2026-09-15T00:00:00.000Z'))).toBe('2026-09-15');
    expect(toIsoDay('2026-09-15T18:30:00-06:00')).toBe('2026-09-15');
    expect(toIsoDay('15/09/2026')).toBeNull();
    expect(toIsoDay(null)).toBeNull();
  });

  it('matches equal values regardless of formatting', () => {
    expect(
      compareShipment(expected, readback({ carrier: ' paquetexpress', trackingNumber: 'px 123' }))
    ).toEqual({
      matches: true,
      differences: [],
    });
  });

  it('ignores the tracking number when UNIK did not send one', () => {
    const result = compareShipment(
      { ...expected, trackingNumber: null },
      readback({ trackingNumber: 'ZOHO-AUTO' })
    );
    expect(result.matches).toBe(true);
  });

  it('lists every different field', () => {
    const result = compareShipment(
      expected,
      readback({ carrier: 'DHL', shipmentDate: '2026-09-16', trackingNumber: 'DHL1' })
    );
    expect(result.matches).toBe(false);
    expect(result.differences.map((d) => d.field)).toEqual([
      'carrier',
      'shipmentDate',
      'trackingNumber',
    ]);
    expect(describeDifferences(result.differences)).toContain(
      'Transportista: UNIK pidió "Paquetexpress" y Zoho tiene "DHL"'
    );
  });

  it('evaluates the outcome of a write', () => {
    expect(evaluateShipmentReadback(expected, readback(), 'local')).toBe('awaiting_readback');
    expect(evaluateShipmentReadback(expected, readback({ zohoShipmentId: null }), 'zoho')).toBe(
      'not_written'
    );
    expect(evaluateShipmentReadback(expected, readback(), 'zoho')).toBe('match');
    expect(evaluateShipmentReadback(expected, readback(), 'mock')).toBe('match');
    expect(evaluateShipmentReadback(expected, readback({ carrier: 'DHL' }), 'zoho')).toBe(
      'mismatch'
    );
  });

  it('decides where the package values come from', () => {
    const writeStartedAt = new Date('2026-09-15T15:00:00.000Z');
    expect(readbackSource({ mock: true, lastDetailFetchedAt: null, writeStartedAt })).toBe('mock');
    expect(readbackSource({ mock: false, lastDetailFetchedAt: null, writeStartedAt })).toBe(
      'local'
    );
    expect(
      readbackSource({
        mock: false,
        lastDetailFetchedAt: new Date('2026-09-15T15:00:02.000Z'),
        writeStartedAt,
      })
    ).toBe('zoho');
    expect(
      readbackSource({
        mock: false,
        lastDetailFetchedAt: new Date('2026-09-15T10:00:00.000Z'),
        writeStartedAt,
      })
    ).toBe('local');
  });
});
