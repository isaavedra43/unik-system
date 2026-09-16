import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_ORDER,
  DECISION_NOTE_MAX,
  INVENTORY_SPACES,
  STOCK_ACTION_KINDS,
  aggregateConfidence,
  buildAdjustmentDecision,
  buildClaimConfirmation,
  buildDisputeResolution,
  buildLegacyClaim,
  buildStockAction,
  claimExpiryLabel,
  demandOptionKey,
  describeAdjustmentOutcome,
  emptyLegacyClaimForm,
  emptyStockActionForm,
  groupCountLines,
  stockActionNeedsAdjustPermission,
  stockActionNeedsReason,
  stockActionNeedsStockItem,
  confidenceChartTone,
  confidenceLabel,
  confidenceSegments,
  confidenceTone,
  controlledShare,
  countProgressLabel,
  expectedSupplyText,
  formatQty,
  formatSignedQty,
  inventoryHref,
  movementKindLabel,
  parseCountedQty,
  parseLocationCode,
  parseSignedQty,
  pickNextLocation,
  profileHref,
  scanTarget,
  stalenessLabel,
  summarizeExpectedSupply,
  validateProfileForm,
  type LocationLike,
  type ProfileFormValues,
  type StockActionFormValues,
} from './inventario-model';

/**
 * Pure rules of the Inventario experience: what a level means, what to count
 * first, and what a person may type. The engine validates everything again;
 * these tests keep the screen from sending what it already knows is wrong.
 */

function location(overrides: Partial<LocationLike> = {}): LocationLike {
  return {
    id: 'loc-1',
    code: 'A-01',
    label: null,
    items: 4,
    confidence: 'CONTROLLED',
    daysSinceCount: 2,
    ...overrides,
  };
}

describe('confianza', () => {
  it('ordena los niveles del menos confiable al más confiable', () => {
    expect([...CONFIDENCE_ORDER]).toStrictEqual([
      'DISPUTED',
      'UNCOUNTED',
      'PROVISIONAL',
      'CONTROLLED',
    ]);
  });

  it('cada nivel tiene su tono y su etiqueta en español', () => {
    expect(confidenceTone('CONTROLLED')).toBe('success');
    expect(confidenceTone('DISPUTED')).toBe('danger');
    expect(confidenceTone('PROVISIONAL')).toBe('warning');
    expect(confidenceTone('UNCOUNTED')).toBe('weak');
    expect(confidenceLabel('CONTROLLED')).toBe('Controlado');
    expect(confidenceChartTone('DISPUTED')).toBe('danger');
  });

  it('un valor desconocido se trata como sin contar', () => {
    expect(confidenceTone('LO_QUE_SEA')).toBe('weak');
    expect(confidenceLabel(null)).toBe('Sin contar');
  });

  it('la confianza de una ubicación es la peor de lo que guarda', () => {
    expect(aggregateConfidence({ disputed: 1, uncounted: 3, provisional: 2, controlled: 9 })).toBe(
      'DISPUTED'
    );
    expect(aggregateConfidence({ disputed: 0, uncounted: 1, provisional: 2, controlled: 9 })).toBe(
      'UNCOUNTED'
    );
    expect(aggregateConfidence({ disputed: 0, uncounted: 0, provisional: 2, controlled: 9 })).toBe(
      'PROVISIONAL'
    );
    expect(aggregateConfidence({ disputed: 0, uncounted: 0, provisional: 0, controlled: 9 })).toBe(
      'CONTROLLED'
    );
    expect(aggregateConfidence({ disputed: 0, uncounted: 0, provisional: 0, controlled: 0 })).toBe(
      null
    );
  });

  it('los segmentos de la gráfica cubren los cuatro niveles aunque falten datos', () => {
    const segments = confidenceSegments([
      { confidence: 'CONTROLLED', items: 12 },
      { confidence: 'DISPUTED', items: 3 },
    ]);
    expect(segments.map((segment) => segment.key)).toStrictEqual([
      'UNCOUNTED',
      'PROVISIONAL',
      'CONTROLLED',
      'DISPUTED',
    ]);
    expect(segments.find((segment) => segment.key === 'CONTROLLED')?.count).toBe(12);
    expect(segments.find((segment) => segment.key === 'UNCOUNTED')?.count).toBe(0);
  });

  it('el porcentaje de controlados es 0 cuando no hay artículos', () => {
    expect(controlledShare([])).toBe(0);
    expect(
      controlledShare([
        { confidence: 'CONTROLLED', items: 3 },
        { confidence: 'UNCOUNTED', items: 1 },
      ])
    ).toBe(75);
  });
});

describe('formateadores', () => {
  it('muestra cantidades con su unidad y un guion cuando no hay dato', () => {
    expect(formatQty('1240.5', 'm2')).toBe('1,240.5 m2');
    expect(formatQty(12)).toBe('12');
    expect(formatQty(null)).toBe('—');
    expect(formatQty('')).toBe('—');
  });

  it('marca el signo de un movimiento', () => {
    expect(formatSignedQty('12', 'pz')).toBe('+12 pz');
    expect(formatSignedQty('-3', 'pz')).toBe('−3 pz');
    expect(formatSignedQty('0')).toBe('0');
  });

  it('traduce el tipo de movimiento', () => {
    expect(movementKindLabel('receipt')).toBe('Entrada');
    expect(movementKindLabel('inventado')).toBe('inventado');
  });

  it('dice en palabras qué tan viejo es un conteo', () => {
    expect(stalenessLabel(null)).toBe('Nunca se ha contado');
    expect(stalenessLabel(0)).toBe('Contado hoy');
    expect(stalenessLabel(1)).toBe('Contado ayer');
    expect(stalenessLabel(12)).toBe('Contado hace 12 días');
    expect(stalenessLabel(35)).toBe('Contado hace un mes');
    expect(stalenessLabel(95)).toBe('Contado hace 3 meses');
  });

  it('resume el avance de un conteo', () => {
    expect(countProgressLabel({ lines: 0 })).toBe('Sin líneas capturadas');
    expect(countProgressLabel({ lines: 1 })).toBe('1 línea capturada');
    expect(countProgressLabel({ lines: 7, disputed: 2 })).toBe(
      '7 líneas capturadas · 2 en disputa'
    );
  });
});

describe('enlaces', () => {
  it('arma la ruta de cada espacio con su filtro', () => {
    expect(inventoryHref(INVENTORY_SPACES.map)).toBe('/app/areas/inventario/mapa');
    expect(inventoryHref(INVENTORY_SPACES.stock, { confianza: 'DISPUTED' })).toBe(
      '/app/areas/inventario/existencias?confianza=DISPUTED'
    );
    expect(inventoryHref(INVENTORY_SPACES.map, { count: null, scan: false })).toBe(
      '/app/areas/inventario/mapa'
    );
  });

  it('escapa el identificador del artículo en el perfil', () => {
    expect(profileHref('item/1')).toBe('/app/areas/inventario/perfiles/item%2F1');
  });
});

describe('qué contar primero', () => {
  it('sin existencias no propone nada', () => {
    expect(pickNextLocation([])).toBeNull();
    expect(pickNextLocation([location({ items: 0 })])).toBeNull();
  });

  it('la disputa manda sobre todo lo demás', () => {
    const next = pickNextLocation([
      location({ id: 'a', confidence: 'UNCOUNTED', daysSinceCount: null }),
      location({ id: 'b', confidence: 'DISPUTED', daysSinceCount: 1 }),
    ]);
    expect(next?.location.id).toBe('b');
    expect(next?.reason).toBe('disputed');
  });

  it('después va lo que nunca se contó, empezando por lo que más guarda', () => {
    const next = pickNextLocation([
      location({ id: 'a', confidence: 'UNCOUNTED', daysSinceCount: null, items: 2 }),
      location({ id: 'b', confidence: 'UNCOUNTED', daysSinceCount: null, items: 9 }),
      location({ id: 'c', confidence: 'CONTROLLED', daysSinceCount: 1 }),
    ]);
    expect(next?.location.id).toBe('b');
    expect(next?.reason).toBe('uncounted');
  });

  it('luego lo que lleva más de treinta días', () => {
    const next = pickNextLocation([
      location({ id: 'a', confidence: 'CONTROLLED', daysSinceCount: 40 }),
      location({ id: 'b', confidence: 'CONTROLLED', daysSinceCount: 60 }),
      location({ id: 'c', confidence: 'CONTROLLED', daysSinceCount: 2 }),
    ]);
    expect(next?.location.id).toBe('b');
    expect(next?.reason).toBe('stale');
  });

  it('si todo está al día propone la más antigua', () => {
    const next = pickNextLocation([
      location({ id: 'a', daysSinceCount: 3 }),
      location({ id: 'b', daysSinceCount: 9 }),
    ]);
    expect(next?.location.id).toBe('b');
    expect(next?.reason).toBe('oldest');
  });
});

describe('a dónde lleva un escaneo', () => {
  const locations = [
    location({ id: 'loc-1', code: 'A-01' }),
    location({ id: 'loc-2', code: 'B-02' }),
  ];

  it('una etiqueta de ubicación abre su casilla del mapa', () => {
    expect(
      scanTarget({ kind: 'location', title: 'Ubicación b-02', items: [] }, locations)
    ).toStrictEqual({ kind: 'location', locationId: 'loc-2', code: 'B-02' });
  });

  it('una ubicación que no está en la bodega abierta no inventa destino', () => {
    expect(
      scanTarget({ kind: 'location', title: 'Ubicación Z-99', items: [] }, locations)
    ).toStrictEqual({ kind: 'unknown' });
  });

  it('una etiqueta de existencia abre esa fila con su ubicación', () => {
    expect(
      scanTarget(
        { kind: 'stock_item', title: 'Loseta', items: [{ id: 'si-1', locationCode: 'A-01' }] },
        locations
      )
    ).toStrictEqual({ kind: 'stock_item', stockItemId: 'si-1', locationCode: 'A-01' });
  });

  it('un SKU ofrece todas sus filas', () => {
    expect(
      scanTarget(
        {
          kind: 'sku',
          title: 'Placa 4x8',
          items: [
            { id: 'si-1', locationCode: 'A-01' },
            { id: 'si-2', locationCode: 'B-02' },
          ],
        },
        locations
      )
    ).toStrictEqual({ kind: 'sku', stockItemIds: ['si-1', 'si-2'] });
  });

  it('lo que no se reconoce no lleva a ningún lado', () => {
    expect(scanTarget({ kind: 'unknown', title: 'x', items: [] }, locations)).toStrictEqual({
      kind: 'unknown',
    });
    expect(scanTarget(null, locations)).toStrictEqual({ kind: 'unknown' });
    expect(scanTarget({ kind: 'sku', title: 'x', items: [] }, locations)).toStrictEqual({
      kind: 'unknown',
    });
  });
});

describe('validación de lo que se captura', () => {
  it('acepta cantidades con coma o punto y rechaza texto', () => {
    expect(parseCountedQty('12,5')).toStrictEqual({ ok: true, value: '12.5' });
    expect(parseCountedQty(' 0 ')).toStrictEqual({ ok: true, value: '0' });
    expect(parseCountedQty('doce')).toStrictEqual({
      ok: false,
      error: 'Usa sólo números (hasta seis decimales)',
    });
    expect(parseCountedQty('')).toStrictEqual({ ok: false, error: 'Escribe la cantidad contada' });
  });

  it('una cantidad contada nunca es negativa', () => {
    const result = parseCountedQty('-2');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('negativa');
  });

  it('un ajuste lleva signo y no puede ser cero', () => {
    expect(parseSignedQty('-2')).toStrictEqual({ ok: true, value: '-2' });
    const zero = parseSignedQty('0');
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.error).toContain('cero');
  });

  it('normaliza el código de ubicación como lo guarda el motor', () => {
    expect(parseLocationCode(' rack a 1 ')).toStrictEqual({ ok: true, value: 'RACK-A-1' });
    const reserved = parseLocationCode('general');
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) expect(reserved.error).toContain('reservado');
    const invalid = parseLocationCode('a**b');
    expect(invalid.ok).toBe(false);
  });
});

describe('formulario del perfil', () => {
  const values = (overrides: Partial<ProfileFormValues> = {}): ProfileFormValues => ({
    baseUnit: 'pz',
    tolerancePct: '2',
    trackingPolicy: 'none',
    defaultSource: 'stock',
    isBulk: false,
    variantAxes: 'color, medida',
    conversions: [{ unit: 'caja', factor: '12' }],
    weightKgPerBaseUnit: '',
    areaM2PerBaseUnit: '',
    ...overrides,
  });

  it('normaliza unidades, ejes y conversiones', () => {
    const result = validateProfileForm(values({ baseUnit: ' PZ ', variantAxes: 'Color, Medida ' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.baseUnit).toBe('pz');
      expect(result.patch.variantAxes).toStrictEqual(['color', 'medida']);
      expect(result.patch.conversions).toStrictEqual([{ unit: 'caja', factor: '12' }]);
      expect(result.patch.tolerancePct).toBe(2);
      expect(result.patch.weightKgPerBaseUnit).toBeNull();
    }
  });

  it('exige unidad base y tolerancia dentro de rango', () => {
    const missing = validateProfileForm(values({ baseUnit: '   ' }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.baseUnit).toContain('unidad base');

    const tolerance = validateProfileForm(values({ tolerancePct: '120' }));
    expect(tolerance.ok).toBe(false);
    if (!tolerance.ok) expect(tolerance.errors.tolerancePct).toContain('0 a 100');
  });

  it('rechaza conversiones repetidas, factores inválidos y la unidad base con factor distinto de 1', () => {
    const repeated = validateProfileForm(
      values({
        conversions: [
          { unit: 'caja', factor: '12' },
          { unit: 'Caja', factor: '6' },
        ],
      })
    );
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) expect(repeated.errors['conversions.1.unit']).toContain('repetida');

    const zero = validateProfileForm(values({ conversions: [{ unit: 'caja', factor: '0' }] }));
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.errors['conversions.0.factor']).toContain('mayor que cero');

    const base = validateProfileForm(values({ conversions: [{ unit: 'pz', factor: '3' }] }));
    expect(base.ok).toBe(false);
    if (!base.ok) expect(base.errors['conversions.0.factor']).toContain('factor 1');
  });

  it('ignora las filas de conversión vacías', () => {
    const result = validateProfileForm(
      values({
        conversions: [
          { unit: '', factor: '' },
          { unit: 'caja', factor: '12' },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.conversions).toHaveLength(1);
  });

  it('acepta medidas opcionales y rechaza las negativas', () => {
    const ok = validateProfileForm(values({ weightKgPerBaseUnit: '1,5' }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.patch.weightKgPerBaseUnit).toBe(1.5);

    const negative = validateProfileForm(values({ areaM2PerBaseUnit: '-4' }));
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.errors.areaM2PerBaseUnit).toBeTruthy();
  });
});

describe('lo que viene en camino de Compras', () => {
  const lines = [
    { zohoItemId: 'item_a', orderId: 'oc_1', expectedQty: '10', overdue: false },
    { zohoItemId: 'item_a', orderId: 'oc_2', expectedQty: '2.5', overdue: true },
    { zohoItemId: 'item_b', orderId: 'oc_1', expectedQty: '4', overdue: false },
    // Sin artículo (una partida libre) o sin nada pendiente: no cuenta.
    { zohoItemId: null, orderId: 'oc_3', expectedQty: '9', overdue: false },
    { zohoItemId: 'item_c', orderId: 'oc_4', expectedQty: '0', overdue: false },
  ];

  it('suma por artículo, cuenta órdenes y hereda el atraso', () => {
    const summary = summarizeExpectedSupply(lines);
    expect(summary.item_a).toStrictEqual({ quantity: 12.5, orders: 2, overdue: true });
    expect(summary.item_b).toStrictEqual({ quantity: 4, orders: 1, overdue: false });
    expect(summary.item_c).toBeUndefined();
    expect(Object.keys(summary)).toHaveLength(2);
  });

  it('lo dice como una persona, y calla cuando no viene nada', () => {
    const summary = summarizeExpectedSupply(lines);
    expect(expectedSupplyText(summary.item_a, 'pza')).toBe('12.5 pza en 2 órdenes');
    expect(expectedSupplyText(summary.item_b, 'pza')).toBe('4 pza en 1 orden');
    expect(expectedSupplyText(undefined, 'pza')).toBe('—');
    expect(expectedSupplyText({ quantity: 0, orders: 0, overdue: false })).toBe('—');
  });

  it('nunca se mezcla con lo disponible: es su propio dato', () => {
    // La regla del plan: lo esperado no es inventario. La suma vive aparte y
    // el llamador la pinta en su propia columna.
    const summary = summarizeExpectedSupply([
      { zohoItemId: 'item_a', orderId: 'oc_1', expectedQty: 3, overdue: false },
    ]);
    expect(summary.item_a?.quantity).toBe(3);
    expect(summarizeExpectedSupply([])).toStrictEqual({});
  });
});

describe('decisiones sobre las diferencias de un conteo', () => {
  it('la autorización viaja con su decisión y recorta la nota', () => {
    const decision = buildAdjustmentDecision({
      lineId: ' line-1 ',
      decision: 'approve',
      note: ` ${'x'.repeat(600)} `,
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.value.lineId).toBe('line-1');
    expect(decision.value.note).toHaveLength(DECISION_NOTE_MAX);
  });

  it('sin nota la autorización sigue siendo válida (el motor no la exige)', () => {
    const decision = buildAdjustmentDecision({ lineId: 'line-1', decision: 'reject', note: '  ' });
    expect(decision).toStrictEqual({ ok: true, value: { lineId: 'line-1', decision: 'reject' } });
  });

  it('una decisión que no está en el vocabulario del comando no sale', () => {
    expect(buildAdjustmentDecision({ lineId: 'line-1', decision: 'maybe' }).ok).toBe(false);
    expect(buildAdjustmentDecision({ lineId: '  ', decision: 'approve' }).ok).toBe(false);
  });

  it('la disputa exige explicación: es lo que pide el servicio', () => {
    const missing = buildDisputeResolution({
      lineId: 'line-1',
      decision: 'adjust',
      note: '   ',
    });
    expect(missing).toStrictEqual({
      ok: false,
      error: 'Explica cómo se resolvió la diferencia',
    });
  });

  it('la cantidad confirmada sólo tiene sentido cuando se ajusta', () => {
    const wrong = buildDisputeResolution({
      lineId: 'line-1',
      decision: 'keep_book',
      confirmedQty: '12',
      note: 'Se conserva el libro',
    });
    expect(wrong.ok).toBe(false);

    const right = buildDisputeResolution({
      lineId: 'line-1',
      decision: 'adjust',
      confirmedQty: '12,5',
      unit: 'm2',
      note: 'Recontado entre dos',
    });
    expect(right).toStrictEqual({
      ok: true,
      value: {
        lineId: 'line-1',
        decision: 'adjust',
        note: 'Recontado entre dos',
        confirmedQty: '12.5',
        unit: 'm2',
      },
    });
  });

  it('separa las líneas por lo que falta decidir', () => {
    const grouped = groupCountLines([
      { resolution: 'pending' },
      { resolution: 'disputed' },
      { resolution: 'adjusted' },
      { resolution: 'accepted' },
    ]);
    expect(grouped.pending).toHaveLength(1);
    expect(grouped.disputed).toHaveLength(1);
    expect(grouped.settled).toHaveLength(2);
  });

  it('dice la verdad cuando el ajuste quedó esperando otra firma', () => {
    expect(
      describeAdjustmentOutcome({
        decision: 'approve',
        awaitingApproval: false,
        noApprovers: false,
      })
    ).toContain('Ajuste aplicado');
    expect(
      describeAdjustmentOutcome({ decision: 'approve', awaitingApproval: true, noApprovers: false })
    ).toContain('falta otra firma');
    expect(
      describeAdjustmentOutcome({ decision: 'approve', awaitingApproval: true, noApprovers: true })
    ).toContain('no hay suficientes personas');
  });
});

describe('captura de un movimiento', () => {
  function form(overrides: Partial<StockActionFormValues> = {}): StockActionFormValues {
    return emptyStockActionForm({
      kind: 'receipt',
      zohoItemId: 'item-1',
      warehouseId: 'wh-1',
      quantity: '10',
      unit: 'm2',
      ...overrides,
    });
  }

  it('una entrada normaliza la ubicación y conserva la referencia', () => {
    const built = buildStockAction(form({ locationCode: ' a-01 ', reference: ' REM-9 ' }));
    expect(built).toStrictEqual({
      ok: true,
      value: {
        kind: 'receipt',
        zohoItemId: 'item-1',
        warehouseId: 'wh-1',
        quantity: '10',
        locationCode: 'A-01',
        unit: 'm2',
        reference: 'REM-9',
      },
    });
  });

  it('con una fila elegida no se manda ubicación: el motor usaría la de la fila', () => {
    const built = buildStockAction(
      form({ stockItemId: 'si-1', locationCode: 'A-01', kind: 'issue' })
    );
    expect(built).toStrictEqual({
      ok: true,
      value: {
        kind: 'issue',
        zohoItemId: 'item-1',
        warehouseId: 'wh-1',
        stockItemId: 'si-1',
        quantity: '10',
        unit: 'm2',
      },
    });
  });

  it('la cantidad de un movimiento es siempre mayor que cero', () => {
    expect(buildStockAction(form({ quantity: '0' })).ok).toBe(false);
    expect(buildStockAction(form({ quantity: '-3' })).ok).toBe(false);
  });

  it('el ajuste admite signo pero nunca cero', () => {
    expect(buildStockAction(form({ kind: 'adjust', quantity: '-3', reason: 'Merma' })).ok).toBe(
      true
    );
    expect(buildStockAction(form({ kind: 'adjust', quantity: '0', reason: 'Merma' })).ok).toBe(
      false
    );
  });

  it('ajustar, bloquear y desbloquear exigen motivo; bloquear además una fila', () => {
    expect(stockActionNeedsReason('adjust')).toBe(true);
    expect(stockActionNeedsReason('receipt')).toBe(false);
    expect(stockActionNeedsStockItem('block')).toBe(true);
    expect(buildStockAction(form({ kind: 'adjust', quantity: '-1' })).ok).toBe(false);
    expect(buildStockAction(form({ kind: 'block', quantity: '1', reason: 'Dañado' })).ok).toBe(
      false
    );
    expect(
      buildStockAction(
        form({ kind: 'block', quantity: '1', reason: 'Dañado', stockItemId: 'si-1' })
      ).ok
    ).toBe(true);
  });

  it('un traspaso a la misma bodega necesita una ubicación de destino', () => {
    expect(buildStockAction(form({ kind: 'transfer', toWarehouseId: 'wh-1' })).ok).toBe(false);
    expect(buildStockAction(form({ kind: 'transfer', toWarehouseId: 'wh-2' })).ok).toBe(true);
    expect(
      buildStockAction(form({ kind: 'transfer', toWarehouseId: 'wh-1', toLocationCode: 'b-02' }))
    ).toMatchObject({ ok: true, value: { toLocationCode: 'B-02' } });
  });

  it('sólo ajuste, bloqueo y desbloqueo piden el permiso de ajustar', () => {
    expect(STOCK_ACTION_KINDS.filter(stockActionNeedsAdjustPermission)).toStrictEqual([
      'adjust',
      'block',
      'unblock',
    ]);
  });
});

describe('compromisos previos al corte', () => {
  it('exige referencia: es lo que permite reconocerlo meses después', () => {
    const noReference = buildLegacyClaim(
      emptyLegacyClaimForm({
        zohoItemId: 'item-1',
        warehouseId: 'wh-1',
        quantity: '5',
        reference: '  ',
      })
    );
    expect(noReference.ok).toBe(false);

    const built = buildLegacyClaim(
      emptyLegacyClaimForm({
        zohoItemId: 'item-1',
        warehouseId: 'wh-1',
        quantity: '5',
        unit: 'bulto',
        source: 'verbal',
        reference: 'Acuerdo con don Julio',
        note: 'Lo apartó en la obra',
      })
    );
    expect(built).toStrictEqual({
      ok: true,
      value: {
        zohoItemId: 'item-1',
        warehouseId: 'wh-1',
        quantity: '5',
        source: 'verbal',
        reference: 'Acuerdo con don Julio',
        unit: 'bulto',
        note: 'Lo apartó en la obra',
      },
    });
  });

  it('un origen inventado no llega al comando', () => {
    const built = buildLegacyClaim(
      emptyLegacyClaimForm({
        zohoItemId: 'item-1',
        warehouseId: 'wh-1',
        quantity: '5',
        source: 'porque_si',
        reference: 'x',
      })
    );
    expect(built.ok).toBe(false);
  });

  it('confirmar parte la llave del selector en expediente y necesidad', () => {
    expect(
      buildClaimConfirmation({
        claimId: 'claim-1',
        demandKey: demandOptionKey('case-1', 'demand-9'),
        allowProvisional: true,
      })
    ).toStrictEqual({
      ok: true,
      value: { claimId: 'claim-1', caseId: 'case-1', demandId: 'demand-9', allowProvisional: true },
    });
    expect(buildClaimConfirmation({ claimId: 'claim-1', demandKey: '' }).ok).toBe(false);
    expect(buildClaimConfirmation({ claimId: 'claim-1', demandKey: 'case-1:' }).ok).toBe(false);
  });

  it('dice cuánto le queda antes de que el supervisor lo expire', () => {
    const now = new Date('2026-09-16T12:00:00.000Z');
    expect(claimExpiryLabel('2026-09-16T18:00:00.000Z', now)).toBe('Vence hoy');
    expect(claimExpiryLabel('2026-09-17T18:00:00.000Z', now)).toBe('Vence mañana');
    expect(claimExpiryLabel('2026-09-21T12:00:00.000Z', now)).toBe('Vence en 5 días');
    expect(claimExpiryLabel('2026-09-15T12:00:00.000Z', now)).toContain('Venció');
  });
});
