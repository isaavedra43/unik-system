import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Etapas del embudo sobre FakePrisma con el motor de comandos real (plan 6.5:
 * «Seed of an empty pipeline (editable afterwards with `crm.manage_stages`)»).
 *
 * `crm.stage.create | update | reorder` existían con su permiso desde el
 * principio, pero ninguna pantalla los invocaba, así que nadie los había
 * ejercido con los payloads que arma la aplicación. Esta prueba los manda
 * EXACTAMENTE como los construye `pipeline-model.ts` (el modelo del tablero de
 * Ventas), así que un cambio de forma en la pantalla rompe aquí.
 */

const mocks = await vi.hoisted(async () => {
  const { createCrmFake } = await import('./testing/crm-fixtures');
  return { fake: createCrmFake() };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/notifications/notification-service', () => ({
  notifyUser: vi.fn(async () => ({ id: 'n', inApp: true, push: false, suppressed: false })),
}));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: vi.fn(async () => ({
    id: '1',
    channel: '',
    type: '',
    payload: {},
    createdAt: '',
  })),
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));
vi.mock('@/modules/auth/permissions', async (importOriginal) => {
  const { withCrmPermissions } = await import('./testing/crm-permissions-mock');
  return withCrmPermissions(await importOriginal<typeof import('@/modules/auth/permissions')>());
});
vi.mock('@/modules/jobs/job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/jobs/job-queue')>()),
  wakeJobWorker: vi.fn(),
  registerJobHandler: vi.fn(),
}));
vi.mock('@/modules/jobs/scheduled-jobs', () => ({ registerRecurringJob: vi.fn() }));

import {
  activeStageIds,
  buildCreateStageCommand,
  buildReorderStagesCommand,
  buildUpdateStageCommand,
  moveStageInOrder,
} from '@/components/areas/ventas/pipeline-model';
import type { PipelineStageDTO } from './crm-dto';
import type { CommandResult } from '@/modules/operations/commands';
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { seedArea, seedResponsible, seedUser } from '@/modules/operations/testing/fixtures';
import { ensurePipelineSeed, listPipelineStages } from './pipeline-service';
import { runCrmCommand } from './crm-helpers';
import { seedOpportunity } from './testing/crm-fixtures';

const { fake } = mocks;

const manager = seedUser(fake, {
  id: 'u-jefa',
  name: 'Jefa comercial',
  permissions: ['crm.view', 'crm.manage', 'crm.manage_stages'],
}).currentUser;
const seller = seedUser(fake, {
  id: 'u-luis',
  name: 'Luis',
  permissions: ['crm.view', 'crm.manage'],
}).currentUser;
seedArea(fake, 'ventas');
seedResponsible(fake, { area: 'ventas', userId: 'u-jefa' });

/** Manda un comando de etapa tal como lo haría la cola sin conexión del tablero. */
function send<D>(
  actor: typeof manager,
  command: { type: string; aggregate: { type: string; id: string }; payload: unknown }
): Promise<CommandResult<D>> {
  return runCrmCommand<D>(actor, command.type, command.aggregate, command.payload);
}

async function stages(includeInactive = true): Promise<PipelineStageDTO[]> {
  return listPipelineStages(manager, { includeInactive });
}

beforeEach(async () => {
  for (const model of [
    'pipelineStage',
    'opportunity',
    'operationalEvent',
    'operationalCommand',
    'auditLog',
  ]) {
    await (
      fake.client as unknown as Record<string, { deleteMany(args: unknown): Promise<unknown> }>
    )[model].deleteMany({});
  }
  invalidateOperationsConfigCache();
  await ensurePipelineSeed();
});

describe('etapas del embudo desde la pantalla', () => {
  it('crea una etapa abierta con el payload del tablero y la mete antes del cierre', async () => {
    const before = await stages();
    expect(before.map((stage) => stage.key)).toStrictEqual([
      'nuevo',
      'contactado',
      'cotizado',
      'negociacion',
      'ganado',
      'perdido',
    ]);

    const result = await send<{ stage: PipelineStageDTO }>(
      manager,
      buildCreateStageCommand({
        name: 'Visita técnica',
        kind: 'open',
        probabilityPct: '35',
        slaHours: '48',
      })
    );
    expect(result.status, result.message).toBe('completed');
    expect(result.data!.stage).toMatchObject({
      key: 'visita_tecnica',
      name: 'Visita técnica',
      kind: 'open',
      probabilityDefault: 0.35,
      slaHours: 48,
      active: true,
    });
    // Una etapa abierta entra ANTES de ganado/perdido, que bajan un lugar.
    expect((await stages()).map((stage) => stage.key)).toStrictEqual([
      'nuevo',
      'contactado',
      'cotizado',
      'negociacion',
      'visita_tecnica',
      'ganado',
      'perdido',
    ]);
  });

  it('renombra, quita el SLA y reordena con los payloads del tablero', async () => {
    const current = await stages();
    const negociacion = current.find((stage) => stage.key === 'negociacion')!;

    expect(
      (
        await send(
          manager,
          buildUpdateStageCommand({
            stageId: negociacion.id,
            name: ' Negociación final ',
            probabilityPct: '80',
            slaHours: null,
          })
        )
      ).status
    ).toBe('completed');
    const updated = (await stages()).find((stage) => stage.id === negociacion.id)!;
    expect(updated).toMatchObject({
      name: 'Negociación final',
      probabilityDefault: 0.8,
      slaHours: null,
    });

    const ids = activeStageIds(current);
    const moved = moveStageInOrder(ids, negociacion.id, 'up');
    expect((await send(manager, buildReorderStagesCommand(moved))).status).toBe('completed');
    expect((await stages()).map((stage) => stage.key)).toStrictEqual([
      'nuevo',
      'contactado',
      'negociacion',
      'cotizado',
      'ganado',
      'perdido',
    ]);
  });

  it('sin crm.manage_stages el comando se rechaza y el embudo no cambia', async () => {
    const result = await send(
      seller,
      buildCreateStageCommand({ name: 'Visita', kind: 'open', probabilityPct: '', slaHours: '' })
    );
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
    expect((await stages()).map((stage) => stage.key)).toHaveLength(6);
  });

  it('apaga una etapa vacía pero no una con oportunidades vivas ni la última de su tipo', async () => {
    const current = await stages();
    const contactado = current.find((stage) => stage.key === 'contactado')!;
    const ganado = current.find((stage) => stage.key === 'ganado')!;

    seedOpportunity(fake, { id: 'opp-viva', stageId: contactado.id, status: 'open' });
    const blocked = await send(
      manager,
      buildUpdateStageCommand({ stageId: contactado.id, active: false })
    );
    expect(blocked).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });
    expect(blocked.message).toMatch(/Mueve primero/);

    // La única etapa ganada tampoco se apaga: el embudo dejaría de poder ganar.
    const lastWon = await send(
      manager,
      buildUpdateStageCommand({ stageId: ganado.id, active: false })
    );
    expect(lastWon).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });

    const cotizado = current.find((stage) => stage.key === 'cotizado')!;
    expect(
      (await send(manager, buildUpdateStageCommand({ stageId: cotizado.id, active: false }))).status
    ).toBe('completed');
    expect((await listPipelineStages(manager)).map((stage) => stage.key)).not.toContain('cotizado');
    // Apagada, no borrada: sigue en el catálogo completo.
    expect((await stages()).map((stage) => stage.key)).toContain('cotizado');
  });
});
