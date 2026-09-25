import { z } from 'zod';
import { registerTool } from './registry';

/**
 * renderView — draws a live component inside the chat (chart, KPI cards,
 * mission progress, timeline). The spec is validated here and re-validated
 * when the UI rebuilds it from the persisted tool record; no markup ever
 * reaches the client.
 */

const viewSpec = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('chart'),
    chart: z.enum(['bar', 'line', 'pie']),
    title: z.string().max(100).optional(),
    unit: z.string().max(20).optional().describe('Etiqueta de unidad: "MXN", "órdenes", "%".'),
    labels: z.array(z.string().max(40)).min(1).max(24).describe('Etiquetas del eje X (o del pie).'),
    series: z
      .array(z.object({ name: z.string().max(40).optional(), data: z.array(z.number()).min(1).max(24) }))
      .min(1)
      .max(4)
      .describe('Series de datos alineadas a labels.'),
  }),
  z.object({
    type: z.literal('kpi'),
    title: z.string().max(100).optional(),
    items: z
      .array(
        z.object({
          label: z.string().max(60),
          value: z.string().max(60),
          delta: z.string().max(40).optional().describe('Comparativa: "+12% vs ayer".'),
          tone: z.enum(['neutral', 'success', 'warning', 'danger', 'info']).optional(),
        })
      )
      .min(1)
      .max(8),
  }),
  z.object({
    type: z.literal('progress'),
    title: z.string().max(100),
    steps: z
      .array(
        z.object({
          title: z.string().max(100),
          status: z.enum(['pending', 'running', 'done', 'failed']),
          detail: z.string().max(120).optional(),
        })
      )
      .min(1)
      .max(20),
  }),
  z.object({
    type: z.literal('timeline'),
    title: z.string().max(100).optional(),
    events: z
      .array(
        z.object({
          label: z.string().max(100),
          at: z.string().max(40).optional().describe('Hora o fecha legible: "08:30", "ayer".'),
          detail: z.string().max(160).optional(),
          tone: z.enum(['neutral', 'success', 'warning', 'danger', 'info']).optional(),
        })
      )
      .min(1)
      .max(20),
  }),
]);

registerTool({
  name: 'renderView',
  description:
    'Dibuja un componente vivo dentro del chat: gráfica (bar/line/pie), tarjetas KPI, progreso de una misión o línea de tiempo. Úsala DESPUÉS de consultar los datos con las tools de datos — las cifras del view deben venir de resultados reales. Para archivos descargables usa las tools de reportes; renderView es para visualizar en la conversación.',
  category: 'system',
  enabledByDefault: true,
  effect: 'draft',
  parameters: z.object({
    view: viewSpec.describe('Spec del componente a dibujar.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { view: z.infer<typeof viewSpec> };
    return {
      view: args.view,
      note: 'Componente dibujado en el chat. No describas la misma gráfica en texto largo: resume el insight en una línea.',
    };
  },
});
