import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import {
  assertPermission,
  AuthorizationError,
  type CurrentUser,
} from '@/modules/auth/authorization';
import {
  getStorageObject,
  readObjectToBuffer,
  saveGeneratedFile,
  StorageError,
} from '@/modules/storage/storage-service';
import { enqueueJob, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { segmentImage } from './sam-client';
import { modelForMode, estimateGeneration } from './higgsfield-adapter';
import type {
  SurfacePromptSpec,
  VisualAssetDTO,
  VisualMode,
  VisualProjectSummary,
  VisualProposalDTO,
  VisualSurfaceDTO,
} from './visual-contract';

/**
 * Lógica de dominio de Visual Studio.
 *
 * Autorización: cada operación vuelve a resolver actor + permiso; no hay
 * "ids que otorgan acceso". UNIK es mono-empresa, así que el aislamiento es
 * por permiso y por propiedad del proyecto (createdBy), no por tenant.
 *
 * Imágenes: originales, máscaras y resultados viven en el storage privado con
 * purpose `visual`; la UI solo recibe `/app/files/api/objects/:id/content`.
 *
 * Generación: `requestProposal` crea el registro y encola `visual.generate`;
 * el handler (visual-jobs.ts) hace el upload a Higgsfield, somete, espera y
 * guarda el resultado. Un fallo del proveedor deja la propuesta en `failed`
 * con el error — nunca se marca completada ni se registra cobro ficticio.
 */

export const VISUAL_GENERATE_JOB = 'visual.generate';
const MAX_IMAGE_READ_BYTES = 20 * 1024 * 1024;

function contentUrl(objectId: string): string {
  return `/app/files/api/objects/${objectId}/content`;
}

function notFound(message = 'No encontrado'): never {
  throw new StorageError(message, 'not_found', 404);
}

// ---------------------------------------------------------------------------
// Proyectos
// ---------------------------------------------------------------------------

export async function listProjects(actor: CurrentUser): Promise<VisualProjectSummary[]> {
  assertPermission(actor, 'visual_studio.view');
  const projects = await prisma.visualProject.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 200,
    include: {
      contact: { select: { contactName: true, companyName: true } },
      _count: { select: { assets: true, proposals: true } },
    },
  });
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    notes: p.notes,
    contactId: p.contactId,
    contactName: p.contact?.companyName ?? p.contact?.contactName ?? null,
    quoteId: p.quoteId,
    salesOrderId: p.salesOrderId,
    assetCount: p._count.assets,
    proposalCount: p._count.proposals,
    createdBy: p.createdById,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }));
}

export async function getProject(actor: CurrentUser, id: string) {
  assertPermission(actor, 'visual_studio.view');
  const project = await prisma.visualProject.findUnique({
    where: { id },
    include: { contact: { select: { contactName: true, companyName: true } } },
  });
  if (!project) notFound('Proyecto no encontrado');
  return project;
}

export async function createProject(
  actor: CurrentUser,
  input: { name: string; contactId?: string | null; quoteId?: string | null; salesOrderId?: string | null; notes?: string | null },
): Promise<{ id: string }> {
  assertPermission(actor, 'visual_studio.edit');
  const project = await prisma.visualProject.create({
    data: {
      name: input.name,
      notes: input.notes ?? null,
      contactId: input.contactId ?? null,
      quoteId: input.quoteId ?? null,
      salesOrderId: input.salesOrderId ?? null,
      createdById: actor.id,
    },
  });
  return { id: project.id };
}

export async function updateProject(
  actor: CurrentUser,
  id: string,
  input: { name?: string; notes?: string | null; status?: string; contactId?: string | null; quoteId?: string | null; salesOrderId?: string | null },
): Promise<void> {
  assertPermission(actor, 'visual_studio.edit');
  const result = await prisma.visualProject.updateMany({ where: { id }, data: input });
  if (result.count === 0) notFound('Proyecto no encontrado');
}

// ---------------------------------------------------------------------------
// Assets (fotografías del cliente)
// ---------------------------------------------------------------------------

function assetDTO(a: {
  id: string;
  kind: string;
  objectId: string;
  width: number | null;
  height: number | null;
  label: string | null;
  createdAt: Date;
}): VisualAssetDTO {
  return {
    id: a.id,
    kind: a.kind as VisualAssetDTO['kind'],
    objectId: a.objectId,
    width: a.width,
    height: a.height,
    label: a.label,
    contentUrl: contentUrl(a.objectId),
    createdAt: a.createdAt.toISOString(),
  };
}

export async function listAssets(actor: CurrentUser, projectId: string): Promise<VisualAssetDTO[]> {
  assertPermission(actor, 'visual_studio.view');
  const assets = await prisma.visualAsset.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  });
  return assets.map(assetDTO);
}

// ---------------------------------------------------------------------------
// Superficies y máscaras (SAM 2)
// ---------------------------------------------------------------------------

interface MaskHistoryEntry {
  maskObjectId: string;
  prompt: SurfacePromptSpec;
  score: number | null;
  model: string;
  source: 'sam' | 'manual';
  at: string;
}

function surfaceDTO(s: {
  id: string;
  assetId: string;
  label: string;
  maskObjectId: string;
  promptSpec: unknown;
  status: string;
  updatedAt: Date;
}): VisualSurfaceDTO {
  return {
    id: s.id,
    assetId: s.assetId,
    label: s.label,
    maskObjectId: s.maskObjectId,
    maskUrl: contentUrl(s.maskObjectId),
    prompt: (s.promptSpec ?? { points: [] }) as SurfacePromptSpec,
    status: s.status,
    updatedAt: s.updatedAt.toISOString(),
  };
}

export async function listSurfaces(actor: CurrentUser, projectId: string): Promise<VisualSurfaceDTO[]> {
  assertPermission(actor, 'visual_studio.view');
  const surfaces = await prisma.visualSurface.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
  });
  return surfaces.map(surfaceDTO);
}

async function saveMaskObject(actor: CurrentUser, maskPng: Buffer, label: string) {
  return saveGeneratedFile({
    createdBy: actor.id,
    purpose: 'visual',
    fileName: `${label}.png`,
    mimeType: 'image/png',
    source: { buffer: maskPng },
    restricted: true,
  });
}

async function loadAssetImage(assetId: string) {
  const asset = await prisma.visualAsset.findUnique({ where: { id: assetId } });
  if (!asset) notFound('Fotografía no encontrada');
  const object = await getStorageObject(asset.objectId);
  if (!object || object.status !== 'ready') {
    throw new StorageError('La fotografía aún no está disponible', 'invalid', 409);
  }
  const buffer = await readObjectToBuffer(object, MAX_IMAGE_READ_BYTES);
  return { asset, buffer };
}

/**
 * Crea una superficie nueva: SAM segmenta la foto con los puntos/caja dados y
 * la máscara queda guardada como objeto de storage + historial.
 */
export async function createSurface(
  actor: CurrentUser,
  input: { projectId: string; assetId: string; label: string; prompt: SurfacePromptSpec },
): Promise<VisualSurfaceDTO> {
  assertPermission(actor, 'visual_studio.edit');
  const project = await prisma.visualProject.findUnique({ where: { id: input.projectId } });
  if (!project) notFound('Proyecto no encontrado');
  const { asset, buffer } = await loadAssetImage(input.assetId);
  if (asset.projectId !== input.projectId) throw new AuthorizationError('El asset no pertenece al proyecto');

  const seg = await segmentImage({ image: buffer, prompt: input.prompt });
  const mask = await saveMaskObject(actor, seg.maskPng, `mask-${input.label}`);

  const history: MaskHistoryEntry[] = [
    { maskObjectId: mask.id, prompt: input.prompt, score: seg.score, model: seg.model, source: 'sam', at: new Date().toISOString() },
  ];
  const surface = await prisma.visualSurface.create({
    data: {
      projectId: input.projectId,
      assetId: input.assetId,
      label: input.label,
      maskObjectId: mask.id,
      promptSpec: input.prompt as unknown as Prisma.InputJsonValue,
      maskHistory: history as unknown as Prisma.InputJsonValue,
      createdById: actor.id,
    },
  });
  return surfaceDTO(surface);
}

/**
 * Refina una superficie: nuevos puntos contra la máscara previa (SAM) o una
 * máscara dibujada a mano por el usuario (pincel/borrador). Cada corrección
 * conserva la versión anterior en maskHistory.
 */
export async function refineSurface(
  actor: CurrentUser,
  input: { surfaceId: string; prompt: SurfacePromptSpec; manualMaskPngBase64?: string | null },
): Promise<VisualSurfaceDTO> {
  assertPermission(actor, 'visual_studio.edit');
  const surface = await prisma.visualSurface.findUnique({ where: { id: input.surfaceId } });
  if (!surface) notFound('Superficie no encontrada');

  let maskPng: Buffer;
  let score: number | null = null;
  let model = 'manual';
  let source: MaskHistoryEntry['source'] = 'manual';

  if (input.manualMaskPngBase64) {
    maskPng = Buffer.from(input.manualMaskPngBase64, 'base64');
    if (maskPng.length > MAX_IMAGE_READ_BYTES) {
      throw new StorageError('La máscara excede el tamaño máximo', 'invalid', 413);
    }
  } else {
    const { buffer } = await loadAssetImage(surface.assetId);
    const priorObject = await getStorageObject(surface.maskObjectId);
    const priorMask = priorObject
      ? await readObjectToBuffer(priorObject, MAX_IMAGE_READ_BYTES)
      : undefined;
    const seg = await segmentImage({ image: buffer, prompt: input.prompt, priorMaskPng: priorMask });
    maskPng = seg.maskPng;
    score = seg.score;
    model = seg.model;
    source = 'sam';
  }

  const mask = await saveMaskObject(actor, maskPng, `mask-${surface.label}`);
  const history = [
    ...((surface.maskHistory as unknown as MaskHistoryEntry[]) ?? []),
    { maskObjectId: mask.id, prompt: input.prompt, score, model, source, at: new Date().toISOString() },
  ];
  const updated = await prisma.visualSurface.update({
    where: { id: surface.id },
    data: {
      maskObjectId: mask.id,
      promptSpec: input.prompt as unknown as Prisma.InputJsonValue,
      maskHistory: history as unknown as Prisma.InputJsonValue,
    },
  });
  return surfaceDTO(updated);
}

export async function deleteSurface(actor: CurrentUser, surfaceId: string): Promise<void> {
  assertPermission(actor, 'visual_studio.edit');
  await prisma.visualSurface.delete({ where: { id: surfaceId } }).catch(() => notFound('Superficie no encontrada'));
}

// ---------------------------------------------------------------------------
// Medios de producto
// ---------------------------------------------------------------------------

export async function listProductMedia(actor: CurrentUser, productId: string) {
  assertPermission(actor, 'visual_studio.view');
  const media = await prisma.productMedia.findMany({
    where: { productId },
    orderBy: { createdAt: 'asc' },
    include: { object: { select: { originalName: true } } },
  });
  return media.map((m) => ({
    id: m.id,
    productId: m.productId,
    objectId: m.objectId,
    kind: m.kind,
    label: m.label ?? m.object.originalName,
    contentUrl: contentUrl(m.objectId),
    createdAt: m.createdAt.toISOString(),
  }));
}

export async function searchProducts(actor: CurrentUser, query: string) {
  assertPermission(actor, 'visual_studio.view');
  assertPermission(actor, 'products.view');
  return prisma.product.findMany({
    where: query
      ? {
          OR: [
            { name: { contains: query, mode: 'insensitive' } },
            { sku: { contains: query, mode: 'insensitive' } },
          ],
        }
      : {},
    orderBy: { name: 'asc' },
    take: 40,
    select: {
      id: true,
      name: true,
      sku: true,
      rate: true,
      unit: true,
      status: true,
      _count: { select: { media: true } },
    },
  });
}

// ---------------------------------------------------------------------------
// Propuestas y generación
// ---------------------------------------------------------------------------

function proposalDTO(p: {
  id: string;
  surfaceId: string | null;
  productId: string | null;
  product: { name: string | null } | null;
  mode: string;
  prompt: string;
  provider: string;
  model: string | null;
  providerJobId: string | null;
  costCredits: Prisma.Decimal | null;
  status: string;
  resultObjectId: string | null;
  error: string | null;
  version: number;
  selectedAt: Date | null;
  createdAt: Date;
}): VisualProposalDTO {
  return {
    id: p.id,
    surfaceId: p.surfaceId,
    productId: p.productId,
    productName: p.product?.name ?? null,
    mode: p.mode as VisualMode,
    prompt: p.prompt,
    provider: p.provider,
    model: p.model,
    providerJobId: p.providerJobId,
    costCredits: p.costCredits ? p.costCredits.toString() : null,
    status: p.status as VisualProposalDTO['status'],
    resultObjectId: p.resultObjectId,
    resultUrl: p.resultObjectId ? contentUrl(p.resultObjectId) : null,
    error: p.error,
    version: p.version,
    selectedAt: p.selectedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
  };
}

export async function listProposals(actor: CurrentUser, projectId: string): Promise<VisualProposalDTO[]> {
  assertPermission(actor, 'visual_studio.view');
  const proposals = await prisma.visualProposal.findMany({
    where: { projectId },
    orderBy: [{ version: 'asc' }, { createdAt: 'asc' }],
    include: { product: { select: { name: true } } },
  });
  return proposals.map(proposalDTO);
}

export interface RequestProposalResult {
  proposalId: string;
  estimateCredits: number | null;
  estimateAvailable: boolean;
}

/**
 * Registra la propuesta y encola la generación. La estimación de costo se
 * intenta pero no bloquea: si el proveedor no responde se guarda
 * `estimateAvailable=false` y la UI decide si pide confirmación extra.
 */
export async function requestProposal(
  actor: CurrentUser,
  input: { projectId: string; surfaceId: string; productId?: string | null; mode: VisualMode; prompt: string },
): Promise<RequestProposalResult> {
  assertPermission(actor, 'visual_studio.generate');
  const [project, surface] = await Promise.all([
    prisma.visualProject.findUnique({ where: { id: input.projectId } }),
    prisma.visualSurface.findUnique({ where: { id: input.surfaceId } }),
  ]);
  if (!project) notFound('Proyecto no encontrado');
  if (!surface || surface.projectId !== input.projectId) notFound('Superficie no encontrada');
  if (input.productId) {
    const product = await prisma.product.findUnique({ where: { id: input.productId } });
    if (!product) notFound('Producto no encontrado');
  }

  const version =
    (await prisma.visualProposal.count({ where: { projectId: input.projectId, surfaceId: input.surfaceId } })) + 1;
  const model = modelForMode(input.mode);

  const proposal = await prisma.visualProposal.create({
    data: {
      projectId: input.projectId,
      surfaceId: input.surfaceId,
      productId: input.productId ?? null,
      mode: input.mode,
      prompt: input.prompt,
      provider: 'higgsfield',
      model,
      version,
      status: 'pending',
      createdById: actor.id,
    },
  });

  let estimateCredits: number | null = null;
  let estimateAvailable = false;
  try {
    // Estimación solo si el proveedor está configurado; no sube media todavía.
    const est = await estimateGeneration(actor, {
      mode: input.mode,
      prompt: input.prompt,
      photoMediaId: 'pending-upload',
      maskMediaId: input.mode === 'faithful' ? 'pending-upload' : undefined,
      model,
    });
    estimateCredits = est.credits;
    estimateAvailable = true;
    if (est.credits != null) {
      await prisma.visualProposal.update({
        where: { id: proposal.id },
        data: { costCredits: new Prisma.Decimal(est.credits) },
      });
    }
  } catch {
    estimateAvailable = false;
  }

  await enqueueJob({
    type: VISUAL_GENERATE_JOB,
    payload: { proposalId: proposal.id, actorId: actor.id },
    priority: JOB_PRIORITY.interactive,
    dedupeKey: `visual-generate:${proposal.id}`,
    maxAttempts: 2,
    createdBy: actor.id,
  });

  return { proposalId: proposal.id, estimateCredits, estimateAvailable };
}

/** Marca la propuesta elegida por el cliente (registro comercial). */
export async function selectProposal(actor: CurrentUser, proposalId: string): Promise<void> {
  assertPermission(actor, 'visual_studio.select');
  const result = await prisma.visualProposal.updateMany({
    where: { id: proposalId, status: 'completed' },
    data: { selectedAt: new Date(), selectedById: actor.id },
  });
  if (result.count === 0) notFound('Propuesta no disponible para selección');
}
