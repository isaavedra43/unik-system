import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ajustes de la contabilidad interna sobre FakePrisma (plan 6.4: «Sólo las
 * liquidaciones mueven caja (cuenta "Banco (Zoho)" configurable)»).
 *
 * `updateFinanceSettings` existía desde el principio pero NADIE lo llamaba: no
 * había ruta, ni server action, ni pantalla, así que el sistema corría siempre
 * con `defaultFinanceSettings()` y repuntar la cuenta de cobros exigía editar la
 * fila a mano. Esta prueba ejerce la escritura que ahora usa la pantalla de
 * Catálogos: permiso, fusión parcial, fila creada en la primera vez, caché
 * invalidada y auditoría.
 */

const mocks = await vi.hoisted(async () => {
  const { createFinanceFake } = await import('./testing/finance-fixtures');
  return { fake: createFinanceFake() };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/auth/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/auth/permissions')>();
  const { withFinancePermissions } = await import('./testing/finance-permissions');
  return withFinancePermissions(actual);
});
vi.mock('@/modules/jobs/job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/jobs/job-queue')>()),
  wakeJobWorker: vi.fn(),
  registerJobHandler: vi.fn(),
}));

import { isOperationsError } from '@/modules/operations/errors';
import {
  FINANCE_CONFIG_SOURCE,
  defaultFinanceSettings,
  getFinanceSettings,
  invalidateFinanceSettingsCache,
  normalizeFinanceSettings,
  readFinanceSettings,
  updateFinanceSettings,
} from './finance-config';
import { resetFinanceFake, seedFinanceTeam, type FinanceTeam } from './testing/finance-fixtures';

const { fake } = mocks;
let team: FinanceTeam;

const configRows = () =>
  fake.rows('integrationConfig').filter((row) => row.source === FINANCE_CONFIG_SOURCE);
const auditRows = () =>
  fake.rows('auditLog').filter((row) => row.action === 'finance.config.updated');

beforeEach(async () => {
  await resetFinanceFake(fake);
  invalidateFinanceSettingsCache();
  team = seedFinanceTeam(fake);
});

describe('ajustes de contabilidad', () => {
  it('sin fila guardada corre con los valores por omisión', async () => {
    expect(await readFinanceSettings()).toEqual(defaultFinanceSettings());
    expect(defaultFinanceSettings().collectionsCashAccountKey).toBe('banco_zoho');
    expect(configRows()).toHaveLength(0);
  });

  it('crea la fila la primera vez y deja la entrada de auditoría', async () => {
    const saved = await updateFinanceSettings(team.admin, {
      collectionsCashAccountKey: 'banco_santander',
    });
    expect(saved.collectionsCashAccountKey).toBe('banco_santander');
    // Lo demás no se toca.
    expect(saved.obligationsDueAlertDays).toBe(defaultFinanceSettings().obligationsDueAlertDays);

    expect(configRows()).toHaveLength(1);
    expect(configRows()[0]).toMatchObject({
      source: 'finance',
      displayName: 'Contabilidad interna',
      isEnabled: true,
    });
    expect(normalizeFinanceSettings(configRows()[0].settings)).toEqual(saved);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      actorUserId: 'u-conta',
      targetType: 'integration_config',
      targetId: 'finance',
      metadata: { fields: ['collectionsCashAccountKey'] },
    });
  });

  it('un segundo parche fusiona sin borrar lo anterior y se lee de vuelta', async () => {
    await updateFinanceSettings(team.admin, { collectionsCashAccountKey: 'banco_santander' });
    const saved = await updateFinanceSettings(team.admin, {
      obligationsDueAlertDays: 10,
      dailyCloseReminder: false,
    });
    expect(saved).toEqual({
      collectionsCashAccountKey: 'banco_santander',
      obligationsDueAlertDays: 10,
      reconcileLookbackDays: 120,
      expenseHistoryMonths: 6,
      dailyCloseReminder: false,
    });
    expect(configRows()).toHaveLength(1);
    expect(await readFinanceSettings()).toEqual(saved);
    // La caché del lector global se invalida al guardar: nadie sigue conciliando
    // contra la cuenta vieja.
    expect(await getFinanceSettings()).toEqual(saved);
  });

  it('exige finance.manage_catalog y no escribe nada cuando falta', async () => {
    await expect(
      updateFinanceSettings(team.capturer, { collectionsCashAccountKey: 'caja_chica' })
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(configRows()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('rechaza un parche inválido con invalid_config y deja la fila como estaba', async () => {
    await updateFinanceSettings(team.admin, { collectionsCashAccountKey: 'banco_santander' });
    const error = await updateFinanceSettings(team.admin, {
      obligationsDueAlertDays: 999,
    }).catch((err: unknown) => err);
    expect(isOperationsError(error) && error.code).toBe('invalid_config');
    expect((await readFinanceSettings()).obligationsDueAlertDays).toBe(3);
    expect((await readFinanceSettings()).collectionsCashAccountKey).toBe('banco_santander');
  });

  it('normaliza una fila escrita a mano con basura sin reventar', () => {
    expect(
      normalizeFinanceSettings({
        collectionsCashAccountKey: 'MAYÚSCULAS NO',
        obligationsDueAlertDays: 'tres',
        reconcileLookbackDays: 45,
        extra: true,
      })
    ).toEqual({ ...defaultFinanceSettings(), reconcileLookbackDays: 45 });
    expect(normalizeFinanceSettings(null)).toEqual(defaultFinanceSettings());
  });
});
