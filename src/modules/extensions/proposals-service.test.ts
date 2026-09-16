import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * Characterization of approveProposal: material change → invalidated, double approval never
 * executes twice, expired proposals are closed without running. Plus the approver scope of agent
 * proposals (proposer, responsible, backup, permission, stranger, bot) and the double signature.
 * Prisma is an in-memory table and the tool registry is scripted, so no tool really runs.
 */

type ProposalRow = {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  userId: string;
  toolName: string;
  toolVersion: string | null;
  capabilityId: string | null;
  connectionId: string | null;
  argsHash: string;
  args: unknown;
  summary: string;
  recipient: string | null;
  fileIds: string[];
  contextHash: string | null;
  effect: string;
  status: string;
  decisionBy: string | null;
  decidedAt: Date | null;
  approverScope: unknown;
  secondDecisionBy: string | null;
  secondDecidedAt: Date | null;
  executedAt: Date | null;
  result: unknown;
  error: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const { rows, users, registry, sessions, matches, agents } = vi.hoisted(() => {
  type Where = Record<string, unknown>;
  const matchValue = (value: unknown, cond: unknown): boolean => {
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      const c = cond as Record<string, unknown>;
      if ('in' in c) return (c.in as unknown[]).includes(value);
      if ('gt' in c) return value instanceof Date && value.getTime() > (c.gt as Date).getTime();
      if ('lt' in c) return value instanceof Date && value.getTime() < (c.lt as Date).getTime();
      // Only used as `{ not: Prisma.AnyNull }`.
      if ('not' in c) return value !== null && value !== undefined;
      if ('path' in c) {
        const obj = value as Record<string, unknown> | null;
        return Boolean(obj) && obj![(c.path as string[])[0]] === c.equals;
      }
    }
    return value === cond;
  };
  const matches = (row: Record<string, unknown>, where: Where | undefined): boolean =>
    Object.entries(where ?? {}).every(([key, cond]) => {
      if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
      if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
      return matchValue(row[key], cond);
    });
  return {
    rows: new Map<string, Record<string, unknown>>(),
    users: new Map<string, { isBot: boolean; isActive: boolean }>(),
    registry: {
      tools: new Map<string, Record<string, unknown>>(),
      executeTool: vi.fn(),
    },
    sessions: { addMessage: vi.fn(async () => undefined) },
    matches,
    // botUserId → AgentIdentity.key, and the dispatcher entry point for failed agent proposals.
    agents: {
      identities: new Map<string, string>(),
      enqueueProposalFailed: vi.fn(async () => true),
    },
  };
});

vi.mock('@/lib/prisma', () => ({
  prisma: {
    aiProposal: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = rows.get(where.id);
        return row ? { ...row } : null;
      }),
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
        [...rows.values()]
          .filter((row) => matches(row, where))
          .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
          .slice(0, take ?? 1000)
          .map((row) => ({ ...row }))
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `prop-${rows.size + 1}`,
          status: 'pending',
          decisionBy: null,
          decidedAt: null,
          approverScope: null,
          secondDecisionBy: null,
          secondDecidedAt: null,
          executedAt: null,
          result: null,
          error: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.set(row.id as string, row);
        return { ...row };
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = rows.get(where.id);
          if (!row) throw new Error('Record not found');
          Object.assign(row, data, { updatedAt: new Date() });
          return { ...row };
        }
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const row of rows.values()) {
            if (!matches(row, where)) continue;
            Object.assign(row, data);
            count++;
          }
          return { count };
        }
      ),
    },
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null
      ),
    },
    agentIdentity: {
      findUnique: vi.fn(async ({ where }: { where: { botUserId: string } }) => {
        const key = agents.identities.get(where.botUserId);
        return key ? { key } : null;
      }),
    },
  },
}));
vi.mock('@/modules/agents/dispatcher', () => ({
  enqueueProposalFailed: agents.enqueueProposalFailed,
}));
vi.mock('@/modules/ai/tools/registry', () => ({
  getToolDefinition: (name: string) => registry.tools.get(name),
  executeTool: registry.executeTool,
}));
vi.mock('./external-tools', () => ({ refreshExternalTools: vi.fn(async () => undefined) }));
vi.mock('@/modules/ai/ai-sessions-service', () => ({ addMessage: sessions.addMessage }));

import { prisma } from '@/lib/prisma';
import {
  ProposalError,
  approveProposal,
  computeProposalHash,
  createProposal,
  evaluateProposalDecision,
  expireProposals,
  listPendingProposals,
  listProposalsForScope,
  normalizeApproverScope,
  rejectProposal,
  secondApprovalPermissionsFor,
  type ApproverScope,
} from './proposals-service';

function makeActor(id: string, overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id,
    username: id,
    name: id,
    email: null,
    mustChangePassword: false,
    roleKeys: [],
    permissionKeys: [],
    isSuperAdmin: false,
    ...overrides,
  };
}

const perms = (...keys: string[]) => keys as CurrentUser['permissionKeys'];

const actor = makeActor('user-1', { username: 'ventas', name: 'Ventas', roleKeys: ['ventas'] });
const responsible = makeActor('resp-1', { username: 'ana' });
const backup = makeActor('backup-1', { username: 'luis' });
const manager = makeActor('mgr-1', {
  username: 'marta',
  permissionKeys: perms('operations.manage'),
});
const director = makeActor('dir-1', {
  username: 'dora',
  permissionKeys: perms('operations.manage', 'operations.admin'),
});
const stranger = makeActor('stranger-1', {
  username: 'otro',
  permissionKeys: perms('operations.view'),
});
// Inventario aprueba con CUALQUIERA de sus dos llaves: una persona por llave.
const adjuster = makeActor('inv-adjust', {
  username: 'ines',
  permissionKeys: perms('inventory.adjust'),
});
const stockManager = makeActor('inv-manage', {
  username: 'ivan',
  permissionKeys: perms('inventory.manage'),
});
const areaBot = makeActor('bot-compras', { username: 'ia_compras', roleKeys: ['agent_compras'] });
const flaggedBot = makeActor('bot-flag', { username: 'ia_flag' });

const ARGS = { customerId: '460000000012345', total: 1500 };

const SCOPE: ApproverScope = {
  caseId: 'case-1',
  areaKey: 'compras',
  userIds: ['resp-1', 'backup-1'],
  permissions: ['operations.manage'],
};

function seedProposal(overrides: Partial<ProposalRow> = {}): ProposalRow {
  const base: ProposalRow = {
    id: 'prop-1',
    conversationId: 'conv-1',
    messageId: null,
    userId: actor.id,
    toolName: 'createQuote',
    toolVersion: '1',
    capabilityId: null,
    connectionId: null,
    argsHash: '',
    args: ARGS,
    summary: 'Crear cotización para el cliente',
    recipient: null,
    fileIds: [],
    contextHash: null,
    effect: 'business_write',
    status: 'pending',
    decisionBy: null,
    decidedAt: null,
    approverScope: null,
    secondDecisionBy: null,
    secondDecidedAt: null,
    executedAt: null,
    result: null,
    error: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  if (!overrides.argsHash) {
    base.argsHash = computeProposalHash({
      toolName: base.toolName,
      toolVersion: base.toolVersion,
      connectionId: base.connectionId,
      args: base.args,
      recipient: base.recipient,
      fileIds: base.fileIds,
      contextHash: base.contextHash,
    });
  }
  rows.set(base.id, base as unknown as Record<string, unknown>);
  return base;
}

beforeEach(() => {
  rows.clear();
  users.clear();
  for (const u of [
    actor,
    responsible,
    backup,
    manager,
    director,
    stranger,
    adjuster,
    stockManager,
    areaBot,
  ]) {
    users.set(u.id, { isBot: u.id.startsWith('bot-'), isActive: true });
  }
  users.set(flaggedBot.id, { isBot: true, isActive: true });
  registry.tools.clear();
  registry.tools.set('createQuote', { name: 'createQuote', version: '1' });
  registry.tools.set('reserveStock', { name: 'reserveStock', version: '1' });
  registry.tools.set('authorizePayment', {
    name: 'authorizePayment',
    version: '1',
    requiresSecondApproval: true,
    requiredPermission: 'operations.admin',
  });
  registry.executeTool.mockReset();
  registry.executeTool.mockResolvedValue({
    success: true,
    result: { quoteId: 'Q-1' },
    durationMs: 5,
  });
  sessions.addMessage.mockClear();
  vi.mocked(prisma.aiProposal.updateMany).mockClear();
  agents.identities.clear();
  agents.identities.set(areaBot.id, 'area:compras');
  agents.enqueueProposalFailed.mockClear();
});

describe('approveProposal — material change', () => {
  it('invalidates when the tool version changed since it was proposed and does not execute', async () => {
    seedProposal();
    registry.tools.set('createQuote', { name: 'createQuote', version: '2' });

    const attempt = approveProposal(actor, 'prop-1');
    await expect(attempt).rejects.toBeInstanceOf(ProposalError);
    await expect(attempt).rejects.toMatchObject({ status: 409 });

    expect(rows.get('prop-1')).toMatchObject({
      status: 'invalidated',
      error: 'La herramienta o sus argumentos cambiaron desde que se propuso',
    });
    expect(registry.executeTool).not.toHaveBeenCalled();
    expect(prisma.aiProposal.updateMany).not.toHaveBeenCalled();
  });

  it('invalidates when the stored arguments no longer match the approved hash', async () => {
    seedProposal({
      argsHash: computeProposalHash({
        toolName: 'createQuote',
        toolVersion: '1',
        connectionId: null,
        args: { ...ARGS, total: 1 },
        recipient: null,
        fileIds: [],
        contextHash: null,
      }),
    });

    await expect(approveProposal(actor, 'prop-1')).rejects.toMatchObject({
      name: 'ProposalError',
      status: 409,
    });
    expect(rows.get('prop-1')?.status).toBe('invalidated');
    expect(registry.executeTool).not.toHaveBeenCalled();
  });

  it('invalidates when the tool no longer exists', async () => {
    seedProposal();
    registry.tools.delete('createQuote');

    await expect(approveProposal(actor, 'prop-1')).rejects.toMatchObject({ status: 409 });
    expect(rows.get('prop-1')).toMatchObject({
      status: 'invalidated',
      error: 'La herramienta ya no existe',
    });
    expect(registry.executeTool).not.toHaveBeenCalled();
  });
});

describe('approveProposal — double approval', () => {
  it('executes the stored arguments once; a second approval is rejected without executing', async () => {
    seedProposal();

    const first = await approveProposal(actor, 'prop-1');
    expect(first.proposal.status).toBe('executed');
    expect(registry.executeTool).toHaveBeenCalledTimes(1);
    expect(registry.executeTool).toHaveBeenCalledWith(
      'createQuote',
      actor,
      ARGS,
      expect.objectContaining({
        approvedProposalId: 'prop-1',
        skipApproval: true,
        conversationId: 'conv-1',
      })
    );
    expect(sessions.addMessage).toHaveBeenCalledTimes(1);

    const second = approveProposal(actor, 'prop-1');
    await expect(second).rejects.toBeInstanceOf(ProposalError);
    await expect(second).rejects.toMatchObject({ status: 409 });
    expect(registry.executeTool).toHaveBeenCalledTimes(1);
  });

  it('a concurrent click that read the proposal while pending loses the atomic claim and does not execute', async () => {
    seedProposal();
    // What a second, simultaneous click read before the first one claimed the proposal.
    const staleRead = { ...rows.get('prop-1')! };

    await approveProposal(actor, 'prop-1');
    vi.mocked(prisma.aiProposal.findUnique).mockResolvedValueOnce(staleRead as never);

    const second = approveProposal(actor, 'prop-1');
    await expect(second).rejects.toBeInstanceOf(ProposalError);
    await expect(second).rejects.toMatchObject({
      status: 409,
      message: 'La propuesta ya fue procesada',
    });

    expect(prisma.aiProposal.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.aiProposal.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: 'prop-1', status: 'pending' } })
    );
    expect(registry.executeTool).toHaveBeenCalledTimes(1);
    expect(rows.get('prop-1')?.status).toBe('executed');
  });
});

describe('approveProposal — expiry and ownership', () => {
  it('marks an expired proposal as expired and does not execute', async () => {
    seedProposal({ expiresAt: new Date(Date.now() - 1000) });

    const attempt = approveProposal(actor, 'prop-1');
    await expect(attempt).rejects.toBeInstanceOf(ProposalError);
    await expect(attempt).rejects.toMatchObject({ status: 410 });

    expect(rows.get('prop-1')?.status).toBe('expired');
    expect(registry.executeTool).not.toHaveBeenCalled();
    expect(prisma.aiProposal.updateMany).not.toHaveBeenCalled();
  });

  it("hides another user's proposal as not found", async () => {
    seedProposal({ userId: 'someone-else' });

    await expect(approveProposal(actor, 'prop-1')).rejects.toMatchObject({ status: 404 });
    expect(rows.get('prop-1')?.status).toBe('pending');
    expect(registry.executeTool).not.toHaveBeenCalled();
  });

  it('keeps an uncertain execution as pending_review', async () => {
    seedProposal();
    registry.executeTool.mockResolvedValueOnce({
      success: false,
      uncertain: true,
      error: 'timeout',
      durationMs: 30_000,
    });

    const { proposal } = await approveProposal(actor, 'prop-1');
    expect(proposal.status).toBe('pending_review');
    expect(rows.get('prop-1')?.status).toBe('pending_review');
  });
});

describe('approver scope', () => {
  function seedAgentProposal(overrides: Partial<ProposalRow> = {}) {
    return seedProposal({
      userId: areaBot.id,
      toolName: 'reserveStock',
      summary: 'Reservar 15 m² de Loseta Perla',
      approverScope: SCOPE,
      ...overrides,
    });
  }

  it('the human proposer still approves a proposal that carries a scope', async () => {
    seedProposal({ approverScope: SCOPE });
    const { proposal } = await approveProposal(actor, 'prop-1');
    expect(proposal.status).toBe('executed');
    expect(registry.executeTool).toHaveBeenCalledTimes(1);
  });

  it('the area responsible approves the bot proposal: it runs as the responsible with the scope in context', async () => {
    seedAgentProposal();
    const { proposal, execution } = await approveProposal(responsible, 'prop-1');

    expect(execution.success).toBe(true);
    expect(proposal).toMatchObject({
      status: 'executed',
      decisionBy: 'resp-1',
      proposedBy: 'bot-compras',
    });
    expect(registry.executeTool).toHaveBeenCalledWith(
      'reserveStock',
      responsible,
      ARGS,
      expect.objectContaining({
        approvedProposalId: 'prop-1',
        skipApproval: true,
        approverScope: SCOPE,
        agentAreaKey: 'compras',
      })
    );
    expect(sessions.addMessage).toHaveBeenCalledWith(
      'conv-1',
      'system',
      expect.stringContaining('@ana APROBÓ la propuesta prop-1'),
      null,
      0,
      0,
      0
    );
  });

  it('the backup listed in the scope approves', async () => {
    seedAgentProposal();
    const { proposal } = await approveProposal(backup, 'prop-1');
    expect(proposal).toMatchObject({ status: 'executed', decisionBy: 'backup-1' });
    expect(agents.enqueueProposalFailed).not.toHaveBeenCalled();
  });

  it('an approved agent proposal that fails to run wakes its proposer once (action_failed)', async () => {
    seedAgentProposal();
    registry.executeTool.mockResolvedValueOnce({
      success: false,
      error: 'Sin existencia controlada',
      errorCode: 'error',
      durationMs: 3,
    });
    const { proposal, execution } = await approveProposal(responsible, 'prop-1');
    expect(execution.success).toBe(false);
    expect(proposal.status).toBe('failed');
    expect(agents.enqueueProposalFailed).toHaveBeenCalledTimes(1);
    expect(agents.enqueueProposalFailed).toHaveBeenCalledWith({
      proposalId: 'prop-1',
      agentKey: 'area:compras',
      toolName: 'reserveStock',
      error: 'Sin existencia controlada',
      caseId: 'case-1',
      areaKey: 'compras',
    });
  });

  it('a failed proposal of a person, or an uncertain one, never enqueues an agent turn', async () => {
    seedProposal({ approverScope: SCOPE });
    registry.executeTool.mockResolvedValueOnce({
      success: false,
      error: 'Zoho caído',
      errorCode: 'error',
      durationMs: 3,
    });
    await approveProposal(actor, 'prop-1');
    rows.clear();
    seedAgentProposal();
    registry.executeTool.mockResolvedValueOnce({
      success: false,
      uncertain: true,
      error: 'timeout',
      errorCode: 'timeout',
      durationMs: 3,
    });
    await approveProposal(responsible, 'prop-1');
    expect(agents.enqueueProposalFailed).not.toHaveBeenCalled();
  });

  it('a holder of the scope permission approves even if not listed', async () => {
    seedAgentProposal();
    const { proposal } = await approveProposal(manager, 'prop-1');
    expect(proposal).toMatchObject({ status: 'executed', decisionBy: 'mgr-1' });
  });

  // Inventario aprueba con `inventory.adjust` O `inventory.manage` (columna «Aprobar» del
  // registro de áreas): quien tenga CUALQUIERA de las dos decide, no sólo la primera.
  it('an area with two approval keys: a holder of either one decides', async () => {
    const inventoryScope = {
      ...SCOPE,
      areaKey: 'inventario',
      permissions: ['inventory.adjust', 'inventory.manage'],
    };
    seedAgentProposal({ approverScope: inventoryScope });
    expect(await approveProposal(adjuster, 'prop-1')).toMatchObject({
      proposal: { status: 'executed', decisionBy: 'inv-adjust' },
    });

    rows.clear();
    seedAgentProposal({ approverScope: inventoryScope });
    expect(await approveProposal(stockManager, 'prop-1')).toMatchObject({
      proposal: { status: 'executed', decisionBy: 'inv-manage' },
    });
  });

  // Filas guardadas antes del campo plural: traían `permission` (singular) y siguen decidiéndose.
  it('a stored scope with the legacy singular permission still grants the decision', async () => {
    seedAgentProposal({
      approverScope: {
        caseId: 'case-1',
        areaKey: 'compras',
        userIds: [],
        permission: 'operations.manage',
      },
    });
    const { proposal } = await approveProposal(manager, 'prop-1');
    expect(proposal).toMatchObject({ status: 'executed', decisionBy: 'mgr-1' });
    expect(normalizeApproverScope({ userIds: [], permission: 'operations.manage' })).toEqual({
      userIds: [],
      permissions: ['operations.manage'],
    });
  });

  it('a stranger (not listed, without the permission) gets not found and nothing runs', async () => {
    seedAgentProposal();
    await expect(approveProposal(stranger, 'prop-1')).rejects.toMatchObject({ status: 404 });
    await expect(rejectProposal(stranger, 'prop-1', 'no')).rejects.toMatchObject({ status: 404 });
    expect(rows.get('prop-1')?.status).toBe('pending');
    expect(registry.executeTool).not.toHaveBeenCalled();
  });

  it('a scope naming an unknown permission grants nothing by permission', async () => {
    seedAgentProposal({ approverScope: { ...SCOPE, permissions: ['operations.compras.approve'] } });
    await expect(approveProposal(manager, 'prop-1')).rejects.toMatchObject({ status: 404 });
    expect(registry.executeTool).not.toHaveBeenCalled();
  });

  it('a bot never approves nor rejects, not even its own proposal', async () => {
    seedAgentProposal();
    await expect(approveProposal(areaBot, 'prop-1')).rejects.toMatchObject({ status: 403 });
    await expect(rejectProposal(areaBot, 'prop-1')).rejects.toMatchObject({ status: 403 });
    expect(rows.get('prop-1')?.status).toBe('pending');
    expect(registry.executeTool).not.toHaveBeenCalled();
  });

  it('a user flagged isBot in the database is refused even when listed in the scope', async () => {
    seedAgentProposal({ approverScope: { ...SCOPE, userIds: ['bot-flag'] } });
    await expect(approveProposal(flaggedBot, 'prop-1')).rejects.toMatchObject({
      status: 403,
      message: 'Un usuario bot no puede aprobar ni rechazar propuestas',
    });
    expect(registry.executeTool).not.toHaveBeenCalled();
  });

  it('the responsible rejects: the decision is recorded and the thread learns it', async () => {
    seedAgentProposal();
    const dto = await rejectProposal(responsible, 'prop-1', 'No hay espacio en bodega');
    expect(dto).toMatchObject({
      status: 'rejected',
      decisionBy: 'resp-1',
      error: 'No hay espacio en bodega',
    });
    expect(sessions.addMessage).toHaveBeenCalledWith(
      'conv-1',
      'system',
      expect.stringContaining('RECHAZÓ la propuesta prop-1'),
      null,
      0,
      0,
      0
    );
    await expect(rejectProposal(backup, 'prop-1')).rejects.toMatchObject({ status: 409 });
  });

  it('createProposal stores the normalized scope (deduplicated ids) and omits an empty one', async () => {
    const tool = { name: 'reserveStock', version: '1', effect: 'business_write' } as never;
    const withScope = await createProposal({
      actor: areaBot,
      tool,
      args: ARGS,
      summary: 'Reservar',
      approverScope: { ...SCOPE, userIds: ['resp-1', 'resp-1', 'backup-1', ''] },
    });
    expect(withScope.approverScope).toEqual(SCOPE);

    const without = await createProposal({
      actor,
      tool,
      args: ARGS,
      summary: 'Reservar',
      approverScope: null,
    });
    expect(without.approverScope).toBeNull();
    expect(normalizeApproverScope({ userIds: [] })).toBeNull();
  });
});

describe('double signature', () => {
  function seedPayment(overrides: Partial<ProposalRow> = {}) {
    return seedProposal({
      userId: areaBot.id,
      toolName: 'authorizePayment',
      summary: 'Autorizar pago de $48,000 a Cerámica del Norte',
      approverScope: SCOPE,
      ...overrides,
    });
  }

  it('the first approval only records the first signature; nothing runs yet', async () => {
    seedPayment();
    const { proposal, execution } = await approveProposal(responsible, 'prop-1');

    expect(proposal).toMatchObject({
      status: 'awaiting_second_approval',
      decisionBy: 'resp-1',
      awaitingSecondApproval: true,
    });
    expect(execution).toMatchObject({
      success: false,
      needsApproval: true,
      errorCode: 'awaiting_second_approval',
    });
    expect(registry.executeTool).not.toHaveBeenCalled();
    expect(sessions.addMessage).toHaveBeenCalledWith(
      'conv-1',
      'system',
      expect.stringContaining('PRIMERA FIRMA'),
      null,
      0,
      0,
      0
    );
  });

  it('the same user cannot give the second signature', async () => {
    seedPayment();
    await approveProposal(responsible, 'prop-1');

    await expect(approveProposal(responsible, 'prop-1')).rejects.toMatchObject({
      status: 403,
      message: 'La segunda firma debe ser de una persona distinta a quien dio la primera',
    });
    expect(rows.get('prop-1')?.status).toBe('awaiting_second_approval');
    expect(registry.executeTool).not.toHaveBeenCalled();
  });

  it('a distinct scope member without the permission cannot sign second', async () => {
    seedPayment();
    await approveProposal(responsible, 'prop-1');

    await expect(approveProposal(backup, 'prop-1')).rejects.toMatchObject({
      status: 403,
      message: 'La segunda firma requiere el permiso operations.manage',
    });
    expect(registry.executeTool).not.toHaveBeenCalled();
  });

  it('with two approval keys either one signs second, and the message names both', async () => {
    const permissions = ['inventory.adjust', 'inventory.manage'];
    seedPayment({ approverScope: { ...SCOPE, areaKey: 'inventario', permissions } });
    await approveProposal(responsible, 'prop-1');
    expect(sessions.addMessage).toHaveBeenCalledWith(
      'conv-1',
      'system',
      expect.stringContaining('permiso inventory.adjust o inventory.manage'),
      null,
      0,
      0,
      0
    );

    const { proposal } = await approveProposal(adjuster, 'prop-1');
    expect(proposal).toMatchObject({ status: 'executed', secondDecisionBy: 'inv-adjust' });
    expect(registry.executeTool).toHaveBeenCalledTimes(1);
  });

  it('a distinct user holding the permission signs second and the tool runs once as that user', async () => {
    seedPayment();
    await approveProposal(responsible, 'prop-1');
    const { proposal, execution } = await approveProposal(manager, 'prop-1');

    expect(execution.success).toBe(true);
    expect(proposal).toMatchObject({
      status: 'executed',
      decisionBy: 'resp-1',
      secondDecisionBy: 'mgr-1',
    });
    expect(registry.executeTool).toHaveBeenCalledTimes(1);
    expect(registry.executeTool).toHaveBeenCalledWith(
      'authorizePayment',
      manager,
      ARGS,
      expect.anything()
    );
    expect(sessions.addMessage).toHaveBeenLastCalledWith(
      'conv-1',
      'system',
      expect.stringContaining('SEGUNDA FIRMA y APROBÓ'),
      null,
      0,
      0,
      0
    );

    await expect(approveProposal(director, 'prop-1')).rejects.toMatchObject({ status: 409 });
    expect(registry.executeTool).toHaveBeenCalledTimes(1);
  });

  it('a stranger cannot sign second', async () => {
    seedPayment();
    await approveProposal(responsible, 'prop-1');
    await expect(approveProposal(stranger, 'prop-1')).rejects.toMatchObject({ status: 404 });
  });

  it('without a scope the second signer needs the tool permission (operations.admin)', async () => {
    seedPayment({ userId: actor.id, approverScope: null });
    await approveProposal(actor, 'prop-1');

    await expect(approveProposal(manager, 'prop-1')).rejects.toMatchObject({ status: 404 });
    const { proposal } = await approveProposal(director, 'prop-1');
    expect(proposal).toMatchObject({
      status: 'executed',
      decisionBy: 'user-1',
      secondDecisionBy: 'dir-1',
    });
  });

  it('the second signer may reject instead: the first signature is kept', async () => {
    seedPayment();
    await approveProposal(responsible, 'prop-1');
    const dto = await rejectProposal(manager, 'prop-1', 'Falta la factura');

    expect(dto).toMatchObject({
      status: 'rejected',
      decisionBy: 'resp-1',
      secondDecisionBy: 'mgr-1',
    });
    expect(registry.executeTool).not.toHaveBeenCalled();
  });

  it('a proposal waiting for the second signature expires like a pending one', async () => {
    seedPayment({
      status: 'awaiting_second_approval',
      decisionBy: 'resp-1',
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(approveProposal(manager, 'prop-1')).rejects.toMatchObject({ status: 410 });
    expect(rows.get('prop-1')?.status).toBe('expired');

    seedPayment({
      id: 'prop-2',
      status: 'awaiting_second_approval',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await expireProposals()).toBe(1);
    expect(rows.get('prop-2')?.status).toBe('expired');
  });

  it('pure rules: second permission falls back scope → tool → operations.admin', () => {
    expect(secondApprovalPermissionsFor(SCOPE, { requiredPermission: 'operations.admin' })).toEqual(
      ['operations.manage']
    );
    expect(secondApprovalPermissionsFor(null, { requiredPermission: 'operations.view' })).toEqual([
      'operations.view',
    ]);
    expect(
      secondApprovalPermissionsFor({ userIds: ['a'], permissions: ['nope.x'] }, undefined)
    ).toEqual(['operations.admin']);
    expect(
      evaluateProposalDecision({
        actor: responsible,
        proposal: { userId: 'bot-compras', status: 'executed', approverScope: SCOPE },
        decision: 'approve',
        requiresSecondApproval: false,
        secondApprovalPermissions: ['operations.manage'],
      })
    ).toEqual({ ok: false, status: 409, message: 'La propuesta ya está executed' });
  });
});

describe('listing', () => {
  const past = new Date(Date.now() - 60_000);

  function seedListing() {
    seedProposal({ id: 'p-own', createdAt: new Date(Date.now() - 1000) });
    seedProposal({
      id: 'p-scope',
      userId: areaBot.id,
      approverScope: SCOPE,
      createdAt: new Date(Date.now() - 2000),
    });
    seedProposal({
      id: 'p-case2',
      userId: areaBot.id,
      approverScope: { ...SCOPE, caseId: 'case-2' },
      createdAt: new Date(Date.now() - 2500),
    });
    seedProposal({ id: 'p-foreign', userId: 'x', createdAt: new Date(Date.now() - 3000) });
    seedProposal({
      id: 'p-await',
      userId: 'y',
      toolName: 'authorizePayment',
      status: 'awaiting_second_approval',
      decisionBy: 'z',
      approverScope: { caseId: 'case-1', userIds: ['z'], permissions: ['operations.manage'] },
      createdAt: new Date(Date.now() - 4000),
    });
    seedProposal({ id: 'p-expired', userId: areaBot.id, approverScope: SCOPE, expiresAt: past });
    seedProposal({
      id: 'p-done',
      userId: areaBot.id,
      approverScope: SCOPE,
      status: 'executed',
      createdAt: new Date(Date.now() - 5000),
    });
  }

  it('listPendingProposals(userId) keeps its contract: only the caller own pending proposals', async () => {
    seedListing();
    const own = await listPendingProposals('user-1');
    expect(own.map((p) => p.id)).toEqual(['p-own']);
    expect(await listPendingProposals('user-1', 'other-conv')).toEqual([]);
  });

  it('listPendingProposals(actor) returns what the actor can decide across surfaces', async () => {
    seedListing();
    expect((await listPendingProposals(responsible)).map((p) => p.id)).toEqual([
      'p-scope',
      'p-case2',
    ]);
    expect((await listPendingProposals(manager)).map((p) => p.id)).toEqual([
      'p-scope',
      'p-case2',
      'p-await',
    ]);
    expect((await listPendingProposals(actor)).map((p) => p.id)).toEqual(['p-own']);
    expect(await listPendingProposals(stranger)).toEqual([]);
  });

  it('listProposalsForScope filters by case and respects visibility', async () => {
    seedListing();
    expect(
      (await listProposalsForScope(responsible, { caseId: 'case-1' })).map((p) => p.id)
    ).toEqual(['p-scope']);
    expect((await listProposalsForScope(manager, { caseId: 'case-1' })).map((p) => p.id)).toEqual([
      'p-scope',
      'p-await',
    ]);
    expect(
      (await listProposalsForScope(responsible, { caseId: 'case-1', includeDecided: true })).map(
        (p) => p.id
      )
    ).toEqual(['p-expired', 'p-scope', 'p-done']);
    expect(
      await listProposalsForScope(stranger, { caseId: 'case-1', includeDecided: true })
    ).toEqual([]);
  });
});

/**
 * Contrato de los argumentos de una propuesta (plan §5.3 / §6.6, «la IA propone, la persona
 * aprueba»): la fila guarda los argumentos CRUDOS —son los que se hashean y los que se
 * ejecutan— y la redacción ocurre sólo a la salida, en `toProposalDTO`.
 *
 * Redactar al guardar rompía las dos mitades a la vez: `createProposal` hasheaba los crudos y
 * `approveProposal` recalculaba el hash sobre los redactados, así que la propuesta quedaba
 * `invalidated` («cambio material») sin que nadie hubiera cambiado nada; y, sin esa guardia, la
 * herramienta se habría ejecutado con un id mutilado. Estas pruebas recorren el camino real
 * crudo → almacenado → aprobado, que es el que ninguna prueba anterior ejercía (todas construían
 * el `argsHash` sobre los MISMOS argumentos que guardaban).
 */
describe('argumentos de la propuesta: crudos al guardar y ejecutar, redactados al mostrar', () => {
  const quoteTool = { name: 'createQuote', version: '1', effect: 'business_write' } as never;
  // `ca7owrkix9xsjh43hbtrhj7lf` es la forma de un cuid real y lleva «rk» seguido de 18
  // caracteres: exactamente lo que el patrón de credenciales mordía (1.7 % de los ids).
  // `note` sí parece una credencial, así que la redacción la reescribe siempre.
  const RAW_ARGS = {
    requestId: 'ca7owrkix9xsjh43hbtrhj7lf',
    note: 'Bearer abcdefghijklmnopqrstuvwxyz',
    action: 'accept',
  };

  it('la aprobación no invalida y ejecuta los argumentos EXACTOS que se propusieron', async () => {
    const created = await createProposal({
      actor,
      tool: quoteTool,
      args: RAW_ARGS,
      summary: 'Aceptar la solicitud',
    });
    expect(rows.get(created.id)?.args).toEqual(RAW_ARGS);

    const { proposal: decided, execution } = await approveProposal(actor, created.id);

    expect(execution.success).toBe(true);
    expect(decided.status).toBe('executed');
    expect(registry.executeTool).toHaveBeenCalledWith(
      'createQuote',
      actor,
      RAW_ARGS,
      expect.objectContaining({ approvedProposalId: created.id, skipApproval: true })
    );
  });

  it('lo que sale hacia la UI, las APIs y el modelo sí va redactado', async () => {
    const created = await createProposal({
      actor,
      tool: quoteTool,
      args: RAW_ARGS,
      summary: 'Aceptar la solicitud',
    });
    const { toProposalDTO } = await import('./proposals-service');
    const dto = toProposalDTO(rows.get(created.id) as never);

    expect(dto.args).toEqual({ ...RAW_ARGS, note: '[REDACTED]' });
  });
});

/**
 * Plan 5.4: la ejecución de una propuesta aprobada corre con la firma de quien la aprobó, para
 * que `requestApproval` (sección 6.0) la registre como PRIMERA FIRMA de la aprobación de negocio
 * que ese mismo clic abre y no le pida dos veces lo mismo.
 */
describe('firma de negocio heredada de la decisión', () => {
  it('la herramienta se ejecuta con la firma de quien aprobó (y sólo dentro de esa ejecución)', async () => {
    const seen: Array<{ userId: string; proposalId: string; toolName: string } | null> = [];
    registry.executeTool.mockImplementation(async () => {
      const { peekApprovalFirstSignature } =
        await import('@/modules/operations/approval-first-signature');
      const current = peekApprovalFirstSignature();
      seen.push(
        current
          ? { userId: current.userId, proposalId: current.proposalId, toolName: current.toolName }
          : null
      );
      return { success: true, result: { ok: true }, durationMs: 1 };
    });
    seedProposal({ userId: actor.id, approverScope: SCOPE });

    const { peekApprovalFirstSignature } =
      await import('@/modules/operations/approval-first-signature');
    expect(peekApprovalFirstSignature()).toBeNull();

    await approveProposal(responsible, 'prop-1');

    expect(seen).toEqual([
      { userId: responsible.id, proposalId: 'prop-1', toolName: 'createQuote' },
    ]);
    // El contexto no se filtra fuera de la ejecución de la herramienta.
    expect(peekApprovalFirstSignature()).toBeNull();
  });

  it('la primera de dos firmas no ejecuta nada, así que no hereda firma de negocio', async () => {
    const seen: unknown[] = [];
    registry.executeTool.mockImplementation(async () => {
      seen.push('ran');
      return { success: true, result: {}, durationMs: 1 };
    });
    seedProposal({ toolName: 'authorizePayment', approverScope: SCOPE, userId: areaBot.id });

    const { execution } = await approveProposal(director, 'prop-1');

    expect(execution.errorCode).toBe('awaiting_second_approval');
    expect(seen).toEqual([]);
  });
});
