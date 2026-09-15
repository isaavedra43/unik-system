import { describe, expect, it } from 'vitest';
import {
  checkCancelOrder,
  checkCloseOrder,
  checkEditOrder,
  checkReceiveOrder,
  checkRequestPayment,
  checkSendOrder,
  checkSubmitOrder,
  classifyReceiptLine,
  computeOrderTotals,
  distributeFifo,
  lineStatusAfterReceipt,
  orderStatusLabel,
  paymentStatusFor,
  pendingQuantity,
  statusAfterApprovalDecision,
  statusAfterPaid,
  statusAfterPaymentRequest,
  statusAfterReceipt,
  statusAfterSend,
} from './orders-state';

describe('checks de transición', () => {
  it('sólo se edita y se envía a aprobación un borrador con partidas y total', () => {
    expect(checkEditOrder('draft')).toEqual({ ok: true });
    expect(checkEditOrder('approved')).toMatchObject({ ok: false, code: 'invalid_state' });
    expect(checkSubmitOrder({ status: 'draft', lineCount: 2, total: '100' })).toEqual({ ok: true });
    expect(checkSubmitOrder({ status: 'draft', lineCount: 0, total: '100' })).toMatchObject({ ok: false, code: 'invalid_payload' });
    expect(checkSubmitOrder({ status: 'draft', lineCount: 1, total: 0 })).toMatchObject({ ok: false, code: 'invalid_payload' });
    expect(checkSubmitOrder({ status: 'pending_approval', lineCount: 1, total: 10 })).toMatchObject({ ok: false, code: 'invalid_state' });
  });

  it('no se cancela lo que ya tiene material recibido', () => {
    expect(checkCancelOrder({ status: 'approved', postedReceipts: 0 })).toEqual({ ok: true });
    expect(checkCancelOrder({ status: 'partially_received', postedReceipts: 1 })).toMatchObject({ ok: false });
    expect(checkCancelOrder({ status: 'awaiting_receipt', postedReceipts: 1 }).ok).toBe(false);
    expect(checkCancelOrder({ status: 'closed', postedReceipts: 0 }).ok).toBe(false);
    expect(checkCancelOrder({ status: 'cancelled', postedReceipts: 0 })).toMatchObject({ message: 'La orden ya está cancelada' });
  });

  it('el pago se solicita una vez y nunca en borrador ni pagada', () => {
    expect(checkRequestPayment({ status: 'approved', paymentStatus: 'unpaid', obligationId: null })).toEqual({ ok: true });
    expect(checkRequestPayment({ status: 'received', paymentStatus: 'partial', obligationId: null })).toEqual({ ok: true });
    expect(checkRequestPayment({ status: 'approved', paymentStatus: 'unpaid', obligationId: 'ob1' })).toMatchObject({ code: 'duplicate' });
    expect(checkRequestPayment({ status: 'approved', paymentStatus: 'paid', obligationId: null }).ok).toBe(false);
    expect(checkRequestPayment({ status: 'draft', paymentStatus: 'unpaid', obligationId: null }).ok).toBe(false);
  });

  it('envío y recepción según estado y modo de entrega', () => {
    expect(checkSendOrder('approved')).toEqual({ ok: true });
    expect(checkSendOrder('pending_approval').ok).toBe(false);
    expect(checkReceiveOrder({ status: 'awaiting_receipt', deliveryMode: 'warehouse', mode: 'warehouse' })).toEqual({ ok: true });
    expect(checkReceiveOrder({ status: 'awaiting_receipt', deliveryMode: 'direct_to_customer', mode: 'warehouse' }).ok).toBe(false);
    expect(checkReceiveOrder({ status: 'approved', deliveryMode: 'direct_to_customer', mode: 'direct_delivery' })).toEqual({ ok: true });
    expect(checkReceiveOrder({ status: 'approved', deliveryMode: 'warehouse', mode: 'direct_delivery' }).ok).toBe(false);
    expect(checkReceiveOrder({ status: 'draft', deliveryMode: 'warehouse', mode: 'warehouse' }).ok).toBe(false);
  });

  it('cerrar exige diferencias resueltas, aceptar faltantes y pago o cuenta por pagar', () => {
    const base = { status: 'partially_received', openDifferences: 0, pendingQty: 0, acceptShortages: false, paymentStatus: 'paid', obligationId: null };
    expect(checkCloseOrder({ ...base, status: 'received' })).toEqual({ ok: true });
    expect(checkCloseOrder({ ...base, openDifferences: 1 }).ok).toBe(false);
    expect(checkCloseOrder({ ...base, pendingQty: 2 }).ok).toBe(false);
    expect(checkCloseOrder({ ...base, pendingQty: 2, acceptShortages: true })).toEqual({ ok: true });
    expect(checkCloseOrder({ ...base, status: 'received', paymentStatus: 'unpaid' }).ok).toBe(false);
    expect(checkCloseOrder({ ...base, status: 'received', paymentStatus: 'unpaid', obligationId: 'ob1' })).toEqual({ ok: true });
    expect(checkCloseOrder({ ...base, status: 'approved' }).ok).toBe(false);
  });
});

describe('estados siguientes', () => {
  it('aprobación: aprobada o regresa a borrador; nada si ya no espera', () => {
    expect(statusAfterApprovalDecision('pending_approval', 'approved')).toBe('approved');
    expect(statusAfterApprovalDecision('pending_approval', 'rejected')).toBe('draft');
    expect(statusAfterApprovalDecision('cancelled', 'approved')).toBeNull();
  });

  it('pago anticipado espera el pago; crédito y contra entrega no cambian', () => {
    expect(statusAfterPaymentRequest('approved', 'prepaid')).toBe('pending_payment');
    expect(statusAfterPaymentRequest('approved', 'credit')).toBe('approved');
    expect(statusAfterPaymentRequest('awaiting_receipt', 'prepaid')).toBe('awaiting_receipt');
  });

  it('enviar al proveedor: anticipada sin pagar queda pendiente de pago', () => {
    expect(statusAfterSend('approved', 'prepaid', 'unpaid')).toBe('pending_payment');
    expect(statusAfterSend('approved', 'prepaid', 'paid')).toBe('awaiting_receipt');
    expect(statusAfterSend('approved', 'credit', 'unpaid')).toBe('awaiting_receipt');
    expect(statusAfterSend('pending_payment', 'prepaid', 'unpaid')).toBe('pending_payment');
    expect(statusAfterSend('partially_received', 'cod', 'unpaid')).toBe('partially_received');
  });

  it('pagada: si ya se envió espera el material; si no, queda aprobada lista para enviar', () => {
    expect(statusAfterPaid('pending_payment', true)).toBe('awaiting_receipt');
    expect(statusAfterPaid('pending_payment', false)).toBe('approved');
    expect(statusAfterPaid('partially_received', true)).toBe('partially_received');
  });

  it('paymentStatusFor con tolerancia de centavos', () => {
    expect(paymentStatusFor('100', '99.996')).toBe('paid');
    expect(paymentStatusFor('100', '40')).toBe('partial');
    expect(paymentStatusFor('100', '0')).toBe('unpaid');
    expect(paymentStatusFor('0', '0')).toBe('unpaid');
  });

  it('estado de partida y de orden tras recibir', () => {
    expect(lineStatusAfterReceipt(10, 10, 'partial')).toBe('received');
    expect(lineStatusAfterReceipt(10, 4, 'open')).toBe('partial');
    expect(lineStatusAfterReceipt(10, 0, 'open')).toBe('open');
    expect(lineStatusAfterReceipt(10, 10, 'cancelled')).toBe('cancelled');
    const lines = [
      { qty: 10, qtyReceived: 10, status: 'received' },
      { qty: 5, qtyReceived: 0, status: 'cancelled' },
    ];
    expect(statusAfterReceipt('awaiting_receipt', lines, 0)).toBe('received');
    expect(statusAfterReceipt('awaiting_receipt', [{ qty: 10, qtyReceived: 3, status: 'partial' }], 0)).toBe('partially_received');
    expect(statusAfterReceipt('partially_received', [{ qty: 10, qtyReceived: 3, status: 'partial' }], 1)).toBe('disputed');
    expect(statusAfterReceipt('disputed', [{ qty: 10, qtyReceived: 0, status: 'open' }], 0)).toBe('awaiting_receipt');
    expect(statusAfterReceipt('approved', [{ qty: 10, qtyReceived: 2, status: 'closed' }], 0)).toBe('received');
    expect(statusAfterReceipt('cancelled', lines, 0)).toBe('cancelled');
    expect(pendingQuantity([{ qty: 10, qtyReceived: 3, status: 'partial' }, { qty: 4, qtyReceived: 0, status: 'closed' }])).toBe(7);
  });

  it('etiquetas en español', () => {
    expect(orderStatusLabel('pending_payment')).toBe('Pendiente de pago');
    expect(orderStatusLabel('otro')).toBe('otro');
  });
});

describe('computeOrderTotals', () => {
  it('suma partidas, IVA por partida y flete sin IVA', () => {
    const totals = computeOrderTotals(
      [
        { qty: 10, unitPrice: 100, taxRate: 0.16 },
        { qty: 2, unitPrice: '50.5', taxRate: null },
      ],
      150
    );
    expect(totals.lineTotals.map(String)).toEqual(['1000', '101']);
    expect(totals.subtotal.toString()).toBe('1101');
    expect(totals.taxTotal.toString()).toBe('160');
    expect(totals.freight.toString()).toBe('150');
    expect(totals.total.toString()).toBe('1411');
    expect(computeOrderTotals([], -5).freight.toString()).toBe('0');
  });
});

describe('classifyReceiptLine', () => {
  it('una recepción parcial sin declaración no es diferencia', () => {
    expect(classifyReceiptLine({ ordered: 10, receivedBefore: 0, received: 4 })).toEqual({
      ok: true,
      accepted: 4,
      rejected: 0,
      differenceKind: 'none',
      overQty: 0,
    });
  });

  it('lo rechazado es daño; lo de más es excedente; el faltante y el artículo equivocado se declaran', () => {
    expect(classifyReceiptLine({ ordered: 10, receivedBefore: 0, received: 4, rejected: 1 })).toMatchObject({ accepted: 3, differenceKind: 'damaged' });
    expect(classifyReceiptLine({ ordered: 10, receivedBefore: 8, received: 5 })).toMatchObject({ differenceKind: 'over', overQty: 3 });
    expect(classifyReceiptLine({ ordered: 10, receivedBefore: 0, received: 6, declared: 'short' })).toMatchObject({ differenceKind: 'short' });
    expect(classifyReceiptLine({ ordered: 10, receivedBefore: 0, received: 0, declared: 'short' })).toMatchObject({ ok: true, differenceKind: 'short' });
    expect(classifyReceiptLine({ ordered: 10, receivedBefore: 0, received: 5, accepted: 0, rejected: 5, declared: 'wrong_item' })).toMatchObject({ differenceKind: 'wrong_item', accepted: 0 });
    expect(classifyReceiptLine({ ordered: 10, receivedBefore: 0, received: 5, declared: 'none' })).toMatchObject({ differenceKind: 'none' });
  });

  it('rechaza cantidades incoherentes o sin nada recibido', () => {
    expect(classifyReceiptLine({ ordered: 10, receivedBefore: 0, received: 4, accepted: 3, rejected: 0 })).toMatchObject({ ok: false, code: 'invalid_quantity' });
    expect(classifyReceiptLine({ ordered: 10, receivedBefore: 0, received: -1 })).toMatchObject({ ok: false });
    expect(classifyReceiptLine({ ordered: 10, receivedBefore: 0, received: 2, rejected: -1 })).toMatchObject({ ok: false });
    expect(classifyReceiptLine({ ordered: 10, receivedBefore: 0, received: 0 })).toMatchObject({ ok: false, code: 'nothing_received' });
  });
});

describe('distributeFifo', () => {
  it('reparte en orden sin pasar los topes', () => {
    expect(
      distributeFifo(7, [
        { id: 'a', cap: 4 },
        { id: 'b', cap: 0 },
        { id: 'c', cap: 5 },
      ])
    ).toEqual({ shares: [{ id: 'a', qty: 4 }, { id: 'c', qty: 3 }], rest: 0 });
    expect(distributeFifo(10, [{ id: 'a', cap: 4 }])).toEqual({ shares: [{ id: 'a', qty: 4 }], rest: 6 });
    expect(distributeFifo(-2, [{ id: 'a', cap: 4 }])).toEqual({ shares: [], rest: 0 });
  });
});

describe('receiptReservationCap', () => {
  it.each([
    [{ need: 10, promised: 5, suppliedByLine: 0 }, 5],
    [{ need: 5, promised: 5, suppliedByLine: 5 }, 0],
    [{ need: 3, promised: 5, suppliedByLine: 0 }, 3],
    [{ need: 10, promised: 5, suppliedByLine: 2.5 }, 2.5],
    [{ need: 0, promised: 5, suppliedByLine: 0 }, 0],
    [{ need: -1, promised: 5, suppliedByLine: 0 }, 0],
    [{ need: 10, promised: 5, suppliedByLine: 7 }, 0],
    [{ need: 10, promised: 5, suppliedByLine: -3 }, 5],
    [{ need: 1.00001, promised: 1.00004, suppliedByLine: 0 }, 1],
  ])('%j → %s', async (input, expected) => {
    const { receiptReservationCap } = await import('./orders-state');
    expect(receiptReservationCap(input)).toBe(expected);
  });
});
