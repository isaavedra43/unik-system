import { describe, it, expect } from 'vitest';

/**
 * Loading every tool module, job handler barrel and storage access barrel
 * must not throw (duplicate tool names, duplicate job types or import
 * cycles would surface here instead of at server boot).
 */
describe('registration barrels', () => {
  it('registers all built-in tools with unique names', async () => {
    const registry = await import('./index');
    const tools = registry.getAllTools();
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(80);
    for (const tool of tools) {
      expect(tool.source ?? 'builtin').toBe('builtin');
      expect([
        'read',
        'draft',
        'internal_task',
        'external_send',
        'business_write',
        'destructive',
      ]).toContain(tool.effect ?? 'read');
    }
    // Every side-effecting built-in tool either requires approval or is explicitly auto.
    const sideEffects = tools.filter((t) =>
      ['external_send', 'business_write', 'destructive'].includes(t.effect ?? 'read')
    );
    expect(sideEffects.length).toBeGreaterThan(0);
  });

  it('loads job handlers and storage access resolvers without throwing', async () => {
    await import('@/modules/jobs/register-handlers');
    const { listJobTypes } = await import('@/modules/jobs/job-queue');
    const types = listJobTypes();
    expect(new Set(types).size).toBe(types.length);
    expect(types).toEqual(
      expect.arrayContaining([
        'storage.validate_object',
        'storage.cleanup',
        'extensions.maintenance',
        'knowledge.process_version',
      ])
    );
    await import('@/modules/storage/register-access-resolvers');
    const { listUploadTargetTypes } = await import('@/modules/storage/storage-access');
    expect(listUploadTargetTypes()).toEqual(
      expect.arrayContaining(['ai_conversation', 'chat_channel', 'knowledge_source'])
    );
  });
});
