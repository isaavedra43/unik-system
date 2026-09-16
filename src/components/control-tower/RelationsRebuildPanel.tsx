'use client';

import { useMemo, useState, useTransition } from 'react';
import { Network, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { ChartCard } from '@/components/patterns/dashboard/ChartCard';
import { Alert, Button, Checkbox } from '@/components/ui/primitives';
import {
  describeRebuildStatus,
  isRebuildRunning,
  rebuildButtonLabel,
  type RelationsRebuildStatus,
} from './relations-rebuild-model';

/**
 * Reconstruye la proyección `ObjectRelation` del grafo operativo (plan 2.1:
 * «proyección reconstruible para el grafo»).
 *
 * Antes de este panel nadie podía dispararla: el trabajo `ops.relations_rebuild`
 * y su manejador existían y estaban registrados, pero ninguna ruta, acción ni
 * botón llamaba a `enqueueRelationsRebuild`, así que el único camino para crear
 * una arista era `ctx.relate` dentro de cada comando. Si un `relate` fallaba o
 * se agregaba una relación nueva, el grafo —y la vista de red que lo consume—
 * quedaban desfasados para siempre.
 *
 * La reconstrucción NUNCA borra ni cierra aristas: inserta las que faltan y
 * reabre las que se habían cerrado, así que pedirla de más es inofensivo.
 */

export interface RelationsRebuildPanelProps {
  /** Fuentes registradas en `relations-rebuild.ts`. */
  sources: Array<{ key: string; label: string }>;
  last: RelationsRebuildStatus | null;
  /** Acción del servidor ligada por la página; vuelve a exigir `operations.admin`. */
  rebuildAction: (sources: string[]) => Promise<{
    success: boolean;
    error: string | null;
    jobId: string | null;
    deduplicated: boolean;
  }>;
  nowIso: string;
}

export function RelationsRebuildPanel({
  sources,
  last,
  rebuildAction,
  nowIso,
}: RelationsRebuildPanelProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const now = useMemo(() => Date.parse(nowIso) || Date.now(), [nowIso]);
  const running = isRebuildRunning(last);

  const toggle = (key: string) =>
    setSelected((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key]
    );

  const run = () => {
    startTransition(async () => {
      const result = await rebuildAction(selected);
      if (!result.success) {
        toast.error(result.error ?? 'No se pudo encolar la reconstrucción');
        return;
      }
      toast.success(
        result.deduplicated
          ? 'Ya había una reconstrucción en curso; se reutilizó esa.'
          : 'Reconstrucción encolada. El avance se ve aquí al recargar.'
      );
    });
  };

  return (
    <ChartCard
      title="Grafo de relaciones"
      description="Vuelve a derivar las aristas del grafo desde las tablas de origen. Sólo agrega lo que falta y reabre lo que se había cerrado: nunca borra una relación."
      height="auto"
    >
      <Alert variant={running ? 'warning' : 'info'} title={describeRebuildStatus(last, now)}>
        {last === null ? (
          <p>
            La proyección nunca se ha reconstruido: hoy sólo existe lo que cada comando escribió con{' '}
            <code>relate</code>.
          </p>
        ) : null}
        {last?.totals ? (
          <p>
            Última corrida: {last.totals.scanned.toLocaleString('es-MX')} filas leídas,{' '}
            {last.totals.edges.toLocaleString('es-MX')} aristas derivadas,{' '}
            {last.totals.created.toLocaleString('es-MX')} creadas y{' '}
            {last.totals.reopened.toLocaleString('es-MX')} reabiertas.
          </p>
        ) : null}
        {last?.lastError ? <p>Último error: {last.lastError}</p> : null}
        {running ? <p>Avance: {last?.progress ?? 0} %.</p> : null}
      </Alert>

      <p className="ct-flag-desc">
        Sin marcar nada se reconstruyen las {sources.length} fuentes. Marca algunas para limitar la
        corrida a esas.
      </p>

      <ul className="ct-flag-list">
        {sources.map((source) => (
          <li key={source.key} className="ct-flag">
            <Checkbox
              id={`ct-relsrc-${source.key}`}
              label={source.label}
              description={source.key}
              checked={selected.includes(source.key)}
              onChange={() => toggle(source.key)}
              disabled={pending}
            />
          </li>
        ))}
      </ul>

      <div className="ct-sticky-bar">
        {selected.length > 0 ? (
          <Button variant="ghost" onClick={() => setSelected([])} disabled={pending}>
            <RefreshCw aria-hidden="true" size={16} />
            Quitar la selección
          </Button>
        ) : null}
        <Button onClick={run} disabled={pending || sources.length === 0}>
          <Network aria-hidden="true" size={16} />
          {rebuildButtonLabel(selected.length, sources.length, pending)}
        </Button>
      </div>
    </ChartCard>
  );
}
