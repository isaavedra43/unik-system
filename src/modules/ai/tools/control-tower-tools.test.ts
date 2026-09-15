import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * Control Tower tools: the pure delay simulation over dependsOn/slaMinutes, the
 * pulse, stuck cases and blockers builders, and the operations.admin gate.
 */

const h = vi.hoisted(() => {
  const model = () => ({ findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() });
  return {
    prisma: {
      operationalCase: model(),
      operationalEvent: model(),
      workItem: model(),
      areaRequest: model(),
      incident: model(),
      approvalRequest: model(),
      caseStep: model(),
      user: model(),
    } as Record<string, ReturnType<typeof model>>,
    getAreaAiUsage: vi.fn(),
    loadProcessBlueprint: vi.fn(),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: h.prisma }));
vi.mock('@/modules/ai/ai-admin-config-service', () => ({ getAiSettings: vi.fn(async () => ({})) }));
vi.mock('@/modules/extensions/proposals-service', () => ({ createProposal: vi.fn() }));
vi.mock('@/modules/operations/commands', () => ({ executeCommand: vi.fn(), registerCommand: vi.fn(), versionedAggregate: vi.fn(() => ({})) }));
vi.mock('@/modules/agents/budget', () => ({ getAreaAiUsage: h.getAreaAiUsage }));
vi.mock('@/modules/operations/process-blueprints/registry', () => ({ loadProcessBlueprint: h.loadProcessBlueprint }));

import { executeTool, getToolDefinition } from './registry';
import {
  blueprintSimulationSteps,
  buildCompanyPulse,
  classifyStuckCase,
  isAdministratorBot,
  projectStepFinishes,
  rankBlockers,
  simulateStepDelay,
  type SimulationStep,
} from './control-tower-tools';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function person(permissions: string[], overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'u-dir',
    username: 'dir',
    name: 'Dirección',
    email: null,
    mustChangePassword: false,
    roleKeys: ['direccion'],
    permissionKeys: permissions as never,
    isSuperAdmin: false,
    ...overrides,
  };
}

const admin = person(['operations.view', 'operations.admin']);

function step(ref: string, overrides: Partial<SimulationStep> = {}): SimulationStep {
  return {
    ref,
    stepKey: ref.split(':')[0],
    scopeKey: ref.split(':')[1] ?? '',
    label: ref,
    areaKey: 'inventario',
    dependsOn: [],
    slaMinutes: 60,
    status: 'pending',
    dueAt: null,
    completedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of Object.values(h.prisma)) {
    model.findUnique.mockReset().mockResolvedValue(null);
    model.findFirst.mockReset().mockResolvedValue(null);
    model.findMany.mockReset().mockResolvedValue([]);
    model.count.mockReset().mockResolvedValue(0);
    model.groupBy.mockReset().mockResolvedValue([]);
  }
});

await import('./control-tower-tools');

describe('simulateStepDelay (pure over dependsOn / slaMinutes)', () => {
  const now = new Date('2026-09-15T16:00:00.000Z');

  it('pushes the delayed step and its successors, not the parallel branches', () => {
    const steps = [
      step('verificar:d1', { status: 'done', completedAt: new Date('2026-09-15T10:00:00.000Z') }),
      step('comprar:a1', { status: 'active', dueAt: new Date('2026-09-15T18:00:00.000Z'), dependsOn: ['verificar:d1'], areaKey: 'compras' }),
      step('recibir:a1', { dependsOn: ['comprar:a1'], slaMinutes: 120, areaKey: 'compras' }),
      step('reservar:a2', { dependsOn: ['verificar:d1'], slaMinutes: 15 }),
      step('entregar:', { dependsOn: ['recibir:a1', 'reservar:a2'], slaMinutes: 60, areaKey: 'logistica' }),
    ];
    const result = simulateStepDelay(steps, { stepKey: 'comprar', delayMinutes: 90, now, promisedAt: new Date('2026-09-15T22:30:00.000Z') });
    expect(result.affected.map((a) => a.ref)).toEqual(['comprar:a1', 'recibir:a1', 'entregar:']);
    expect(result.affected.every((a) => a.shiftMinutes === 90)).toBe(true);
    expect(result.baselineFinish).toBe('2026-09-15T21:00:00.000Z');
    expect(result.delayedFinish).toBe('2026-09-15T22:30:00.000Z');
    expect(result.shiftMinutes).toBe(90);
    expect(result).toMatchObject({ lateBefore: false, lateAfter: false, unaffectedOpenSteps: 1 });

    const later = simulateStepDelay(steps, { stepKey: 'comprar', delayMinutes: 120, now, promisedAt: new Date('2026-09-15T22:30:00.000Z') });
    expect(later.lateAfter).toBe(true);
  });

  it('a delay shorter than the slack of a parallel branch does not move the finish', () => {
    const steps = [
      step('a:', { status: 'active', dueAt: new Date('2026-09-15T17:00:00.000Z') }),
      step('b:', { status: 'active', dueAt: new Date('2026-09-15T20:00:00.000Z') }),
      step('fin:', { dependsOn: ['a:', 'b:'], slaMinutes: 30 }),
    ];
    const result = simulateStepDelay(steps, { stepKey: 'a', delayMinutes: 60, now });
    expect(result.affected.map((a) => a.ref)).toEqual(['a:']);
    expect(result.shiftMinutes).toBe(0);
  });

  it('refuses unknown or finished steps', () => {
    const steps = [step('hecho:', { status: 'done', completedAt: now })];
    expect(() => simulateStepDelay(steps, { stepKey: 'hecho', delayMinutes: 30, now })).toThrow(/ya terminó/);
    expect(() => simulateStepDelay(steps, { stepKey: 'otro', delayMinutes: 30, now })).toThrow(/No existe el paso otro/);
  });

  it('projects open steps never before now and survives dependency cycles', () => {
    const projection = projectStepFinishes(
      [
        step('vencido:', { status: 'active', dueAt: new Date('2026-09-15T12:00:00.000Z') }),
        step('x:', { dependsOn: ['y:'] }),
        step('y:', { dependsOn: ['x:'] }),
      ],
      { start: new Date('2026-09-15T08:00:00.000Z'), now }
    );
    expect(projection.get('vencido:')).toBe(now.getTime());
    expect(projection.get('x:')).toBeGreaterThan(now.getTime());
  });

  it('simulates on the process template when there is no case', () => {
    const template = blueprintSimulationSteps();
    expect(template.length).toBeGreaterThan(10);
    const result = simulateStepDelay(template, { stepKey: 'verificar_disponibilidad', delayMinutes: 60, now, start: now });
    expect(result.affected.map((a) => a.stepKey)).toContain('plan_abastecimiento');
    expect(result.shiftMinutes).toBe(60);
  });
});

describe('builders', () => {
  const now = new Date('2026-09-15T16:00:00.000Z');

  it('buildCompanyPulse summarizes cases, delays by area, incidents and AI use', () => {
    const pulse = buildCompanyPulse({
      now,
      casesByStatus: [
        { status: 'open', count: 12 },
        { status: 'blocked', count: 3 },
      ],
      casesByPhase: [{ phase: 'sourcing', count: 15 }],
      openedToday: 4,
      deliveredToday: 2,
      stuck24h: 1,
      workOpenByArea: [{ areaKey: 'compras', count: 7 }],
      workOverdueByArea: [{ areaKey: 'compras', count: 2 }],
      requestsOpenByArea: [{ areaKey: 'inventario', count: 5 }],
      requestsOverdueByArea: [{ areaKey: 'inventario', count: 1 }],
      blockingRequests: 3,
      incidentsBySeverity: [
        { severity: 'critical', count: 1 },
        { severity: 'low', count: 2 },
      ],
      pendingApprovals: 6,
      aiByArea: [{ areaKey: 'compras', tokens: 1200, usd: 0 }],
    });
    expect(pulse.cases).toMatchObject({ open: 15, openedToday: 4, deliveredToday: 2, stuck24h: 1 });
    expect(pulse.areas.find((a) => a.areaKey === 'compras')).toMatchObject({ openWorkItems: 7, overdueWorkItems: 2, aiTokensToday: 1200 });
    expect(pulse.incidents).toMatchObject({ open: 3 });
    expect(pulse.headline[1]).toContain('Compras (2 trabajos y 0 solicitudes vencidas)');
    expect(pulse.headline.join(' ')).toContain('IA hoy');
  });

  it('classifyStuckCase suggests what to do', () => {
    const base = {
      id: 'c1',
      caseNumber: 'EXP-7',
      salesOrderNumber: 'OV-1',
      customerName: 'Sol',
      status: 'open',
      phase: 'sourcing',
      ownerName: 'Vendedor',
      lastActivityAt: new Date(now.getTime() - 30 * HOUR),
      promisedAt: new Date(now.getTime() + 2 * HOUR),
      openWorkItems: [],
      openRequests: [],
    };
    expect(classifyStuckCase({ ...base, orphan: true }, now)).toMatchObject({ idleHours: 30, orphan: true, promiseAtRisk: true, suggestion: expect.stringContaining('Sin trabajo pendiente') });
    expect(
      classifyStuckCase({ ...base, orphan: false, openRequests: [{ toAreaKey: 'compras', blocksDelivery: true, status: 'acknowledged', dueAt: now }] }, now).suggestion
    ).toContain('Esperando a Compras');
    expect(
      classifyStuckCase({ ...base, orphan: false, openWorkItems: [{ ownerName: 'Luis', dueAt: new Date(now.getTime() - HOUR), areaKey: 'inventario' }] }, now).suggestion
    ).toContain('Trabajo vencido de Luis');
  });

  it('rankBlockers orders people by their oldest delay', () => {
    const blockers = rankBlockers({
      now,
      names: new Map([
        ['u-luis', 'Luis'],
        ['u-ana', 'Ana'],
      ]),
      caseNumbers: new Map([['c1', 'EXP-7']]),
      items: [
        { id: 'w1', caseId: 'c1', areaKey: 'inventario', ownerUserId: 'u-luis', title: 'Contar', dueAt: new Date(now.getTime() - 2 * HOUR), escalationLevel: 0 },
        { id: 'w2', caseId: null, areaKey: 'compras', ownerUserId: 'u-ana', title: 'Cotizar', dueAt: new Date(now.getTime() - 5 * HOUR), escalationLevel: 1 },
      ],
      requests: [{ id: 'r1', caseId: 'c1', toAreaKey: 'inventario', ownerUserId: 'u-luis', title: 'Verificar', dueAt: new Date(now.getTime() + HOUR), status: 'blocked', blocksDelivery: true }],
    });
    expect(blockers.map((b) => b.name)).toEqual(['Ana', 'Luis']);
    expect(blockers[1]).toMatchObject({ overdueWorkItems: 1, blockingRequests: 1, cases: ['EXP-7'], oldestOverdueHours: 2 });
  });
});

describe('tools (operations.admin)', () => {
  it('people need operations.admin; the administrator bot reads them and area bots do not', async () => {
    const adminBot = person(['chat.use', 'operations.view', 'operations.manage'], { id: 'bot-admin', roleKeys: ['agent_admin'], isBot: true });
    const areaBot = person(['chat.use', 'operations.view'], { id: 'bot-compras', roleKeys: ['agent_compras'], isBot: true });
    for (const name of ['getCompanyPulse', 'findStuckCases', 'whoIsBlocking', 'simulateDelay']) {
      expect(getToolDefinition(name)).toMatchObject({ requiredPermission: 'operations.admin', effect: 'read', category: 'operations' });
      const args = name === 'simulateDelay' ? { stepKey: 'entregar', delayMinutes: 30 } : {};
      expect((await executeTool(name, person(['operations.view']), args)).errorCode).toBe('forbidden');
      expect((await executeTool(name, areaBot, args)).errorCode).toBe('forbidden');
    }
    expect(isAdministratorBot(adminBot)).toBe(true);
    expect(isAdministratorBot(areaBot)).toBe(false);
    // Without operations.view even the admin role is refused (fixed permissions of the bot).
    expect(isAdministratorBot(person([], { roleKeys: ['agent_admin'], isBot: true }))).toBe(false);
    // A person given the agent_admin role is not the administrator bot and gets nothing extra.
    const disguised = person(['operations.view', 'operations.manage'], { id: 'u-x', roleKeys: ['agent_admin'] });
    expect(isAdministratorBot(disguised)).toBe(false);
    expect((await executeTool('getCompanyPulse', disguised, {})).errorCode).toBe('forbidden');
    const simulated = await executeTool('simulateDelay', adminBot, { stepKey: 'asignar_transporte', delayMinutes: 60 });
    expect(simulated).toMatchObject({ success: true, result: { mode: 'template' } });
  });

  it('getCompanyPulse aggregates with groupBy and adds the AI use of the day', async () => {
    h.prisma.operationalCase.groupBy.mockImplementation(async ({ by }: { by: string[] }) =>
      by[0] === 'status' ? [{ status: 'open', _count: { _all: 5 } }] : [{ phase: 'planning', _count: { _all: 5 } }]
    );
    h.prisma.workItem.groupBy.mockResolvedValue([{ areaKey: 'ventas', _count: { _all: 2 } }]);
    h.getAreaAiUsage.mockResolvedValueOnce({ areas: [{ areaKey: 'ventas', tokens: 900, usd: 0 }] });
    const result = await executeTool('getCompanyPulse', admin, {});
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ cases: { open: 5 }, areas: expect.arrayContaining([expect.objectContaining({ areaKey: 'ventas', openWorkItems: 2, aiTokensToday: 900 })]) });
  });

  it('findStuckCases classifies idle open cases with their pending work', async () => {
    const lastActivityAt = new Date(Date.now() - 40 * HOUR);
    h.prisma.operationalCase.findMany.mockResolvedValue([
      { id: 'c1', caseNumber: 'EXP-7', salesOrderNumber: 'OV-1', customerName: 'Sol', status: 'open', phase: 'sourcing', ownerUserId: 'u-vend', lastActivityAt, promisedAt: null },
    ]);
    h.prisma.user.findMany.mockResolvedValue([{ id: 'u-vend', name: 'Vendedor' }]);
    const result = await executeTool('findStuckCases', admin, { idleHours: 24 });
    expect(h.prisma.operationalCase.findMany.mock.calls[0][0].where).toMatchObject({ phase: { not: 'closing' } });
    expect(result.result).toMatchObject({ count: 1, cases: [{ caseNumber: 'EXP-7', orphan: true, owner: 'Vendedor', idleHours: 40 }] });
  });

  it('whoIsBlocking reads overdue work and blocked requests of one case', async () => {
    h.prisma.operationalCase.findUnique.mockResolvedValue({ id: 'c1', caseNumber: 'EXP-7', status: 'open', promisedAt: null });
    h.prisma.workItem.findMany.mockResolvedValue([
      { id: 'w1', caseId: 'c1', areaKey: 'compras', ownerUserId: 'u-ana', title: 'Cotizar', dueAt: new Date(Date.now() - 3 * HOUR), escalationLevel: 0 },
    ]);
    h.prisma.user.findMany.mockResolvedValue([{ id: 'u-ana', name: 'Ana' }]);
    h.prisma.operationalCase.findMany.mockResolvedValue([{ id: 'c1', caseNumber: 'EXP-7' }]);
    const result = await executeTool('whoIsBlocking', admin, { caseId: 'c1' });
    expect(h.prisma.workItem.findMany.mock.calls[0][0].where).toMatchObject({ caseId: 'c1' });
    expect(result.result).toMatchObject({ scope: 'EXP-7', blockers: [{ name: 'Ana', overdueWorkItems: 1, cases: ['EXP-7'] }] });
  });

  it('simulateDelay uses the real steps of the case', async () => {
    h.prisma.operationalCase.findUnique.mockImplementation(async ({ select }: { select?: Record<string, boolean> }) =>
      select?.processVersionId
        ? { openedAt: new Date(Date.now() - 5 * HOUR), processVersionId: 'pv1' }
        : { id: 'c1', caseNumber: 'EXP-7', status: 'open', promisedAt: new Date(Date.now() + 48 * HOUR) }
    );
    h.loadProcessBlueprint.mockRejectedValueOnce(new Error('sin versión'));
    h.prisma.caseStep.findMany.mockResolvedValue([
      { stepKey: 'asignar_transporte', scopeKey: '', areaKey: 'logistica', dependsOn: [], slaMinutes: 60, status: 'active', dueAt: new Date(Date.now() + HOUR), completedAt: null },
      { stepKey: 'entregar', scopeKey: '', areaKey: 'logistica', dependsOn: ['asignar_transporte:'], slaMinutes: 480, status: 'pending', dueAt: null, completedAt: null },
    ]);
    const result = await executeTool('simulateDelay', admin, { caseId: 'c1', stepKey: 'asignar_transporte', delayMinutes: 240 });
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ mode: 'case', caseNumber: 'EXP-7', shiftMinutes: 240, lateAfter: false });
    expect((result.result as { affected: Array<{ label: string }> }).affected.map((a) => a.label)).toEqual(['Asignar transporte', 'Entregar al cliente']);
  });
});
