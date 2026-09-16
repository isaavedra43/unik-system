import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_CONFIDENCE_ESTIMATE,
  CANDIDATE_CONFIDENCE_VERIFIED,
  DIFFERENCE_OPTIONS,
  MAX_COMPARED_CANDIDATES,
  candidateConfidenceLevel,
  candidateConfidenceNote,
  canInviteCandidate,
  checkReceiptDraft,
  checkReceiptLine,
  formatLeadTime,
  formatMoney,
  formatQty,
  formatScore,
  inviteCandidateBlockedReason,
  orderNextAction,
  pendingLineQty,
  responseNeedsReview,
  purchasesBoardTouches,
  reviewReasonText,
  sourcingProgress,
  toggleComparedCandidate,
} from './compras-model';

/**
 * The pure rules of the Compras experience: what the person is allowed to do,
 * what the receipt capture accepts and how much a sourcing candidate can be
 * trusted. Every rule the UI shows is decided here, so it is testable without
 * a database or a browser.
 */

describe('confianza de un candidato de sourcing', () => {
  it('sin confianza no inventa una insignia', () => {
    expect(candidateConfidenceLevel(null)).toBeNull();
    expect(candidateConfidenceLevel(undefined)).toBeNull();
    expect(candidateConfidenceLevel('')).toBeNull();
    expect(candidateConfidenceLevel('no-es-un-número')).toBeNull();
  });

  it('clasifica por umbrales, incluyendo los bordes', () => {
    expect(candidateConfidenceLevel(CANDIDATE_CONFIDENCE_VERIFIED)).toBe('verified');
    expect(candidateConfidenceLevel(0.95)).toBe('verified');
    expect(candidateConfidenceLevel(CANDIDATE_CONFIDENCE_ESTIMATE)).toBe('estimate');
    expect(candidateConfidenceLevel(0.79)).toBe('estimate');
    expect(candidateConfidenceLevel(0.49)).toBe('assumption');
    expect(candidateConfidenceLevel(0)).toBe('assumption');
  });

  it('acepta el decimal como cadena (así viaja desde Prisma)', () => {
    expect(candidateConfidenceLevel('0.82')).toBe('verified');
    expect(candidateConfidenceLevel('0.5')).toBe('estimate');
  });

  it('la nota dice cuánta evidencia respalda la ficha', () => {
    expect(candidateConfidenceNote({ confidence: 0.9, evidenceCount: 0 })).toBe(
      'sin evidencia guardada'
    );
    expect(candidateConfidenceNote({ confidence: 0.9, evidenceCount: 1 })).toBe(
      'con 1 evidencia guardada'
    );
    expect(candidateConfidenceNote({ confidence: 0.9, evidenceCount: 3 })).toBe(
      'con 3 evidencias guardadas'
    );
    expect(candidateConfidenceNote({ confidence: null, evidenceCount: 3 })).toBeNull();
  });
});

describe('comparación de candidatos', () => {
  it('agrega y quita candidatos', () => {
    const first = toggleComparedCandidate([], 'c1');
    expect(first).toStrictEqual({ ok: true, selected: ['c1'] });
    const second = toggleComparedCandidate(['c1'], 'c2');
    expect(second).toStrictEqual({ ok: true, selected: ['c1', 'c2'] });
    expect(toggleComparedCandidate(['c1', 'c2'], 'c1')).toStrictEqual({
      ok: true,
      selected: ['c2'],
    });
  });

  it(`no compara más de ${MAX_COMPARED_CANDIDATES} y lo explica`, () => {
    const full = ['c1', 'c2', 'c3', 'c4'];
    const result = toggleComparedCandidate(full, 'c5');
    expect(result.ok).toBe(false);
    expect(result.selected).toStrictEqual(full);
    if (!result.ok) expect(result.error).toContain(String(MAX_COMPARED_CANDIDATES));
  });

  it('en el tope todavía se puede quitar uno', () => {
    expect(toggleComparedCandidate(['c1', 'c2', 'c3', 'c4'], 'c2')).toStrictEqual({
      ok: true,
      selected: ['c1', 'c3', 'c4'],
    });
  });
});

describe('a quién se le puede pedir cotización', () => {
  const base = { status: 'new', supplierId: null, phone: '+52 81 1234 5678', email: null };

  it('un candidato nuevo con teléfono sí', () => {
    expect(canInviteCandidate(base)).toBe(true);
    expect(inviteCandidateBlockedReason(base)).toBeNull();
  });

  it('sin teléfono ni correo no, y dice por qué', () => {
    const blind = { ...base, phone: null, email: null };
    expect(canInviteCandidate(blind)).toBe(false);
    expect(inviteCandidateBlockedReason(blind)).toContain('teléfono ni correo');
  });

  it('si ya es proveedor manda a su ficha', () => {
    const promoted = { ...base, status: 'promoted', supplierId: 'sup-1' };
    expect(canInviteCandidate(promoted)).toBe(false);
    expect(inviteCandidateBlockedReason(promoted)).toContain('proveedor');
  });

  it('descartado se reactiva antes de contactarlo', () => {
    const rejected = { ...base, status: 'rejected' };
    expect(canInviteCandidate(rejected)).toBe(false);
    expect(inviteCandidateBlockedReason(rejected)).toContain('descartaste');
  });
});

describe('progreso de la búsqueda', () => {
  it('pendiente sigue consultando', () => {
    const progress = sourcingProgress({ status: 'pending', resultCount: 0 });
    expect(progress.running).toBe(true);
    expect(progress.tone).toBe('info');
  });

  it('terminada dice cuántos encontró y si no gastó', () => {
    expect(sourcingProgress({ status: 'done', resultCount: 3 }).label).toBe(
      '3 candidatos encontrados'
    );
    expect(sourcingProgress({ status: 'done', resultCount: 1 }).label).toBe(
      '1 candidato encontrado'
    );
    expect(sourcingProgress({ status: 'done', resultCount: 2, cached: true }).label).toContain(
      'sin gasto'
    );
    expect(sourcingProgress({ status: 'done', resultCount: 0 }).tone).toBe('weak');
  });

  it('fallida muestra el motivo y deja de consultar', () => {
    const progress = sourcingProgress({
      status: 'failed',
      resultCount: 0,
      error: 'sin presupuesto',
    });
    expect(progress.running).toBe(false);
    expect(progress.tone).toBe('danger');
    expect(progress.label).toContain('sin presupuesto');
  });
});

describe('captura de una recepción', () => {
  const line = {
    orderLineId: 'ol-1',
    ordered: 10,
    receivedBefore: 0,
    qtyReceived: 10,
    qtyRejected: 0,
    differenceKind: null,
  };

  it('todo completo no es diferencia', () => {
    expect(checkReceiptLine(line)).toStrictEqual({
      ok: true,
      accepted: 10,
      differenceKind: 'none',
      over: 0,
    });
  });

  it('una entrega parcial sin declarar tampoco lo es: lo demás sigue esperado', () => {
    const result = checkReceiptLine({ ...line, qtyReceived: 4 });
    expect(result).toStrictEqual({ ok: true, accepted: 4, differenceKind: 'none', over: 0 });
  });

  it('lo rechazado sale de lo aceptado y marca dañado', () => {
    const result = checkReceiptLine({ ...line, qtyReceived: 10, qtyRejected: 3 });
    expect(result).toStrictEqual({ ok: true, accepted: 7, differenceKind: 'damaged', over: 0 });
  });

  it('de más se detecta contra lo ya recibido', () => {
    const result = checkReceiptLine({ ...line, receivedBefore: 8, qtyReceived: 4 });
    expect(result).toStrictEqual({ ok: true, accepted: 4, differenceKind: 'over', over: 2 });
  });

  it('el faltante declarado se respeta aunque no llegue nada', () => {
    const result = checkReceiptLine({
      ...line,
      qtyReceived: 0,
      differenceKind: 'short',
    });
    expect(result).toStrictEqual({ ok: true, accepted: 0, differenceKind: 'short', over: 0 });
  });

  it('el artículo equivocado gana sobre el resto', () => {
    const result = checkReceiptLine({ ...line, qtyRejected: 2, differenceKind: 'wrong_item' });
    expect(result.ok && result.differenceKind).toBe('wrong_item');
  });

  it('rechaza cantidades imposibles', () => {
    expect(checkReceiptLine({ ...line, qtyReceived: -1 })).toStrictEqual({
      ok: false,
      error: 'La cantidad recibida no puede ser negativa',
    });
    expect(checkReceiptLine({ ...line, qtyRejected: -2 })).toStrictEqual({
      ok: false,
      error: 'La cantidad rechazada no puede ser negativa',
    });
    expect(checkReceiptLine({ ...line, qtyReceived: 2, qtyRejected: 5 })).toStrictEqual({
      ok: false,
      error: 'No puedes rechazar más de lo que recibiste',
    });
  });

  it('una partida vacía sin declarar el faltante no se registra', () => {
    expect(checkReceiptLine({ ...line, qtyReceived: 0 })).toStrictEqual({
      ok: false,
      error: 'Indica la cantidad recibida o declara el faltante',
    });
  });

  it('una diferencia exige evidencia antes de mandarla', () => {
    const draft = checkReceiptDraft({
      lines: [{ ...line, qtyRejected: 2 }],
      evidenceCount: 0,
    });
    expect(draft.ok).toBe(false);
    if (!draft.ok) expect(draft.error).toContain('foto');
  });

  it('con evidencia la diferencia pasa', () => {
    const draft = checkReceiptDraft({ lines: [{ ...line, qtyRejected: 2 }], evidenceCount: 1 });
    expect(draft.ok).toBe(true);
    if (draft.ok) expect(draft.lines[0].differenceKind).toBe('damaged');
  });

  it('una recepción sin nada capturado se rechaza y señala la partida con error', () => {
    expect(checkReceiptDraft({ lines: [], evidenceCount: 0 })).toStrictEqual({
      ok: false,
      error: 'Agrega al menos una partida recibida',
      orderLineId: null,
    });
    const invalid = checkReceiptDraft({
      lines: [{ ...line, qtyReceived: 0, qtyRejected: 0 }],
      evidenceCount: 0,
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.orderLineId).toBe('ol-1');
  });

  it('lo pendiente nunca es negativo y una partida cerrada no espera nada', () => {
    expect(pendingLineQty({ qty: '10', qtyAccepted: '4', status: 'partial' })).toBe(6);
    expect(pendingLineQty({ qty: '10', qtyAccepted: '12', status: 'partial' })).toBe(0);
    expect(pendingLineQty({ qty: '10', qtyAccepted: '0', status: 'cancelled' })).toBe(0);
  });

  it('las opciones de diferencia están en español y empiezan por "sin diferencia"', () => {
    expect(DIFFERENCE_OPTIONS[0]).toStrictEqual({ value: 'none', label: 'Sin diferencia' });
    expect(DIFFERENCE_OPTIONS.map((option) => option.value)).toContain('wrong_item');
    for (const option of DIFFERENCE_OPTIONS) expect(option.label).not.toBe(option.value);
  });
});

describe('siguiente acción de una orden de compra', () => {
  const base = {
    status: 'draft',
    paymentMode: 'credit',
    paymentStatus: 'unpaid',
    deliveryMode: 'warehouse',
    sentToSupplierAt: null,
    obligationId: null,
    openDifferences: 0,
  };

  it('un borrador se manda a aprobación', () => {
    expect(orderNextAction(base).id).toBe('submit');
  });

  it('aprobada y de contado pide el pago antes de enviarla', () => {
    expect(orderNextAction({ ...base, status: 'approved', paymentMode: 'prepaid' }).id).toBe(
      'request_payment'
    );
  });

  it('aprobada a crédito se envía al proveedor', () => {
    expect(orderNextAction({ ...base, status: 'approved' }).id).toBe('mark_sent');
  });

  it('si el pago ya se pidió no lo vuelve a pedir', () => {
    expect(
      orderNextAction({
        ...base,
        status: 'approved',
        paymentMode: 'prepaid',
        obligationId: 'obl-1',
      }).id
    ).toBe('mark_sent');
  });

  it('esperando material se recibe, y si es entrega directa se confirma', () => {
    expect(orderNextAction({ ...base, status: 'awaiting_receipt' }).id).toBe('receive');
    expect(
      orderNextAction({
        ...base,
        status: 'partially_received',
        deliveryMode: 'direct_to_customer',
      }).id
    ).toBe('confirm_direct');
  });

  it('recibida se cierra', () => {
    expect(orderNextAction({ ...base, status: 'received' }).id).toBe('close');
  });

  it('una diferencia abierta manda resolverla antes que nada', () => {
    expect(orderNextAction({ ...base, status: 'received', openDifferences: 1 }).id).toBe(
      'resolve_difference'
    );
    expect(orderNextAction({ ...base, status: 'disputed' }).id).toBe('resolve_difference');
  });

  it('una orden cerrada o cancelada no pide nada', () => {
    expect(orderNextAction({ ...base, status: 'closed' }).id).toBe('none');
    expect(orderNextAction({ ...base, status: 'cancelled' }).id).toBe('none');
  });

  it('cada acción declara el permiso que la habilita', () => {
    expect(orderNextAction(base).permissions).toContain('purchases.manage_orders');
    expect(orderNextAction({ ...base, status: 'awaiting_receipt' }).permissions).toContain(
      'purchases.receive'
    );
  });
});

describe('revisión de respuestas de cotización', () => {
  it('lo que el modelo marcó para revisión se revisa', () => {
    expect(
      responseNeedsReview({ status: 'needs_review', confidence: 0.99, reviewReasons: [] })
    ).toBe(true);
  });

  it('confianza baja obliga a revisar', () => {
    expect(responseNeedsReview({ status: 'parsed', confidence: 0.4, reviewReasons: [] })).toBe(
      true
    );
  });

  it('una respuesta confirmada por una persona ya no se revisa', () => {
    expect(
      responseNeedsReview({ status: 'confirmed', confidence: 0.2, reviewReasons: ['x'] })
    ).toBe(false);
  });

  it('los motivos se muestran en español', () => {
    expect(reviewReasonText([])).toBeNull();
    expect(reviewReasonText(['falta el precio'])).toBe('Revisa: falta el precio');
    expect(reviewReasonText(['a', 'b'])).toBe('Revisa: a; b');
  });
});

describe('formateo', () => {
  it('dinero y cantidades vacías se muestran como raya, nunca como cero', () => {
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney('')).toBe('—');
    expect(formatQty(null)).toBe('—');
    expect(formatMoney('no')).toBe('—');
  });

  it('el dinero lleva su moneda', () => {
    expect(formatMoney('1234.5')).toContain('1,234.5');
    expect(formatMoney(0)).toContain('0');
  });

  it('las cantidades llevan su unidad', () => {
    expect(formatQty('12.5', 'm2')).toBe('12.5 m2');
    expect(formatQty(3)).toBe('3');
  });

  it('el plazo se dice como lo diría una persona', () => {
    expect(formatLeadTime(null)).toBe('Sin plazo');
    expect(formatLeadTime(0)).toBe('Inmediato');
    expect(formatLeadTime(1)).toBe('1 día');
    expect(formatLeadTime(5)).toBe('5 días');
  });

  it('el puntaje se muestra como porcentaje', () => {
    expect(formatScore(0.831)).toBe('83 %');
    expect(formatScore(null)).toBe('—');
  });
});

describe('mensajes de purchases:board', () => {
  // `publishBoard` publica sólo los ids que tocó el comando (ver
  // `purchases-helpers.ts`): la pantalla decide con eso si le incumbe.

  it('la captura de recepción sólo se refresca con SU orden', () => {
    const interest = { orderId: 'oc_1' };
    expect(purchasesBoardTouches({ orderId: 'oc_1' }, interest)).toBe(true);
    expect(purchasesBoardTouches({ orderId: 'oc_1', receiptId: 'rc_9' }, interest)).toBe(true);
    expect(purchasesBoardTouches({ orderId: 'oc_2' }, interest)).toBe(false);
    expect(purchasesBoardTouches({ requestId: 'sc_1' }, interest)).toBe(false);
  });

  it('la revisión de una cotización se refresca con su RFQ, incluso al elegir respuesta', () => {
    const interest = { rfqId: 'rfq_1' };
    expect(purchasesBoardTouches({ rfqId: 'rfq_1', responseId: 'rs_2' }, interest)).toBe(true);
    // Elegir una respuesta publica `{ rfqId, orderId }`: sigue siendo su RFQ.
    expect(purchasesBoardTouches({ rfqId: 'rfq_1', orderId: 'oc_7' }, interest)).toBe(true);
    expect(purchasesBoardTouches({ rfqId: 'rfq_2' }, interest)).toBe(false);
  });

  it('el laboratorio escucha su búsqueda y cualquier movimiento de candidatos', () => {
    const interest = { searchId: 'bs_1', anySourcing: true };
    expect(purchasesBoardTouches({ searchId: 'bs_1' }, interest)).toBe(true);
    expect(purchasesBoardTouches({ candidateId: 'cd_3' }, interest)).toBe(true);
    expect(purchasesBoardTouches({ supplierId: 'pv_1', candidateId: 'cd_3' }, interest)).toBe(true);
    // Una orden de compra no mueve el laboratorio.
    expect(purchasesBoardTouches({ orderId: 'oc_1' }, interest)).toBe(false);
  });

  it('sin interés declarado escucha todo, y nunca truena con basura', () => {
    expect(purchasesBoardTouches({ orderId: 'oc_1' })).toBe(true);
    expect(purchasesBoardTouches({})).toBe(true);
    expect(purchasesBoardTouches(null, { orderId: 'oc_1' })).toBe(false);
    expect(purchasesBoardTouches('texto', { orderId: 'oc_1' })).toBe(false);
    expect(purchasesBoardTouches({ orderId: 42 }, { orderId: 'oc_1' })).toBe(false);
  });
});
