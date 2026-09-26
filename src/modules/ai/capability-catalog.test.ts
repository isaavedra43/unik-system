import { describe, expect, it, vi } from 'vitest';

vi.mock('./ai-admin-config-service', () => ({ getAiSettings: async () => ({ enabledTools: [] }) }));

import { resolvePickedCapabilities } from './capability-catalog';
import type { CurrentUser } from '@/modules/auth/authorization';

const actor = { id: 'u1' } as CurrentUser;
const tools = [
  { name: 'web_search' },
  { name: 'web_research' },
  { name: 'fetch_url' },
  { name: 'browser' },
  { name: 'venueExec' },
  { name: 'runSkill' },
  { name: 'notion__search', extensionId: 'ext-notion' },
  { name: 'notion__create_page', extensionId: 'ext-notion' },
  { name: 'composioSearchTools' },
  { name: 'composioExecute' },
];

describe('resolvePickedCapabilities', () => {
  it('maps picks to the tools the actor can really run, with one directive each', async () => {
    const r = await resolvePickedCapabilities(
      actor,
      ['builtin:web', 'ext:ext-notion', 'skill:cotizar_rapido', 'app:gmail'],
      tools
    );
    expect([...r.tools]).toEqual(
      expect.arrayContaining([
        'web_search',
        'web_research',
        'fetch_url',
        'notion__search',
        'notion__create_page',
        'runSkill',
        'composioExecute',
      ])
    );
    expect(r.directives).toHaveLength(4);
    expect(r.directives[0]).toMatch(/INTERNET/);
  });

  it('drops unknown ids, unavailable powers and anything that looks like an injected tool', async () => {
    const r = await resolvePickedCapabilities(
      actor,
      ['builtin:media', 'ext:not-mine', 'deleteEverything', 'builtin:nope'],
      tools
    );
    expect(r.tools.size).toBe(0);
    expect(r.directives).toHaveLength(0);
  });

  it('sanitizes skill keys and app slugs', async () => {
    const r = await resolvePickedCapabilities(actor, ['skill:a"b\nc', 'app:GMAIL!'], tools);
    expect(r.labels).toEqual(['abc', 'gmail']);
    expect(r.directives.join(' ')).not.toMatch(/\n|!|a"b/);
    const empty = await resolvePickedCapabilities(actor, ['skill:"', 'app:!!!'], tools);
    expect(empty.directives).toHaveLength(0);
  });
});
