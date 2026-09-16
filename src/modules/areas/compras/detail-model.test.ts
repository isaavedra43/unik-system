import { describe, expect, it } from 'vitest';
import { ORDER_DELIVERY_MODES } from '@/modules/purchases/purchases-types';
import { recordReceiptSchema, resolveDifferenceSchema } from '@/modules/purchases/receipts-service';
import { selectResponseSchema } from '@/modules/purchases/rfq-service';
import {
  acceptedQty,
  differenceFormToPayload,
  emptyReceiptForm,
  orderedComparison,
  receiptFormIsPristine,
  receiptFormToPayload,
  responseActions,
  rfqReviewIsPristine,
  selectResponseFormToPayload,
  suggestedDifferenceKind,
  type ComparisonEntry,
  type DifferenceForm,
  type ReceiptLineForm,
  type ReceiptOrderLine,
  type SelectResponseForm,
} from './detail-model';

/**
 * Lo que estas pruebas cuidan: que el panel de Compras arme EXACTAMENTE el
 * payload que el comando acepta. Por eso cada caso bueno vuelve a pasar por el
 * esquema Zod del servicio real — si alguien cambia el comando, la prueba se
 * cae aquí y no en producción.
 */

const ORDER_LINES: ReceiptOrderLine[] = [
  { id: 'l1', description: 'Loseta Perla 60x60', qty: '10', qtyPending: '10', status: 'open' },
  { id: 'l2', description: 'Adhesivo', qty: '4', qtyPending: '4', status: 'open' },
  { id: 'l3', description: 'Partida cancelada', qty: '1', qtyPending: '0', status: 'cancelled' },
];

function line(overrides: Partial<ReceiptLineForm> = {}): ReceiptLineForm {
  return {
    orderLineId: 'l1',
    received: '',
    rejected: '',
    differenceKind: '',
    lotCode: '',
    ...overrides,
  };
}

describe('captura de recepción', () => {
  it('el formulario vacío sólo trae las partidas que siguen esperando material', () => {
    expect(emptyReceiptForm(ORDER_LINES).map((entry) => entry.orderLineId)).toEqual(['l1', 'l2']);
  });

  it('lo aceptado es lo que llegó menos lo rechazado', () => {
    expect(acceptedQty(line({ received: '10', rejected: '4' }))).toBe(6);
    expect(acceptedQty(line({ received: '10', rejected: '' }))).toBe(10);
    expect(acceptedQty(line({ received: '', rejected: '' }))).toBe(0);
  });

  it('arma el payload de la recepción parcial y el comando lo acepta', () => {
    const result = receiptFormToPayload({
      orderId: 'ord-1',
      orderLines: ORDER_LINES,
      lines: [
        line({ received: '6', rejected: '1', lotCode: ' LOTE-9 ' }),
        line({ orderLineId: 'l2' }),
      ],
      post: true,
      notes: '  Llegó incompleto  ',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // La partida sin cantidad no viaja.
    expect(result.payload.lines).toEqual([
      {
        orderLineId: 'l1',
        qtyReceived: 6,
        qtyRejected: 1,
        differenceKind: 'damaged',
        lotCode: 'LOTE-9',
      },
    ]);
    expect(result.payload.notes).toBe('Llegó incompleto');
    const parsed = recordReceiptSchema.safeParse(result.payload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('un borrador (post:false) también es un payload válido', () => {
    const result = receiptFormToPayload({
      orderId: 'ord-1',
      orderLines: ORDER_LINES,
      lines: [line({ received: '10' })],
      post: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.post).toBe(false);
    expect(recordReceiptSchema.safeParse(result.payload).success).toBe(true);
  });

  it('no deja rechazar más de lo que llegó ni enviar una recepción vacía', () => {
    const tooMuch = receiptFormToPayload({
      orderId: 'ord-1',
      orderLines: ORDER_LINES,
      lines: [line({ received: '2', rejected: '5' })],
      post: true,
    });
    expect(tooMuch.ok).toBe(false);
    if (!tooMuch.ok) expect(tooMuch.errors[0]).toContain('no puedes rechazar más de lo que llegó');

    const empty = receiptFormToPayload({
      orderId: 'ord-1',
      orderLines: ORDER_LINES,
      lines: [line(), line({ orderLineId: 'l2' })],
      post: true,
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors[0]).toContain('al menos una partida');
  });

  it('clasifica sola la diferencia que las cantidades muestran, y respeta la que eligió la persona', () => {
    const short = line({ received: '6' });
    expect(suggestedDifferenceKind(short, ORDER_LINES[0])).toBe('short');
    expect(suggestedDifferenceKind(line({ received: '12' }), ORDER_LINES[0])).toBe('over');
    expect(suggestedDifferenceKind(line({ received: '10' }), ORDER_LINES[0])).toBe('none');
    expect(suggestedDifferenceKind(line({ received: '10', rejected: '2' }), ORDER_LINES[0])).toBe(
      'damaged'
    );
    expect(
      suggestedDifferenceKind(line({ received: '6', differenceKind: 'wrong_item' }), ORDER_LINES[0])
    ).toBe('wrong_item');
  });
});

describe('resolución de una diferencia', () => {
  function form(overrides: Partial<DifferenceForm> = {}): DifferenceForm {
    return {
      receiptLineId: 'rl-1',
      resolution: 'credit',
      note: 'Abona el faltante',
      creditQty: '',
      ...overrides,
    };
  }

  it('arma un payload que el comando acepta', () => {
    const result = differenceFormToPayload(form({ creditQty: '2.5' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toEqual({
      receiptLineId: 'rl-1',
      resolution: 'credit',
      note: 'Abona el faltante',
      creditQty: 2.5,
    });
    expect(resolveDifferenceSchema.safeParse(result.payload).success).toBe(true);
  });

  it('exige elegir la resolución y describirla', () => {
    const bad = differenceFormToPayload(form({ resolution: '', note: 'ok' }));
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.join(' ')).toContain('Elige cómo se resuelve');
    expect(bad.errors.join(' ')).toContain('Describe cómo se resolvió');
  });

  it('la cantidad a abonar sólo viaja con `credit` y nunca vacía o cero', () => {
    const zero = differenceFormToPayload(form({ creditQty: '0' }));
    expect(zero.ok).toBe(false);
    const other = differenceFormToPayload(form({ resolution: 'accept', creditQty: '5' }));
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.payload).not.toHaveProperty('creditQty');
  });
});

describe('revisión de respuestas de cotización', () => {
  it('una respuesta por leer se confirma o se descarta; una confirmada se puede elegir', () => {
    expect(responseActions({ status: 'needs_review' }, 'collecting').map((a) => a.id)).toEqual([
      'confirm',
      'reject',
    ]);
    expect(responseActions({ status: 'confirmed' }, 'compared').map((a) => a.id)).toEqual([
      'select',
      'reject',
    ]);
  });

  it('una cotización cerrada no ofrece nada, y una respuesta ya elegida tampoco se descarta', () => {
    expect(responseActions({ status: 'confirmed' }, 'closed')).toEqual([]);
    expect(responseActions({ status: 'selected' }, 'compared')).toEqual([]);
    expect(responseActions({ status: 'rejected' }, 'compared')).toEqual([]);
  });

  it('la comparación se ve por puntaje, con las no comparables al final', () => {
    const entries: ComparisonEntry[] = [
      {
        responseId: 'r3',
        rank: 1,
        score: 10,
        landedTotal: null,
        comparable: false,
        recommended: false,
        reasons: [],
      },
      {
        responseId: 'r2',
        rank: 2,
        score: 70,
        landedTotal: 200,
        comparable: true,
        recommended: false,
        reasons: [],
      },
      {
        responseId: 'r1',
        rank: 1,
        score: 90,
        landedTotal: 100,
        comparable: true,
        recommended: true,
        reasons: [],
      },
    ];
    expect(orderedComparison(entries).map((entry) => entry.responseId)).toEqual(['r1', 'r2', 'r3']);
  });

  it('elegir una respuesta arma el payload que el comando acepta', () => {
    const base: SelectResponseForm = {
      responseId: 'resp-1',
      deliveryMode: 'warehouse',
      warehouseId: 'wh-1',
      directDeliveryCaseId: '',
      expectedAt: '2026-10-01',
      notes: '  Urge  ',
    };
    const result = selectResponseFormToPayload(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toEqual({
      responseId: 'resp-1',
      deliveryMode: 'warehouse',
      warehouseId: 'wh-1',
      expectedAt: '2026-10-01',
      notes: 'Urge',
    });
    expect(selectResponseSchema.safeParse(result.payload).success).toBe(true);
  });

  it('los modos de entrega del formulario son los del dominio', () => {
    expect([...ORDER_DELIVERY_MODES]).toContain('warehouse');
    expect([...ORDER_DELIVERY_MODES]).toContain('direct_to_customer');
  });

  it('una entrega directa sin expediente no se envía, y la fecha inválida se detiene aquí', () => {
    const direct = selectResponseFormToPayload({
      responseId: 'resp-1',
      deliveryMode: 'direct_to_customer',
      warehouseId: '',
      directDeliveryCaseId: '',
      expectedAt: '',
      notes: '',
    });
    expect(direct.ok).toBe(false);
    if (direct.ok) return;
    expect(direct.errors[0]).toContain('expediente');

    const badDate = selectResponseFormToPayload({
      responseId: 'resp-1',
      deliveryMode: '',
      warehouseId: '',
      directDeliveryCaseId: '',
      expectedAt: '01/10/2026',
      notes: '',
    });
    expect(badDate.ok).toBe(false);
  });
});

describe('refrescar sin pisar lo que alguien está capturando', () => {
  const orderLines: ReceiptOrderLine[] = [
    { id: 'ol_1', description: 'Lámina', qty: '10', qtyPending: '10', status: 'open' },
    { id: 'ol_2', description: 'Tornillo', qty: '4', qtyPending: '4', status: 'open' },
  ];

  it('un formulario recién abierto está limpio', () => {
    expect(receiptFormIsPristine(emptyReceiptForm(orderLines), '')).toBe(true);
  });

  it('cualquier dato escrito lo ensucia', () => {
    const base = emptyReceiptForm(orderLines);
    expect(receiptFormIsPristine([{ ...base[0]!, received: '3' }, base[1]!], '')).toBe(false);
    expect(receiptFormIsPristine([{ ...base[0]!, rejected: '1' }, base[1]!], '')).toBe(false);
    expect(receiptFormIsPristine([{ ...base[0]!, lotCode: 'L-1' }, base[1]!], '')).toBe(false);
    expect(receiptFormIsPristine([{ ...base[0]!, differenceKind: 'short' }, base[1]!], '')).toBe(
      false
    );
    expect(receiptFormIsPristine(base, 'llegó golpeado')).toBe(false);
    // Espacios en blanco no cuentan como trabajo.
    expect(receiptFormIsPristine(base, '   ')).toBe(true);
  });

  it('la revisión de una cotización se ensucia al elegir o al rechazar', () => {
    const empty: SelectResponseForm = {
      responseId: '',
      deliveryMode: '',
      warehouseId: '',
      directDeliveryCaseId: '',
      expectedAt: '',
      notes: '',
    };
    expect(rfqReviewIsPristine(empty, null)).toBe(true);
    expect(rfqReviewIsPristine({ ...empty, responseId: 'rs_1' }, null)).toBe(false);
    expect(rfqReviewIsPristine({ ...empty, notes: 'ok' }, null)).toBe(false);
    expect(rfqReviewIsPristine(empty, { responseId: 'rs_1', reason: '' })).toBe(false);
  });
});
