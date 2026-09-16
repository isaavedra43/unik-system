import { describe, expect, it } from 'vitest';
import {
  demandFulfillment,
  expectedQuantity,
  hasPhysicalEvidence,
  roundQuantity,
  summarizeDelivery,
  statusAfterTripRelease,
  type AllocationExpectation,
  chooseLinkablePackage,
} from './delivery-rules';

const allocations: AllocationExpectation[] = [
  { allocationId: 'a1', demandId: 'd1', quantity: 10, deliveredQuantity: 0 },
  { allocationId: 'a2', demandId: 'd2', quantity: 5, deliveredQuantity: 0 },
];

describe('summarizeDelivery', () => {
  it('owes quantity minus what was already delivered', () => {
    expect(
      expectedQuantity({ allocationId: 'a', demandId: 'd', quantity: 10, deliveredQuantity: 4 })
    ).toBe(6);
    expect(
      expectedQuantity({ allocationId: 'a', demandId: 'd', quantity: 3, deliveredQuantity: 5 })
    ).toBe(0);
  });

  it('is complete when every allocation receives what it is owed', () => {
    const result = summarizeDelivery(allocations, [
      { allocationId: 'a1', deliveredQty: 10 },
      { allocationId: 'a2', deliveredQty: 5 },
    ]);
    expect(result).toMatchObject({
      ok: true,
      summary: { complete: true, totalDelivered: 15, totalShort: 0, shortAllocationIds: [] },
    });
  });

  it('is partial with short lines; a missing line counts as nothing delivered', () => {
    const partial = summarizeDelivery(allocations, [
      { allocationId: 'a1', deliveredQty: 10 },
      { allocationId: 'a2', deliveredQty: 3 },
    ]);
    expect(partial).toMatchObject({
      ok: true,
      summary: { complete: false, totalDelivered: 13, totalShort: 2, shortAllocationIds: ['a2'] },
    });
    const missing = summarizeDelivery(allocations, [{ allocationId: 'a1', deliveredQty: 10 }]);
    expect(missing).toMatchObject({
      ok: true,
      summary: { complete: false, shortAllocationIds: ['a2'], totalShort: 5 },
    });
  });

  it('rejects unknown, duplicated, negative, excessive or empty deliveries', () => {
    expect(summarizeDelivery(allocations, [{ allocationId: 'zz', deliveredQty: 1 }])).toMatchObject(
      {
        ok: false,
        code: 'unknown_allocation',
      }
    );
    expect(
      summarizeDelivery(allocations, [
        { allocationId: 'a1', deliveredQty: 1 },
        { allocationId: 'a1', deliveredQty: 1 },
      ])
    ).toMatchObject({ ok: false, code: 'duplicate_line' });
    expect(
      summarizeDelivery(allocations, [{ allocationId: 'a1', deliveredQty: -1 }])
    ).toMatchObject({
      ok: false,
      code: 'invalid_quantity',
    });
    expect(
      summarizeDelivery(
        [{ allocationId: 'a1', demandId: 'd1', quantity: 10, deliveredQuantity: 4 }],
        [{ allocationId: 'a1', deliveredQty: 7 }]
      )
    ).toMatchObject({ ok: false, code: 'quantity_exceeds', allocationId: 'a1' });
    expect(summarizeDelivery(allocations, [{ allocationId: 'a1', deliveredQty: 0 }])).toMatchObject(
      {
        ok: false,
        code: 'nothing_delivered',
      }
    );
  });

  it('tolerates floating point noise at 4 decimals', () => {
    const result = summarizeDelivery(
      [{ allocationId: 'a1', demandId: 'd1', quantity: 0.3, deliveredQuantity: 0 }],
      [{ allocationId: 'a1', deliveredQty: 0.1 + 0.2 }]
    );
    expect(result).toMatchObject({ ok: true, summary: { complete: true } });
    expect(roundQuantity(1.23456)).toBe(1.2346);
  });
});

describe('evidence and demand fulfillment', () => {
  it('requires a photo or signature whose bytes reached storage', () => {
    expect(hasPhysicalEvidence([{ kind: 'photo', objectStatus: 'ready' }])).toBe(true);
    expect(hasPhysicalEvidence([{ kind: 'signature', objectStatus: 'validating' }])).toBe(true);
    expect(hasPhysicalEvidence([{ kind: 'photo', objectStatus: 'initiated' }])).toBe(false);
    expect(hasPhysicalEvidence([{ kind: 'note', objectStatus: 'ready' }])).toBe(false);
    expect(hasPhysicalEvidence([])).toBe(false);
  });

  it('accumulates fulfilled quantity', () => {
    expect(demandFulfillment(10, 4, 6)).toEqual({ fulfilledQuantity: 10, fulfilled: true });
    expect(demandFulfillment(10, 0, 9.5)).toEqual({ fulfilledQuantity: 9.5, fulfilled: false });
  });
});

describe('chooseLinkablePackage', () => {
  it('links the package whose lines are the items of the order, never by date', () => {
    const packages = [
      { id: 'pkg-a', itemIds: ['item-3'] },
      { id: 'pkg-b', itemIds: ['item-1', 'item-2'] },
    ];
    expect(chooseLinkablePackage(packages, ['item-1', 'item-2'])).toBe('pkg-b');
    expect(chooseLinkablePackage(packages, ['item-3'])).toBe('pkg-a');
    // A package of other deliveries is not guessed.
    expect(chooseLinkablePackage(packages, ['item-1'])).toBeNull();
  });

  it('does not guess between equal candidates nor between packages without synced lines', () => {
    expect(
      chooseLinkablePackage(
        [
          { id: 'pkg-a', itemIds: ['item-1'] },
          { id: 'pkg-b', itemIds: ['item-1'] },
        ],
        ['item-1']
      )
    ).toBeNull();
    expect(
      chooseLinkablePackage(
        [
          { id: 'pkg-a', itemIds: [] },
          { id: 'pkg-b', itemIds: [] },
        ],
        ['item-1']
      )
    ).toBeNull();
    expect(chooseLinkablePackage([{ id: 'pkg-a', itemIds: [] }], ['item-1'])).toBe('pkg-a');
    expect(chooseLinkablePackage([], ['item-1'])).toBeNull();
  });
});

/**
 * Plan §4: cancelar un viaje no inventa entregas fallidas. La entrega que
 * venía en él regresa al estado que su espejo de Zoho describe, nunca a
 * `failed` por el simple hecho de haber salido.
 */
describe('statusAfterTripRelease', () => {
  it.each([
    ['dispatched', 'readback_ok', 'assigned'],
    ['dispatched', 'pending_write', 'pending_external'],
    ['dispatched', 'written', 'pending_external'],
    ['dispatched', 'readback_mismatch', 'conflict'],
    ['dispatched', 'failed', 'failed'],
    ['dispatched', 'not_required', 'planned'],
    // Un estado de sincronización que esta tabla no conoce nunca deja la
    // entrega en «En camino»: vuelve a planeación, que siempre es asignable.
    ['dispatched', 'delivered_written', 'planned'],
  ])('una entrega %s con Zoho %s regresa a %s', (status, zohoSyncState, expected) => {
    expect(statusAfterTripRelease({ status, zohoSyncState })).toBe(expected);
  });

  it.each(['pending', 'planned', 'assigned', 'pending_external', 'conflict', 'failed'])(
    'una entrega %s conserva su estado (ya es asignable)',
    (status) => {
      expect(statusAfterTripRelease({ status, zohoSyncState: 'readback_ok' })).toBe(status);
    }
  );
});
