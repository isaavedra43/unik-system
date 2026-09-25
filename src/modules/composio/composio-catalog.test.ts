import { describe, expect, it } from 'vitest';
import { mergeCatalogItems, normalizeCatalogItem, type RawToolkitItem } from './composio-catalog';

const raw = (over: Partial<RawToolkitItem> = {}): RawToolkitItem => ({
  slug: 'GITHUB',
  name: 'GitHub',
  no_auth: false,
  auth_schemes: ['oauth2', 'api_key'],
  composio_managed_auth_schemes: ['oauth2'],
  meta: {
    description: 'Repositorios, issues y PRs.',
    logo: 'https://cdn.composio.dev/logos/github.svg',
    app_url: 'https://github.com',
    tools_count: 42,
    categories: [
      { slug: 'dev-tools', name: 'Developer Tools' },
      { slug: 'collab', name: 'Collaboration' },
    ],
  },
  ...over,
});

describe('normalizeCatalogItem', () => {
  it('maps the raw snake_case payload to the catalog shape', () => {
    expect(normalizeCatalogItem(raw())).toEqual({
      slug: 'github',
      name: 'GitHub',
      description: 'Repositorios, issues y PRs.',
      logo: 'https://cdn.composio.dev/logos/github.svg',
      categories: ['Developer Tools', 'Collaboration'],
      authSchemes: ['OAUTH2', 'API_KEY'],
      managedAuthSchemes: ['OAUTH2'],
      toolsCount: 42,
      appUrl: 'https://github.com',
      noAuth: false,
    });
  });

  it('lowercases the slug and rejects items without slug or name', () => {
    expect(normalizeCatalogItem(raw())?.slug).toBe('github');
    expect(normalizeCatalogItem(raw({ slug: '  ' }))).toBeNull();
    expect(normalizeCatalogItem(raw({ slug: undefined }))).toBeNull();
    expect(normalizeCatalogItem(raw({ name: '' }))).toBeNull();
  });

  it('handles missing meta gracefully', () => {
    const item = normalizeCatalogItem(raw({ meta: null, logo: 'https://x/l.png' }));
    expect(item).toMatchObject({
      description: '',
      logo: 'https://x/l.png',
      categories: [],
      toolsCount: 0,
      appUrl: null,
    });
  });

  it('clamps negative/absent tool counts and truncates long descriptions', () => {
    expect(normalizeCatalogItem(raw({ meta: { tools_count: -3 } }))?.toolsCount).toBe(0);
    const long = normalizeCatalogItem(raw({ meta: { description: 'x'.repeat(500) } }));
    expect(long?.description.length).toBe(200);
  });

  it('marks no-auth toolkits', () => {
    expect(normalizeCatalogItem(raw({ no_auth: true }))?.noAuth).toBe(true);
  });
});

describe('mergeCatalogItems', () => {
  it('dedupes by slug keeping the first occurrence', () => {
    const a = raw({ slug: 'github', name: 'GitHub' });
    const b = raw({ slug: 'GitHub', name: 'GitHub v2' });
    const c = raw({ slug: 'slack', name: 'Slack' });
    const merged = mergeCatalogItems([a, b, c]);
    expect(merged.map((i) => i.slug)).toEqual(['github', 'slack']);
    expect(merged[0].name).toBe('GitHub');
  });

  it('skips unprocessable rows without failing the page', () => {
    const merged = mergeCatalogItems([
      raw(),
      { slug: '', name: 'broken' },
      raw({ slug: 'x', name: 'X' }),
    ]);
    expect(merged).toHaveLength(2);
  });
});
