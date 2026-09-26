import { z } from 'zod';
import { registerTool } from './registry';
import { describeGenUiCatalog } from '../genui/prompt';
import { sanitizeGenUiSpec } from '../genui/validate';

/**
 * renderUi — the agent composes a card from the UNIK json-render catalog
 * (layouts, KPIs, tables with search and filters, charts, kanban, timelines,
 * file previews, forms, computer status, routine builder). The spec is
 * validated against the catalog here and again in the browser; unknown
 * components, props, actions or unsafe links never reach the screen, and the
 * issues come back so the model can fix the card in the next step.
 */

const elementSchema = z
  .object({
    type: z.string().max(40),
    props: z.record(z.unknown()).optional(),
    children: z.array(z.string().max(80)).max(60).optional(),
    visible: z.unknown().optional(),
    on: z.record(z.unknown()).optional(),
    repeat: z
      .object({ statePath: z.string().max(200), key: z.string().max(60).optional() })
      .optional(),
  })
  .passthrough();

registerTool({
  name: 'renderUi',
  description: `Dibuja en el chat una tarjeta o mini-app con el catálogo de UNIK (json-render): reportes con gráficas, tablas con búsqueda y filtros, KPIs, tableros kanban, líneas de tiempo, vistas de archivos, formularios, el estado de la computadora virtual o un constructor de rutinas. Úsala DESPUÉS de obtener los datos reales con tus herramientas; mete esos datos en "state". Prefiérela a describir tablas largas en texto. Si devuelve "issues", corrige el spec y vuelve a llamarla.
${describeGenUiCatalog()}`,
  category: 'system',
  enabledByDefault: true,
  effect: 'draft',
  parameters: z.object({
    title: z.string().max(120).optional().describe('Título corto de la tarjeta.'),
    spec: z
      .object({
        root: z.string().max(80),
        elements: z.record(elementSchema),
        state: z.record(z.unknown()).optional(),
      })
      .describe('Spec json-render plano (ver FORMATO).'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { title?: string; spec: unknown };
    const { spec, issues } = sanitizeGenUiSpec(args.spec);
    if (!spec) {
      return {
        rendered: false,
        issues: issues.slice(0, 20),
        note: 'La tarjeta no se pudo dibujar. Corrige los problemas y vuelve a llamar renderUi.',
      };
    }
    return {
      rendered: true,
      title: args.title ?? null,
      spec,
      issues: issues.slice(0, 20),
      note:
        issues.length > 0
          ? 'Tarjeta dibujada con ajustes (revisa issues si falta algo importante). No repitas su contenido en texto: resume el hallazgo en una o dos líneas.'
          : 'Tarjeta dibujada en el chat. No repitas su contenido en texto: resume el hallazgo en una o dos líneas.',
    };
  },
});
