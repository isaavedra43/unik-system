import { z } from 'zod';
import { executeTool, getAvailableTools, registerTool } from './registry';
import { getAiSettings } from '../ai-admin-config-service';
import { getAttachmentForActor, readAttachmentBytes } from '../ai-attachments-service';
import { chatCompletion } from '../ai-client';
import { getModelById } from '../model-catalog';
import { safeFetch } from '@/modules/extensions/safe-fetch';
import { acquireVenue, isVenueEnabled, VenueUnavailableError } from '@/modules/venues/venue-manager';
import { isUrlDenied } from '@/modules/web/fetch-service';

/**
 * Media tools — image analysis and media generation.
 *
 * `analyzeImage` answers a question about an image the agent can actually
 * reach: a conversation attachment, a public URL (safe-fetch, image content
 * types only), or the live screen of the virtual computer. The analysis is a
 * real vision-model call — if no configured model has vision, the tool says
 * so instead of inventing a description.
 *
 * `generateImage` / `generateVideo` are honest dispatchers: they locate an
 * approved external capability (MCP server, API extension, plugin, Composio)
 * whose contract mentions generating that medium and call it through the
 * registry — same permission/enabled/approval pipeline as any tool. When no
 * provider is connected they return a configuration error, never a fake file.
 */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

type Obj = Record<string, unknown>;

/** Picks the first configured model that can actually see images. */
function pickVisionModel(settings: Awaited<ReturnType<typeof getAiSettings>>): string | null {
  for (const candidate of [settings.routingComplexModel, settings.routingStandardModel, settings.routingSimpleModel]) {
    if (candidate && getModelById(candidate)?.capabilities.includes('vision')) return candidate;
  }
  return null;
}

async function imageDataUrl(
  actor: { id: string },
  args: { attachmentId?: string; imageUrl?: string; venueScreenshot?: boolean },
  conversationId?: string
): Promise<{ dataUrl: string; source: string } | { error: string }> {
  if (args.attachmentId) {
    if (!conversationId) return { error: 'Sin conversación para resolver el adjunto.' };
    const att = await getAttachmentForActor(conversationId, actor.id, args.attachmentId);
    if (!att) return { error: `Adjunto ${args.attachmentId} no encontrado o no disponible.` };
    if (!att.mimeType.startsWith('image/')) {
      return { error: `El adjunto "${att.fileName}" no es una imagen (${att.mimeType}).` };
    }
    const buffer = await readAttachmentBytes(att, MAX_IMAGE_BYTES);
    return { dataUrl: `data:${att.mimeType};base64,${buffer.toString('base64')}`, source: `adjunto ${att.fileName}` };
  }

  if (args.imageUrl) {
    const settings = await getAiSettings();
    const denied = isUrlDenied(
      args.imageUrl,
      (settings.webDomainAllowlist ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean),
      (settings.webDomainDenylist ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean)
    );
    if (denied) return { error: denied };
    const res = await safeFetch(
      args.imageUrl,
      {},
      {
        allowAnyHost: true,
        allowedHosts: [],
        denyHosts: (settings.webDomainDenylist ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean),
        timeoutMs: 20_000,
        maxResponseBytes: MAX_IMAGE_BYTES,
        allowedContentTypes: IMAGE_CONTENT_TYPES,
      }
    );
    const mime = res.headers['content-type']?.split(';')[0] || 'image/jpeg';
    return { dataUrl: `data:${mime};base64,${res.body.toString('base64')}`, source: args.imageUrl };
  }

  if (args.venueScreenshot) {
    if (!(await isVenueEnabled())) return { error: 'La computadora virtual no está habilitada.' };
    try {
      const venue = await acquireVenue({ userId: actor.id, purpose: 'analyze-screenshot' });
      const shot = await venue.screenshot();
      return { dataUrl: `data:${shot.mimeType};base64,${shot.imageBase64}`, source: 'pantalla de la computadora virtual' };
    } catch (err) {
      if (err instanceof VenueUnavailableError) return { error: err.message };
      throw err;
    }
  }

  return { error: 'Indica la imagen: attachmentId, imageUrl o venueScreenshot:true.' };
}

registerTool({
  name: 'analyzeImage',
  description:
    'Analiza una imagen con visión y responde una pregunta sobre ella. Fuentes: un adjunto de la conversación (attachmentId), una URL pública de imagen (imageUrl), o la pantalla actual de la computadora virtual (venueScreenshot:true).',
  category: 'media',
  enabledByDefault: true,
  requiredPermission: 'assistant.upload',
  resultTrust: 'untrusted',
  timeoutMs: 90_000,
  maxResultBytes: 16_000,
  contextTags: ['all'],
  parameters: z.object({
    question: z.string().min(3).max(2000).describe('Qué quieres saber de la imagen, ej. "¿qué dice el documento?", "describe los defectos visibles".'),
    attachmentId: z.string().optional().describe('Id de un adjunto de la conversación.'),
    imageUrl: z.string().url().max(2000).optional().describe('URL https:// de una imagen pública.'),
    venueScreenshot: z.boolean().optional().describe('true = analizar la pantalla actual de la computadora virtual.'),
  }),
  summarize: (a) => `Analizar imagen: "${String((a as Obj).question ?? '').slice(0, 70)}"`,
  execute: async (actor, args, ctx) => {
    const a = args as { question: string; attachmentId?: string; imageUrl?: string; venueScreenshot?: boolean };
    const img = await imageDataUrl(actor, a, ctx.conversationId);
    if ('error' in img) return { error: img.error };

    const settings = await getAiSettings();
    const model = pickVisionModel(settings);
    if (!model) {
      return {
        error:
          'Ningún modelo configurado tiene visión. Activa un modelo con capacidad de visión en Asistente IA → Modelos para analizar imágenes.',
      };
    }

    const completion = await chatCompletion({
      model,
      messages: [
        {
          role: 'system',
          content:
            'Eres el analista visual de UNIK. Describe solo lo que la imagen muestra de verdad — texto legible, objetos, cantidades, defectos. Si algo no se distingue, dilo; nunca inventes datos que no estén en la imagen.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: a.question },
            { type: 'image_url', image_url: { url: img.dataUrl } },
          ],
        },
      ],
      maxTokens: 1200,
      temperature: 0.2,
    });

    const answer = completion.content?.trim();
    if (!answer) return { error: 'El modelo de visión no devolvió análisis.' };
    return { source: img.source, model, analysis: answer };
  },
});

/**
 * Finds an approved, enabled external capability that generates `medium`.
 * Matches on name/description keywords — Composio/MCP/API tools all land in
 * the same registry, so a provider only needs to be connected once in
 * Asistente IA → Extensiones to become usable here.
 */
async function findMediaCapability(
  actor: Parameters<typeof getAvailableTools>[0],
  medium: 'image' | 'video',
  explicitName?: string
) {
  const settings = await getAiSettings();
  const available = getAvailableTools(actor, settings.enabledTools);
  const external = available.filter((t) => t.source && t.source !== 'builtin');
  const needles =
    medium === 'image'
      ? ['image', 'imagen', 'photo', 'flux', 'dall', 'banana', 'paint', 'picture', 'render']
      : ['video', 'clip', 'movie', 'reel', 'higgsfield', 'kling', 'runway', 'sora'];

  if (explicitName) {
    const found = external.find((t) => t.name === explicitName);
    if (!found) return { error: `La capacidad "${explicitName}" no está disponible para tu rol o está deshabilitada.` };
    return { tool: found };
  }

  const matches = external.filter((t) => {
    const hay = `${t.name} ${t.description}`.toLowerCase();
    const generates = /generat|create|produce|render|make|hacer|crear/.test(hay);
    return generates && needles.some((n) => hay.includes(n));
  });
  if (matches.length === 0) {
    return {
      error:
        medium === 'image'
          ? 'No hay ningún proveedor de generación de imágenes conectado. Conecta una extensión/MCP de imágenes en Asistente IA → Extensiones y vuelve a intentarlo.'
          : 'No hay ningún proveedor de generación de video conectado. Conecta una extensión/MCP de video en Asistente IA → Extensiones y vuelve a intentarlo.',
    };
  }
  return { tool: matches[0], candidates: matches.map((t) => t.name) };
}

function mediaTool(kind: 'image' | 'video') {
  const isImage = kind === 'image';
  registerTool({
    name: isImage ? 'generateImage' : 'generateVideo',
    description: isImage
      ? 'Genera una imagen usando el proveedor de imágenes conectado (extensión/MCP/Composio). Consume créditos del proveedor — requiere aprobación. Si no hay proveedor, lo dice claramente en vez de fingir.'
      : 'Genera un video usando el proveedor de video conectado (extensión/MCP/Composio). Consume créditos del proveedor — requiere aprobación. Si no hay proveedor, lo dice claramente en vez de fingir.',
    category: 'media',
    enabledByDefault: true,
    requiredPermission: 'assistant.use',
    resultTrust: 'untrusted',
    effect: 'business_write',
    timeoutMs: 240_000,
    maxResultBytes: 60_000,
    contextTags: ['all'],
    parameters: z.object({
      prompt: z.string().min(3).max(4000).describe('Descripción detallada de lo que debe generarse.'),
      extensionTool: z.string().max(200).optional().describe('Nombre exacto de la capacidad del proveedor si el usuario o tú ya la conoces; si se omite, se detecta automáticamente.'),
      extraArgs: z.record(z.string(), z.unknown()).optional().describe('Argumentos extra que el proveedor acepte (tamaño, estilo, duración…).'),
    }),
    summarize: (a) => `Generar ${isImage ? 'imagen' : 'video'}: "${String((a as Obj).prompt ?? '').slice(0, 70)}"`,
    execute: async (actor, args, ctx) => {
      const a = args as { prompt: string; extensionTool?: string; extraArgs?: Record<string, unknown> };
      const found = await findMediaCapability(actor, kind, a.extensionTool);
      if ('error' in found) return { error: found.error };
      const { tool } = found;
      const result = await executeTool(tool.name, actor, { prompt: a.prompt, ...(a.extraArgs ?? {}) }, ctx);
      if (!result.success) {
        return { error: `El proveedor (${tool.name}) falló: ${result.error ?? 'error desconocido'}`, providerTool: tool.name };
      }
      return {
        providerTool: tool.name,
        medium: kind,
        result: result.result,
        note: `Generado con ${tool.name}. Si el resultado trae una URL o archivo, preséntalo tal cual — no afirmes más de lo que devolvió.`,
      };
    },
  });
}

mediaTool('image');
mediaTool('video');
