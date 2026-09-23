import { z } from 'zod';
import { registerTool } from './registry';
import {
  createSurface,
  listAssets,
  listProductMedia,
  listProjects,
  listProposals,
  listSurfaces,
  refineSurface,
  requestProposal,
  selectProposal,
} from '@/modules/visual-studio/visual-service';
import { surfacePromptSchema } from '@/modules/visual-studio/visual-contract';

/**
 * Tools de Visual Studio para el orquestador. El agente de Ventas/Diseño usa
 * estas capacidades sobre los mismos servicios que la UI — mismos permisos,
 * mismo audit trail. Generar propuestas es `business_write` (consume créditos
 * del proveedor): pasa por la tarjeta de aprobación del registry.
 */

registerTool({
  name: 'visual_list_projects',
  description:
    'Lista los proyectos de Visual Studio (espacios fotografiados de clientes con propuestas de materiales). ' +
    'Devuelve id, nombre, cliente vinculado, conteo de fotos y propuestas.',
  category: 'sales',
  requiredPermission: 'visual_studio.view',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({}),
  execute: async (actor) => ({ projects: await listProjects(actor) }),
});

registerTool({
  name: 'visual_get_project',
  description:
    'Detalle de un proyecto visual: fotografías del cliente, superficies segmentadas y propuestas con su estado.',
  category: 'sales',
  requiredPermission: 'visual_studio.view',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({ projectId: z.string().describe('Id del proyecto visual.') }),
  execute: async (actor, raw) => {
    const { projectId } = raw as { projectId: string };
    const [assets, surfaces, proposals] = await Promise.all([
      listAssets(actor, projectId),
      listSurfaces(actor, projectId),
      listProposals(actor, projectId),
    ]);
    return { assets, surfaces, proposals };
  },
});

registerTool({
  name: 'visual_segment_surface',
  description:
    'Segmenta una superficie de una fotografía del proyecto con SAM 2 (worker local). ' +
    'Requiere puntos (x,y en píxeles de la imagen) o una caja delimitadora. ' +
    'Úsalo cuando el usuario describa una zona y la interfaz ya haya marcado puntos, o con una caja aproximada. ' +
    'Crea una superficie nombrada reutilizable para generaciones posteriores.',
  category: 'sales',
  requiredPermission: 'visual_studio.edit',
  enabledByDefault: true,
  effect: 'internal_task',
  timeoutMs: 120_000,
  parameters: z.object({
    projectId: z.string(),
    assetId: z.string().describe('Id de la fotografía (de visual_get_project).'),
    label: z.string().describe('Nombre de la superficie, ej. "cubierta", "salpicadero".'),
    prompt: surfacePromptSchema.describe('Puntos positivos/negativos y/o caja en píxeles.'),
  }),
  summarize: (args) => {
    const a = args as { label: string };
    return `Segmentar superficie "${a.label}" con SAM 2`;
  },
  execute: async (actor, raw) => {
    const a = raw as { projectId: string; assetId: string; label: string; prompt: never };
    const surface = await createSurface(actor, a);
    return { surface, hint: 'Muestra la máscara al usuario para confirmarla antes de generar.' };
  },
});

registerTool({
  name: 'visual_refine_surface',
  description:
    'Corrige la máscara de una superficie con clics adicionales (positivos o negativos) contra la máscara previa.',
  category: 'sales',
  requiredPermission: 'visual_studio.edit',
  enabledByDefault: true,
  effect: 'internal_task',
  timeoutMs: 120_000,
  parameters: z.object({
    surfaceId: z.string(),
    prompt: surfacePromptSchema,
  }),
  execute: async (actor, raw) => {
    const a = raw as { surfaceId: string; prompt: never };
    return { surface: await refineSurface(actor, a) };
  },
});

registerTool({
  name: 'visual_product_media',
  description:
    'Lista las imágenes de referencia de un producto UNIK (swatch, referencia, textura). ' +
    'Si está vacío, el producto no tiene referencias visuales y habrá que subirlas.',
  category: 'products',
  requiredPermission: 'visual_studio.view',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({ productId: z.string() }),
  execute: async (actor, raw) => {
    const { productId } = raw as { productId: string };
    return { media: await listProductMedia(actor, productId) };
  },
});

registerTool({
  name: 'visual_request_proposal',
  description:
    'Solicita una propuesta visual al proveedor de imágenes (Higgsfield). Consume créditos — requiere aprobación. ' +
    'Modo "faithful": cambia solo la superficie enmascarada conservando la foto. ' +
    'Modo "creative": propuesta conceptual con libertad de decoración/iluminación. ' +
    'El resultado llega como nueva versión; las anteriores se conservan.',
  category: 'sales',
  requiredPermission: 'visual_studio.generate',
  enabledByDefault: true,
  effect: 'business_write',
  timeoutMs: 60_000,
  parameters: z.object({
    projectId: z.string(),
    surfaceId: z.string().describe('Superficie segmentada a modificar.'),
    productId: z.string().nullish().describe('Producto UNIK cuyo material se visualizará.'),
    mode: z.enum(['faithful', 'creative']),
    prompt: z.string().describe('Instrucción de edición, ej. "cambia la cubierta a granito Titanium".'),
  }),
  summarize: (args) => {
    const a = args as { mode: string; prompt: string };
    return `Generar propuesta ${a.mode === 'faithful' ? 'fiel' : 'creativa'}: "${a.prompt.slice(0, 80)}"`;
  },
  execute: async (actor, raw) => {
    const a = raw as {
      projectId: string;
      surfaceId: string;
      productId?: string | null;
      mode: 'faithful' | 'creative';
      prompt: string;
    };
    return requestProposal(actor, a);
  },
});

registerTool({
  name: 'visual_select_proposal',
  description:
    'Registra qué versión eligió el cliente para el seguimiento comercial. ' +
    'Nunca deduzcas cantidades o m² de la fotografía: las dimensiones se capturan aparte en la cotización.',
  category: 'sales',
  requiredPermission: 'visual_studio.select',
  enabledByDefault: true,
  effect: 'business_write',
  parameters: z.object({ proposalId: z.string() }),
  execute: async (actor, raw) => {
    const { proposalId } = raw as { proposalId: string };
    await selectProposal(actor, proposalId);
    return { ok: true };
  },
});
