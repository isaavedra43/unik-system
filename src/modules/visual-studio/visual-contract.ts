import { z } from 'zod';

/**
 * Contrato compartido de Visual Studio: tipos de dominio y esquemas de entrada
 * usados por las server actions, las rutas API, el worker SAM y las tools del
 * asistente. Nada de proveedores aquí — los detalles de Higgsfield viven en
 * higgsfield-adapter.ts.
 */

export const visualModes = ['faithful', 'creative'] as const;
export type VisualMode = (typeof visualModes)[number];

export const visualProposalStatuses = [
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled',
] as const;
export type VisualProposalStatus = (typeof visualProposalStatuses)[number];

export const visualAssetKinds = ['source', 'mask', 'result', 'reference'] as const;
export type VisualAssetKind = (typeof visualAssetKinds)[number];

export const surfacePromptSchema = z.object({
  points: z
    .array(
      z.object({
        x: z.number(),
        y: z.number(),
        positive: z.boolean().default(true),
      })
    )
    .default([]),
  box: z
    .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
    .nullish(),
});
export type SurfacePromptSpec = z.infer<typeof surfacePromptSchema>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contactId: z.string().nullish(),
  quoteId: z.string().nullish(),
  salesOrderId: z.string().nullish(),
  notes: z.string().max(4000).nullish(),
});

export const createSurfaceSchema = z.object({
  projectId: z.string().min(1),
  assetId: z.string().min(1),
  label: z.string().trim().min(1).max(120),
  prompt: surfacePromptSchema,
});

export const refineSurfaceSchema = z.object({
  surfaceId: z.string().min(1),
  prompt: surfacePromptSchema,
  /** Máscara editada a mano (PNG base64) — pincel/borrador del cliente. Si se envía, reemplaza el resultado del worker. */
  manualMaskPngBase64: z.string().max(40_000_000).nullish(),
});

export const requestProposalSchema = z.object({
  projectId: z.string().min(1),
  surfaceId: z.string().min(1),
  productId: z.string().nullish(),
  mode: z.enum(visualModes),
  prompt: z.string().trim().min(1).max(4000),
});

export interface VisualProjectSummary {
  id: string;
  name: string;
  status: string;
  notes: string | null;
  contactId: string | null;
  contactName: string | null;
  quoteId: string | null;
  salesOrderId: string | null;
  assetCount: number;
  proposalCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface VisualAssetDTO {
  id: string;
  kind: VisualAssetKind;
  objectId: string;
  width: number | null;
  height: number | null;
  label: string | null;
  /** URL local para pintar la imagen; nunca expone el storage directamente. */
  contentUrl: string;
  createdAt: string;
}

export interface VisualSurfaceDTO {
  id: string;
  assetId: string;
  label: string;
  maskObjectId: string;
  maskUrl: string;
  prompt: SurfacePromptSpec;
  status: string;
  updatedAt: string;
}

export interface VisualProposalDTO {
  id: string;
  surfaceId: string | null;
  productId: string | null;
  productName: string | null;
  mode: VisualMode;
  prompt: string;
  provider: string;
  model: string | null;
  providerJobId: string | null;
  costCredits: string | null;
  status: VisualProposalStatus;
  resultObjectId: string | null;
  resultUrl: string | null;
  error: string | null;
  version: number;
  selectedAt: string | null;
  createdAt: string;
}
