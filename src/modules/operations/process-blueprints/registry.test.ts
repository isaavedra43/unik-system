import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('../testing/fixtures');
  return { fake: createOpsFake() };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: vi.fn(),
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));

import {
  blueprintChecksum,
  clearProcessBlueprintCache,
  ensureProcessVersion,
  loadProcessBlueprint,
  validateBlueprint,
} from './registry';
import { SALES_FULFILLMENT_BLUEPRINT } from './sales-fulfillment';
import type { ProcessBlueprint } from './types';

const { fake } = mocks;
const db = fake.client as never;

function clone(): ProcessBlueprint {
  return JSON.parse(JSON.stringify(SALES_FULFILLMENT_BLUEPRINT)) as ProcessBlueprint;
}

beforeEach(() => {
  fake.tables.clear();
  clearProcessBlueprintCache();
});

describe('validateBlueprint', () => {
  it('el blueprint publicado es válido', () => {
    expect(validateBlueprint(SALES_FULFILLMENT_BLUEPRINT)).toEqual([]);
  });

  it('detecta dependencias inexistentes, ciclos, condiciones desconocidas y reglas de alcance', () => {
    const missing = clone();
    missing.steps[1].dependsOn = ['no_existe'];
    expect(validateBlueprint(missing).join(' ')).toContain('inexistente');

    const cycle = clone();
    cycle.steps[0].dependsOn = ['cierre_financiero'];
    expect(validateBlueprint(cycle).join(' ')).toContain('circular');

    const condition = clone();
    (condition.steps[0] as { autoComplete?: string }).autoComplete = 'inventada';
    expect(validateBlueprint(condition).length).toBeGreaterThan(0);

    const scope = clone();
    scope.steps[0].appliesTo = ['stock'];
    expect(validateBlueprint(scope).join(' ')).toContain('appliesTo');

    const engine = clone();
    delete engine.steps[2].autoComplete;
    expect(validateBlueprint(engine).join(' ')).toContain('motor');
  });
});

describe('blueprintChecksum', () => {
  it('es estable y cambia con cualquier cambio de definición', () => {
    expect(blueprintChecksum(clone())).toBe(blueprintChecksum(SALES_FULFILLMENT_BLUEPRINT));
    const changed = clone();
    changed.steps[0].slaMinutes = 90;
    expect(blueprintChecksum(changed)).not.toBe(blueprintChecksum(SALES_FULFILLMENT_BLUEPRINT));
  });
});

describe('ensureProcessVersion', () => {
  it('publica la versión la primera vez y después devuelve la misma fila', async () => {
    const first = await ensureProcessVersion(db, SALES_FULFILLMENT_BLUEPRINT);
    const second = await ensureProcessVersion(db, SALES_FULFILLMENT_BLUEPRINT);
    expect(second.id).toBe(first.id);
    expect(fake.rows('processVersion')).toHaveLength(1);
    expect(fake.rows('processVersion')[0]).toMatchObject({
      processKey: 'sales_fulfillment',
      version: 1,
      active: true,
      checksum: blueprintChecksum(SALES_FULFILLMENT_BLUEPRINT),
    });
  });

  it('rechaza con un error claro otra definición bajo la misma versión', async () => {
    await ensureProcessVersion(db, SALES_FULFILLMENT_BLUEPRINT);
    const changed = clone();
    changed.steps[0].slaMinutes = 90;
    await expect(ensureProcessVersion(db, changed)).rejects.toMatchObject({
      code: 'process_version_mismatch',
      message: expect.stringContaining('publica la versión 2'),
    });
  });

  it('una versión nueva se publica aparte y desactiva las anteriores', async () => {
    const v1 = await ensureProcessVersion(db, SALES_FULFILLMENT_BLUEPRINT);
    const next = clone();
    next.version = 2;
    next.steps[0].slaMinutes = 90;
    const v2 = await ensureProcessVersion(db, next);
    expect(v2.id).not.toBe(v1.id);
    const rows = fake.rows('processVersion');
    expect(rows.find((r) => r.id === v1.id)!.active).toBe(false);
    expect(rows.find((r) => r.id === v2.id)!.active).toBe(true);
  });
});

describe('loadProcessBlueprint', () => {
  it('devuelve la definición con la que se instanció el expediente', async () => {
    const version = await ensureProcessVersion(db, SALES_FULFILLMENT_BLUEPRINT);
    clearProcessBlueprintCache();
    const loaded = await loadProcessBlueprint(db, version.id);
    expect(loaded.version).toEqual({ id: version.id, processKey: 'sales_fulfillment', version: 1 });
    expect(loaded.blueprint.steps).toHaveLength(15);
  });

  it('detecta una definición guardada alterada', async () => {
    const version = await ensureProcessVersion(db, SALES_FULFILLMENT_BLUEPRINT);
    clearProcessBlueprintCache();
    const row = fake.rows('processVersion').find((r) => r.id === version.id)!;
    (row.definition as { steps: Array<{ slaMinutes: number }> }).steps[0].slaMinutes = 1;
    await expect(loadProcessBlueprint(db, version.id)).rejects.toMatchObject({
      code: 'process_version_corrupt',
    });
    await expect(loadProcessBlueprint(db, 'no-existe')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
