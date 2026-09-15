import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  upserts: [] as Array<{ create: Record<string, unknown>; update: Record<string, unknown> }>,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    aiUserPreference: {
      findUnique: vi.fn(async () => store.row),
      upsert: vi.fn(async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        store.upserts.push({ create: args.create, update: args.update });
        store.row = { ...args.update };
        return store.row;
      }),
    },
  },
}));

import {
  DEFAULT_PREFERENCES,
  DEFAULT_SURFACE_MODES,
  copilotModeFor,
  fallbackCopilotMode,
  getCopilotMode,
  getPreferences,
  mergePreferences,
  normalizeSurfaceModes,
  preferencesPatchSchema,
  updatePreferences,
} from './preferences-service';

const STORED_ROW = {
  mode: 'on_request',
  tone: 'profesional',
  language: 'es',
  depth: 'normal',
  format: 'markdown',
  customInstructions: null,
  memoryEnabled: true,
  inboxCopilotMode: 'paused',
  chatCopilotMode: 'on_demand',
  planMode: 'auto',
  surfaceModes: null as unknown,
};

beforeEach(() => {
  store.row = null;
  store.upserts = [];
});

describe('surface modes', () => {
  it('defaults: Mi trabajo active, the other operations surfaces on demand', () => {
    expect(DEFAULT_SURFACE_MODES).toEqual({ area: 'on_demand', case: 'on_demand', mywork: 'active', control_tower: 'on_demand' });
    expect(DEFAULT_PREFERENCES.surfaceModes).toEqual(DEFAULT_SURFACE_MODES);
  });

  it('normalizes stored Json: unknown kinds dropped, invalid modes back to default', () => {
    expect(normalizeSurfaceModes(null)).toEqual(DEFAULT_SURFACE_MODES);
    expect(normalizeSurfaceModes([])).toEqual(DEFAULT_SURFACE_MODES);
    expect(normalizeSurfaceModes({ area: 'active', case: 'loud', inbox: 'paused', mywork: 'paused' })).toEqual({
      area: 'active',
      case: 'on_demand',
      mywork: 'paused',
      control_tower: 'on_demand',
    });
  });

  it('copilotModeFor keeps the literal columns for inbox/chat and reads surfaceModes for the rest', () => {
    const prefs = {
      ...DEFAULT_PREFERENCES,
      inboxCopilotMode: 'paused' as const,
      chatCopilotMode: 'on_demand' as const,
      surfaceModes: { ...DEFAULT_SURFACE_MODES, area: 'active' as const },
    };
    expect(copilotModeFor(prefs, 'inbox')).toBe('paused');
    expect(copilotModeFor(prefs, 'chat')).toBe('on_demand');
    expect(copilotModeFor(prefs, 'area')).toBe('active');
    expect(copilotModeFor(prefs, 'case')).toBe('on_demand');
    expect(copilotModeFor(prefs, 'mywork')).toBe('active');
    expect(copilotModeFor(prefs, 'control_tower')).toBe('on_demand');
  });

  it('falls back per surface when preferences cannot be read', () => {
    expect(fallbackCopilotMode('inbox')).toBe('active');
    expect(fallbackCopilotMode('chat')).toBe('active');
    expect(fallbackCopilotMode('mywork')).toBe('active');
    expect(fallbackCopilotMode('area')).toBe('on_demand');
  });
});

describe('preferences patch', () => {
  it('accepts {surfaceModes: {[kind]: mode}} and rejects unknown kinds or modes', () => {
    expect(preferencesPatchSchema.safeParse({ surfaceModes: { area: 'active' } }).success).toBe(true);
    expect(preferencesPatchSchema.safeParse({ surfaceModes: { inbox: 'paused', control_tower: 'active' } }).success).toBe(true);
    expect(preferencesPatchSchema.safeParse({ surfaceModes: { warehouse: 'active' } }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ surfaceModes: { area: 'loud' } }).success).toBe(false);
    // Partial parse never invents the other surfaces (so a PATCH cannot reset them).
    const parsed = preferencesPatchSchema.parse({ surfaceModes: { case: 'paused' } });
    expect(parsed.surfaceModes).toEqual({ case: 'paused' });
    expect(parsed).not.toHaveProperty('inboxCopilotMode');
  });

  it('mergePreferences fuses surfaceModes and routes inbox/chat to their columns', () => {
    const current = { ...DEFAULT_PREFERENCES, surfaceModes: { ...DEFAULT_SURFACE_MODES, area: 'active' as const } };
    const merged = mergePreferences(current, { surfaceModes: { case: 'paused', chat: 'on_demand' } });
    expect(merged.surfaceModes).toEqual({ area: 'active', case: 'paused', mywork: 'active', control_tower: 'on_demand' });
    expect(merged.chatCopilotMode).toBe('on_demand');
    expect(merged.inboxCopilotMode).toBe('active');
    // An explicit column value wins over surfaceModes.inbox; undefined values never reset anything.
    const explicit = mergePreferences(current, { inboxCopilotMode: 'paused', surfaceModes: { inbox: 'active', mywork: undefined } });
    expect(explicit.inboxCopilotMode).toBe('paused');
    expect(explicit.surfaceModes.mywork).toBe('active');
  });
});

describe('preferences persistence', () => {
  it('reads surfaceModes from the Json column', async () => {
    store.row = { ...STORED_ROW, surfaceModes: { control_tower: 'active' } };
    const prefs = await getPreferences('u1');
    expect(prefs.inboxCopilotMode).toBe('paused');
    expect(prefs.surfaceModes).toEqual({ ...DEFAULT_SURFACE_MODES, control_tower: 'active' });
    expect(await getCopilotMode('u1', 'control_tower')).toBe('active');
    expect(await getCopilotMode('u1', 'inbox')).toBe('paused');
  });

  it('a user without a row gets the defaults for every surface', async () => {
    const prefs = await getPreferences('nobody');
    expect(prefs.surfaceModes).toEqual(DEFAULT_SURFACE_MODES);
    expect(await getCopilotMode('nobody', 'mywork')).toBe('active');
    expect(await getCopilotMode('nobody', 'case')).toBe('on_demand');
  });

  it('updatePreferences changes one surface and keeps the others and the columns', async () => {
    store.row = { ...STORED_ROW, surfaceModes: { area: 'active', mywork: 'paused' } };
    const result = await updatePreferences('u1', { surfaceModes: { case: 'active' } });
    expect(result.surfaceModes).toEqual({ area: 'active', case: 'active', mywork: 'paused', control_tower: 'on_demand' });
    expect(result.inboxCopilotMode).toBe('paused');
    expect(result.chatCopilotMode).toBe('on_demand');
    const written = store.upserts[0];
    expect(written.update.surfaceModes).toEqual({ area: 'active', case: 'active', mywork: 'paused', control_tower: 'on_demand' });
    expect(written.create).toMatchObject({ userId: 'u1', inboxCopilotMode: 'paused' });
  });
});
