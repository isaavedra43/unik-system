import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('@/modules/operations/testing/fixtures');
  // `FakePrisma` no lee el esquema: los valores por omisión de `CtGraphScene`
  // (`version @default(1)`, `shared @default(false)`) se declaran aquí.
  return {
    fake: createOpsFake({
      defaults: {
        ctGraphScene: () => ({ version: 1, shared: false, filters: null, layout: null, at: null }),
      },
    }),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));

import {
  MAX_SCENES_PER_USER,
  createGraphScene,
  deleteGraphScene,
  getGraphScene,
  listGraphScenes,
  updateGraphScene,
} from './scenes-service';
import { makeCurrentUser } from '@/modules/operations/testing/fixtures';

/**
 * Escenas guardadas del explorador del grafo. Lo que se prueba son las reglas
 * de propiedad y de visibilidad: una escena propia la manda su dueño; una
 * compartida la abre quien tenga permiso de la perspectiva, pero NADIE ajeno la
 * edita ni la borra.
 */

const ANA = makeCurrentUser({
  id: 'u-ana',
  permissionKeys: ['operations.admin', 'finance.view'],
});
const BETO = makeCurrentUser({ id: 'u-beto', permissionKeys: ['operations.admin'] });
const NOBODY = makeCurrentUser({ id: 'u-nadie', permissionKeys: [] });

const INPUT = {
  name: 'Atoradas de la semana',
  perspectiveKey: 'expediente',
  roots: [{ type: 'operational_case', id: 'c1' }],
};

function reset(): void {
  for (const table of mocks.fake.tables.keys()) mocks.fake.tables.set(table, []);
  mocks.fake.seed('user', { id: 'u-ana', name: 'Ana', username: 'ana' });
  mocks.fake.seed('user', { id: 'u-beto', name: 'Beto', username: 'beto' });
}

describe('createGraphScene', () => {
  beforeEach(reset);

  it('guarda la escena del usuario de la sesión', async () => {
    const scene = await createGraphScene(ANA, { ...INPUT, filters: { area: 'compras' }, depth: 3 });
    expect(scene).toMatchObject({
      name: 'Atoradas de la semana',
      perspectiveKey: 'expediente',
      ownerUserId: 'u-ana',
      ownerName: 'Ana',
      mine: true,
      canEdit: true,
      shared: false,
      version: 1,
    });
    expect(scene.roots).toEqual([{ type: 'operational_case', id: 'c1' }]);
    expect(scene.filters).toEqual({ area: 'compras', depth: 3 });
    expect(scene.perspectiveLabel).not.toBe('expediente');
  });

  it('exige operations.admin', async () => {
    await expect(createGraphScene(NOBODY, INPUT)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rechaza una perspectiva inexistente', async () => {
    await expect(
      createGraphScene(ANA, { ...INPUT, perspectiveKey: 'inventada' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rechaza una escena sin nombre o sin raíces, con mensaje en español', async () => {
    await expect(createGraphScene(ANA, { ...INPUT, name: '  ' })).rejects.toThrow(
      /Ponle un nombre/
    );
    await expect(createGraphScene(ANA, { ...INPUT, roots: [] })).rejects.toThrow(
      /punto de partida/
    );
  });

  it('rechaza un tipo de nodo con forma inválida', async () => {
    await expect(
      createGraphScene(ANA, { ...INPUT, roots: [{ type: 'Tipo Raro!', id: 'x' }] })
    ).rejects.toThrow(/Tipo de nodo inválido/);
  });

  it('rechaza un trazado descomunal antes de guardarlo', async () => {
    const layout = { nodes: 'x'.repeat(300 * 1024) };
    await expect(createGraphScene(ANA, { ...INPUT, layout })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('pone un tope de escenas por persona', async () => {
    for (let index = 0; index < MAX_SCENES_PER_USER; index += 1) {
      mocks.fake.seed('ctGraphScene', {
        userId: 'u-ana',
        name: `escena ${index}`,
        perspectiveKey: 'expediente',
        roots: [],
        shared: false,
        version: 1,
      });
    }
    await expect(createGraphScene(ANA, INPUT)).rejects.toMatchObject({ code: 'invalid_request' });
    // ...y el tope es por persona, no global
    await expect(createGraphScene(BETO, INPUT)).resolves.toMatchObject({ ownerUserId: 'u-beto' });
  });
});

describe('listGraphScenes / getGraphScene', () => {
  beforeEach(reset);

  it('lista las propias y las compartidas, no las privadas de otros', async () => {
    await createGraphScene(ANA, { ...INPUT, name: 'privada de Ana' });
    await createGraphScene(ANA, { ...INPUT, name: 'compartida de Ana', shared: true });
    await createGraphScene(BETO, { ...INPUT, name: 'privada de Beto' });

    const names = (await listGraphScenes(BETO)).map((scene) => scene.name).sort();
    expect(names).toEqual(['compartida de Ana', 'privada de Beto']);
  });

  it('una escena compartida cuya perspectiva ya no existe deja de listarse', async () => {
    // Pasa cuando se retira una perspectiva del código: la fila sigue en la
    // base pero nadie ajeno debe poder abrirla.
    mocks.fake.seed('ctGraphScene', {
      userId: 'u-ana',
      name: 'perspectiva retirada',
      perspectiveKey: 'perspectiva_que_ya_no_existe',
      roots: [],
      shared: true,
      version: 1,
    });
    expect(await listGraphScenes(BETO)).toHaveLength(0);
    // ...pero su dueño la sigue viendo, para poder borrarla.
    expect(await listGraphScenes(ANA)).toHaveLength(1);
  });

  it('una escena compartida de otra área sí la abre quien administra operaciones', async () => {
    await createGraphScene(ANA, {
      name: 'dinero comprometido',
      perspectiveKey: 'contabilidad',
      roots: [{ type: 'obligation', id: 'ob1' }],
      shared: true,
    });
    expect(await listGraphScenes(BETO)).toHaveLength(1);
  });

  it('filtra por perspectiva', async () => {
    await createGraphScene(ANA, { ...INPUT, name: 'a' });
    await createGraphScene(ANA, {
      name: 'b',
      perspectiveKey: 'logistica',
      roots: [{ type: 'trip', id: 't1' }],
    });
    const scenes = await listGraphScenes(ANA, { perspectiveKey: 'logistica' });
    expect(scenes.map((scene) => scene.name)).toEqual(['b']);
  });

  it('getGraphScene no filtra una escena ajena privada', async () => {
    const scene = await createGraphScene(ANA, INPUT);
    await expect(getGraphScene(BETO, scene.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(getGraphScene(ANA, scene.id)).resolves.toMatchObject({ id: scene.id });
  });

  it('quien puede abrir una compartida la ve como ajena y sin edición', async () => {
    const scene = await createGraphScene(ANA, { ...INPUT, shared: true });
    const seen = await getGraphScene(BETO, scene.id);
    expect(seen).toMatchObject({ mine: false, canEdit: false, ownerName: 'Ana' });
  });
});

describe('updateGraphScene', () => {
  beforeEach(reset);

  it('guarda los cambios del dueño y sube la versión', async () => {
    const scene = await createGraphScene(ANA, INPUT);
    const updated = await updateGraphScene(ANA, scene.id, {
      name: 'Otro nombre',
      shared: true,
      layout: { zoom: 1.5 },
    });
    expect(updated).toMatchObject({ name: 'Otro nombre', shared: true, version: 2 });
    expect(updated.layout).toEqual({ zoom: 1.5 });
  });

  it('un cambio parcial no borra lo demás', async () => {
    const scene = await createGraphScene(ANA, { ...INPUT, filters: { area: 'compras' } });
    const updated = await updateGraphScene(ANA, scene.id, { name: 'Sólo el nombre' });
    expect(updated.filters).toEqual({ area: 'compras' });
    expect(updated.roots).toEqual(scene.roots);
  });

  it('nadie más puede editarla, ni siquiera si está compartida', async () => {
    const scene = await createGraphScene(ANA, { ...INPUT, shared: true });
    await expect(updateGraphScene(BETO, scene.id, { name: 'mía ahora' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('una escena ajena privada responde "no existe", no "no puedes"', async () => {
    const scene = await createGraphScene(ANA, INPUT);
    await expect(updateGraphScene(BETO, scene.id, { name: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('con expectedVersion vieja devuelve conflicto en vez de pisar el trabajo ajeno', async () => {
    const scene = await createGraphScene(ANA, INPUT);
    await updateGraphScene(ANA, scene.id, { name: 'primero' });
    await expect(
      updateGraphScene(ANA, scene.id, { name: 'segundo', expectedVersion: scene.version })
    ).rejects.toMatchObject({ code: 'version_conflict' });
  });

  it('con la versión correcta sí guarda', async () => {
    const scene = await createGraphScene(ANA, INPUT);
    await expect(
      updateGraphScene(ANA, scene.id, { name: 'segundo', expectedVersion: 1 })
    ).resolves.toMatchObject({ name: 'segundo', version: 2 });
  });
});

describe('deleteGraphScene', () => {
  beforeEach(reset);

  it('el dueño la borra', async () => {
    const scene = await createGraphScene(ANA, INPUT);
    await expect(deleteGraphScene(ANA, scene.id)).resolves.toEqual({ id: scene.id });
    expect(mocks.fake.rows('ctGraphScene')).toHaveLength(0);
  });

  it('nadie más la borra, ni una compartida', async () => {
    const scene = await createGraphScene(ANA, { ...INPUT, shared: true });
    await expect(deleteGraphScene(BETO, scene.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(mocks.fake.rows('ctGraphScene')).toHaveLength(1);
  });

  it('borrar algo que no existe responde en español', async () => {
    await expect(deleteGraphScene(ANA, 'no-existe')).rejects.toThrow(/No encontramos esa escena/);
  });

  it('exige operations.admin', async () => {
    await expect(deleteGraphScene(NOBODY, 'x')).rejects.toMatchObject({ code: 'forbidden' });
  });
});
