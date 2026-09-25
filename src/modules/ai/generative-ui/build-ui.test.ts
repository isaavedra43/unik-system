import { describe, expect, it } from 'vitest';
import {
  buildUiComponents,
  extractMediaItems,
  extractMcpUiResources,
  extractUiFromData,
  safeHttpUrl,
  sanitizeViewSpec,
} from './build-ui';

describe('generative-ui builder', () => {
  it('turns Gmail-like messages into a record list', () => {
    const ui = buildUiComponents({
      toolName: 'composioExecute',
      success: true,
      result: {
        tool: 'GMAIL_FETCH_EMAILS',
        toolkit: 'gmail',
        successful: true,
        data: {
          messages: [
            {
              messageId: 'a1',
              subject: 'Cotización piel',
              sender: 'Ana <ana@x.com>',
              snippet: 'Te envío los precios…',
              messageTimestamp: '2026-09-20T10:00:00Z',
              labelIds: ['INBOX'],
            },
            {
              messageId: 'a2',
              subject: 'Junta lunes',
              sender: 'Luis <luis@x.com>',
              snippet: 'Confirmo asistencia',
              messageTimestamp: '2026-09-21T10:00:00Z',
            },
          ],
        },
      },
    });
    expect(ui).toHaveLength(1);
    expect(ui[0]).toMatchObject({ type: 'records', total: 2 });
    const first = (ui[0] as { items: Array<{ title: string; subtitle?: string; date?: string }> })
      .items[0];
    expect(first.title).toBe('Cotización piel');
    expect(first.subtitle).toContain('Ana');
    expect(first.date).toBe('2026-09-20T10:00:00Z');
  });

  it('maps calendar events (nested start/end, htmlLink)', () => {
    const ui = extractUiFromData(
      {
        items: [
          {
            id: 'e1',
            summary: 'Entrega obra',
            start: { dateTime: '2026-09-25T09:00:00-06:00' },
            htmlLink: 'https://calendar.google.com/x',
            location: 'Bodega',
          },
        ],
      },
      'Google Calendar'
    );
    expect(ui[0]).toMatchObject({ type: 'records' });
    const item = (ui[0] as unknown as { items: Array<Record<string, unknown>> }).items[0];
    expect(item.url).toBe('https://calendar.google.com/x');
    expect(item.date).toBe('2026-09-25T09:00:00-06:00');
  });

  it('renders spreadsheet values as a table', () => {
    const ui = extractUiFromData({
      values: [
        ['Producto', 'Cantidad'],
        ['Piel', 4],
        ['Loseta', 9],
      ],
    });
    expect(ui[0]).toMatchObject({ type: 'table', columns: ['Producto', 'Cantidad'], total: 2 });
    expect((ui[0] as { rows: string[][] }).rows[1]).toEqual(['Loseta', '9']);
  });

  it('counts omitted rows from shrunk payloads', () => {
    const ui = extractUiFromData({
      items: [{ title: 'A', status: 'open' }, { title: 'B', status: 'closed' }, { _omitted: 40 }],
    });
    expect(ui[0]).toMatchObject({ type: 'records', total: 42 });
  });

  it('shows a connect card instead of an error when the account is missing', () => {
    const ui = buildUiComponents({
      toolName: 'composioExecute',
      success: true,
      result: {
        tool: 'SLACK_SEND',
        toolkit: 'slack',
        successful: false,
        needsConnection: true,
        error: 'x',
      },
    });
    expect(ui).toEqual([{ type: 'connect', toolkit: 'slack', name: 'Slack', connected: false }]);
  });

  it('flags uncertain writes as a warning', () => {
    const ui = buildUiComponents({
      toolName: 'composioExecute',
      success: true,
      result: {
        tool: 'GMAIL_SEND_EMAIL',
        successful: false,
        uncertain: true,
        error: 'Tiempo agotado',
      },
    });
    expect(ui[0]).toMatchObject({ type: 'notice', tone: 'warning' });
  });

  it('never lets non-http URLs through', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeHttpUrl('data:text/html,<script>')).toBeUndefined();
    expect(safeHttpUrl('https://ok.com/a')).toBe('https://ok.com/a');
    const ui = extractUiFromData([{ title: 'x', url: 'javascript:alert(1)', description: 'd' }]);
    expect((ui[0] as { items: Array<{ url?: string }> }).items[0].url).toBeUndefined();
  });

  it('only accepts ui:// html resources from MCP results and caps their size', () => {
    const ok = extractMcpUiResources({
      content: [
        {
          type: 'resource',
          resource: { uri: 'ui://chart/1', mimeType: 'text/html', text: '<b>hi</b>' },
        },
      ],
    });
    expect(ok).toHaveLength(1);
    expect(
      extractMcpUiResources({
        content: [
          {
            type: 'resource',
            resource: { uri: 'https://evil', mimeType: 'text/html', text: '<b>x</b>' },
          },
        ],
      })
    ).toHaveLength(0);
    expect(
      extractMcpUiResources({
        content: [
          {
            type: 'resource',
            resource: { uri: 'ui://big', mimeType: 'text/html', text: 'x'.repeat(200_000) },
          },
        ],
      })
    ).toHaveLength(0);
    expect(
      extractMcpUiResources({
        content: [
          {
            type: 'resource',
            resource: { uri: 'ui://l', mimeType: 'text/uri-list', text: 'http://insecure.com' },
          },
        ],
      })
    ).toHaveLength(0);
  });

  it('ignores failures and non-object results', () => {
    expect(
      buildUiComponents({ toolName: 'composioExecute', success: false, result: { error: 'x' } })
    ).toEqual([]);
    expect(buildUiComponents({ toolName: 'queryProducts', success: true, result: 'text' })).toEqual(
      []
    );
  });

  it('sanitizes a chart spec from renderView into a closed-vocabulary component', () => {
    const ui = buildUiComponents({
      toolName: 'renderView',
      success: true,
      result: {
        view: {
          type: 'chart',
          chart: 'bar',
          title: 'Ventas por método',
          unit: 'MXN',
          labels: ['Efectivo', 'Crédito', '<script>x</script>'.repeat(10)],
          series: [{ name: 'Hoy', data: [10, 5, 'NaN', 2] }, { name: 'Ayer', data: [] }, 'garbage'],
        },
      },
    });
    expect(ui).toHaveLength(1);
    const chart = ui[0] as {
      type: string;
      chart: string;
      labels: string[];
      series: Array<{ name?: string; data: number[] }>;
    };
    expect(chart.type).toBe('chart');
    expect(chart.chart).toBe('bar');
    expect(chart.labels).toHaveLength(3);
    // empty/garbage series dropped; non-finite numbers coerced to 0
    expect(chart.series).toHaveLength(1);
    expect(chart.series[0].data).toEqual([10, 5, 0, 2]);
  });

  it('sanitizes kpi, progress and timeline specs', () => {
    const kpi = sanitizeViewSpec({
      type: 'kpi',
      title: 'Corte',
      items: [
        { label: 'Ventas', value: '$12,400', delta: '+8%', tone: 'success' },
        { label: 'Sin valor', tone: 'bogus-tone' },
      ],
    });
    expect(kpi).toMatchObject({ type: 'kpi' });
    const items = (kpi as { items: Array<{ label: string; tone: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0].tone).toBe('success');

    const progress = sanitizeViewSpec({
      type: 'progress',
      steps: [
        { title: 'Descargar reporte', status: 'done' },
        { title: 'Conciliar', status: 'hacking' },
        { status: 'pending' },
      ],
    });
    expect(progress).toMatchObject({ type: 'progress' });
    const steps = (progress as { steps: Array<{ title: string; status: string }> }).steps;
    expect(steps).toHaveLength(2);
    expect(steps[1].status).toBe('pending'); // invalid status → pending

    const timeline = sanitizeViewSpec({
      type: 'timeline',
      events: [{ label: 'Creada', at: '09:00', tone: 'danger' }, { detail: 'sin label' }],
    });
    expect(timeline).toMatchObject({ type: 'timeline' });
    expect((timeline as { events: unknown[] }).events).toHaveLength(1);
  });

  it('rejects invalid or unknown view types', () => {
    expect(sanitizeViewSpec(null)).toBeNull();
    expect(sanitizeViewSpec({ type: 'chart', labels: [], series: [] })).toBeNull();
    expect(sanitizeViewSpec({ type: 'html', markup: '<b>x</b>' })).toBeNull();
    expect(
      buildUiComponents({ toolName: 'renderView', success: true, result: { view: 'nope' } })
    ).toEqual([]);
  });
});

describe('media cards', () => {
  it('generateVideo result with a cdn URL becomes a media card with the prompt as title', () => {
    const ui = buildUiComponents({
      toolName: 'generateVideo',
      success: true,
      args: { prompt: 'un dron sobrevolando la bodega' },
      result: {
        providerTool: 'higgsfield__generate_video',
        medium: 'video',
        result: {
          content: [{ type: 'text', text: 'Listo: https://cdn.higgsfield.ai/jobs/abc/output.mp4' }],
          structuredContent: null,
        },
      },
    });
    expect(ui).toHaveLength(1);
    const card = ui[0] as {
      type: string;
      title?: string;
      source?: string;
      items: Array<{ kind: string; url: string }>;
      actions?: Array<{ label: string; sendText: string }>;
    };
    expect(card.type).toBe('media');
    expect(card.title).toBe('un dron sobrevolando la bodega');
    expect(card.items).toEqual([
      { kind: 'video', url: 'https://cdn.higgsfield.ai/jobs/abc/output.mp4' },
    ]);
    const labels = card.actions?.map((a) => a.label) ?? [];
    expect(labels).toContain('Otra variación');
    expect(labels).toContain('Formato vertical');
    expect(card.actions?.[0].sendText).toContain('un dron sobrevolando la bodega');
  });

  it('generateImage reads url-ish fields and dedupes', () => {
    const ui = buildUiComponents({
      toolName: 'generateImage',
      success: true,
      args: { prompt: 'logo minimalista' },
      result: {
        providerTool: 'img__make',
        result: {
          image_url: 'https://x.cdn/img.png',
          thumbnail: 'https://x.cdn/img.png',
          prompt: 'logo minimalista',
        },
      },
    });
    const card = ui[0] as {
      type: string;
      items: Array<{ kind: string; url: string }>;
      actions?: Array<{ label: string; sendText: string }>;
    };
    expect(card.type).toBe('media');
    expect(card.items).toHaveLength(1);
    expect(card.items[0].kind).toBe('image');
    // Imagen → ofrece el salto a video usando la URL generada.
    const toVideo = card.actions?.find((a) => a.label === 'Convertir en video');
    expect(toVideo?.sendText).toContain('https://x.cdn/img.png');
  });

  it('generation failures render a danger notice instead of a card', () => {
    const ui = buildUiComponents({
      toolName: 'generateVideo',
      success: true,
      result: { error: 'No hay ningún proveedor de generación de video conectado.' },
    });
    expect(ui[0].type).toBe('notice');
    expect((ui[0] as { tone: string }).tone).toBe('danger');
  });

  it('MCP tools emit media before data cards (Higgsfield structuredContent)', () => {
    const ui = buildUiComponents({
      toolName: 'higgsfield__generate_image',
      success: true,
      args: { prompt: 'retrato corporativo' },
      result: {
        content: [{ type: 'text', text: 'done' }],
        structuredContent: { url: 'https://cdn.higgsfield.ai/a/b.webp', job_id: 'j1' },
      },
    });
    expect(ui[0].type).toBe('media');
    const items = (ui[0] as { items: Array<{ kind: string; url: string }> }).items;
    expect(items[0]).toEqual({ kind: 'image', url: 'https://cdn.higgsfield.ai/a/b.webp' });
    // The args prompt feeds the same variation actions as generateImage.
    const actions =
      (ui[0] as { actions?: Array<{ label: string }> }).actions?.map((a) => a.label) ?? [];
    expect(actions).toContain('Otra variación');
  });

  it('ignores non-media urls, ui:// resources and javascript: strings', () => {
    const items = extractMediaItems({
      url: 'https://example.com/page',
      icon: 'javascript:alert(1)',
      res: 'ui://component/1',
      data: 'data:image/png;base64,AAAA',
      nested: { link: 'ftp://x/file.png' },
    });
    expect(items).toEqual([]);
  });
});
