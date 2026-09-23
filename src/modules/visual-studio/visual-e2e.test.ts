import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/prisma';

/**
 * Integración real de Visual Studio: corre SOLO cuando están definidas
 * DATABASE_URL y VISUAL_SAM_URL (worker SAM vivo). No mockea nada: crea un
 * usuario con rol, guarda una imagen real en el storage configurado y ejecuta
 * segmentación + corrección + solicitud de propuesta contra los servicios.
 *
 *   DATABASE_URL=... VISUAL_SAM_URL=http://127.0.0.1:8765 VISUAL_SAM_TOKEN=...
 *   vitest run --project unit src/modules/visual-studio/visual-e2e.test.ts
 */

const RUN = Boolean(process.env.DATABASE_URL && process.env.VISUAL_SAM_URL);
const itE2E = RUN ? it : it.skip;

import { saveGeneratedFile } from '@/modules/storage/storage-service';
import {
  createProject,
  createSurface,
  listProposals,
  refineSurface,
  requestProposal,
} from './visual-service';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { PermissionKey } from '@/modules/auth/permissions';

/** PNG 640x480: fondo claro + rectángulo oscuro que simula una cubierta. */
function syntheticKitchenPng(): Buffer {
  // PNG mínimo generado con zlib manual sería largo; usamos un canvas-like
  // bitmap → PNG vía sharp? No disponible. Generamos un PNG real con la
  // librería de compresión de node.
  const zlib = require('node:zlib') as typeof import('node:zlib');
  const W = 640, H = 480;
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 3);
    raw[row] = 0; // filter none
    for (let x = 0; x < W; x++) {
      const o = row + 1 + x * 3;
      const inRect = x >= 80 && x < 560 && y >= 280 && y < 360;
      raw[o] = inRect ? 90 : 200;
      raw[o + 1] = inRect ? 80 : 200;
      raw[o + 2] = inRect ? 70 : 195;
    }
  }
  const idat = zlib.deflateSync(raw);
  const crcTable = (() => {
    const t: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t.push(c >>> 0);
    }
    return t;
  })();
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe.skipIf(!RUN)('visual-studio e2e (worker SAM real)', () => {
  let actor: CurrentUser;
  let projectId = '';
  let assetId = '';
  let cleanup: Array<() => Promise<unknown>> = [];

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        username: `vs-e2e-${Date.now()}`,
        name: 'VS E2E',
        passwordHash: 'x',
        isActive: true,
      },
    });
    const role = await prisma.role.create({
      data: {
        key: `vs-e2e-${Date.now()}`,
        name: 'VS E2E',
        permissions: {
          create: (
            [
              'visual_studio.view',
              'visual_studio.edit',
              'visual_studio.generate',
              'visual_studio.select',
              'visual_studio.media',
              'products.view',
            ] as PermissionKey[]
          ).map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    actor = {
      id: user.id,
      username: user.username,
      name: user.name,
      email: null,
      mustChangePassword: false,
      roleKeys: [role.key],
      permissionKeys: [
        'visual_studio.view',
        'visual_studio.edit',
        'visual_studio.generate',
        'visual_studio.select',
        'visual_studio.media',
        'products.view',
      ],
      isSuperAdmin: false,
    };
    cleanup = [
      () => prisma.userRole.deleteMany({ where: { userId: user.id } }),
      () => prisma.rolePermission.deleteMany({ where: { roleId: role.id } }),
      () => prisma.role.delete({ where: { id: role.id } }),
      () => prisma.user.delete({ where: { id: user.id } }),
    ];
  });

  afterAll(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
    await prisma.$disconnect();
  });

  itE2E('flujo completo hasta propuesta encolada', async () => {
    // 1. Proyecto
    const project = await createProject(actor, { name: 'E2E cocina' });
    projectId = project.id;
    expect(projectId).toBeTruthy();

    // 2. Foto al storage real + asset
    const png = syntheticKitchenPng();
    const object = await saveGeneratedFile({
      createdBy: actor.id,
      purpose: 'visual',
      fileName: 'cocina.png',
      mimeType: 'image/png',
      source: { buffer: png },
      restricted: true,
    });
    const asset = await prisma.visualAsset.create({
      data: { projectId, kind: 'source', objectId: object.id, createdById: actor.id },
    });
    assetId = asset.id;

    // 3. Segmentación real contra el worker
    const surface = await createSurface(actor, {
      projectId,
      assetId,
      label: 'cubierta',
      prompt: { points: [{ x: 320, y: 320, positive: true }], box: null },
    });
    expect(surface.maskObjectId).toBeTruthy();
    expect(surface.status).toBe('active');

    // 4. Corrección con clic negativo contra la máscara previa
    const refined = await refineSurface(actor, {
      surfaceId: surface.id,
      prompt: { points: [{ x: 320, y: 320, positive: true }], box: null },
    });
    expect(refined.maskObjectId).not.toBe(surface.maskObjectId);
    const stored = await prisma.visualSurface.findUnique({ where: { id: surface.id } });
    expect((stored?.maskHistory as unknown[]).length).toBe(2);

    // 5. Solicitud de propuesta → queda pending y el job queda encolado
    const req = await requestProposal(actor, {
      projectId,
      surfaceId: surface.id,
      mode: 'faithful',
      prompt: 'cambia la cubierta a granito negro',
    });
    const proposals = await listProposals(actor, projectId);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status === 'pending' || proposals[0].status === 'failed').toBe(true);
    expect(proposals[0].version).toBe(1);
    expect(req.proposalId).toBe(proposals[0].id);

    // 6. Sin permiso → rechazado
    const intruder: CurrentUser = { ...actor, permissionKeys: [], roleKeys: [] };
    await expect(listProposals(intruder, projectId)).rejects.toThrow();

    // limpieza del proyecto
    await prisma.visualProposal.deleteMany({ where: { projectId } });
    await prisma.visualSurface.deleteMany({ where: { projectId } });
    await prisma.visualAsset.deleteMany({ where: { projectId } });
    await prisma.visualProject.delete({ where: { id: projectId } });
  }, 180_000);
});
