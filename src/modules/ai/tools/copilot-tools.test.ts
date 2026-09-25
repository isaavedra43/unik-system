import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * sendInternalChatMessage — recipient resolution happens in prepareArgs (before
 * the approval card), so the proposal stores the CONCRETE destination: either a
 * channelId the actor belongs to or a recipientUserId whose DM is created on send.
 */

const proposals: Array<{ id: string; args: Record<string, unknown>; summary: string }> = [];
const sentMessages: Array<Record<string, unknown>> = [];
const dmCalls: string[] = [];

const USERS = [
  { id: 'u-karla', name: 'Karla Núñez', username: 'karlan', email: null },
  { id: 'u-juan1', name: 'Juan Pérez', username: 'juanp', email: null },
  { id: 'u-juan2', name: 'Juan López', username: 'juanl', email: null },
];

const member = (userId: string, name: string) => ({
  userId,
  name,
  username: name,
  role: 'member',
  status: 'offline',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
});

const CHANNELS = [
  {
    id: 'ch-ventas',
    type: 'group',
    name: 'Ventas',
    members: [member('u-self', 'Yo'), member('u-karla', 'Karla Núñez')],
  },
  {
    id: 'ch-dm-juan1',
    type: 'dm',
    name: null,
    members: [member('u-self', 'Yo'), member('u-juan1', 'Juan Pérez')],
  },
];

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string; isActive?: boolean } }) =>
        USERS.find((u) => u.id === where.id) ?? null,
    },
  },
}));

vi.mock('@/modules/chat/chat-service', () => ({
  getChannel: async (id: string, userId: string) =>
    CHANNELS.find((c) => c.id === id && c.members.some((m) => m.userId === userId)) ?? null,
  listUserChannels: async () => CHANNELS,
  createDmChannel: async (_actor: unknown, otherUserId: string) => {
    dmCalls.push(otherUserId);
    return { id: `dm-${otherUserId}`, isNew: true };
  },
  sendMessage: async (_actor: unknown, input: Record<string, unknown>) => {
    sentMessages.push(input);
    return {
      id: 'msg-1',
      channelId: input.channelId as string,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  },
}));

vi.mock('@/modules/notifications/audience', () => ({
  findUsersByQuery: async (q: string) => {
    const lower = q.toLowerCase();
    return USERS.filter(
      (u) => u.name.toLowerCase().includes(lower) || u.username.toLowerCase().includes(lower)
    );
  },
}));

vi.mock('@/modules/extensions/proposals-service', () => ({
  createProposal: async (input: { args: Record<string, unknown>; summary: string }) => {
    const p = {
      id: `prop-${proposals.length + 1}`,
      args: input.args,
      summary: input.summary,
      effect: 'external_send',
      expiresAt: new Date(Date.now() + 60_000),
    };
    proposals.push(p);
    return p;
  },
}));

vi.mock('@/modules/extensions/extension-audit', () => ({
  recordExtensionExecution: async () => {},
}));

vi.mock('@/modules/copilot/knowledge-service', () => ({ searchKnowledge: async () => [] }));
vi.mock('@/modules/copilot/memory-service', () => ({
  addMemory: async () => ({}),
  deleteMemory: async () => true,
  listMemory: async () => [],
}));
vi.mock('../artifact-share', () => ({
  markdownLinksToPlain: (t: string) => t,
  rewriteArtifactLinksForSharing: async (t: string) => ({ text: t }),
}));
vi.mock('@/modules/comms/normalize', () => ({
  previewText: (t: string | null | undefined, max = 120) => (t ?? '').slice(0, max),
}));

import { executeTool } from './registry';
import './copilot-tools';

const actor = (overrides: Partial<CurrentUser> = {}): CurrentUser => ({
  id: 'u-self',
  username: 'me',
  name: 'Yo',
  email: null,
  mustChangePassword: false,
  roleKeys: ['ventas'],
  permissionKeys: ['assistant.use', 'chat.use'] as never,
  isSuperAdmin: false,
  ...overrides,
});

beforeEach(() => {
  proposals.length = 0;
  sentMessages.length = 0;
  dmCalls.length = 0;
});

describe('sendInternalChatMessage — destinatario', () => {
  it('resuelve un nombre de persona único a un DM (recipientUserId) en la propuesta', async () => {
    const res = await executeTool('sendInternalChatMessage', actor(), {
      recipient: 'Karla',
      content: 'hola',
    });
    expect(res.needsApproval).toBe(true);
    expect(proposals[0].args).toMatchObject({ recipientUserId: 'u-karla' });
    expect(proposals[0].summary).toContain('chat con Karla Núñez');
  });

  it('resuelve un nombre de grupo a su channelId', async () => {
    const res = await executeTool('sendInternalChatMessage', actor(), {
      recipient: 'Ventas',
      content: 'hola equipo',
    });
    expect(res.needsApproval).toBe(true);
    expect(proposals[0].args).toMatchObject({ channelId: 'ch-ventas' });
    expect(proposals[0].summary).toContain('grupo "Ventas"');
  });

  it('rechaza un destinatario ambiguo listando los candidatos', async () => {
    // "Juan" cubre el DM con Juan Pérez y al usuario Juan López.
    const res = await executeTool('sendInternalChatMessage', actor(), {
      recipient: 'Juan',
      content: 'hola',
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('invalid_args');
    expect(res.error).toContain('ambiguo');
    expect(res.error).toContain('Juan López');
    expect(proposals).toHaveLength(0);
  });

  it('rechaza cuando falta el destinatario', async () => {
    const res = await executeTool('sendInternalChatMessage', actor(), { content: 'hola' });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('invalid_args');
    expect(proposals).toHaveLength(0);
  });

  it('tras la aprobación crea el DM y envía con prioridad', async () => {
    const res = await executeTool(
      'sendInternalChatMessage',
      actor(),
      { recipientUserId: 'u-karla', recipient: 'Karla', content: 'hola', priority: 'urgent' },
      { approvedProposalId: 'prop-1', skipApproval: true }
    );
    expect(res.success).toBe(true);
    expect(dmCalls).toEqual(['u-karla']);
    expect(sentMessages[0]).toMatchObject({
      channelId: 'dm-u-karla',
      content: 'hola',
      priority: 'urgent',
    });
    expect((res.result as { sentTo: string }).sentTo).toContain('dm-u-karla');
  });

  it('tras la aprobación con channelId envía directo sin crear DM', async () => {
    const res = await executeTool(
      'sendInternalChatMessage',
      actor(),
      { channelId: 'ch-ventas', content: 'aviso' },
      { approvedProposalId: 'prop-2', skipApproval: true }
    );
    expect(res.success).toBe(true);
    expect(dmCalls).toHaveLength(0);
    expect(sentMessages[0]).toMatchObject({ channelId: 'ch-ventas', content: 'aviso' });
    expect((res.result as { sentTo: string }).sentTo).toContain('Ventas');
  });

  it('rechaza un DM al propio usuario', async () => {
    const res = await executeTool('sendInternalChatMessage', actor(), {
      recipientUserId: 'u-self',
      content: 'nota',
    });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('invalid_args');
  });
});
