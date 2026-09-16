import { relativeSince } from '@/modules/areas/area-time';

/**
 * Lógica pura del panel de reconstrucción del grafo (plan 2.1). Vive fuera del
 * componente para poder probarla sin navegador y para que el cargador del
 * servidor (`_data.ts`) comparta exactamente el mismo tipo y la misma lectura
 * del resumen del trabajo.
 */

export interface RelationsRebuildStatus {
  id: string;
  /** pending | running | completed | failed | cancelled */
  status: string;
  progress: number;
  createdAtIso: string;
  completedAtIso: string | null;
  lastError: string | null;
  /** Totales de `RelationsRebuildSummary` cuando el trabajo terminó bien. */
  totals: RelationsRebuildTotals | null;
}

export interface RelationsRebuildTotals {
  scanned: number;
  edges: number;
  created: number;
  reopened: number;
}

const TOTAL_KEYS: Array<keyof RelationsRebuildTotals> = ['scanned', 'edges', 'created', 'reopened'];

/**
 * Suma los totales por fuente del `RelationsRebuildSummary` guardado en
 * `BackgroundJob.result`. El campo es Json, así que no se confía en su forma:
 * cualquier cosa que no sea un número finito se ignora en vez de romper.
 */
export function relationsRebuildTotals(result: unknown): RelationsRebuildTotals | null {
  if (!result || typeof result !== 'object') return null;
  const sources = (result as { sources?: unknown }).sources;
  if (!sources || typeof sources !== 'object') return null;
  const totals: RelationsRebuildTotals = { scanned: 0, edges: 0, created: 0, reopened: 0 };
  for (const value of Object.values(sources as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    for (const key of TOTAL_KEYS) {
      const n = (value as Record<string, unknown>)[key];
      if (typeof n === 'number' && Number.isFinite(n)) totals[key] += n;
    }
  }
  return totals;
}

export function isRebuildRunning(last: RelationsRebuildStatus | null): boolean {
  return last?.status === 'pending' || last?.status === 'running';
}

/** Encabezado del aviso: qué pasó con la última reconstrucción y cuándo. */
export function describeRebuildStatus(
  last: RelationsRebuildStatus | null,
  now: Date | number | string
): string {
  if (!last) return 'La proyección del grafo nunca se ha reconstruido';
  const started = relativeSince(last.createdAtIso, now);
  const ended = relativeSince(last.completedAtIso ?? last.createdAtIso, now);
  switch (last.status) {
    case 'pending':
      return `Hay una reconstrucción encolada ${started}`;
    case 'running':
      return `Hay una reconstrucción en curso desde ${started}`;
    case 'completed':
      return `Última reconstrucción completa ${ended}`;
    case 'failed':
      return `La última reconstrucción falló ${ended}`;
    case 'cancelled':
      return `La última reconstrucción se canceló ${ended}`;
    default:
      return `Última reconstrucción (${last.status}) ${ended}`;
  }
}

/** Texto del botón: dice cuántas fuentes se van a recorrer, no sólo «reconstruir». */
export function rebuildButtonLabel(
  selectedCount: number,
  totalCount: number,
  pending: boolean
): string {
  if (pending) return 'Encolando…';
  if (selectedCount === 0) return `Reconstruir las ${totalCount} fuentes`;
  if (selectedCount === 1) return 'Reconstruir 1 fuente';
  return `Reconstruir ${selectedCount} fuentes`;
}
