import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { deflateRawSync } from 'zlib';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * Skill runner (allowed tools, approvals, conditions) and plugin importer
 * (traversal, secrets, manifest validation) with an in-memory Prisma stub.
 */

interface Row {
  [k: string]: unknown;
}
const db = {
  skill: new Map<string, Row>(),
  skillRun: new Map<string, Row>(),
  aiProposal: new Map<string, Row>(),
  auditLog: [] as Row[],
};
let seq = 0;
const nextId = () => `id${++seq}`;

vi.mock('@/lib/prisma', () => ({
  prisma: {
    skill: {
      findUnique: async ({ where }: { where: { key?: string; id?: string } }) =>
        [...db.skill.values()].find((s) => (where.key ? s.key === where.key : s.id === where.id)) ??
        null,
      create: async ({ data }: { data: Row }) => {
        const row = {
          id: nextId(),
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          extensionId: null,
          publishedAt: null,
          publishedBy: null,
          ...data,
        };
        db.skill.set(row.id as string, row);
        return row;
      },
    },
    skillRun: {
      create: async ({ data }: { data: Row }) => {
        const row = {
          id: nextId(),
          createdAt: new Date(),
          updatedAt: new Date(),
          completedAt: null,
          currentStep: null,
          proposalId: null,
          error: null,
          ...data,
        };
        db.skillRun.set(row.id as string, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = { ...db.skillRun.get(where.id)!, ...data };
        db.skillRun.set(where.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = db.skillRun.get(where.id);
        if (!row) return null;
        return { ...row, skill: db.skill.get(row.skillId as string) };
      },
    },
    aiProposal: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        db.aiProposal.get(where.id) ?? null,
    },
    auditLog: { create: async ({ data }: { data: Row }) => db.auditLog.push(data) },
  },
}));
vi.mock('@/modules/extensions/external-tools', () => ({
  refreshExternalTools: async () => undefined,
}));
vi.mock('@/modules/extensions/proposals-service', () => ({
  createProposal: async (input: { tool: { name: string; effect?: string }; summary: string }) => {
    const p = {
      id: nextId(),
      toolName: input.tool.name,
      summary: input.summary,
      effect: input.tool.effect ?? 'read',
      expiresAt: new Date(Date.now() + 60_000),
      status: 'pending',
      result: null,
    };
    db.aiProposal.set(p.id, p);
    return p;
  },
}));
vi.mock('@/modules/extensions/extension-audit', () => ({
  recordExtensionExecution: async () => undefined,
}));

import { registerTool, registerExternalTool } from '@/modules/ai/tools/registry';
import { createSkill, skillDefinitionSchema } from './skills-service';
import { resumeSkillRun, runSkillByKey } from './skill-runner';
import { importPluginPackage } from './plugin-importer';

const actor: CurrentUser = {
  id: 'u1',
  username: 'u1',
  name: 'User',
  email: null,
  mustChangePassword: false,
  roleKeys: ['ventas'],
  permissionKeys: ['assistant.use', 'sales_orders.view'] as never,
  isSuperAdmin: false,
};

let registered = false;
beforeEach(() => {
  db.skill.clear();
  db.skillRun.clear();
  db.aiProposal.clear();
  if (!registered) {
    registered = true;
    registerTool({
      name: 'lookupSales',
      description: '',
      category: 'sales',
      enabledByDefault: true,
      parameters: z.object({ customer: z.string() }),
      execute: async (_a, args) => ({
        total: (args as { customer: string }).customer === 'ACME' ? 2 : 0,
        items: [{ sku: 'M-1' }],
      }),
    });
    registerTool({
      name: 'forbiddenTool',
      description: '',
      category: 'system',
      enabledByDefault: true,
      parameters: z.object({}),
      execute: async () => ({ leaked: true }),
    });
    registerExternalTool({
      name: 'api_books__createQuote',
      description: '',
      category: 'extension',
      enabledByDefault: false,
      parameters: z.object({ customer: z.string(), sku: z.string() }),
      source: 'api',
      effect: 'business_write',
      allowedRoleKeys: ['ventas'],
      execute: async (_a, args) => ({ quoteId: 'Q-1', args }),
    });
  }
});

const definition = {
  inputs: [{ name: 'cliente', label: 'Cliente', type: 'string', required: true }],
  instructions: 'Preparar propuesta',
  references: [],
  allowedTools: ['lookupSales', 'api_books__createQuote'],
  steps: [
    { id: 'ventas', type: 'tool', tool: 'lookupSales', args: { customer: '{{inputs.cliente}}' } },
    {
      id: 'hay',
      type: 'check',
      condition: { path: 'steps.ventas.result.total', op: 'gt', value: 0 },
      message: 'Sin ventas',
      dependsOn: ['ventas'],
    },
    {
      id: 'nota',
      type: 'note',
      text: 'Cliente {{inputs.cliente}} con {{steps.ventas.result.total}} ventas',
      dependsOn: ['hay'],
    },
    {
      id: 'cotizar',
      type: 'tool',
      tool: 'api_books__createQuote',
      args: { customer: '{{inputs.cliente}}', sku: '{{steps.ventas.result.items[0].sku}}' },
      dependsOn: ['nota'],
    },
  ],
  completion: {
    conditions: [{ path: 'steps.cotizar.result.quoteId', op: 'exists' }],
    summaryTemplate: 'Cotización {{steps.cotizar.result.quoteId}}',
  },
  limits: { maxToolCalls: 10, maxDurationMs: 60_000 },
};

describe('skills', () => {
  it('rejects definitions that call tools outside allowedTools or have cycles', () => {
    const bad = skillDefinitionSchema.safeParse({
      ...definition,
      steps: [{ id: 'x', type: 'tool', tool: 'forbiddenTool', args: {} }],
    });
    expect(bad.success).toBe(false);
    const cyc = skillDefinitionSchema.safeParse({
      ...definition,
      steps: [
        { id: 'a', type: 'tool', tool: 'lookupSales', args: {}, dependsOn: ['b'] },
        { id: 'b', type: 'tool', tool: 'lookupSales', args: {}, dependsOn: ['a'] },
      ],
    });
    expect(cyc.success).toBe(false);
  });

  it('runs steps in order, pauses on the approval point and resumes after approval', async () => {
    await createSkill(actor, {
      key: 'propuesta',
      name: 'Propuesta',
      purpose: 'p',
      scope: 'personal',
      definition: definition as never,
    });
    const first = await runSkillByKey(actor, 'propuesta', { cliente: 'ACME' });
    expect(first.status).toBe('waiting_approval');
    expect(first.notes).toEqual(['Cliente ACME con 2 ventas']);
    expect(first.proposal?.toolName).toBe('api_books__createQuote');
    // The user approves; the proposal was executed elsewhere.
    const proposal = db.aiProposal.get(first.proposal!.id)!;
    proposal.status = 'executed';
    proposal.result = { quoteId: 'Q-1' };
    const resumed = await resumeSkillRun(actor, first.runId);
    expect(resumed.status).toBe('completed');
    expect(resumed.summary).toBe('Cotización Q-1');
  });

  it('fails cleanly when a check does not pass and when inputs are missing', async () => {
    await createSkill(actor, {
      key: 'propuesta2',
      name: 'P',
      purpose: 'p',
      scope: 'personal',
      definition: definition as never,
    });
    const res = await runSkillByKey(actor, 'propuesta2', { cliente: 'NADIE' });
    expect(res.status).toBe('failed');
    expect(res.error).toBe('Sin ventas');
    await expect(runSkillByKey(actor, 'propuesta2', {})).rejects.toThrow(
      /Falta la entrada requerida/
    );
  });

  it('refuses to run a stored definition whose steps use tools outside allowedTools (tampered row)', async () => {
    const skill = await createSkill(actor, {
      key: 'ok',
      name: 'ok',
      purpose: 'p',
      scope: 'personal',
      definition: definition as never,
    });
    const row = db.skill.get(skill.id)!;
    // Tampering the stored row (e.g. direct DB edit) so a step calls a tool outside the list:
    // the runner re-validates the definition before executing anything.
    row.definition = { ...definition, allowedTools: ['lookupSales'] };
    await expect(runSkillByKey(actor, 'ok', { cliente: 'ACME' })).rejects.toThrow(/inválida/);
  });

  it('team skills require skills.manage', async () => {
    await expect(
      createSkill(actor, {
        key: 'team',
        name: 't',
        purpose: 'p',
        scope: 'team',
        definition: definition as never,
      })
    ).rejects.toMatchObject({ status: 403 });
  });
});

function zip(entries: Array<{ name: string; data: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data, 'utf8');
    const compressed = deflateRawSync(data);
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const manifest = {
  manifestVersion: 1,
  namespace: 'plugin.demo',
  name: 'Demo',
  version: '1.0.0',
  api: { baseUrl: 'https://api.demo.com/v1', allowedHosts: ['api.demo.com'] },
  operations: [
    {
      operationId: 'getStock',
      method: 'GET',
      path: '/stock/{sku}',
      pathParams: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
      fixtures: { ok: { stock: 3 } },
      suggestedEffect: 'read',
    },
  ],
  skills: [{ key: 'revisar', name: 'Revisar', purpose: 'p', file: 'skills/revisar.json' }],
  templates: [{ key: 'correo', file: 'templates/correo.md' }],
  docs: ['README.md'],
};

describe('plugin importer', () => {
  it('imports a valid package with content hash', async () => {
    const pkg = zip([
      { name: 'manifest.json', data: JSON.stringify(manifest) },
      {
        name: 'skills/revisar.json',
        data: JSON.stringify({
          ...definition,
          allowedTools: ['lookupSales'],
          steps: [definition.steps[0]],
          completion: { conditions: [] },
        }),
      },
      { name: 'templates/correo.md', data: 'Hola {{cliente}}' },
      { name: 'README.md', data: '# Demo' },
    ]);
    const imported = await importPluginPackage(pkg);
    expect(imported.manifest.namespace).toBe('plugin.demo');
    expect(imported.skills).toHaveLength(1);
    expect(imported.templates[0].content).toBe('Hola {{cliente}}');
    expect(imported.contentHash).toHaveLength(64);
    const again = await importPluginPackage(pkg);
    expect(again.contentHash).toBe(imported.contentHash);
  });

  it('rejects traversal paths, secrets, scripts and disallowed files', async () => {
    await expect(
      importPluginPackage(zip([{ name: '../manifest.json', data: '{}' }]))
    ).rejects.toThrow(/Ruta no permitida/);
    await expect(
      importPluginPackage(
        zip([
          { name: 'manifest.json', data: JSON.stringify(manifest) },
          { name: 'run.js', data: 'x' },
        ])
      )
    ).rejects.toThrow(/no permitido/);
    await expect(
      importPluginPackage(
        zip([
          {
            name: 'manifest.json',
            data: JSON.stringify({ ...manifest, skills: [], templates: [], docs: [] }),
          },
          { name: 'notes.txt', data: 'api_key = "sk_live_abcdefghijklmnop"' },
        ])
      )
    ).rejects.toThrow(/secreto/);
    await expect(
      importPluginPackage(
        zip([
          {
            name: 'manifest.json',
            data: JSON.stringify({ ...manifest, skills: [], templates: [], docs: [] }),
          },
          { name: 'page.html', data: '<script>alert(1)</script>' },
        ])
      )
    ).rejects.toThrow(/scripts/);
    await expect(
      importPluginPackage(
        zip([
          {
            name: 'manifest.json',
            data: JSON.stringify({
              ...manifest,
              api: { baseUrl: 'http://api.demo.com', allowedHosts: [] },
              skills: [],
              templates: [],
              docs: [],
            }),
          },
        ])
      )
    ).rejects.toThrow(/HTTPS/);
  });
});
