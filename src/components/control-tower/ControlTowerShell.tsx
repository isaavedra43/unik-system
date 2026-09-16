import type { ReactNode } from 'react';
import { PageHeader, TabNav } from '@/components/ui/composite';
import { ControlTowerRealtimeBadge } from './ControlTowerRealtimeBadge';
import {
  CONTROL_TOWER_VIEW_DESCRIPTIONS,
  CONTROL_TOWER_VIEW_LABELS,
  controlTowerTabs,
  type ControlTowerView,
} from './control-tower-views';

export interface ControlTowerShellProps {
  view: ControlTowerView;
  /** Name of the person, shown so it is obvious whose session is configuring. */
  userName: string;
  /** Neural Operations pages already exist (plan 7.8). */
  neuralEnabled?: boolean;
  children: ReactNode;
}

/**
 * Shell of the Control Tower (plan 7.7): one title, the live chip of the whole
 * operation, the seven tabs and the view below.
 *
 * Server Component: the only client part is the realtime chip. Every tab is a
 * real link (nested route, never `?tab=`), so a view is shareable and the back
 * button works; the Neural tab is rendered disabled while its pages do not
 * exist, so no tab of this surface lands on a 404.
 */
export function ControlTowerShell({
  view,
  userName,
  neuralEnabled,
  children,
}: ControlTowerShellProps) {
  const tabs = controlTowerTabs(neuralEnabled === undefined ? {} : { neuralEnabled });

  return (
    <div className="ct-shell">
      <PageHeader
        title="Control Tower"
        description="Cómo va la operación, quién la está moviendo y qué se salió del camino."
        actions={<ControlTowerRealtimeBadge />}
      />

      <div className="ct-shell-meta">
        <span>
          Vista: <strong>{CONTROL_TOWER_VIEW_LABELS[view]}</strong>
        </span>
        <span>
          Sesión de <strong>{userName}</strong>
        </span>
        <span>Todo lo que se hace aquí queda en la auditoría de operaciones.</span>
      </div>

      <TabNav activeId={view} tabs={tabs} />

      <div className="ct-view">
        <p className="ct-view-description">{CONTROL_TOWER_VIEW_DESCRIPTIONS[view]}</p>
        {children}
      </div>
    </div>
  );
}
