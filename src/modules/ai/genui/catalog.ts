import { z } from 'zod';

/**
 * UNIK generative-UI catalog (json-render). The ONLY components and actions
 * an agent can compose into a chat card or the home screen.
 *
 * - Components are data: every prop has a Zod schema with hard limits; the
 *   renderer draws them with UNIK's own React components (no markup, no
 *   scripts, no style strings from the model).
 * - Actions are named intents handled by the client through existing APIs
 *   (send a message to the agent, open the workspace, decide an approval,
 *   download an artifact…). Business changes always go through the agent's
 *   tools and their approval cards — never directly from a card.
 * - Values may be json-render expressions ($state, $bindState, $item,
 *   $index, $cond, $template) — resolved at render time against the card's
 *   own state, which the agent fills with REAL tool results.
 *
 * Shared by server (validation, tool description) and client (registry).
 */

export const GENUI_TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const;
const tone = z.enum(GENUI_TONES);

/** lucide icons a card may use (closed list — mapped on the client). */
export const GENUI_ICONS = [
  'sparkles',
  'chart',
  'table',
  'users',
  'user',
  'file',
  'folder',
  'calendar',
  'clock',
  'check',
  'alert',
  'info',
  'money',
  'cart',
  'truck',
  'box',
  'mail',
  'message',
  'phone',
  'globe',
  'terminal',
  'monitor',
  'repeat',
  'bell',
  'star',
  'target',
  'zap',
  'shield',
  'search',
  'link',
  'download',
  'play',
  'settings',
] as const;
const icon = z.enum(GENUI_ICONS);

const str = (max: number) => z.string().max(max);
const cell = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

export interface GenUiComponentDef {
  props: z.ZodObject<z.ZodRawShape>;
  /** "default" = accepts children. */
  slots: string[];
  /** Events the component can emit (keys of element.on). */
  events?: string[];
  description: string;
}

export const GENUI_COMPONENTS = {
  Stack: {
    props: z.object({
      direction: z.enum(['vertical', 'horizontal']).optional(),
      gap: z.enum(['xs', 'sm', 'md', 'lg']).optional(),
      align: z.enum(['start', 'center', 'end', 'stretch']).optional(),
      justify: z.enum(['start', 'center', 'end', 'between']).optional(),
      wrap: z.boolean().optional(),
    }),
    slots: ['default'],
    description: 'Apila hijos en vertical (por defecto) u horizontal.',
  },
  Grid: {
    props: z.object({
      columns: z.number().int().min(1).max(4),
      gap: z.enum(['sm', 'md', 'lg']).optional(),
    }),
    slots: ['default'],
    description: 'Rejilla de 1–4 columnas; en móvil se vuelve una sola columna.',
  },
  Card: {
    props: z.object({
      title: str(120).optional(),
      subtitle: str(240).optional(),
      icon: icon.optional(),
      tone: tone.optional(),
      footer: str(160).optional(),
    }),
    slots: ['default'],
    description: 'Contenedor con título opcional. Agrupa una idea.',
  },
  Tabs: {
    props: z.object({
      tabs: z
        .array(z.object({ id: str(40), label: str(60) }))
        .min(2)
        .max(8),
      value: str(40).optional(),
    }),
    slots: ['default'],
    description:
      'Pestañas. value = {"$bindState":"/tab"}; cada panel hijo usa visible {"$state":"/tab","eq":"<id>"}.',
  },
  Heading: {
    props: z.object({ text: str(160), level: z.number().int().min(1).max(3).optional() }),
    slots: [],
    description: 'Título de sección.',
  },
  Text: {
    props: z.object({
      text: str(2000),
      tone: z.enum(['default', 'muted', 'success', 'warning', 'danger']).optional(),
      size: z.enum(['sm', 'md', 'lg']).optional(),
      weight: z.enum(['normal', 'medium', 'semibold']).optional(),
    }),
    slots: [],
    description: 'Párrafo de texto plano.',
  },
  Markdown: {
    props: z.object({ content: str(8000) }),
    slots: [],
    description: 'Texto con formato Markdown (listas, negritas, enlaces).',
  },
  Badge: {
    props: z.object({ label: str(40), tone: tone.optional() }),
    slots: [],
    description: 'Etiqueta de estado corta.',
  },
  Metric: {
    props: z.object({
      label: str(60),
      value: z.union([str(40), z.number()]),
      format: z.enum(['number', 'money', 'percent', 'text']).optional(),
      delta: str(40).optional(),
      trend: z.enum(['up', 'down', 'flat']).optional(),
      hint: str(120).optional(),
      icon: icon.optional(),
    }),
    slots: [],
    description: 'Indicador (KPI) con valor, variación y tendencia. Úsalo dentro de un Grid.',
  },
  Progress: {
    props: z.object({
      label: str(80).optional(),
      value: z.number(),
      max: z.number().positive().optional(),
      tone: tone.optional(),
    }),
    slots: [],
    description: 'Barra de avance (value de max, por defecto 100).',
  },
  Callout: {
    props: z.object({ title: str(120), body: str(600).optional(), tone: tone.optional() }),
    slots: [],
    description: 'Aviso destacado: hallazgo, riesgo o recomendación.',
  },
  KeyValue: {
    props: z.object({
      items: z
        .array(z.object({ label: str(60), value: str(200) }))
        .min(1)
        .max(24),
    }),
    slots: [],
    description: 'Pares etiqueta → valor (ficha de un registro).',
  },
  List: {
    props: z.object({
      items: z
        .array(
          z.object({
            title: str(160),
            subtitle: str(240).optional(),
            meta: str(60).optional(),
            badge: str(30).optional(),
            tone: tone.optional(),
          })
        )
        .max(50),
      empty: str(120).optional(),
    }),
    slots: [],
    description: 'Lista compacta de elementos con subtítulo, dato y etiqueta.',
  },
  Timeline: {
    props: z.object({
      items: z
        .array(
          z.object({
            title: str(160),
            time: str(40).optional(),
            body: str(300).optional(),
            tone: tone.optional(),
          })
        )
        .min(1)
        .max(30),
    }),
    slots: [],
    description: 'Eventos en orden (historial, bitácora, pasos).',
  },
  Table: {
    props: z.object({
      columns: z
        .array(
          z.object({
            key: str(40),
            label: str(60),
            align: z.enum(['left', 'right', 'center']).optional(),
            format: z.enum(['text', 'number', 'money', 'percent', 'date']).optional(),
          })
        )
        .min(1)
        .max(12),
      rows: z.array(z.record(cell)).max(500),
      searchable: z.boolean().optional(),
      pageSize: z.number().int().min(5).max(100).optional(),
      filterKey: str(40).optional(),
      filterValue: str(120).optional(),
      empty: str(120).optional(),
    }),
    slots: [],
    description:
      'Tabla ordenable con búsqueda y paginación. filterKey/filterValue filtran por una columna (filterValue suele ser {"$state":"/filtro"}).',
  },
  Chart: {
    props: z.object({
      kind: z.enum(['bar', 'line', 'area', 'pie']),
      data: z.array(z.record(cell)).min(1).max(200),
      xKey: str(40),
      series: z
        .array(z.object({ key: str(40), label: str(60).optional() }))
        .min(1)
        .max(6),
      unit: str(20).optional(),
      title: str(100).optional(),
      height: z.number().int().min(160).max(480).optional(),
    }),
    slots: [],
    description: 'Gráfica (barras, líneas, área o pastel) sobre filas de datos.',
  },
  Kanban: {
    props: z.object({
      columns: z
        .array(z.object({ id: str(40), title: str(60), tone: tone.optional() }))
        .min(1)
        .max(8),
      items: z
        .array(
          z.object({
            id: str(60),
            column: str(40),
            title: str(160),
            subtitle: str(200).optional(),
            badge: str(30).optional(),
            meta: str(60).optional(),
          })
        )
        .max(200),
    }),
    slots: [],
    description: 'Tablero por columnas (proyecto, pipeline, estados de pedidos).',
  },
  FilePreview: {
    props: z.object({
      name: str(200),
      mimeType: str(120).optional(),
      sizeBytes: z.number().nonnegative().optional(),
      artifactId: str(80).optional(),
      href: str(1000).optional(),
    }),
    slots: [],
    description:
      'Archivo con vista previa y descarga (artifactId de un documento generado, o href https / ruta /app).',
  },
  Image: {
    props: z.object({ src: str(2000), alt: str(200), caption: str(200).optional() }),
    slots: [],
    description: 'Imagen (solo URL https).',
  },
  Divider: { props: z.object({}), slots: [], description: 'Separador.' },
  Button: {
    props: z.object({
      label: str(60),
      variant: z.enum(['primary', 'secondary', 'ghost', 'danger']).optional(),
      icon: icon.optional(),
      disabled: z.boolean().optional(),
    }),
    slots: [],
    events: ['press'],
    description: 'Botón. Su efecto va en on.press (una acción del catálogo).',
  },
  Input: {
    props: z.object({
      label: str(80),
      value: z.union([str(2000), z.number()]).optional(),
      placeholder: str(120).optional(),
      type: z.enum(['text', 'number', 'date', 'email']).optional(),
    }),
    slots: [],
    events: ['change', 'submit'],
    description: 'Campo de texto; value = {"$bindState":"/ruta"}.',
  },
  Select: {
    props: z.object({
      label: str(80),
      value: str(200).optional(),
      options: z
        .array(z.object({ value: str(120), label: str(120) }))
        .min(1)
        .max(50),
    }),
    slots: [],
    events: ['change'],
    description: 'Selector; value = {"$bindState":"/ruta"}. Ideal para filtros.',
  },
  Toggle: {
    props: z.object({ label: str(80), checked: z.boolean().optional() }),
    slots: [],
    events: ['change'],
    description: 'Interruptor; checked = {"$bindState":"/ruta"}.',
  },
  ComputerStatus: {
    props: z.object({ title: str(80).optional() }),
    slots: [],
    description:
      'Estado en vivo de la computadora virtual del usuario con botones para abrirla (datos reales, sin props de estado).',
  },
  RoutineBuilder: {
    props: z.object({
      goal: str(300),
      schedule: str(80).optional(),
      steps: z.array(str(200)).max(12).optional(),
    }),
    slots: [],
    description:
      'Constructor editable de una rutina/automatización; al confirmar, el agente la propone para aprobación.',
  },
} satisfies Record<string, GenUiComponentDef>;

export type GenUiComponentName = keyof typeof GENUI_COMPONENTS;

export interface GenUiActionDef {
  params: z.ZodObject<z.ZodRawShape>;
  description: string;
}

export const GENUI_ACTIONS = {
  ask: {
    params: z.object({ text: z.string().min(1).max(2000) }),
    description: 'Envía el texto al agente como si el usuario lo escribiera.',
  },
  prefill: {
    params: z.object({ text: z.string().min(1).max(2000) }),
    description: 'Escribe el texto en el cuadro del chat sin enviarlo.',
  },
  openWorkspace: {
    params: z.object({ tab: z.enum(['browser', 'computer', 'files', 'team']) }),
    description: 'Abre el espacio de trabajo en esa pestaña.',
  },
  openUrl: {
    params: z.object({ url: z.string().max(2000) }),
    description: 'Abre un enlace https o una ruta interna /app/… en otra pestaña.',
  },
  openConversation: {
    params: z.object({ conversationId: z.string().min(1).max(80) }),
    description: 'Abre una conversación del usuario.',
  },
  download: {
    params: z.object({ artifactId: z.string().min(1).max(80) }),
    description: 'Descarga un documento generado.',
  },
  decideProposal: {
    params: z.object({
      proposalId: z.string().min(1).max(80),
      decision: z.enum(['approve', 'reject']),
    }),
    description: 'Aprueba o rechaza una acción pendiente (el servidor revalida permisos).',
  },
  copy: {
    params: z.object({ text: z.string().min(1).max(8000) }),
    description: 'Copia el texto al portapapeles.',
  },
} satisfies Record<string, GenUiActionDef>;

export type GenUiActionName = keyof typeof GENUI_ACTIONS;

/** json-render's state-only built-ins (handled by its ActionProvider). */
export const GENUI_BUILTIN_ACTIONS = ['setState', 'pushState', 'removeState', 'validateForm'];

export const GENUI_LIMITS = {
  maxElements: 80,
  maxDepth: 10,
  maxStateBytes: 200_000,
  maxSpecBytes: 400_000,
};

/** Flat json-render spec. */
export interface GenUiElement {
  type: string;
  props: Record<string, unknown>;
  children?: string[];
  visible?: unknown;
  on?: Record<string, unknown>;
  repeat?: { statePath: string; key?: string };
}

export interface GenUiSpec {
  root: string;
  elements: Record<string, GenUiElement>;
  state?: Record<string, unknown>;
}
