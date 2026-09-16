import { describe, expect, it } from 'vitest';
import {
  addStopInput,
  arriveStopInput,
  assignTransportInput,
  buildMapPoints,
  buildTripInput,
  buildTripLines,
  cancelDeliveryInput,
  cancelTripInput,
  checkDeliveredLines,
  closeTripInput,
  completeStopInput,
  createDriverInput,
  createVehicleInput,
  DEFAULT_MAP_CENTER,
  deliveryBlockReason,
  deliveryStatusTone,
  failStopInput,
  fitMapView,
  formatEta,
  shippingModeOptions,
  formatWindow,
  groupDispatchDeliveries,
  navigationUrl,
  needsZohoWrite,
  operationDay,
  parseBoardDate,
  pickDriverStop,
  recordDeliveryInput,
  reorderStopsInput,
  shiftDay,
  startTripInput,
  tripProgress,
  tripsAcceptingStops,
  updateVehicleInput,
  zohoPill,
  ZOHO_WRITE_ACTION_LABEL,
  type DeliveryLineDTO,
  type DispatchDelivery,
  type DispatchStop,
  type DispatchTrip,
} from './logistics-view-model';

/**
 * Rules of the Logística surfaces. Everything here is what a person sees and
 * what each button sends: the engine validates it all again, so the point of
 * these tests is that the UI never offers something the engine would reject and
 * never hides a real state (a conflict with Zoho, a short delivery).
 */

const NOW = new Date('2026-09-15T18:00:00.000Z');

function delivery(overrides: Partial<DispatchDelivery> = {}): DispatchDelivery {
  return {
    id: 'do-1',
    version: 3,
    status: 'planned',
    statusLabel: 'Planeada',
    tone: 'default',
    mode: 'own_fleet',
    modeLabel: 'Flotilla propia',
    caseId: 'case-1',
    caseNumber: 'EXP-1',
    salesOrderNumber: 'SO-1',
    customerName: 'Aceros del Norte',
    carrier: null,
    trackingNumber: null,
    plannedDate: '2026-09-15T00:00:00.000Z',
    windowStart: null,
    windowEnd: null,
    address: {
      line: 'Av. Vallarta 100',
      city: 'Guadalajara',
      state: 'Jalisco',
      postalCode: '44100',
    },
    contact: { name: 'Rosa', phone: '333' },
    coordinates: { lat: 20.67, lng: -103.39 },
    tripId: null,
    tripNumber: null,
    vehicleId: null,
    vehicleLabel: null,
    driverId: null,
    driverName: null,
    packageId: 'pkg-1',
    zohoPackageId: 'z-1',
    zohoSyncState: 'not_required',
    zohoError: null,
    zohoDifferences: [],
    lines: [],
    pendingUnits: 0,
    evidenceCount: 0,
    deliveredAt: null,
    receivedBy: null,
    partialReason: null,
    open: true,
    ...overrides,
  };
}

function stop(overrides: Partial<DispatchStop> = {}): DispatchStop {
  return {
    id: 'stop-1',
    sequence: 1,
    status: 'pending',
    statusLabel: 'Pendiente',
    etaAt: '2026-09-15T19:00:00.000Z',
    arrivedAt: null,
    departedAt: null,
    deliveryOrderId: 'do-1',
    coordinates: { lat: 20.67, lng: -103.39 },
    ...overrides,
  };
}

function trip(overrides: Partial<DispatchTrip> = {}): DispatchTrip {
  return {
    id: 'trip-1',
    version: 2,
    number: 'VJ-1',
    date: '2026-09-15',
    status: 'planned',
    statusLabel: 'Planeado',
    startedAt: null,
    endedAt: null,
    notes: null,
    vehicle: { id: 'v-1', code: 'CAM-01', label: 'Torton', plate: 'ABC-123' },
    driver: { id: 'dr-1', name: 'Luis', phone: '333' },
    stops: [stop()],
    ...overrides,
  };
}

function line(overrides: Partial<DeliveryLineDTO> = {}): DeliveryLineDTO {
  return {
    allocationId: 'al-1',
    demandId: 'dem-1',
    sku: 'SKU-1',
    name: 'Lámina',
    unit: 'pz',
    quantity: 10,
    deliveredQuantity: 0,
    pendingQuantity: 10,
    ...overrides,
  };
}

describe('estado de Zoho', () => {
  it('un conflicto se muestra como acción: Zoho es la autoridad del paquete', () => {
    const pill = zohoPill(delivery({ status: 'conflict', zohoSyncState: 'readback_mismatch' }));
    expect(pill?.tone).toBe('danger');
    expect(pill?.actionable).toBe(true);
    expect(pill?.actionLabel).toBe(ZOHO_WRITE_ACTION_LABEL);
    expect(
      needsZohoWrite(delivery({ status: 'conflict', zohoSyncState: 'readback_mismatch' }))
    ).toBe(true);
  });

  it('una escritura fallida pide reintentar y muestra el error de Zoho', () => {
    const pill = zohoPill(
      delivery({ status: 'failed', zohoSyncState: 'failed', zohoError: 'Zoho respondió 400' })
    );
    expect(pill?.actionable).toBe(true);
    expect(pill?.detail).toContain('Zoho respondió 400');
  });

  it('una escritura en vuelo sólo informa: nadie tiene que hacer nada', () => {
    const pill = zohoPill(delivery({ status: 'pending_external', zohoSyncState: 'pending_write' }));
    expect(pill?.tone).toBe('warning');
    expect(pill?.actionable).toBe(false);
    expect(
      needsZohoWrite(delivery({ status: 'pending_external', zohoSyncState: 'pending_write' }))
    ).toBe(false);
  });

  it('la cancelación y la entrega pendientes de escribir se explican con su operación', () => {
    expect(
      zohoPill(delivery({ status: 'cancelled', zohoSyncState: 'pending_write' }))?.detail
    ).toContain('cancelar la orden de envío');
    expect(
      zohoPill(delivery({ status: 'delivered', zohoSyncState: 'delivered_pending_write' }))?.detail
    ).toContain('marcar la entrega');
  });

  it('confirmado por Zoho y sin escritura pendiente no distraen', () => {
    expect(zohoPill(delivery({ status: 'assigned', zohoSyncState: 'readback_ok' }))?.tone).toBe(
      'success'
    );
    expect(zohoPill(delivery({ status: 'planned', zohoSyncState: 'not_required' }))).toBeNull();
    expect(zohoPill(delivery({ zohoSyncState: 'inventado' }))).toBeNull();
  });
});

describe('tablero de despacho', () => {
  it('separa lo que no tiene viaje, lo cargado y lo cerrado', () => {
    const groups = groupDispatchDeliveries([
      delivery({ id: 'a' }),
      delivery({ id: 'b', tripId: 'trip-1' }),
      delivery({
        id: 'c',
        open: false,
        status: 'delivered',
        deliveredAt: '2026-09-15T17:00:00.000Z',
      }),
      delivery({ id: 'd', status: 'conflict', zohoSyncState: 'readback_mismatch' }),
    ]);
    expect(groups.unassigned.map((row) => row.id)).toEqual(['a', 'd']);
    expect(groups.onTrips.map((row) => row.id)).toEqual(['b']);
    expect(groups.closed.map((row) => row.id)).toEqual(['c']);
    expect(groups.zohoAttention.map((row) => row.id)).toEqual(['d']);
  });

  it('ordena primero lo que se queda sin tiempo', () => {
    const groups = groupDispatchDeliveries([
      delivery({ id: 'tarde', windowEnd: '2026-09-15T23:00:00.000Z' }),
      delivery({ id: 'temprano', windowEnd: '2026-09-15T19:00:00.000Z' }),
      delivery({ id: 'sin-fecha', plannedDate: null }),
    ]);
    expect(groups.unassigned.map((row) => row.id)).toEqual(['temprano', 'tarde', 'sin-fecha']);
  });

  it('el avance del viaje cuenta entregadas y fallidas como visitadas', () => {
    const progress = tripProgress([
      { status: 'done' },
      { status: 'failed' },
      { status: 'pending' },
      { status: 'arrived' },
    ]);
    expect(progress).toMatchObject({ total: 4, done: 1, failed: 1, pending: 2, percent: 50 });
    expect(progress.label).toContain('1 de 4');
    expect(tripProgress([]).label).toBe('Sin paradas');
  });

  it('sólo los viajes activos aceptan paradas nuevas', () => {
    const trips = [
      trip({ id: 't1' }),
      trip({ id: 't2', status: 'en_route' }),
      trip({ id: 't3', status: 'done' }),
    ];
    expect(tripsAcceptingStops(trips).map((row) => row.id)).toEqual(['t1', 't2']);
  });

  it('el tono del estado distingue un conflicto de una entrega hecha', () => {
    expect(deliveryStatusTone('conflict')).toBe('danger');
    expect(deliveryStatusTone('delivered')).toBe('success');
    expect(deliveryStatusTone('pending_external')).toBe('warning');
  });
});

describe('mapa', () => {
  it('marca las paradas de cada viaje y las entregas sueltas', () => {
    const points = buildMapPoints(
      [
        delivery({ id: 'do-1', tripId: 'trip-1' }),
        delivery({ id: 'do-2' }),
        delivery({ id: 'do-3', open: false, status: 'delivered' }),
        delivery({ id: 'do-4', coordinates: null }),
      ],
      [trip()]
    );
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ kind: 'stop', sequence: 1, tripId: 'trip-1' });
    expect(points[0].label).toContain('1.');
    expect(points[1]).toMatchObject({ kind: 'loose', deliveryOrderId: 'do-2', tripId: null });
  });

  it('la polilínea de un viaje sigue el orden de las paradas', () => {
    const points = buildMapPoints(
      [delivery({ id: 'do-1', tripId: 'trip-1' }), delivery({ id: 'do-2', tripId: 'trip-1' })],
      [
        trip({
          stops: [
            stop({
              id: 's2',
              sequence: 2,
              deliveryOrderId: 'do-2',
              coordinates: { lat: 21, lng: -103 },
            }),
            stop({
              id: 's1',
              sequence: 1,
              deliveryOrderId: 'do-1',
              coordinates: { lat: 20, lng: -103 },
            }),
          ],
        }),
      ]
    );
    const lines = buildTripLines(points);
    expect(lines).toHaveLength(1);
    expect(lines[0].positions).toEqual([
      [20, -103],
      [21, -103],
    ]);
  });

  it('sin coordenadas el mapa abre en la zona de operación', () => {
    expect(fitMapView([])).toEqual({ center: DEFAULT_MAP_CENTER, zoom: 11 });
    expect(fitMapView([{ lat: 0, lng: 0 }])).toEqual({ center: DEFAULT_MAP_CENTER, zoom: 11 });
  });

  it('con una sola parada acerca el mapa a ella', () => {
    const view = fitMapView([{ lat: 20.67, lng: -103.39 }]);
    expect(view.center).toEqual({ lat: 20.67, lng: -103.39 });
    expect(view.zoom).toBe(14);
  });

  it('el enlace de navegación usa las coordenadas y, si no hay, la dirección', () => {
    expect(navigationUrl({ lat: 20.67, lng: -103.39 })).toContain('destination=20.67,-103.39');
    expect(navigationUrl(null, { line: 'Av. Vallarta 100', city: 'Guadalajara' })).toContain(
      encodeURIComponent('Av. Vallarta 100, Guadalajara')
    );
    expect(navigationUrl(null, {})).toBeNull();
  });
});

describe('horas y ventanas', () => {
  it('describe la ventana de entrega o calla cuando no hay', () => {
    expect(formatWindow('2026-09-15T15:00:00.000Z', '2026-09-15T19:00:00.000Z')).toContain(
      'Ventana'
    );
    expect(formatWindow('2026-09-15T15:00:00.000Z', null)).toContain('Desde');
    expect(formatWindow(null, '2026-09-15T19:00:00.000Z')).toContain('Hasta');
    expect(formatWindow(null, null)).toBeNull();
  });

  it('avisa cuando la hora estimada se pasa de la ventana', () => {
    const eta = formatEta(
      stop({ etaAt: '2026-09-15T20:00:00.000Z' }),
      '2026-09-15T19:00:00.000Z',
      NOW
    );
    expect(eta.tone).toBe('danger');
    expect(eta.label).toContain('fuera de ventana');
  });

  it('una parada atrasada, una en sitio y una entregada se leen distinto', () => {
    expect(formatEta(stop({ etaAt: '2026-09-15T17:00:00.000Z' }), null, NOW).tone).toBe('warning');
    expect(
      formatEta(stop({ status: 'arrived', arrivedAt: '2026-09-15T17:50:00.000Z' }), null, NOW).tone
    ).toBe('info');
    expect(
      formatEta(stop({ status: 'done', departedAt: '2026-09-15T17:55:00.000Z' }), null, NOW).label
    ).toContain('Entregada');
    expect(formatEta(stop({ status: 'failed' }), null, NOW).tone).toBe('danger');
    expect(formatEta(stop({ etaAt: null }), null, NOW).label).toBe('Sin hora estimada');
  });

  it('el día de la operación es el de Ciudad de México, no el UTC', () => {
    expect(operationDay(new Date('2026-09-15T04:00:00.000Z'))).toBe('2026-09-14');
    expect(operationDay(new Date('2026-09-15T18:00:00.000Z'))).toBe('2026-09-15');
  });

  it('una fecha inválida en la URL cae en el día de hoy', () => {
    expect(parseBoardDate('2026-09-15', NOW)).toBe('2026-09-15');
    expect(parseBoardDate('2026-02-30', NOW)).toBe(operationDay(NOW));
    expect(parseBoardDate('ayer', NOW)).toBe(operationDay(NOW));
    expect(parseBoardDate(undefined, NOW)).toBe(operationDay(NOW));
  });

  it('mueve el día del tablero sin salirse del calendario', () => {
    expect(shiftDay('2026-09-15', 1)).toBe('2026-09-16');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('PWA de chofer', () => {
  it('la parada de trabajo es la que ya visitó, y si no, la siguiente pendiente', () => {
    expect(pickDriverStop([])).toBeNull();
    const next = pickDriverStop([
      { status: 'done', sequence: 1 },
      { status: 'pending', sequence: 2 },
      { status: 'pending', sequence: 3 },
    ]);
    expect(next).toMatchObject({ state: 'next' });
    expect(next?.stop.sequence).toBe(2);
    const arrived = pickDriverStop([
      { status: 'pending', sequence: 1 },
      { status: 'arrived', sequence: 2 },
    ]);
    expect(arrived).toMatchObject({ state: 'arrived' });
    expect(arrived?.stop.sequence).toBe(2);
  });

  it('sin cantidades escritas se entrega todo lo que falta', () => {
    const check = checkDeliveredLines(
      [line(), line({ allocationId: 'al-2', pendingQuantity: 4 })],
      []
    );
    expect(check).toMatchObject({ ok: true, short: false });
    if (check.ok)
      expect(check.lines).toEqual([
        { allocationId: 'al-1', deliveredQty: 10 },
        { allocationId: 'al-2', deliveredQty: 4 },
      ]);
  });

  it('marca la entrega como corta cuando falta cantidad', () => {
    const check = checkDeliveredLines([line()], [{ allocationId: 'al-1', value: '6' }]);
    expect(check).toMatchObject({ ok: true, short: true });
  });

  it('nunca deja entregar de más, ni cantidades imposibles', () => {
    expect(checkDeliveredLines([line()], [{ allocationId: 'al-1', value: '11' }])).toMatchObject({
      ok: false,
    });
    expect(checkDeliveredLines([line()], [{ allocationId: 'al-1', value: '-1' }])).toMatchObject({
      ok: false,
    });
    expect(checkDeliveredLines([line()], [{ allocationId: 'al-1', value: 'dos' }])).toMatchObject({
      ok: false,
    });
  });

  it('cero en todas las líneas manda a la incidencia, no a una entrega vacía', () => {
    const check = checkDeliveredLines([line()], [{ allocationId: 'al-1', value: '0' }]);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toContain('No se pudo entregar');
  });

  it('una entrega necesita quién recibió y evidencia física', () => {
    expect(deliveryBlockReason({ receivedBy: '  ', evidenceCount: 2, online: true })).toContain(
      'quién recibió'
    );
    expect(deliveryBlockReason({ receivedBy: 'Rosa', evidenceCount: 0, online: true })).toContain(
      'foto'
    );
    expect(deliveryBlockReason({ receivedBy: 'Rosa', evidenceCount: 0, online: false })).toContain(
      'Sin conexión'
    );
    expect(deliveryBlockReason({ receivedBy: 'Rosa', evidenceCount: 1, online: false })).toBeNull();
  });
});

describe('comandos', () => {
  it('asignar transporte viaja con la orden, su versión y el transportista', () => {
    const input = assignTransportInput(delivery(), {
      carrier: '  Fletes del Bajío ',
      date: '2026-09-16',
      trackingNumber: '  ',
      vehicleId: 'v-1',
      driverId: 'dr-1',
    });
    expect(input.type).toBe('delivery.assign_transport');
    expect(input.aggregate).toEqual({ type: 'delivery_order', id: 'do-1' });
    expect(input.expectedVersion).toBe(3);
    expect(input.payload).toEqual({
      deliveryOrderId: 'do-1',
      carrier: 'Fletes del Bajío',
      date: '2026-09-16',
      trackingNumber: null,
      vehicleId: 'v-1',
      driverId: 'dr-1',
    });
  });

  /**
   * Plan §4: el modo `carrier` (paquetería) viaja sin vehículo ni chofer, y el
   * diálogo sólo ofrece los modos que el motor acepta al asignar transporte.
   */
  it('asignar transporte por paquetería no manda unidad ni chofer', () => {
    expect(shippingModeOptions()).toEqual([
      { value: 'own_fleet', label: 'Flotilla propia' },
      { value: 'carrier', label: 'Paquetería o transportista' },
    ]);
    const input = assignTransportInput(delivery(), {
      carrier: 'Estafeta',
      date: '2026-09-16',
      trackingNumber: 'EST-1',
      vehicleId: 'v-1',
      driverId: 'dr-1',
      mode: 'carrier',
    });
    expect(input.payload).toEqual({
      deliveryOrderId: 'do-1',
      carrier: 'Estafeta',
      date: '2026-09-16',
      trackingNumber: 'EST-1',
      vehicleId: null,
      driverId: null,
      mode: 'carrier',
    });
    // Con flotilla propia sí viajan, y sin modo explícito el payload no lo manda.
    expect(
      assignTransportInput(delivery(), {
        carrier: 'Torton',
        date: '2026-09-16',
        vehicleId: 'v-1',
        driverId: 'dr-1',
        mode: 'own_fleet',
      }).payload
    ).toMatchObject({ mode: 'own_fleet', vehicleId: 'v-1', driverId: 'dr-1' });
    expect(
      assignTransportInput(delivery(), {
        carrier: 'Torton',
        date: '2026-09-16',
        vehicleId: 'v-1',
        driverId: 'dr-1',
      }).payload
    ).not.toHaveProperty('mode');
  });

  it('armar un viaje usa la llave natural del día y la unidad', () => {
    const input = buildTripInput({
      date: '2026-09-16',
      vehicleId: 'v-1',
      driverId: 'dr-1',
      deliveryOrderIds: ['do-1', 'do-1', 'do-2'],
      optimize: true,
      overrideCapacity: false,
    });
    expect(input.aggregate).toEqual({ type: 'trip', id: 'trip:v-1:2026-09-16' });
    expect(input.expectedVersion).toBeUndefined();
    expect(input.payload).toMatchObject({ deliveryOrderIds: ['do-1', 'do-2'], optimize: true });
  });

  it('los comandos del viaje llevan su versión y el id en el agregado', () => {
    expect(startTripInput(trip())).toMatchObject({
      type: 'trip.start',
      aggregate: { type: 'trip', id: 'trip-1' },
      expectedVersion: 2,
      payload: {},
    });
    expect(closeTripInput(trip()).type).toBe('trip.close');
    // Plan §4: cancelar el viaje que no va a salir; el motivo viaja recortado.
    expect(cancelTripInput(trip(), '  Se descompuso la unidad  ')).toMatchObject({
      type: 'trip.cancel',
      aggregate: { type: 'trip', id: 'trip-1' },
      expectedVersion: 2,
      payload: { reason: 'Se descompuso la unidad' },
    });
    expect(addStopInput(trip(), 'do-9').payload).toEqual({
      deliveryOrderId: 'do-9',
      overrideCapacity: false,
    });
    expect(reorderStopsInput(trip(), ['s2', 's1']).payload).toEqual({ stopIds: ['s2', 's1'] });
  });

  it('las coordenadas sólo viajan cuando son reales', () => {
    expect(arriveStopInput(trip(), 'stop-1', { lat: 20.6, lng: -103.3 }).payload).toMatchObject({
      lat: 20.6,
      lng: -103.3,
    });
    expect(arriveStopInput(trip(), 'stop-1', null).payload).toEqual({ stopId: 'stop-1' });
    expect(arriveStopInput(trip(), 'stop-1', { lat: 0, lng: 0 }).payload).toEqual({
      stopId: 'stop-1',
    });
  });

  it('cerrar una parada manda líneas, quién recibió y las evidencias subidas', () => {
    const input = completeStopInput(trip(), 'stop-1', {
      lines: [{ allocationId: 'al-1', deliveredQty: 6 }],
      receivedBy: ' Rosa ',
      evidenceObjectIds: ['obj-1'],
      partialReason: 'Faltó espacio',
    });
    expect(input.type).toBe('trip.complete_stop');
    expect(input.payload).toMatchObject({
      stopId: 'stop-1',
      receivedBy: 'Rosa',
      evidenceObjectIds: ['obj-1'],
      partialReason: 'Faltó espacio',
    });
  });

  it('una entrega sin viaje se registra contra la orden de entrega', () => {
    const input = recordDeliveryInput(delivery(), {
      lines: [{ allocationId: 'al-1', deliveredQty: 10 }],
      receivedBy: 'Rosa',
      evidenceObjectIds: [],
    });
    expect(input.type).toBe('delivery.record');
    expect(input.payload).toMatchObject({ deliveryOrderId: 'do-1' });
  });

  it('la incidencia de una parada exige motivo y la cancelación también', () => {
    expect(failStopInput(trip(), 'stop-1', ' Nadie recibió ', null).payload).toMatchObject({
      reason: 'Nadie recibió',
    });
    expect(cancelDeliveryInput(delivery(), ' Ya no la quiere ').payload).toMatchObject({
      deliveryOrderId: 'do-1',
      reason: 'Ya no la quiere',
    });
  });

  it('la flotilla usa la misma llave natural que el servicio de comandos', () => {
    expect(
      createVehicleInput({ code: 'cam 01', plate: 'abc-123', label: 'Torton' }).aggregate
    ).toEqual({
      type: 'vehicle',
      id: 'vehicle:CAM-01',
    });
    expect(updateVehicleInput('v-1', { active: false }).payload).toEqual({
      vehicleId: 'v-1',
      active: false,
    });
    expect(createDriverInput({ name: 'Luis', userId: 'u-1' }).aggregate).toEqual({
      type: 'driver',
      id: 'driver:u-1',
    });
    expect(createDriverInput({ name: ' Luis ' }).aggregate.id).toBe('driver:Luis');
  });
});
