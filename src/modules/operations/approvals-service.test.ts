import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('./testing/fixtures');
  return {
    fake: createOpsFake(),
    notifyUser: vi.fn(async () => ({ id: 'n', inApp: true, push: false, suppressed: false })),
    publishRealtime: vi.fn(async () => ({
      id: '1',
      channel: '',
      type: '',
      payload: {},
      createdAt: '',
    })),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser: mocks.notifyUser }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: mocks.publishRealtime,
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));

import { runWithApprovalFirstSignature } from './approval-first-signature';
import {
  checkVote,
  decideApproval,
  defaultApprovalPolicies,
  evaluateApproval,
  fallbackApprovalRule,
  listPendingApprovals,
  onApprovalDecided,
  parseApprovalDecisions,
  requestApproval,
  selectApprovalPolicy,
  type ApprovalDecidedEvent,
  type ApprovalVote,
  type RequestApprovalInput,
  type RequestApprovalOutcome,
} from './approvals-service';
import { executeCommand, registerCommand } from './commands';
import { invalidateOperationsConfigCache } from './operations-config';
import { seedRole, seedUser } from './testing/fixtures';

const { fake } = mocks;
const NOW = new Date('2026-09-15T15:00:00.000Z');
const tx = fake.client as unknown as Prisma.TransactionClient;
const THRESHOLDS = { procurementDoubleApprovalMxn: 50000, expenseAutoApproveMxn: 2000 };

registerCommand<Record<string, unknown>, RequestApprovalOutcome>('test.request_approval', {
  schema: z.record(z.unknown()),
  aggregate: 'none',
  async handler(innerTx, cmd) {
    const outcome = await requestApproval(innerTx, cmd.payload as RequestApprovalInput);
    return { data: outcome };
  },
});

let seq = 0;
async function ask(input: Partial<RequestApprovalInput>) {
  seq += 1;
  return executeCommand<RequestApprovalOutcome>(
    {
      commandId: `ask-${seq}`,
      type: 'test.request_approval',
      actor: { type: 'system', id: 'purchases' },
      aggregate: { type: 'procurement_order', id: String(input.targetId ?? 'po1') },
      payload: {
        scope: 'procurement',
        targetType: 'procurement_order',
        targetId: 'po1',
        amount: '1000',
        requestedByUserId: 'req',
        caseId: 'case1',
        ...input,
      },
    },
    null,
    { now: NOW }
  );
}

let users: Record<string, ReturnType<typeof seedUser>['currentUser']>;
const decided: ApprovalDecidedEvent[] = [];
let offReaction: () => void = () => undefined;

beforeEach(() => {
  fake.tables.clear();
  vi.clearAllMocks();
  invalidateOperationsConfigCache();
  decided.length = 0;
  offReaction();
  offReaction = onApprovalDecided('procurement_order', async (_tx, event) => {
    decided.push(event);
  });
  users = {
    req: seedUser(fake, { id: 'req', permissions: ['operations.view'] }).currentUser,
    a1: seedUser(fake, {
      id: 'a1',
      permissions: ['operations.admin'],
      createdAt: new Date('2026-01-01'),
    }).currentUser,
    a2: seedUser(fake, {
      id: 'a2',
      permissions: ['operations.admin'],
      createdAt: new Date('2026-01-02'),
    }).currentUser,
    viewer: seedUser(fake, { id: 'viewer', permissions: ['operations.view'] }).currentUser,
  };
  seedUser(fake, { id: 'bot', isBot: true, permissions: ['operations.admin'] });
  seedUser(fake, { id: 'gone', isActive: false, permissions: ['operations.admin'] });
});

describe('approval rules (pure)', () => {
  const rules = defaultApprovalPolicies(THRESHOLDS);
  const pick = (scope: 'procurement' | 'expense' | 'payroll', amount: string, currency = 'MXN') =>
    selectApprovalPolicy(rules, { scope, amount: new Prisma.Decimal(amount), currency });

  it('uses one approval below the double-approval threshold and two from it', () => {
    expect(pick('procurement', '49999.99')?.requiredApprovals).toBe(1);
    expect(pick('procurement', '50000')?.requiredApprovals).toBe(2);
    expect(pick('payroll', '1')?.requiredApprovals).toBe(2);
  });

  it('auto-approves expenses below the threshold only', () => {
    expect(pick('expense', '1999.99')?.requiredApprovals).toBe(0);
    expect(pick('expense', '2000')?.requiredApprovals).toBe(1);
  });

  it('never auto-approves when no rule matches (e.g. another currency)', () => {
    expect(pick('expense', '10', 'USD')).toBeNull();
    expect(fallbackApprovalRule('expense', rules).requiredApprovals).toBe(1);
    expect(fallbackApprovalRule('procurement', rules).requiredApprovals).toBe(2);
  });

  it('prefers category-specific rules and then the highest minimum', () => {
    const custom = [
      ...rules,
      {
        ...rules[0],
        id: 'cat',
        categoryId: 'fletes',
        minAmount: new Prisma.Decimal(0),
        maxAmount: null,
        requiredApprovals: 3,
      },
    ];
    expect(
      selectApprovalPolicy(custom, {
        scope: 'procurement',
        amount: new Prisma.Decimal(10),
        currency: 'MXN',
        categoryId: 'fletes',
      })?.id
    ).toBe('cat');
    expect(
      selectApprovalPolicy(custom, {
        scope: 'procurement',
        amount: new Prisma.Decimal(10),
        currency: 'MXN',
      })?.requiredApprovals
    ).toBe(1);
  });

  it('counts distinct approvers, rejects on any rejection and allows one vote per user', () => {
    const vote = (userId: string, decision: 'approve' | 'reject'): ApprovalVote => ({
      userId,
      decision,
      at: '',
      note: null,
    });
    expect(evaluateApproval([vote('a1', 'approve'), vote('a1', 'approve')], 2).status).toBe(
      'pending'
    );
    expect(evaluateApproval([vote('a1', 'approve'), vote('a2', 'approve')], 2)).toMatchObject({
      status: 'approved',
      approvals: 2,
    });
    expect(evaluateApproval([vote('a1', 'approve'), vote('a2', 'reject')], 2).status).toBe(
      'rejected'
    );
    expect(checkVote([vote('a1', 'approve')], 'a1', 'req')).toBe('already_voted');
    expect(checkVote([], 'req', 'req')).toBe('self_approval');
    expect(checkVote([], 'a2', 'req')).toBe('ok');
  });
});

describe('requestApproval', () => {
  it('creates a pending request with one approval work item per eligible approver', async () => {
    const result = await ask({ amount: '12000' });
    expect(result.status).toBe('completed');
    const outcome = result.data!;
    expect(outcome).toMatchObject({ status: 'pending', autoApproved: false, reused: false });
    expect(outcome.approverUserIds.sort()).toEqual(['a1', 'a2']);

    const [request] = fake.rows('approvalRequest');
    expect(request).toMatchObject({
      status: 'pending',
      requiredApprovals: 1,
      areaKey: 'compras',
      policyId: null,
    });
    const items = fake.rows('workItem');
    expect(items.map((i) => i.ownerUserId).sort()).toEqual(['a1', 'a2']);
    expect(
      items.every(
        (i) =>
          i.kind === 'approval' && i.objectType === 'approval_request' && i.objectId === request.id
      )
    ).toBe(true);
    expect(
      mocks.notifyUser.mock.calls.map((c) => (c as unknown as [{ category: string }])[0].category)
    ).toEqual(['approval_requested', 'approval_requested']);
    expect(fake.rows('operationalEvent').map((e) => e.type)).toEqual(
      expect.arrayContaining(['approval.requested', 'workitem.created'])
    );
  });

  it('auto-approves when the policy requires zero approvals and runs the reactions', async () => {
    const result = await ask({ scope: 'expense', targetType: 'procurement_order', amount: 1500 });
    expect(result.data).toMatchObject({ status: 'approved', autoApproved: true, workItemIds: [] });
    expect(fake.rows('workItem')).toHaveLength(0);
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ status: 'approved', auto: true, decidedByUserId: null });
    expect(fake.rows('operationalEvent').map((e) => e.type)).toEqual([
      'approval.requested',
      'approval.approved',
    ]);
  });

  it('reuses the pending request of the same target instead of duplicating it', async () => {
    await ask({ amount: '12000' });
    const again = await ask({ amount: '12000' });
    expect(again.data).toMatchObject({ reused: true, status: 'pending' });
    expect(fake.rows('approvalRequest')).toHaveLength(1);
    expect(fake.rows('workItem')).toHaveLength(2);
  });

  it('a minimum of signatures raises the policy (never lowers it)', async () => {
    const raised = await ask({ amount: '12000', minApprovals: 2 });
    expect(raised.data).toMatchObject({ status: 'pending' });
    expect(fake.rows('approvalRequest')[0]).toMatchObject({ requiredApprovals: 2 });
    const kept = await ask({ targetId: 'po2', amount: '60000', minApprovals: 1 });
    expect(kept.data?.approvalRequest.requiredApprovals).toBe(2);
    const auto = await ask({ scope: 'expense', targetId: 'po3', amount: 1500, minApprovals: 2 });
    expect(auto.data).toMatchObject({ status: 'pending', autoApproved: false });
  });

  it('rejects the command when there are fewer eligible approvers than required signatures', async () => {
    fake.rows('user').find((u) => u.id === 'a2')!.isActive = false;
    const result = await ask({ amount: '60000' });
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'no_approvers' });
    expect(fake.rows('approvalRequest')).toHaveLength(0);
  });

  it('honors stored policies and their approver roles', async () => {
    seedRole(fake, 'jefe_compras');
    seedUser(fake, { id: 'jefe', roleKeys: ['jefe_compras'] });
    fake.seed('approvalPolicy', {
      id: 'pol1',
      scope: 'procurement',
      minAmount: new Prisma.Decimal(0),
      requiredApprovals: 1,
      approverRoleKeys: ['jefe_compras'],
    });
    const result = await ask({ amount: '999999' });
    expect(result.data!.approverUserIds.sort()).toEqual(['a1', 'a2', 'jefe']);
    expect(fake.rows('approvalRequest')[0]).toMatchObject({
      policyId: 'pol1',
      requiredApprovals: 1,
    });
  });

  it('only runs inside a command', async () => {
    await expect(
      requestApproval(tx, {
        scope: 'expense',
        targetType: 't',
        targetId: '1',
        amount: 1,
        requestedByUserId: 'req',
      })
    ).rejects.toMatchObject({ code: 'outside_command' });
  });
});

describe('decideApproval', () => {
  async function doubleSignature() {
    await ask({ amount: '60000' });
    return fake.rows('approvalRequest')[0];
  }

  it('requires two distinct approvers, one vote each, and never the requester', async () => {
    const request = await doubleSignature();
    expect(request.requiredApprovals).toBe(2);

    const first = await decideApproval(
      users.a1,
      { approvalRequestId: request.id, decision: 'approve' },
      { now: NOW }
    );
    expect(first).toMatchObject({ status: 'completed', data: { status: 'pending', approvals: 1 } });
    expect(fake.rows('workItem').find((i) => i.ownerUserId === 'a1')).toMatchObject({
      status: 'done',
      completedBy: 'a1',
    });
    expect(fake.rows('workItem').find((i) => i.ownerUserId === 'a2')).toMatchObject({
      status: 'open',
    });
    expect(decided).toHaveLength(0);

    expect(
      await decideApproval(
        users.a1,
        { approvalRequestId: request.id, decision: 'approve' },
        { now: NOW }
      )
    ).toMatchObject({ status: 'rejected', errorCode: 'already_voted' });
    expect(
      await decideApproval(
        users.req,
        { approvalRequestId: request.id, decision: 'approve' },
        { now: NOW }
      )
    ).toMatchObject({ status: 'rejected', errorCode: 'self_approval' });
    expect(
      await decideApproval(
        users.viewer,
        { approvalRequestId: request.id, decision: 'approve' },
        { now: NOW }
      )
    ).toMatchObject({ status: 'rejected', errorCode: 'not_eligible' });

    const second = await decideApproval(
      users.a2,
      { approvalRequestId: request.id, decision: 'approve', note: 'OK' },
      { now: NOW }
    );
    expect(second).toMatchObject({
      status: 'completed',
      data: { status: 'approved', approvals: 2 },
    });
    expect(fake.rows('approvalRequest')[0]).toMatchObject({ status: 'approved', decidedAt: NOW });
    expect(fake.rows('approvalRequest')[0].decisions.map((d: ApprovalVote) => d.userId)).toEqual([
      'a1',
      'a2',
    ]);
    expect(decided).toEqual([
      expect.objectContaining({ status: 'approved', auto: false, decidedByUserId: 'a2' }),
    ]);
    const notified = mocks.notifyUser.mock.calls.map(
      (c) => (c as unknown as [{ userId: string; category: string }])[0]
    );
    expect(notified).toContainEqual(
      expect.objectContaining({ userId: 'req', category: 'approval_decided' })
    );

    expect(
      await decideApproval(
        users.a2,
        { approvalRequestId: request.id, decision: 'reject' },
        { now: NOW }
      )
    ).toMatchObject({ status: 'rejected', errorCode: 'approval_closed' });
  });

  it('a single rejection closes the request and cancels the other approvers work', async () => {
    const request = await doubleSignature();
    const result = await decideApproval(
      users.a2,
      { approvalRequestId: request.id, decision: 'reject', note: 'Muy caro' },
      { now: NOW }
    );
    expect(result.data).toMatchObject({ status: 'rejected', rejections: 1 });
    expect(fake.rows('workItem').find((i) => i.ownerUserId === 'a1')).toMatchObject({
      status: 'cancelled',
    });
    expect(fake.rows('workItem').find((i) => i.ownerUserId === 'a2')).toMatchObject({
      status: 'done',
    });
    expect(decided).toEqual([expect.objectContaining({ status: 'rejected' })]);
    expect(fake.rows('operationalEvent').map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'approval.voted',
        'approval.rejected',
        'workitem.completed',
        'workitem.cancelled',
      ])
    );
  });

  it('bots can never vote', async () => {
    const request = await doubleSignature();
    const botActor = { ...users.a1, id: 'bot' };
    const result = await executeCommand(
      {
        commandId: 'bot-vote',
        type: 'approval.decide',
        actor: { type: 'ai', id: 'bot' },
        aggregate: { type: 'approval_request', id: request.id },
        payload: { approvalRequestId: request.id, decision: 'approve' },
      },
      botActor,
      { now: NOW }
    );
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
  });

  it('refuses expired requests', async () => {
    const request = await doubleSignature();
    request.expiresAt = new Date(NOW.getTime() - 1000);
    expect(
      await decideApproval(
        users.a1,
        { approvalRequestId: request.id, decision: 'approve' },
        { now: NOW }
      )
    ).toMatchObject({ status: 'rejected', errorCode: 'approval_expired' });
  });

  it('replays a repeated decision command without counting it twice', async () => {
    const request = await doubleSignature();
    const first = await decideApproval(
      users.a1,
      { approvalRequestId: request.id, decision: 'approve' },
      { now: NOW, commandId: 'vote-1' }
    );
    const again = await decideApproval(
      users.a1,
      { approvalRequestId: request.id, decision: 'approve' },
      { now: NOW, commandId: 'vote-1' }
    );
    expect(again).toMatchObject({ replayed: true, status: first.status, data: first.data });
    expect(fake.rows('approvalRequest')[0].decisions).toHaveLength(1);
  });
});

describe('listPendingApprovals', () => {
  it('lists what the actor can still decide', async () => {
    await ask({ amount: '60000' });
    const [request] = fake.rows('approvalRequest');

    expect((await listPendingApprovals(users.a1, { now: NOW })).map((r) => r.id)).toEqual([
      request.id,
    ]);
    expect(await listPendingApprovals(users.req, { now: NOW })).toEqual([]);
    expect(await listPendingApprovals(users.viewer, { now: NOW })).toEqual([]);

    await decideApproval(
      users.a1,
      { approvalRequestId: request.id, decision: 'approve' },
      { now: NOW }
    );
    expect(await listPendingApprovals(users.a1, { now: NOW })).toEqual([]);
    expect(await listPendingApprovals(users.a2, { now: NOW })).toEqual([
      expect.objectContaining({
        id: request.id,
        approvals: 1,
        requiredApprovals: 2,
        amount: '60000',
        scopeLabel: 'Compra',
      }),
    ]);
  });
});

/**
 * Plan 5.4: «si quien aprueba la propuesta de IA cumple la política, esa decisión se registra
 * también como primera firma de negocio para no pedir dos clics por lo mismo». La firma viaja
 * por `runWithApprovalFirstSignature` desde `approveProposal`, no por los argumentos del módulo.
 */
describe('primera firma heredada de la propuesta de IA', () => {
  const signature = { userId: 'a1', proposalId: 'prop-9', toolName: 'submitProcurementOrder' };

  it('una sola firma cierra la solicitud que abrió su propio clic', async () => {
    const result = await runWithApprovalFirstSignature(signature, () =>
      ask({ amount: '12000', requestedByUserId: 'a1' })
    );
    expect(result.data).toMatchObject({
      status: 'approved',
      autoApproved: false,
      firstSignatureByUserId: 'a1',
      workItemIds: [],
    });

    const [request] = fake.rows('approvalRequest');
    expect(request).toMatchObject({ status: 'approved', requiredApprovals: 1 });
    expect(parseApprovalDecisions(request.decisions)).toMatchObject([
      { userId: 'a1', decision: 'approve', note: expect.stringContaining('prop-9') },
    ]);
    expect(fake.rows('workItem')).toHaveLength(0);
    // `auto` significa «decidida en la transacción que la pidió»: el módulo no vuelve a subir
    // la versión de su agregado. `decidedByUserId` distingue la firma de la auto-aprobación.
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ status: 'approved', auto: true, decidedByUserId: 'a1' });
    expect(fake.rows('operationalEvent').map((e) => e.type)).toEqual([
      'approval.requested',
      'approval.voted',
      'approval.approved',
    ]);
  });

  it('con doble firma registra la primera y sólo pide la que falta a otra persona', async () => {
    const result = await runWithApprovalFirstSignature(signature, () =>
      ask({ amount: '60000', requestedByUserId: 'a1' })
    );
    expect(result.data).toMatchObject({ status: 'pending', firstSignatureByUserId: 'a1' });

    const [request] = fake.rows('approvalRequest');
    expect(request.requiredApprovals).toBe(2);
    expect(parseApprovalDecisions(request.decisions).map((v) => v.userId)).toEqual(['a1']);
    expect(fake.rows('workItem').map((i) => i.ownerUserId)).toEqual(['a2']);

    const second = await decideApproval(
      users.a2,
      { approvalRequestId: request.id, decision: 'approve' },
      { now: NOW }
    );
    expect(second.status).toBe('completed');
    expect(second.data).toMatchObject({ status: 'approved', approvals: 2 });
  });

  it('sin la firma heredada la misma orden ni siquiera reúne aprobadores; con ella avanza', async () => {
    const without = await ask({ targetId: 'po9', amount: '60000', requestedByUserId: 'a1' });
    expect(without).toMatchObject({ status: 'rejected', errorCode: 'no_approvers' });

    const withSignature = await runWithApprovalFirstSignature(signature, () =>
      ask({ targetId: 'po9', amount: '60000', requestedByUserId: 'a1' })
    );
    expect(withSignature.data).toMatchObject({ status: 'pending', firstSignatureByUserId: 'a1' });
  });

  it('no la registra si quien decidió no cumple la política del alcance', async () => {
    const result = await runWithApprovalFirstSignature({ ...signature, userId: 'viewer' }, () =>
      ask({ amount: '12000', requestedByUserId: 'viewer' })
    );
    expect(result.data).toMatchObject({ status: 'pending', firstSignatureByUserId: null });
    expect(parseApprovalDecisions(fake.rows('approvalRequest')[0].decisions)).toEqual([]);
    expect(
      fake
        .rows('workItem')
        .map((i) => i.ownerUserId)
        .sort()
    ).toEqual(['a1', 'a2']);
  });

  it('no la hereda una solicitud pedida por otra persona', async () => {
    const result = await runWithApprovalFirstSignature(signature, () =>
      ask({ amount: '12000', requestedByUserId: 'req' })
    );
    expect(result.data).toMatchObject({ status: 'pending', firstSignatureByUserId: null });
  });

  it('se consume una sola vez: una segunda aprobación del mismo clic ya no la hereda', async () => {
    const both = await runWithApprovalFirstSignature(signature, async () => [
      await ask({ targetId: 'po-a', amount: '12000', requestedByUserId: 'a1' }),
      await ask({ targetId: 'po-b', amount: '12000', requestedByUserId: 'a1' }),
    ]);
    expect(both[0].data?.firstSignatureByUserId).toBe('a1');
    expect(both[1].data?.firstSignatureByUserId).toBeNull();
    expect(both[1].data?.status).toBe('pending');
  });

  it('fuera de una decisión de propuesta nada cambia: el solicitante sigue sin firmar lo suyo', async () => {
    const result = await ask({ amount: '12000', requestedByUserId: 'a1' });
    expect(result.data).toMatchObject({ status: 'pending', firstSignatureByUserId: null });
    const [request] = fake.rows('approvalRequest');
    expect(parseApprovalDecisions(request.decisions)).toEqual([]);
    expect(await listPendingApprovals(users.a1, { now: NOW })).toEqual([]);
  });
});
