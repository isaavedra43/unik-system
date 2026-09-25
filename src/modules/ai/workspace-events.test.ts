import { describe, expect, it } from 'vitest';
import { workspaceEventsForTool } from './workspace-events';
import type { ToolExecutionResult } from './tools/registry';
import {
  capabilitiesFromTools,
  detectRequiredCapabilities,
  forcedToolNames,
  describeSourcesUsed,
} from './capabilities';

const ok = (result: unknown): ToolExecutionResult => ({ success: true, result, durationMs: 1 });
const fail = (error: string): ToolExecutionResult => ({ success: false, error, durationMs: 1 });

describe('workspaceEventsForTool', () => {
  it('emits a tool event for every call and nothing more on failure', () => {
    const evs = workspaceEventsForTool('web_search', { query: 'x' }, fail('boom'));
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe('tool');
    expect(evs[0].payload.ok).toBe(false);
    expect(evs[0].payload.error).toBe('boom');
  });

  it('web_search emits the result pages', () => {
    const evs = workspaceEventsForTool('web_search', { query: 'arena gato' }, ok({
      results: [
        { url: 'https://a.com/1', title: 'A', content: 'x' },
        { url: 'https://b.com/2', title: 'B', snippet: 'y' },
      ],
    }));
    const pages = evs.find((e) => e.type === 'pages');
    expect(pages).toBeDefined();
    expect((pages!.payload.pages as unknown[]).length).toBe(2);
    expect(pages!.payload.source).toBe('web_search');
  });

  it('web_research emits sources as pages + readable content', () => {
    const evs = workspaceEventsForTool('web_research', { goal: 'g' }, ok({
      sources: [{ url: 'https://x.com', title: 'X', excerpt: 'texto largo' }],
    }));
    expect(evs.some((e) => e.type === 'pages')).toBe(true);
    const content = evs.find((e) => e.type === 'page_content');
    expect(content?.payload.markdown).toBe('texto largo');
  });

  it('fetch_url emits page + page_content for the reader view', () => {
    const evs = workspaceEventsForTool('fetch_url', { url: 'https://x.com' }, ok({
      url: 'https://x.com', title: 'T', content: '# md',
    }));
    expect(evs.some((e) => e.type === 'page_content')).toBe(true);
  });

  it('browser emits action + screen when a screenshot comes back', () => {
    const evs = workspaceEventsForTool('browser', { action: 'open', url: 'https://x.com' }, ok({
      ok: true, url: 'https://x.com', screenshotBase64: 'abc123',
    }));
    expect(evs.some((e) => e.type === 'browser')).toBe(true);
    const screen = evs.find((e) => e.type === 'screen');
    expect(screen?.payload.dataUrl).toContain('data:image/jpeg;base64,abc123');
  });

  it('oversized screenshots are dropped instead of bloating the event', () => {
    const evs = workspaceEventsForTool('browser', { action: 'open' }, ok({
      ok: true, screenshotBase64: 'x'.repeat(2_000_000),
    }));
    expect(evs.some((e) => e.type === 'screen')).toBe(false);
  });

  it('artifact results emit an artifact event with the download URL', () => {
    const evs = workspaceEventsForTool('generatePdfReport', { title: 'R' }, ok({
      artifactId: 'art1', title: 'Reporte', filename: 'r.pdf',
    }));
    const art = evs.find((e) => e.type === 'artifact');
    expect(art?.payload.artifactId).toBe('art1');
    expect(art?.payload.downloadUrl).toContain('/app/assistant/api/artifacts/art1/download');
  });

  it('media results emit a media event with the provider URL', () => {
    const evs = workspaceEventsForTool('generateImage', { prompt: 'logo' }, ok({
      medium: 'image', providerTool: 'higgsfield__gen', result: { imageUrl: 'https://cdn.x/i.png' },
    }));
    const m = evs.find((e) => e.type === 'media');
    expect(m?.payload.url).toBe('https://cdn.x/i.png');
  });
});

describe('capabilities', () => {
  const tools = (names: string[]) => names.map((name) => ({ name }));

  it('detects internet intent in plain Spanish', () => {
    const req = detectRequiredCapabilities('hola, busca en internet arena de gato en amazon');
    expect(req.some((r) => r.cap === 'web')).toBe(true);
  });

  it('detects browser intent (entra a / reserva)', () => {
    expect(detectRequiredCapabilities('entra a salsforce y revisa mis tareas').some((r) => r.cap === 'browser')).toBe(true);
    expect(detectRequiredCapabilities('hazme una reservación en este hotel').some((r) => r.cap === 'browser')).toBe(true);
  });

  it('detects media generation and analysis intent', () => {
    expect(detectRequiredCapabilities('créame una imagen del producto').some((r) => r.cap === 'media')).toBe(true);
    expect(detectRequiredCapabilities('analiza esta imagen que te mandé').some((r) => r.cap === 'media')).toBe(true);
  });

  it('forces the tools of an available capability into the menu', () => {
    const avail = tools(['web_search', 'fetch_url', 'universalSearch']);
    const forced = forcedToolNames([{ cap: 'web' }], avail);
    expect(forced.has('web_search')).toBe(true);
    expect(forced.has('fetch_url')).toBe(true);
  });

  it('reports capabilities from the real available tool set', () => {
    const caps = capabilitiesFromTools(tools(['web_search', 'universalSearch']));
    expect(caps.find((c) => c.id === 'web')?.available).toBe(true);
    expect(caps.find((c) => c.id === 'browser')?.available).toBe(false);
    expect(caps.find((c) => c.id === 'erp')?.available).toBe(true);
  });

  it('sources label derives only from tools that ran', () => {
    expect(describeSourcesUsed(['universalSearch'])).not.toContain('web');
    expect(describeSourcesUsed(['web_search', 'universalSearch'])).toContain('búsqueda web');
    expect(describeSourcesUsed(['web_research'])).toContain('investigación web');
    expect(describeSourcesUsed([])).toBe('');
  });
});
