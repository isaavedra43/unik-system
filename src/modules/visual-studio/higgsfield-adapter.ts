import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { callMcpTool, McpError } from '@/modules/extensions/mcp-client-service';

/**
 * Adaptador de Higgsfield para Visual Studio.
 *
 * Higgsfield se conecta como una EXTENSIÓN MCP (`kind: 'mcp'`, namespace
 * `higgsfield`, endpoint https://mcp.higgsfield.ai/mcp, conexión oauth2). El
 * administrador la registra en Admin → Extensiones y aprueba las capabilities
 * que Visual Studio puede usar; este adaptador solo invoca capabilities con
 * `enabled` + `reviewStatus: 'approved'` — si faltan, falla con instrucción
 * clara en lugar de llamar sin revisión.
 *
 * Flujo de generación verificado contra el servidor real (sep 2026):
 *   media_upload → PUT presignado → media_confirm → media_id
 *   generate_image { model, prompt, medias: [{value, role}] , get_cost }
 *   job_status / jobs_wait → resultado con URLs descargables
 *   balance → créditos disponibles
 *
 * Roles de media observados: `image_references` (imagen/material de referencia)
 * y `mask` (edición localizada, modelos nano_banana_2*). El modelo por modo se
 * configura con VISUAL_HF_MODEL_FAITHFUL / VISUAL_HF_MODEL_CREATIVE.
 */

const HF_NAMESPACE = 'higgsfield';
const DEFAULT_FAITHFUL_MODEL = 'nano_banana_2';
const DEFAULT_CREATIVE_MODEL = 'flux_kontext';

export class VisualProviderError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'unconfigured'
      | 'capability'
      | 'upload'
      | 'submit'
      | 'poll'
      | 'download'
      | 'cost',
  ) {
    super(message);
    this.name = 'VisualProviderError';
  }
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  return (content ?? [])
    .map((c) => (c.type === 'text' ? String(c.text ?? '') : ''))
    .join('\n')
    .trim();
}

function structuredOf(result: unknown): unknown {
  return (result as { structuredContent?: unknown })?.structuredContent ?? null;
}

/** Busca recursivamente el primer string http(s) dentro de un resultado MCP. */
function findUrl(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) return null;
  if (typeof value === 'string') {
    return /^https?:\/\//.test(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const key of ['url', 'image', 'result', 'download_url', 'output']) {
      const found = findUrl((value as Record<string, unknown>)[key], depth + 1);
      if (found) return found;
    }
    for (const item of Object.values(value)) {
      const found = findUrl(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function findAllUrls(value: unknown, depth = 0, acc: string[] = []): string[] {
  if (depth > 6 || value == null) return acc;
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) acc.push(value);
    return acc;
  }
  if (Array.isArray(value)) {
    for (const item of value) findAllUrls(item, depth + 1, acc);
    return acc;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) findAllUrls(item, depth + 1, acc);
  }
  return acc;
}

function parseJsonMaybe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function higgsfieldExtension() {
  const extension = await prisma.extension.findFirst({
    where: { namespace: HF_NAMESPACE, kind: 'mcp' },
  });
  if (!extension) {
    throw new VisualProviderError(
      'Higgsfield no está registrado. En Admin → Extensiones agrega el MCP https://mcp.higgsfield.ai/mcp con namespace "higgsfield" y conexión OAuth.',
      'unconfigured',
    );
  }
  return extension;
}

async function call(
  actor: CurrentUser,
  localName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const extension = await higgsfieldExtension();
  const capability = await prisma.extensionCapability.findFirst({
    where: {
      extensionId: extension.id,
      localName,
      enabled: true,
      reviewStatus: 'approved',
    },
  });
  if (!capability) {
    throw new VisualProviderError(
      `La herramienta "${localName}" de Higgsfield no está aprobada. Revísala en Admin → Extensiones.`,
      'capability',
    );
  }
  try {
    return await callMcpTool(
      extension,
      {
        localName,
        connectionScope: capability.connectionScope,
        timeoutMs: Math.max(capability.timeoutMs, 60_000),
        maxResultBytes: Math.max(capability.maxResultBytes, 512 * 1024),
      },
      args,
      actor,
    );
  } catch (error) {
    if (error instanceof McpError) {
      throw new VisualProviderError(`Higgsfield (${localName}): ${error.message}`, 'submit');
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Media upload
// ---------------------------------------------------------------------------

interface UploadedMedia {
  mediaId: string;
}

/**
 * Sube bytes a Higgsfield: media_upload devuelve URL(s) presignada(s), el PUT
 * lo hace este servidor (no el navegador del empleado), media_confirm cierra.
 */
export async function uploadMedia(
  actor: CurrentUser,
  file: { bytes: Buffer; fileName: string; mimeType: string },
): Promise<UploadedMedia> {
  const res = await call(actor, 'media_upload', {
    filename: file.fileName,
    content_type: file.mimeType,
  });
  const payload = structuredOf(res) ?? parseJsonMaybe(textOf(res)) ?? {};
  const uploadUrl = findUrl(payload);
  const mediaId =
    (payload as Record<string, unknown>).media_id ??
    (payload as Record<string, unknown>).id ??
    (payload as Record<string, unknown>).mediaId;
  if (typeof uploadUrl !== 'string' || typeof mediaId !== 'string') {
    throw new VisualProviderError(
      `media_upload devolvió un formato inesperado: ${textOf(res).slice(0, 300)}`,
      'upload',
    );
  }
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.mimeType },
    body: new Uint8Array(file.bytes),
  });
  if (!put.ok) {
    throw new VisualProviderError(`Carga presignada falló: HTTP ${put.status}`, 'upload');
  }
  const confirm = await call(actor, 'media_confirm', { type: 'image', media_id: mediaId });
  const confirmed = structuredOf(confirm) ?? parseJsonMaybe(textOf(confirm));
  const confirmedId =
    (confirmed as Record<string, unknown> | null)?.media_id ??
    (confirmed as Record<string, unknown> | null)?.id ??
    mediaId;
  return { mediaId: String(confirmedId) };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GenerateImageRequest {
  mode: 'faithful' | 'creative';
  prompt: string;
  /** media_id de la fotografía original. */
  photoMediaId: string;
  /** media_id de la máscara (solo modo faithful). */
  maskMediaId?: string;
  /** media_ids de referencias del material (hasta 3). */
  materialMediaIds?: string[];
  aspectRatio?: string;
  /** Modelo explícito; por defecto según el modo. */
  model?: string;
}

export interface GenerationEstimate {
  credits: number | null;
  raw: unknown;
}

export function modelForMode(mode: 'faithful' | 'creative'): string {
  return mode === 'faithful'
    ? (process.env.VISUAL_HF_MODEL_FAITHFUL?.trim() || DEFAULT_FAITHFUL_MODEL)
    : (process.env.VISUAL_HF_MODEL_CREATIVE?.trim() || DEFAULT_CREATIVE_MODEL);
}

function buildParams(req: GenerateImageRequest): Record<string, unknown> {
  const medias: Array<{ value: string; role: string }> = [
    { value: req.photoMediaId, role: 'image_references' },
  ];
  if (req.maskMediaId) medias.push({ value: req.maskMediaId, role: 'mask' });
  for (const id of (req.materialMediaIds ?? []).slice(0, 3)) {
    medias.push({ value: id, role: 'image_references' });
  }
  return {
    model: req.model ?? modelForMode(req.mode),
    prompt: req.prompt,
    medias,
    ...(req.aspectRatio ? { aspect_ratio: req.aspectRatio } : {}),
  };
}

/** Estimación sin cobrar: get_cost devuelve el costo sin someter el trabajo. */
export async function estimateGeneration(
  actor: CurrentUser,
  req: GenerateImageRequest,
): Promise<GenerationEstimate> {
  const res = await call(actor, 'generate_image', {
    params: { ...buildParams(req), get_cost: true },
  });
  const payload = structuredOf(res) ?? parseJsonMaybe(textOf(res));
  const credits =
    typeof (payload as Record<string, unknown> | null)?.credits === 'number'
      ? ((payload as Record<string, unknown>).credits as number)
      : typeof (payload as Record<string, unknown> | null)?.cost === 'number'
        ? ((payload as Record<string, unknown>).cost as number)
        : null;
  return { credits, raw: payload };
}

export interface SubmittedGeneration {
  providerJobId: string;
  raw: unknown;
}

export async function submitGeneration(
  actor: CurrentUser,
  req: GenerateImageRequest,
): Promise<SubmittedGeneration> {
  const res = await call(actor, 'generate_image', { params: buildParams(req) });
  const payload = structuredOf(res) ?? parseJsonMaybe(textOf(res)) ?? {};
  const jobId =
    (payload as Record<string, unknown>).job_id ??
    (payload as Record<string, unknown>).jobId ??
    (payload as Record<string, unknown>).id;
  if (typeof jobId !== 'string' || !jobId) {
    throw new VisualProviderError(
      `generate_image no devolvió job id: ${textOf(res).slice(0, 300)}`,
      'submit',
    );
  }
  return { providerJobId: jobId, raw: payload };
}

export type GenerationState =
  | { status: 'pending' | 'processing' }
  | { status: 'completed'; resultUrls: string[]; raw: unknown }
  | { status: 'failed'; error: string; raw: unknown };

export async function pollGeneration(
  actor: CurrentUser,
  providerJobId: string,
): Promise<GenerationState> {
  const res = await call(actor, 'job_status', { jobId: providerJobId });
  const payload = structuredOf(res) ?? parseJsonMaybe(textOf(res)) ?? {};
  const status = String(
    (payload as Record<string, unknown>).status ??
      (payload as Record<string, unknown>).state ??
      '',
  ).toLowerCase();
  if (status === 'completed' || status === 'succeeded' || status === 'success') {
    const urls = findAllUrls(payload).filter((u) => /\.(png|jpe?g|webp|avif)/i.test(u) || true);
    return { status: 'completed', resultUrls: urls, raw: payload };
  }
  if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'nsfw') {
    const error =
      String((payload as Record<string, unknown>).error ?? '') ||
      textOf(res).slice(0, 400) ||
      `estado ${status}`;
    return { status: 'failed', error, raw: payload };
  }
  return { status: status === 'queued' ? 'pending' : 'processing' };
}

/** Descarga el resultado final. Solo HTTPS público. */
export async function downloadResult(url: string): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new VisualProviderError('URL de resultado inválida', 'download');
  }
  if (parsed.protocol !== 'https:') {
    throw new VisualProviderError('Resultado no HTTPS', 'download');
  }
  const res = await fetch(parsed.toString(), { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new VisualProviderError(`Descarga falló: HTTP ${res.status}`, 'download');
  return Buffer.from(await res.arrayBuffer());
}

/** Créditos disponibles en la cuenta del proveedor (para límites/UX). */
export async function providerBalance(actor: CurrentUser): Promise<unknown> {
  const res = await call(actor, 'balance', {});
  return structuredOf(res) ?? parseJsonMaybe(textOf(res)) ?? null;
}
