import {
  NEURAL_BASE_PATH,
  NEURAL_TOOLS,
  type NeuralTool,
} from '@/components/control-tower/neural/neural-model';

/**
 * Views of the Control Tower (plan 7.7). Pure module, no React and no Prisma:
 * the shell, the pages, the copilot and the tests read the same table.
 *
 * Routes are nested (`/app/admin/control-tower/<vista>`), never `?tab=`, so a
 * link to "excepciones con filtro de incidencias" is shareable and the back
 * button works.
 */

export const CONTROL_TOWER_BASE_PATH = '/app/admin/control-tower';

export const CONTROL_TOWER_VIEWS = [
  'resumen',
  'personas',
  'excepciones',
  'aprobaciones',
  'auditoria',
  'configuracion',
] as const;

export type ControlTowerView = (typeof CONTROL_TOWER_VIEWS)[number];

export const DEFAULT_CONTROL_TOWER_VIEW: ControlTowerView = 'resumen';

export const CONTROL_TOWER_VIEW_LABELS: Record<ControlTowerView, string> = {
  resumen: 'Resumen',
  personas: 'Personas',
  excepciones: 'Excepciones',
  aprobaciones: 'Aprobaciones',
  auditoria: 'Auditoría',
  configuracion: 'Configuración',
};

export const CONTROL_TOWER_VIEW_DESCRIPTIONS: Record<ControlTowerView, string> = {
  resumen:
    'Cómo va la empresa ahora mismo: expedientes, trabajo vencido, incidencias y salud técnica.',
  personas: 'Qué tiene en la mano cada persona, cuánto carga y hace cuánto se movió.',
  excepciones: 'Todo lo que se salió del camino, en una sola lista con sus acciones.',
  aprobaciones: 'Lo que espera una firma: propuestas de la IA y aprobaciones de negocio.',
  auditoria: 'Quién hizo qué en la operación, con su objeto y su momento.',
  configuracion: 'Indicadores del núcleo, SLA, escalera, umbrales y políticas de aprobación.',
};

/**
 * Neural Operations lives in its own segment (plan 7.8) and is another surface:
 * its vocabulary is imported, never copied, so the tab and its pages can never
 * disagree about a tool slug.
 */
export const NEURAL_DEFAULT_TOOL: NeuralTool = 'procesos';
export const NEURAL_TAB_ID = 'neural';

/**
 * `/app/admin/control-tower/neural/<tool>` exists. While it does not, the tab
 * is shown disabled instead of linking to a 404 (same rule as
 * `OPERATIONS_CASE_PAGE_ENABLED` in copilot-starters).
 */
export const NEURAL_PAGES_ENABLED = true;

export function neuralHref(tool: NeuralTool = NEURAL_DEFAULT_TOOL): string {
  return `${NEURAL_BASE_PATH}/${tool}`;
}

export function isControlTowerView(value: unknown): value is ControlTowerView {
  return typeof value === 'string' && (CONTROL_TOWER_VIEWS as readonly string[]).includes(value);
}

export type HrefParams = Record<string, string | number | boolean | null | undefined>;

/** Link of a view, with optional query parameters (empty values are dropped). */
export function controlTowerHref(view: ControlTowerView, params: HrefParams = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return `${CONTROL_TOWER_BASE_PATH}/${view}${query ? `?${query}` : ''}`;
}

export interface ControlTowerTab {
  id: string;
  label: string;
  href: string;
  disabled?: boolean;
}

/**
 * Tabs of the shell. `neural` is always listed (it is part of the surface) but
 * it is disabled while its pages do not exist, so no tab lands on a 404.
 */
export function controlTowerTabs(options: { neuralEnabled?: boolean } = {}): ControlTowerTab[] {
  const neuralEnabled = options.neuralEnabled ?? NEURAL_PAGES_ENABLED;
  const tabs: ControlTowerTab[] = CONTROL_TOWER_VIEWS.map((view) => ({
    id: view,
    label: CONTROL_TOWER_VIEW_LABELS[view],
    href: controlTowerHref(view),
  }));
  tabs.push({
    id: NEURAL_TAB_ID,
    label: 'Neural',
    href: neuralEnabled ? neuralHref() : '#',
    ...(neuralEnabled ? {} : { disabled: true }),
  });
  return tabs;
}

export { NEURAL_BASE_PATH, NEURAL_TOOLS, type NeuralTool };

/** The six operational area channels the surface listens to (`area:<key>`). */
export const CONTROL_TOWER_AREA_CHANNELS = [
  'area:ventas',
  'area:compras',
  'area:inventario',
  'area:manufactura',
  'area:logistica',
  'area:contabilidad',
] as const;
