import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { resolveResponsible } from '@/modules/comms/responsibles-service';
import { executeCommand, registerCommand } from './commands';
import { openOrReopenIncident, transitionIncidentInTx } from './incidents-service';
import { getOperationsConfig } from './operations-config';
import {
  AREA_KEYS,
  AREA_LABELS,
  INCIDENT_OPEN_STATUSES,
  type AreaKey,
  type OperationsActor,
} from './types';

/**
 * Idempotent seed of the operations core, run at startup
 * (`src/instrumentation-node.ts`) and safe to call any number of times, from
 * several instances at once:
 *
 * - the `IntegrationConfig('operations')` row (created by `getOperationsConfig`,
 *   which already tolerates concurrent boots);
 * - the 7 `Area` rows with their Spanish label, order and
 *   `responsibleArea = key`, inserted with `createMany … skipDuplicates`
 *   (ON CONFLICT DO NOTHING: never a unique violation). Existing areas are never
 *   modified, so labels or leads edited by an admin survive restarts;
 * - a configuration check of each active area: without an active `Responsible`
 *   the core cannot assign work, so an `owner_absent` incident is opened for
 *   Administración (at most once a day per area; a dismissed one stays
 *   dismissed). Users are never invented. When the responsible is configured
 *   later, the next run resolves the incident.
 *
 * Pipeline stages are not seeded here (the CRM module owns them).
 */

export const OPERATIONS_SEED_ACTOR: OperationsActor = { type: 'system', id: 'ops.seed' };

export const SEED_COMMANDS = {
  responsibleCheck: 'operations.seed_responsible_check',
} as const;

export function responsibleIncidentKey(areaKey: AreaKey): string {
  return `config:responsible_missing:${areaKey}`;
}

/** Default rows of the areas (key = Responsible.area slug). */
export function defaultAreaRows(): Array<{
  key: AreaKey;
  label: string;
  responsibleArea: string;
  sortOrder: number;
  active: boolean;
}> {
  return AREA_KEYS.map((key, index) => ({
    key,
    label: AREA_LABELS[key],
    responsibleArea: key,
    sortOrder: (index + 1) * 10,
    active: true,
  }));
}

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'operations-seed', event, ...extra }));

// ---------------------------------------------------------------------------
// Configuration check command
// ---------------------------------------------------------------------------

export interface ResponsibleCheckData {
  areaKey: AreaKey;
  outcome: 'inactive' | 'configured' | 'reported' | 'resolved';
  incidentId: string | null;
  incidentCreated: boolean;
}

const checkSchema = z.object({ areaKey: z.enum(AREA_KEYS) });

registerCommand<z.output<typeof checkSchema>, ResponsibleCheckData>(
  SEED_COMMANDS.responsibleCheck,
  {
    schema: checkSchema,
    aggregate: 'none',
    actorTypes: ['system'],
    audit: 'never',
    async handler(tx, cmd) {
      const areaKey = cmd.payload.areaKey;
      const base: ResponsibleCheckData = {
        areaKey,
        outcome: 'inactive',
        incidentId: null,
        incidentCreated: false,
      };
      const area = await tx.area.findUnique({ where: { key: areaKey } });
      if (!area || !area.active) return { data: base };

      const dedupeKey = responsibleIncidentKey(areaKey);
      const responsible = await resolveResponsible(area.responsibleArea || areaKey);
      if (responsible) {
        const incident = await tx.incident.findUnique({ where: { dedupeKey } });
        if (!incident || !(INCIDENT_OPEN_STATUSES as readonly string[]).includes(incident.status)) {
          return { data: { ...base, outcome: 'configured', incidentId: incident?.id ?? null } };
        }
        await transitionIncidentInTx(tx, incident, 'resolve', {
          resolution: `Se configuró a ${responsible.userName} como responsable de ${area.label}`,
        });
        return { data: { ...base, outcome: 'resolved', incidentId: incident.id } };
      }

      const { incident, created, reopened } = await openOrReopenIncident(tx, {
        kind: 'owner_absent',
        areaKey: 'administracion',
        severity: areaKey === 'administracion' ? 'critical' : 'high',
        title: `Falta configurar el responsable de ${area.label}`,
        dedupeKey,
        detail: {
          reason: 'responsible_missing',
          areaKey,
          responsibleArea: area.responsibleArea,
          hint:
            'Asigna un responsable activo y su suplente en Administración → Comunicaciones → Responsables. ' +
            'Mientras tanto el trabajo del área se asigna al líder del área, a Administración o al super administrador.',
        },
      });
      return {
        data: {
          ...base,
          outcome: 'reported',
          incidentId: incident.id,
          incidentCreated: created || reopened,
        },
      };
    },
  }
);

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

export interface OperationsSeedSummary {
  areasCreated: number;
  missingResponsibles: AreaKey[];
  incidentsReported: number;
  incidentsResolved: number;
  /** Set when the configuration check did not run. */
  checkSkipped: 'core_disabled' | null;
}

export async function ensureOperationsSeed(
  options: { now?: Date } = {}
): Promise<OperationsSeedSummary> {
  const now = options.now ?? new Date();
  const config = await getOperationsConfig();

  const keys = [...AREA_KEYS];
  const existing = await prisma.area.findMany({
    where: { key: { in: keys } },
    select: { key: true },
  });
  const present = new Set(existing.map((a) => a.key));
  const missingAreas = defaultAreaRows().filter((row) => !present.has(row.key));
  let areasCreated = 0;
  if (missingAreas.length > 0) {
    const res = await prisma.area.createMany({ data: missingAreas, skipDuplicates: true });
    areasCreated = res.count;
  }

  const areas = await prisma.area.findMany({
    where: { key: { in: keys }, active: true },
    orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
  });
  const missingResponsibles: AreaKey[] = [];
  const configured: AreaKey[] = [];
  for (const area of areas) {
    const key = area.key as AreaKey;
    const responsible = await resolveResponsible(area.responsibleArea || key);
    (responsible ? configured : missingResponsibles).push(key);
  }

  const summary: OperationsSeedSummary = {
    areasCreated,
    missingResponsibles,
    incidentsReported: 0,
    incidentsResolved: 0,
    checkSkipped: config.isEnabled ? null : 'core_disabled',
  };
  if (!config.isEnabled) {
    log('seeded', { ...summary });
    return summary;
  }

  const day = now.toISOString().slice(0, 10);
  const run = (areaKey: AreaKey, commandId: string) =>
    executeCommand<ResponsibleCheckData>(
      {
        commandId,
        type: SEED_COMMANDS.responsibleCheck,
        actor: OPERATIONS_SEED_ACTOR,
        aggregate: { type: 'area', id: areaKey },
        payload: { areaKey },
      },
      null,
      { now }
    );

  for (const areaKey of missingResponsibles) {
    const result = await run(areaKey, `seed:responsible_missing:${areaKey}:${day}`);
    if (result.status === 'rejected') {
      log('responsible_check_rejected', { areaKey, errorCode: result.errorCode });
    } else if (!result.replayed && result.data?.incidentCreated) {
      summary.incidentsReported += 1;
    }
  }

  if (configured.length > 0) {
    const openIncidents = await prisma.incident.findMany({
      where: {
        dedupeKey: { in: configured.map(responsibleIncidentKey) },
        status: { in: [...INCIDENT_OPEN_STATUSES] },
      },
      select: { dedupeKey: true, version: true },
    });
    for (const incident of openIncidents) {
      const areaKey = configured.find((key) => responsibleIncidentKey(key) === incident.dedupeKey);
      if (!areaKey) continue;
      const result = await run(
        areaKey,
        `seed:responsible_configured:${areaKey}:v${incident.version}`
      );
      if (result.status === 'rejected') {
        log('responsible_check_rejected', { areaKey, errorCode: result.errorCode });
      } else if (!result.replayed && result.data?.outcome === 'resolved') {
        summary.incidentsResolved += 1;
      }
    }
  }

  log('seeded', { ...summary });
  return summary;
}
