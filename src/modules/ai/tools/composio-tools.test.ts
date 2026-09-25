import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * Composio gateway contract: the effect is decided by UNIK per tool (never by
 * the model), reads run directly, side effects stop at an approval card, bad
 * arguments are rejected BEFORE asking for approval, and a revoked toolkit
 * blocks even an already-approved proposal.
 */

const proposals: Array<{
  id: string;
  toolName: string;
  effect: string;
  args: unknown;
  summary: string;
}> = [];
const executed: Array<{ slug: string; args: unknown }> = [];

const TOOLS: Record<string, { effect: string; schema: Record<string, unknown> }> = {
  GMAIL_FETCH_EMAILS: {
    effect: 'read',
    schema: { type: 'object', properties: { max_results: { type: 'integer' } } },
  },
  GMAIL_SEND_EMAIL: {
    effect: 'external_send',
    schema: {
      type: 'object',
      required: ['recipient_email', 'subject'],
      properties: { recipient_email: { type: 'string' }, subject: { type: 'string' } },
    },
  },
};
let revoked = false;

vi.mock('@/modules/composio/composio-client', () => ({
  isComposioConfigured: () => true,
}));
vi.mock('@/modules/composio/composio-service', () => ({
  resolveTool: async (_actor: unknown, slug: string) => {
    if (revoked) throw new Error('El toolkit "gmail" no está habilitado para tu rol.');
    const t = TOOLS[slug.toUpperCase()];
    if (!t) throw new Error(`La herramienta ${slug} no existe en Composio.`);
    return {
      meta: { slug: slug.toUpperCase(), toolkit: 'gmail', inputSchema: t.schema },
      effect: t.effect,
    };
  },
  executeComposioTool: async (_actor: unknown, slug: string, args: unknown) => {
    executed.push({ slug, args });
    return { tool: slug, toolkit: 'gmail', successful: true, data: { messages: [] } };
  },
}));
vi.mock('@/modules/extensions/proposals-service', () => ({
  createProposal: async (input: {
    tool: { name: string };
    effect?: string;
    args: unknown;
    summary: string;
  }) => {
    const p = {
      id: `prop-${proposals.length + 1}`,
      toolName: input.tool.name,
      effect: input.effect ?? 'business_write',
      args: input.args,
      summary: input.summary,
      expiresAt: new Date(Date.now() + 1000),
    };
    proposals.push(p);
    return p;
  },
}));
vi.mock('@/modules/extensions/extension-audit', () => ({
  recordExtensionExecution: async () => undefined,
}));

import { executeTool, loadAvailableTools } from './registry';
import './composio-tools';

const user: CurrentUser = {
  id: 'u1',
  username: 'u1',
  name: 'User',
  email: null,
  mustChangePassword: false,
  roleKeys: ['ventas'],
  permissionKeys: ['assistant.use'] as never,
  isSuperAdmin: false,
};
const enabled = [
  'composioListToolkits',
  'composioSearchTools',
  'composioConnect',
  'composioExecute',
];

beforeEach(() => {
  proposals.length = 0;
  executed.length = 0;
  revoked = false;
});

describe('composioExecute', () => {
  it('runs read tools directly', async () => {
    const r = await executeTool(
      'composioExecute',
      user,
      { tool: 'gmail_fetch_emails', arguments: { max_results: 3 } },
      { enabledToolNames: enabled }
    );
    expect(r.success).toBe(true);
    expect(r.needsApproval).toBeUndefined();
    expect(executed).toEqual([{ slug: 'GMAIL_FETCH_EMAILS', args: { max_results: 3 } }]);
  });

  it('stops sends at an approval card and does not execute', async () => {
    const r = await executeTool(
      'composioExecute',
      user,
      { tool: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'a@b.com', subject: 'Hola' } },
      { enabledToolNames: enabled }
    );
    expect(r.needsApproval).toBe(true);
    expect(executed).toHaveLength(0);
    expect(proposals[0]).toMatchObject({ toolName: 'composioExecute', effect: 'external_send' });
    expect(proposals[0].summary).toContain('GMAIL_SEND_EMAIL');
    expect(proposals[0].summary).toContain('a@b.com');
  });

  it('rejects invalid arguments BEFORE creating a proposal', async () => {
    const r = await executeTool(
      'composioExecute',
      user,
      { tool: 'GMAIL_SEND_EMAIL', arguments: { subject: 'x' } },
      { enabledToolNames: enabled }
    );
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('invalid_args');
    expect(r.error).toContain('recipient_email');
    expect(proposals).toHaveLength(0);
  });

  it('executes exactly the approved arguments when a proposal is presented', async () => {
    const r = await executeTool(
      'composioExecute',
      user,
      { tool: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'a@b.com', subject: 'Hola' } },
      { enabledToolNames: enabled, approvedProposalId: 'prop-1', skipApproval: true }
    );
    expect(r.success).toBe(true);
    expect(executed).toEqual([
      { slug: 'GMAIL_SEND_EMAIL', args: { recipient_email: 'a@b.com', subject: 'Hola' } },
    ]);
  });

  it('a revoked toolkit blocks even an approved proposal (fails closed)', async () => {
    revoked = true;
    const r = await executeTool(
      'composioExecute',
      user,
      { tool: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'a@b.com', subject: 'Hola' } },
      { enabledToolNames: enabled, approvedProposalId: 'prop-1', skipApproval: true }
    );
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('forbidden');
    expect(executed).toHaveLength(0);
  });

  it('unknown tools return a message the model can act on', async () => {
    const r = await executeTool(
      'composioExecute',
      user,
      { tool: 'MADE_UP_TOOL', arguments: {} },
      { enabledToolNames: enabled }
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain('no existe');
    expect(proposals).toHaveLength(0);
  });
});

describe('availability', () => {
  it('is offered to users with assistant.use when Composio is configured', async () => {
    const tools = await loadAvailableTools(user, enabled);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(enabled));
  });
});
