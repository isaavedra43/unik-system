import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * Logistics tools (plan section 8, entrega 4) through the common executor with
 * the area queries and the logistics commands mocked: registration, readings
 * with bot scope, the guards that stop a bad write before the approval card,
 * and the commands each write actually runs once approved.
 */

const h = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  });
  return {
    prisma: {
      trip: model(),
      tripStop: model(),
      deliveryOrder: model(),
      deliveryEvidence: model(),
      demandAllocation: model(),
      operationalCase: model(),
      vehicle: model(),
      driver: model(),
    } as Record<string, ReturnType<typeof model>>,
    createProposal: vi.fn(),
    getDispatchBoard: vi.fn(),
    getTripDetail: vi.fn(),
    buildTripCommand: vi.fn(),
    addStopCommand: vi.fn(),
    reorderStopsCommand: vi.fn(),
    startTripCommand: vi.fn(),
    recordDeliveryCommand: vi.fn(),
    failStopCommand: vi.fn(),
    involvedAreasOfCase: vi.fn(async () => ['logistica', 'ventas']),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: h.prisma }));
vi.mock('@/modules/ai/ai-admin-config-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/ai/ai-admin-config-service')>()),
  getAiSettings: vi.fn(async () => ({})),
}));
vi.mock('@/modules/extensions/proposals-service', () => ({ createProposal: h.createProposal }));
vi.mock('@/modules/extensions/extension-audit', () => ({
  recordExtensionExecution: vi.fn(async () => undefined),
}));
vi.mock('@/modules/operations/commands', () => ({
  executeCommand: vi.fn(),
  registerCommand: vi.fn(),
  versionedAggregate: vi.fn(() => ({})),
}));
vi.mock('@/modules/operations/register-commands', () => ({}));
vi.mock('@/modules/agents/chat-bridge', () => ({ involvedAreasOfCase: h.involvedAreasOfCase }));
vi.mock('@/modules/areas/logistica/queries', () => ({
  getDispatchBoard: h.getDispatchBoard,
  getTripDetail: h.getTripDetail,
}));
vi.mock('@/modules/logistics/logistics-commands', () => ({
  buildTripCommand: h.buildTripCommand,
  addStopCommand: h.addStopCommand,
  reorderStopsCommand: h.reorderStopsCommand,
  startTripCommand: h.startTripCommand,
  recordDeliveryCommand: h.recordDeliveryCommand,
  failStopCommand: h.failStopCommand,
}));

import { executeTool, getToolDefinition, type ToolExecutionContext } from './registry';
import { LOGISTICS_TOOL_NAMES } from './logistics-tools';

function person(permissions: string[], overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'u-despacho',
    username: 'despacho',
    name: 'Despacho',
    email: null,
    mustChangePassword: false,
    roleKeys: ['staff'],
    permissionKeys: permissions as never,
    isSuperAdmin: false,
    ...overrides,
  };
}

const dispatcher = person(['assistant.use', 'logistics.view', 'logistics.dispatch']);
const viewer = person(['assistant.use', 'logistics.view'], { id: 'u-mira' });
const logisticaBot = person(
  ['chat.use', 'operations.view', 'logistics.view', 'logistics.dispatch'],
  {
    id: 'bot-logistica',
    username: 'ia_logistica',
    roleKeys: ['agent_logistica'],
    isBot: true,
  }
);
const comprasBot = person(['chat.use', 'operations.view', 'logistics.view'], {
  id: 'bot-compras',
  username: 'ia_compras',
  roleKeys: ['agent_compras'],
  isBot: true,
});

const TRIP = {
  id: 'trip1',
  number: 'VJ-000001',
  status: 'planned',
  date: new Date('2026-09-15T00:00:00.000Z'),
};
const ORDER = {
  id: 'do1',
  caseId: 'case_1',
  status: 'planned',
  tripId: null,
  packageId: 'pkg_1',
  allocationIds: ['alloc_1'],
};

const approved = (id: string): ToolExecutionContext => ({
  approvedProposalId: id,
  skipApproval: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of Object.values(h.prisma)) {
    model.findUnique.mockReset().mockResolvedValue(null);
    model.findFirst.mockReset().mockResolvedValue(null);
    model.findMany.mockReset().mockResolvedValue([]);
    model.count.mockReset().mockResolvedValue(0);
  }
  h.involvedAreasOfCase.mockResolvedValue(['logistica', 'ventas']);
  h.prisma.trip.findUnique.mockResolvedValue(TRIP);
  h.prisma.deliveryOrder.findUnique.mockResolvedValue(ORDER);
  h.prisma.vehicle.findUnique.mockResolvedValue(null);
  h.prisma.vehicle.findFirst.mockResolvedValue({
    id: 'veh_1',
    code: 'CAM-01',
    label: 'Camioneta 1',
  });
  h.prisma.driver.findMany.mockResolvedValue([{ id: 'drv_1', name: 'Pedro' }]);
  h.prisma.operationalCase.findUnique.mockResolvedValue({ caseNumber: 'EXP-000001' });
  h.createProposal.mockImplementation(
    async (input: { tool: { effect?: string }; summary: string }) => ({
      id: 'prop-1',
      summary: input.summary,
      effect: input.tool.effect ?? 'read',
      expiresAt: new Date(Date.now() + 3_600_000),
    })
  );
});

describe('registro', () => {
  it('registra las ocho tools con su efecto, categoría y permiso', () => {
    expect(
      LOGISTICS_TOOL_NAMES.map((name) => [
        name,
        getToolDefinition(name)?.effect,
        getToolDefinition(name)?.category,
        getToolDefinition(name)?.requiredPermission,
      ])
    ).toEqual([
      ['getDispatchBoard', 'read', 'operations', 'logistics.view'],
      ['getTripPlan', 'read', 'operations', 'logistics.view'],
      ['buildTrip', 'business_write', 'operations', 'logistics.dispatch'],
      ['addTripStop', 'business_write', 'operations', 'logistics.dispatch'],
      ['reorderTripStops', 'business_write', 'operations', 'logistics.dispatch'],
      ['startTrip', 'business_write', 'operations', 'logistics.dispatch'],
      ['recordDeliveryResult', 'business_write', 'operations', 'logistics.dispatch'],
      ['reportFailedStop', 'business_write', 'operations', 'logistics.dispatch'],
    ]);
  });

  it('la IA de Logística tiene las tres tools de dominio en su allowlist y no pasa de 20 esquemas', async () => {
    const { AGENT_TOOL_ALLOWLIST } = await import('@/modules/agents/tool-allowlist');
    expect(AGENT_TOOL_ALLOWLIST.logistica).toEqual(
      expect.arrayContaining(['getDispatchBoard', 'buildTrip', 'recordDeliveryResult'])
    );
    for (const [key, list] of Object.entries(AGENT_TOOL_ALLOWLIST)) {
      expect(list.length, key).toBeLessThanOrEqual(20);
    }
  });

  it('las ocho quedan habilitadas por omisión y son elegibles por el selector', async () => {
    const [{ DEFAULT_AI_SETTINGS }, { OPERATIONS_TOOL_NAMES }] = await Promise.all([
      import('@/modules/ai/ai-admin-config-service'),
      import('@/modules/ai/tool-selector'),
    ]);
    for (const name of LOGISTICS_TOOL_NAMES) {
      expect(DEFAULT_AI_SETTINGS.enabledTools, name).toContain(name);
      expect(OPERATIONS_TOOL_NAMES, name).toContain(name);
    }
  });
});

describe('lecturas', () => {
  it('resume el tablero del día con contadores, entregas abiertas, viajes y flotilla', async () => {
    h.getDispatchBoard.mockResolvedValue({
      date: '2026-09-15',
      generatedAt: '2026-09-15T15:00:00.000Z',
      counters: {
        unassigned: 1,
        onTrips: 1,
        inTransit: 0,
        zohoPending: 1,
        failed: 0,
        tripsActive: 1,
      },
      deliveries: [
        {
          id: 'do1',
          open: true,
          statusLabel: 'Esperando a Zoho',
          modeLabel: 'Flotilla propia',
          caseNumber: 'EXP-000001',
          salesOrderNumber: 'SO-00001',
          customerName: 'Constructora Uno',
          address: { line: 'Av. Reforma 100', city: 'CDMX', state: 'CDMX', postalCode: '06600' },
          plannedDate: '2026-09-15',
          pendingUnits: 10,
          carrier: 'Flotilla propia',
          tripNumber: 'VJ-000001',
          packageId: null,
          zohoSyncState: 'pending_write',
          zohoDifferences: [{ label: 'Transportista', expected: 'Flotilla propia', actual: 'DHL' }],
          evidenceCount: 0,
        },
        {
          id: 'do2',
          open: false,
          statusLabel: 'Entregada',
          modeLabel: 'Flotilla propia',
          address: {},
          zohoDifferences: [],
        },
      ],
      trips: [
        {
          id: 'trip1',
          number: 'VJ-000001',
          date: '2026-09-15',
          statusLabel: 'Planeado',
          vehicle: { id: 'veh_1', code: 'CAM-01', label: 'Camioneta 1', plate: 'ABC123' },
          driver: { id: 'drv_1', name: 'Pedro', phone: null },
          stops: [
            {
              id: 'st1',
              sequence: 1,
              statusLabel: 'Pendiente',
              deliveryOrderId: 'do1',
              etaAt: null,
            },
          ],
        },
      ],
      vehicles: [
        {
          id: 'veh_1',
          code: 'CAM-01',
          label: 'Camioneta 1',
          available: false,
          reasons: ['En mantenimiento'],
          capacityKg: 1000,
          capacityPieces: 100,
        },
      ],
      drivers: [{ id: 'drv_1', name: 'Pedro', available: true, reasons: [] }],
      permissions: {},
    });
    const result = await executeTool('getDispatchBoard', dispatcher, { date: '2026-09-15' });
    expect(result).toMatchObject({
      success: true,
      result: {
        date: '2026-09-15',
        counters: { unassigned: 1, zohoPending: 1 },
        openTotal: 1,
        deliveries: [
          {
            deliveryOrderId: 'do1',
            status: 'Esperando a Zoho',
            customer: 'Constructora Uno',
            packageMissing: true,
            zohoDifferences: ['Transportista: UNIK Flotilla propia / Zoho DHL'],
          },
        ],
        trips: [{ number: 'VJ-000001', vehicle: 'CAM-01 · Camioneta 1', driver: 'Pedro' }],
        fleet: { vehicles: [{ code: 'CAM-01', available: false, reasons: ['En mantenimiento'] }] },
      },
    });
    expect(h.getDispatchBoard).toHaveBeenCalledWith(dispatcher, { date: '2026-09-15' });
  });

  it('la IA de otra área no lee el tablero de Logística', async () => {
    const result = await executeTool('getDispatchBoard', comprasBot, {});
    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/sólo consulta el trabajo de Compras/),
    });
    expect(h.getDispatchBoard).not.toHaveBeenCalled();
  });

  it('acepta el folio VJ- y devuelve las paradas con la entrega de cada una', async () => {
    h.prisma.trip.findUnique.mockResolvedValue(TRIP);
    h.getTripDetail.mockResolvedValue({
      trip: {
        id: 'trip1',
        number: 'VJ-000001',
        date: '2026-09-15',
        statusLabel: 'En ruta',
        startedAt: '2026-09-15T14:00:00.000Z',
        endedAt: null,
        vehicle: { id: 'veh_1', code: 'CAM-01', label: 'Camioneta 1', plate: 'ABC123' },
        driver: { id: 'drv_1', name: 'Pedro', phone: null },
        stops: [
          {
            id: 'st1',
            sequence: 1,
            statusLabel: 'Pendiente',
            etaAt: null,
            arrivedAt: null,
            deliveryOrderId: 'do1',
          },
        ],
      },
      deliveries: [
        {
          id: 'do1',
          caseNumber: 'EXP-000001',
          customerName: 'Constructora Uno',
          statusLabel: 'Planeada',
          pendingUnits: 10,
          address: { line: 'Av. Reforma 100', city: 'CDMX', state: 'CDMX' },
        },
      ],
      evidence: { do1: [{ id: 'ev1' }] },
      permissions: {},
      isDriver: false,
      generatedAt: '2026-09-15T15:00:00.000Z',
    });
    const result = await executeTool('getTripPlan', viewer, { trip: 'vj-1' });
    expect(h.prisma.trip.findUnique).toHaveBeenCalledWith({ where: { number: 'VJ-000001' } });
    expect(result).toMatchObject({
      success: true,
      result: {
        number: 'VJ-000001',
        status: 'En ruta',
        stops: [
          {
            stopId: 'st1',
            caseNumber: 'EXP-000001',
            address: 'Av. Reforma 100, CDMX, CDMX',
            pendingUnits: 10,
            evidenceCount: 1,
          },
        ],
      },
    });
  });
});

describe('buildTrip', () => {
  it('rechaza antes de la tarjeta una entrega que ya va en un viaje', async () => {
    h.prisma.deliveryOrder.findMany.mockResolvedValue([
      { id: 'do1', caseId: 'case_1', status: 'planned', tripId: 'trip9' },
    ]);
    const result = await executeTool('buildTrip', dispatcher, {
      vehicle: 'CAM-01',
      driver: 'Pedro',
      deliveryOrderIds: ['do1'],
      date: '2026-09-15',
    });
    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/ya están en un viaje/),
    });
    expect(h.createProposal).not.toHaveBeenCalled();
    expect(h.buildTripCommand).not.toHaveBeenCalled();
  });

  it('rechaza una entrega en un estado que no admite viaje', async () => {
    h.prisma.deliveryOrder.findMany.mockResolvedValue([
      { id: 'do1', caseId: 'case_1', status: 'delivered', tripId: null },
    ]);
    const result = await executeTool('buildTrip', dispatcher, {
      vehicle: 'CAM-01',
      driver: 'Pedro',
      deliveryOrderIds: ['do1'],
    });
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/Entregada/) });
    expect(h.buildTripCommand).not.toHaveBeenCalled();
  });

  it('propone la tarjeta con el vehículo y el chofer resueltos, y arma el viaje al aprobarla', async () => {
    h.prisma.deliveryOrder.findMany.mockResolvedValue([
      { id: 'do1', caseId: 'case_1', status: 'planned', tripId: null },
      { id: 'do2', caseId: 'case_1', status: 'assigned', tripId: null },
    ]);
    const card = await executeTool('buildTrip', dispatcher, {
      vehicle: 'cam-01',
      driver: 'Pedro',
      deliveryOrderIds: ['do1', 'do2'],
      date: '2026-09-15',
    });
    expect(card).toMatchObject({ success: false, needsApproval: true });
    expect(h.createProposal.mock.calls[0][0].summary).toBe(
      'Armar viaje del 2026-09-15 con CAM-01 · Camioneta 1, Pedro y 2 entrega(s)'
    );

    h.prisma.vehicle.findUnique.mockResolvedValue({
      id: 'veh_1',
      code: 'CAM-01',
      label: 'Camioneta 1',
    });
    h.prisma.driver.findUnique.mockResolvedValue({ id: 'drv_1', name: 'Pedro' });
    h.buildTripCommand.mockResolvedValue({
      status: 'completed',
      data: {
        tripId: 'trip2',
        number: 'VJ-000002',
        date: '2026-09-15',
        stops: [{ stopId: 'st1', deliveryOrderId: 'do1', sequence: 1, etaAt: null }],
        load: { kg: 100, m2: 10, pieces: 4 },
      },
    });
    const done = await executeTool(
      'buildTrip',
      dispatcher,
      {
        vehicle: 'veh_1',
        driver: 'drv_1',
        deliveryOrderIds: ['do1', 'do2'],
        date: '2026-09-15',
        optimize: true,
      },
      approved('prop-1')
    );
    expect(done).toMatchObject({ success: true, result: { tripId: 'trip2', number: 'VJ-000002' } });
    expect(h.buildTripCommand).toHaveBeenCalledWith(
      dispatcher,
      {
        date: '2026-09-15',
        vehicleId: 'veh_1',
        driverId: 'drv_1',
        deliveryOrderIds: ['do1', 'do2'],
        optimize: true,
      },
      { commandId: 'proposal:prop-1:buildTrip', actorType: 'user' }
    );
  });

  it('una IA de Logística arma el viaje como actor `ai`; una de Compras no puede', async () => {
    h.prisma.deliveryOrder.findMany.mockResolvedValue([
      { id: 'do1', caseId: 'case_1', status: 'planned', tripId: null },
    ]);
    const foreign = await executeTool('buildTrip', comprasBot, {
      vehicle: 'CAM-01',
      driver: 'Pedro',
      deliveryOrderIds: ['do1'],
    });
    expect(foreign).toMatchObject({ success: false });
    expect(h.buildTripCommand).not.toHaveBeenCalled();

    h.prisma.vehicle.findUnique.mockResolvedValue({
      id: 'veh_1',
      code: 'CAM-01',
      label: 'Camioneta 1',
    });
    h.prisma.driver.findUnique.mockResolvedValue({ id: 'drv_1', name: 'Pedro' });
    h.buildTripCommand.mockResolvedValue({
      status: 'completed',
      data: { tripId: 'trip3', number: 'VJ-000003', stops: [], load: null },
    });
    await executeTool(
      'buildTrip',
      logisticaBot,
      { vehicle: 'veh_1', driver: 'drv_1', deliveryOrderIds: ['do1'], date: '2026-09-15' },
      { ...approved('prop-2'), agentAreaKey: 'logistica' }
    );
    expect(h.buildTripCommand).toHaveBeenCalledWith(
      logisticaBot,
      expect.objectContaining({ vehicleId: 'veh_1' }),
      { commandId: 'proposal:prop-2:buildTrip', actorType: 'ai' }
    );
  });
});

describe('paradas del viaje', () => {
  it('no agrega una parada de una entrega que ya va en otro viaje', async () => {
    h.prisma.deliveryOrder.findUnique.mockResolvedValue({ ...ORDER, tripId: 'trip9' });
    const result = await executeTool('addTripStop', dispatcher, {
      trip: 'VJ-000001',
      deliveryOrderId: 'do1',
    });
    expect(result).toMatchObject({ success: false, error: 'Esa entrega ya está en un viaje' });
    expect(h.addStopCommand).not.toHaveBeenCalled();
  });

  it('agrega la parada al aprobarla', async () => {
    h.addStopCommand.mockResolvedValue({
      status: 'completed',
      data: { tripId: 'trip1', stopId: 'st2', sequence: 2 },
    });
    const card = await executeTool('addTripStop', dispatcher, {
      trip: 'VJ-000001',
      deliveryOrderId: 'do1',
    });
    expect(card).toMatchObject({ success: false, needsApproval: true });
    expect(h.createProposal.mock.calls[0][0].summary).toBe(
      'Agregar la entrega do1 al viaje VJ-000001'
    );
    const done = await executeTool(
      'addTripStop',
      dispatcher,
      { trip: 'trip1', deliveryOrderId: 'do1' },
      approved('prop-3')
    );
    expect(done).toMatchObject({
      success: true,
      result: { tripNumber: 'VJ-000001', stopId: 'st2', sequence: 2 },
    });
    expect(h.addStopCommand).toHaveBeenCalledWith(
      dispatcher,
      { tripId: 'trip1', deliveryOrderId: 'do1' },
      { commandId: 'proposal:prop-3:addTripStop', actorType: 'user' }
    );
  });

  it('exige que el nuevo orden traiga todas las paradas del viaje y sólo las suyas', async () => {
    h.prisma.tripStop.findMany.mockResolvedValue([
      { id: 'st1', deliveryOrderId: 'do1' },
      { id: 'st2', deliveryOrderId: 'do2' },
    ]);
    expect(
      await executeTool('reorderTripStops', dispatcher, { trip: 'trip1', stopIds: ['st2'] })
    ).toMatchObject({
      success: false,
      error: expect.stringMatching(/tiene 2 paradas/),
    });
    expect(
      await executeTool('reorderTripStops', dispatcher, { trip: 'trip1', stopIds: ['st2', 'st9'] })
    ).toMatchObject({
      success: false,
      error: expect.stringMatching(/no son del viaje: st9/),
    });
    expect(
      await executeTool('reorderTripStops', dispatcher, { trip: 'trip1', stopIds: ['st1', 'st1'] })
    ).toMatchObject({
      success: false,
      error: 'Hay paradas repetidas en la lista',
    });
    expect(h.reorderStopsCommand).not.toHaveBeenCalled();
  });

  it('reordena las paradas al aprobarlo', async () => {
    h.prisma.tripStop.findMany.mockResolvedValue([
      { id: 'st1', deliveryOrderId: 'do1' },
      { id: 'st2', deliveryOrderId: 'do2' },
    ]);
    h.prisma.deliveryOrder.findMany.mockResolvedValue([
      { id: 'do1', caseId: 'case_1' },
      { id: 'do2', caseId: 'case_1' },
    ]);
    const card = await executeTool('reorderTripStops', dispatcher, {
      trip: 'trip1',
      stopIds: ['st2', 'st1'],
    });
    expect(card).toMatchObject({ success: false, needsApproval: true });
    expect(h.createProposal.mock.calls[0][0].summary).toBe(
      'Reordenar las 2 paradas del viaje VJ-000001'
    );
    h.reorderStopsCommand.mockResolvedValue({
      status: 'completed',
      data: { tripId: 'trip1', stopIds: ['st2', 'st1'] },
    });
    const done = await executeTool(
      'reorderTripStops',
      dispatcher,
      { trip: 'trip1', stopIds: ['st2', 'st1'] },
      approved('prop-4')
    );
    expect(done).toMatchObject({
      success: true,
      result: { tripNumber: 'VJ-000001', stopIds: ['st2', 'st1'] },
    });
  });
});

describe('startTrip', () => {
  it('no pone en ruta un viaje cuyas entregas todavía no tienen paquete de Zoho', async () => {
    h.prisma.tripStop.findMany.mockResolvedValue([{ deliveryOrderId: 'do1' }]);
    h.prisma.deliveryOrder.findMany.mockResolvedValue([
      { id: 'do1', caseId: 'case_1', packageId: null },
    ]);
    const result = await executeTool('startTrip', dispatcher, { trip: 'VJ-000001' });
    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/no tienen paquete en Zoho: do1/),
    });
    expect(h.startTripCommand).not.toHaveBeenCalled();
  });

  it('no pone en ruta un viaje sin paradas ni uno que ya salió', async () => {
    h.prisma.tripStop.findMany.mockResolvedValue([]);
    expect(await executeTool('startTrip', dispatcher, { trip: 'trip1' })).toMatchObject({
      success: false,
      error: 'El viaje VJ-000001 no tiene paradas',
    });
    h.prisma.trip.findUnique.mockResolvedValue({ ...TRIP, status: 'en_route' });
    expect(await executeTool('startTrip', dispatcher, { trip: 'trip1' })).toMatchObject({
      success: false,
      error: expect.stringMatching(/ya no está planeado/),
    });
    expect(h.startTripCommand).not.toHaveBeenCalled();
  });

  it('pone el viaje en ruta al aprobarlo', async () => {
    h.prisma.tripStop.findMany.mockResolvedValue([{ deliveryOrderId: 'do1' }]);
    h.prisma.deliveryOrder.findMany.mockResolvedValue([
      { id: 'do1', caseId: 'case_1', packageId: 'pkg_1' },
    ]);
    const card = await executeTool('startTrip', dispatcher, { trip: 'trip1' });
    expect(card).toMatchObject({ success: false, needsApproval: true });
    expect(h.createProposal.mock.calls[0][0].summary).toBe('Poner en ruta el viaje VJ-000001');
    h.startTripCommand.mockResolvedValue({
      status: 'completed',
      data: { tripId: 'trip1', status: 'en_route' },
    });
    const done = await executeTool('startTrip', dispatcher, { trip: 'trip1' }, approved('prop-5'));
    expect(done).toMatchObject({
      success: true,
      result: { tripNumber: 'VJ-000001', status: 'en_route' },
    });
    expect(h.startTripCommand).toHaveBeenCalledWith(
      dispatcher,
      { tripId: 'trip1' },
      { commandId: 'proposal:prop-5:startTrip', actorType: 'user' }
    );
  });
});

describe('recordDeliveryResult', () => {
  beforeEach(() => {
    h.prisma.deliveryEvidence.findMany.mockResolvedValue([{ id: 'ev1' }]);
    h.prisma.demandAllocation.findMany.mockResolvedValue([{ id: 'alloc_1', quantity: 10 }]);
  });

  it('se niega sin evidencia física ya subida', async () => {
    h.prisma.deliveryEvidence.findMany.mockResolvedValue([]);
    const result = await executeTool('recordDeliveryResult', dispatcher, {
      deliveryOrderId: 'do1',
      receivedBy: 'Juan',
      lines: [{ allocationId: 'alloc_1', deliveredQty: 10 }],
    });
    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/Falta la evidencia de entrega/),
    });
    expect(h.recordDeliveryCommand).not.toHaveBeenCalled();
  });

  it('exige el motivo cuando se entrega de menos y rechaza asignaciones ajenas', async () => {
    expect(
      await executeTool('recordDeliveryResult', dispatcher, {
        deliveryOrderId: 'do1',
        receivedBy: 'Juan',
        lines: [{ allocationId: 'alloc_1', deliveredQty: 6 }],
      })
    ).toMatchObject({ success: false, error: expect.stringMatching(/partialReason/) });
    expect(
      await executeTool('recordDeliveryResult', dispatcher, {
        deliveryOrderId: 'do1',
        receivedBy: 'Juan',
        lines: [{ allocationId: 'alloc_9', deliveredQty: 1 }],
      })
    ).toMatchObject({
      success: false,
      error: expect.stringMatching(/no son de la entrega: alloc_9/),
    });
    expect(h.recordDeliveryCommand).not.toHaveBeenCalled();
  });

  it('no registra sobre una entrega ya cerrada', async () => {
    h.prisma.deliveryOrder.findUnique.mockResolvedValue({ ...ORDER, status: 'delivered' });
    expect(
      await executeTool('recordDeliveryResult', dispatcher, {
        deliveryOrderId: 'do1',
        receivedBy: 'Juan',
        lines: [{ allocationId: 'alloc_1', deliveredQty: 10 }],
      })
    ).toMatchObject({ success: false, error: 'La entrega ya está Entregada' });
  });

  it('propone la tarjeta y registra la entrega parcial al aprobarla', async () => {
    const card = await executeTool('recordDeliveryResult', dispatcher, {
      deliveryOrderId: 'do1',
      receivedBy: 'Juan Pérez',
      lines: [{ allocationId: 'alloc_1', deliveredQty: 6 }],
      partialReason: 'No cupo en la camioneta',
    });
    expect(card).toMatchObject({ success: false, needsApproval: true });
    expect(h.createProposal.mock.calls[0][0].summary).toBe(
      'Registrar entrega de 6 unidad(es) recibidas por Juan Pérez en EXP-000001 (esperado alloc_1: 10)'
    );
    h.recordDeliveryCommand.mockResolvedValue({
      status: 'completed',
      data: {
        deliveryOrderId: 'do1',
        status: 'partially_delivered',
        complete: false,
        childDeliveryOrderId: 'do3',
        totalDelivered: 6,
        totalShort: 4,
        incidentId: 'inc1',
      },
    });
    const done = await executeTool(
      'recordDeliveryResult',
      dispatcher,
      {
        deliveryOrderId: 'do1',
        receivedBy: 'Juan Pérez',
        lines: [{ allocationId: 'alloc_1', deliveredQty: 6 }],
        partialReason: 'No cupo en la camioneta',
        evidenceObjectIds: ['obj1'],
      },
      approved('prop-6')
    );
    expect(done).toMatchObject({
      success: true,
      result: {
        status: 'Entregada parcialmente',
        childDeliveryOrderId: 'do3',
        totalShort: 4,
        note: expect.stringMatching(/Decidir remanente/),
      },
    });
    expect(h.recordDeliveryCommand).toHaveBeenCalledWith(
      dispatcher,
      {
        deliveryOrderId: 'do1',
        lines: [{ allocationId: 'alloc_1', deliveredQty: 6 }],
        receivedBy: 'Juan Pérez',
        evidenceObjectIds: ['obj1'],
        partialReason: 'No cupo en la camioneta',
      },
      { commandId: 'proposal:prop-6:recordDeliveryResult', actorType: 'user' }
    );
  });
});

describe('reportFailedStop', () => {
  it('rechaza una parada de otro viaje o ya cerrada', async () => {
    h.prisma.tripStop.findUnique.mockResolvedValue({
      id: 'st1',
      tripId: 'trip9',
      status: 'pending',
      deliveryOrderId: 'do1',
    });
    expect(
      await executeTool('reportFailedStop', dispatcher, {
        trip: 'trip1',
        stopId: 'st1',
        reason: 'Cerrado',
      })
    ).toMatchObject({
      success: false,
      error: 'La parada st1 no es del viaje VJ-000001',
    });
    h.prisma.tripStop.findUnique.mockResolvedValue({
      id: 'st1',
      tripId: 'trip1',
      status: 'done',
      deliveryOrderId: 'do1',
    });
    expect(
      await executeTool('reportFailedStop', dispatcher, {
        trip: 'trip1',
        stopId: 'st1',
        reason: 'Cerrado',
      })
    ).toMatchObject({
      success: false,
      error: 'La parada ya está entregada',
    });
    expect(h.failStopCommand).not.toHaveBeenCalled();
  });

  it('marca la parada como fallida al aprobarlo', async () => {
    h.prisma.tripStop.findUnique.mockResolvedValue({
      id: 'st1',
      tripId: 'trip1',
      status: 'arrived',
      deliveryOrderId: 'do1',
    });
    const card = await executeTool('reportFailedStop', dispatcher, {
      trip: 'VJ-000001',
      stopId: 'st1',
      reason: 'Nadie recibió',
    });
    expect(card).toMatchObject({ success: false, needsApproval: true });
    expect(h.createProposal.mock.calls[0][0].summary).toBe(
      'Marcar como no entregada la parada st1 del viaje VJ-000001: Nadie recibió'
    );
    h.failStopCommand.mockResolvedValue({
      status: 'completed',
      data: {
        tripId: 'trip1',
        stopId: 'st1',
        deliveryOrderId: 'do1',
        workItemId: 'wi1',
        areaRequestId: 'ar1',
      },
    });
    const done = await executeTool(
      'reportFailedStop',
      dispatcher,
      { trip: 'trip1', stopId: 'st1', reason: 'Nadie recibió' },
      approved('prop-7')
    );
    expect(done).toMatchObject({
      success: true,
      result: { tripNumber: 'VJ-000001', workItemId: 'wi1' },
    });
    expect(h.failStopCommand).toHaveBeenCalledWith(
      dispatcher,
      { tripId: 'trip1', stopId: 'st1', reason: 'Nadie recibió' },
      { commandId: 'proposal:prop-7:reportFailedStop', actorType: 'user' }
    );
  });
});
