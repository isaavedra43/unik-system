import type { ReactNode } from 'react';
import { FlaskConical, GitBranch, History, Network, Workflow } from 'lucide-react';
import { PageHeader, TabNav } from '@/components/ui/composite';
import {
  freshnessLabel,
  neuralHref,
  neuralToolMeta,
  NEURAL_TOOL_LIST,
  type NeuralTool,
} from './neural-model';

const TOOL_ICON = {
  workflow: Workflow,
  'git-branch': GitBranch,
  network: Network,
  history: History,
  'flask-conical': FlaskConical,
} as const;

export interface NeuralShellProps {
  tool: NeuralTool;
  /** Frescura de las cuatro proyecciones (pie de página). */
  projections: readonly { label: string; minutesAgo: number | null; stale: boolean }[];
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Marco de UNIK Neural Operations (plan 7.8): encabezado, pestañas de las cinco
 * herramientas y el pie que dice qué tan frescas están las proyecciones.
 *
 * La frescura NO es decoración: variantes, cuellos de botella, traspasos y
 * causas salen de proyecciones que se recalculan cada 15 minutos. Quien mira un
 * número tiene derecho a saber de cuándo es.
 */
export function NeuralShell({ tool, projections, actions, children }: NeuralShellProps) {
  const meta = neuralToolMeta(tool);
  const Icon = TOOL_ICON[meta.icon];
  const stale = projections.some((row) => row.stale);

  return (
    <div className="neural-shell">
      <PageHeader
        title="UNIK Neural Operations"
        description="Cómo se mueve la operación de verdad: el proceso definido, los caminos que recorren los expedientes, la red que los conecta, la historia de cada uno y qué pasaría si algo se retrasa."
        {...(actions ? { actions } : {})}
      />

      <TabNav
        tabs={NEURAL_TOOL_LIST.map((entry) => ({
          id: entry.key,
          label: entry.label,
          href: neuralHref(entry.key),
        }))}
        activeId={tool}
      />

      <p className="neural-intro">
        <Icon className="h-4 w-4" aria-hidden="true" /> {meta.description}
      </p>

      {children}

      <footer className="neural-footer">
        <span className={stale ? 'neural-footer-stale' : undefined}>
          {freshnessLabel(projections)}
        </span>
        <span>
          Las proyecciones se recalculan cada 15 minutos con el trabajo{' '}
          <code>ct.projections_refresh</code>.
        </span>
      </footer>
    </div>
  );
}
