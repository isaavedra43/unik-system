import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * Common executor contract: enablement, permission, roles, approval,
 * timeouts, result bounds and audit — for built-in and external tools alike.
 */

const proposals: Array<{ id: string; toolName: string; summary: string; effect: string }> = [];
const executions: Array<Record<string, unknown>> = [];

vi.mock('@/modules/extensions/proposals-service', () => ({
  createProposal: async (input: { tool: { name: string; effect?: string }; summary: string }) => {
    const p = {
      id: `prop-${proposals.length + 1}`,
      toolName: input.tool.name,
      summary: input.summary,
      effect: input.tool.effect ?? 'read',
      expiresAt: new Date(Date.now() + 1000),
    };
    proposals.push(p);
    return p;
  },
}));
vi.mock('@/modules/extensions/extension-audit', () => ({
  recordExtensionExecution: async (record: Record<string, unknown>) => {
    executions.push(record);
  },
}));

import {
  clearExternalTools,
  executeTool,
  getAvailableTools,
  loadAvailableTools,
  registerExternalTool,
  registerTool,
} from './registry';

const user = (overrides: Partial<CurrentUser> = {}): CurrentUser => ({
  id: 'u1',
  username: 'u1',
  name: 'User',
  email: null,
  mustChangePassword: false,
  roleKeys: ['ventas'],
  permissionKeys: ['assistant.use', 'sales_orders.view'] as never,
  isSuperAdmin: false,
  ...overrides,
});

let registered = false;

beforeEach(() => {
  proposals.length = 0;
  executions.length = 0;
  clearExternalTools();
  if (!registered) {
    registered = true;
    registerTool({
      name: 'testRead',
      description: 'read',
      category: 'system',
      enabledByDefault: true,
      parameters: z.object({ q: z.string() }),
      requiredPermission: 'sales_orders.view',
      execute: async (_a, args) => ({ echo: (args as { q: string }).q }),
    });
    registerTool({
      name: 'testSlow',
      description: 'slow',
      category: 'system',
      enabledByDefault: true,
      parameters: z.object({}),
      timeoutMs: 30,
      execute: () => new Promise((resolve) => setTimeout(() => resolve({ late: true }), 200)),
    });
    registerTool({
      name: 'testDestructiveAuto',
      description: 'maintenance',
      category: 'system',
      enabledByDefault: true,
      parameters: z.object({}),
      effect: 'destructive',
      approvalPolicy: 'auto',
      execute: async () => ({ cleaned: 1 }),
    });
  }
});

function externalTool(overrides: Record<string, unknown> = {}) {
  registerExternalTool({
    name: 'api_proveedor__createOrder',
    description: 'Crea pedido',
    category: 'extension',
    enabledByDefault: false,
    parameters: z.object({ sku: z.string(), qty: z.number().int().min(1) }),
    requiredPermission: 'assistant.use',
    source: 'api',
    version: 'v1',
    effect: 'business_write',
    approvalPolicy: 'require_approval',
    allowedRoleKeys: ['ventas'],
    extensionId: 'ext1',
    capabilityId: 'cap1',
    maxResultBytes: 200,
    execute: async (_a, args) => ({ ok: true, args }),
    ...overrides,
  });
}

describe('executeTool — built-in', () => {
  it('runs an enabled tool with permission and validates args', async () => {
    const res = await executeTool(
      'testRead',
      user(),
      { q: 'x' },
      { enabledToolNames: ['testRead'] }
    );
    expect(res.success).toBe(true);
    expect(res.result).toEqual({ echo: 'x' });
    const bad = await executeTool('testRead', user(), { q: 1 }, { enabledToolNames: ['testRead'] });
    expect(bad.success).toBe(false);
    expect(bad.errorCode).toBe('invalid_args');
  });

  it('refuses a disabled tool even when invoked directly', async () => {
    const res = await executeTool('testRead', user(), { q: 'x' }, { enabledToolNames: ['other'] });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('disabled');
  });

  it('refuses without permission and for unknown tools', async () => {
    const res = await executeTool(
      'testRead',
      user({ permissionKeys: ['assistant.use'] as never }),
      { q: 'x' }
    );
    expect(res.errorCode).toBe('forbidden');
    const unknown = await executeTool('nope', user(), {});
    expect(unknown.errorCode).toBe('unknown_tool');
  });

  it('enforces the timeout', async () => {
    const res = await executeTool('testSlow', user(), {});
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('timeout');
  });

  it('auto-approved destructive maintenance runs without a proposal', async () => {
    const res = await executeTool('testDestructiveAuto', user(), {});
    expect(res.success).toBe(true);
    expect(proposals).toHaveLength(0);
  });

  it('lists only enabled tools the actor may use', () => {
    const tools = getAvailableTools(user(), ['testRead', 'testSlow']);
    expect(tools.map((t) => t.name)).toEqual(['testRead', 'testSlow']);
    const noPerm = getAvailableTools(user({ permissionKeys: [] as never }), [
      'testRead',
      'testSlow',
    ]);
    expect(noPerm.map((t) => t.name)).toEqual(['testSlow']);
  });
});

describe('executeTool — external capabilities', () => {
  it('creates a proposal instead of running a business_write tool and audits it', async () => {
    externalTool();
    const res = await executeTool(
      'api_proveedor__createOrder',
      user(),
      { sku: 'A', qty: 2 },
      { conversationId: 'c1' }
    );
    expect(res.success).toBe(false);
    expect(res.needsApproval).toBe(true);
    expect(res.proposal?.id).toBe('prop-1');
    expect(proposals[0].effect).toBe('business_write');
    expect(executions[0]).toMatchObject({
      status: 'needs_approval',
      toolName: 'api_proveedor__createOrder',
    });
  });

  it('executes the approved proposal exactly once with skipApproval', async () => {
    externalTool();
    const res = await executeTool(
      'api_proveedor__createOrder',
      user(),
      { sku: 'A', qty: 2 },
      { approvedProposalId: 'prop-1', skipApproval: true }
    );
    expect(res.success).toBe(true);
    expect(proposals).toHaveLength(0);
    expect(executions[0]).toMatchObject({ status: 'success', proposalId: 'prop-1' });
  });

  it('denies actors whose roles are not allowed, and unavailable (suspended) tools', async () => {
    externalTool();
    const res = await executeTool('api_proveedor__createOrder', user({ roleKeys: ['almacen'] }), {
      sku: 'A',
      qty: 1,
    });
    expect(res.errorCode).toBe('forbidden');
    expect(executions.at(-1)).toMatchObject({ status: 'denied', errorCode: 'role' });

    clearExternalTools();
    externalTool({ isAvailable: async () => false });
    const suspended = await executeTool(
      'api_proveedor__createOrder',
      user(),
      { sku: 'A', qty: 1 },
      { skipApproval: true }
    );
    expect(suspended.errorCode).toBe('unavailable');
  });

  it('bounds large results and flags uncertain outcomes', async () => {
    externalTool({
      effect: 'read',
      approvalPolicy: 'auto',
      execute: async () => ({ big: 'x'.repeat(1000) }),
    });
    const res = await executeTool('api_proveedor__createOrder', user(), { sku: 'A', qty: 1 });
    expect(res.success).toBe(true);
    expect(res.truncated).toBe(true);
    expect((res.result as { truncated: boolean }).truncated).toBe(true);

    clearExternalTools();
    externalTool({ execute: async () => ({ uncertain: true, error: 'timeout after send' }) });
    const unc = await executeTool(
      'api_proveedor__createOrder',
      user(),
      { sku: 'A', qty: 1 },
      { skipApproval: true }
    );
    expect(unc.uncertain).toBe(true);
    expect(executions.at(-1)).toMatchObject({ status: 'pending_review' });
  });

  it('loads external tools per role and context, never through enabledToolNames', async () => {
    externalTool({ contextTags: ['/app/sales'] });
    const none = await loadAvailableTools(user(), ['testRead'], { page: '/app/products' });
    expect(none.map((t) => t.name)).toEqual(['testRead']);
    const sales = await loadAvailableTools(user(), ['testRead'], { page: '/app/sales/orders' });
    expect(sales.map((t) => t.name)).toEqual(['testRead', 'api_proveedor__createOrder']);
    const wrongRole = await loadAvailableTools(
      user({ roleKeys: ['almacen'] }),
      ['testRead', 'api_proveedor__createOrder'],
      { page: '/app/sales' }
    );
    expect(wrongRole.map((t) => t.name)).toEqual(['testRead']);
    expect(() =>
      registerExternalTool({
        name: 'testRead',
        description: '',
        category: 'extension',
        enabledByDefault: false,
        parameters: z.object({}),
        execute: async () => null,
      })
    ).toThrow(/collides/);
  });
});
