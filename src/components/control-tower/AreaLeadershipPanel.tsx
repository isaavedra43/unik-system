'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ChartCard } from '@/components/patterns/dashboard/ChartCard';
import { Alert, Button, Select } from '@/components/ui/primitives';

export interface AreaLeadershipRow {
  key: string;
  label: string;
  leadUserId: string | null;
}

export interface AreaLeadershipPanelProps {
  areas: AreaLeadershipRow[];
  users: Array<{ id: string; name: string }>;
  saveAction: (input: {
    areaKey: string;
    leadUserId: string | null;
  }) => Promise<{ success: boolean; error: string | null; areas: AreaLeadershipRow[] | null }>;
}

/**
 * The area lead is the escalation destination when a responsible or backup
 * cannot take a work item. Responsibles and backups remain managed in the
 * communications administration; this panel owns the separate Area.leadUserId.
 */
export function AreaLeadershipPanel({ areas, users, saveAction }: AreaLeadershipPanelProps) {
  const [rows, setRows] = useState(areas);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = (areaKey: string, leadUserId: string) => {
    setPendingKey(areaKey);
    startTransition(async () => {
      const outcome = await saveAction({ areaKey, leadUserId: leadUserId || null });
      setPendingKey(null);
      if (!outcome.success || !outcome.areas) {
        toast.error(outcome.error ?? 'No pudimos guardar el líder del área');
        return;
      }
      setRows(outcome.areas);
      toast.success('Liderazgo del área actualizado');
    });
  };

  return (
    <ChartCard
      title="Liderazgo por área"
      description="Define a quién escala el sistema cuando el responsable y su suplente no pueden atender un pendiente."
      height="auto"
    >
      {users.length === 0 ? (
        <Alert variant="warning">No hay usuarios humanos activos para asignar como líderes.</Alert>
      ) : (
        <div className="ct-settings-grid">
          {rows.map((area) => (
            <div key={area.key} className="ct-filter">
              <label htmlFor={`ct-area-lead-${area.key}`}>{area.label}</label>
              <Select
                id={`ct-area-lead-${area.key}`}
                value={area.leadUserId ?? ''}
                disabled={pending && pendingKey === area.key}
                onChange={(event) => save(area.key, event.target.value)}
              >
                <option value="">Sin líder asignado</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </Select>
              <span className="ct-cell-sub">
                {pending && pendingKey === area.key ? 'Guardando…' : 'Se usa en escalamiento'}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="ct-actions mt-3">
        <Button variant="secondary" size="sm" disabled>
          Responsables y suplentes se administran en Comunicaciones
        </Button>
      </div>
    </ChartCard>
  );
}
