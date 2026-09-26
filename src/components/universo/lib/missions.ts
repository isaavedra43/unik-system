/** Missions (proposeMission / missions API) — shared helpers for cards and lists. */

export interface MissionItem {
  id: string;
  goal: string;
  status: string;
  plan?: { steps?: Array<{ title: string; status: string; agent?: string | null }> } | null;
  schedule?: string | null;
  nextRunAt?: string | null;
  createdAt?: string;
  completedAt?: string | null;
  conversationId?: string | null;
}

export const MISSION_STATUS_LABEL: Record<string, string> = {
  awaiting_approval: 'Por aprobar',
  active: 'En curso',
  blocked: 'Pausada',
  done: 'Completada',
  failed: 'Falló',
  cancelled: 'Cancelada',
};

export function missionProgress(m: Pick<MissionItem, 'plan'>): { done: number; total: number } {
  const steps = m.plan?.steps ?? [];
  return {
    done: steps.filter((s) => s.status === 'done' || s.status === 'skipped').length,
    total: steps.length,
  };
}

export function scheduleLabel(schedule?: string | null): string | null {
  if (!schedule) return null;
  if (schedule.startsWith('daily:')) return `Todos los días ${schedule.slice(6)}`;
  if (schedule.startsWith('every:')) return `Cada ${schedule.slice(6)} min`;
  return schedule;
}

export function missionSubtitle(m: MissionItem): string {
  const { done, total } = missionProgress(m);
  const label = MISSION_STATUS_LABEL[m.status] ?? m.status;
  const sched = scheduleLabel(m.schedule);
  if (sched) return `${sched} · ${label.toLowerCase()}`;
  return total > 0 ? `${label} · ${done}/${total} pasos` : label;
}
