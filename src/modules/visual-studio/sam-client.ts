import type { SurfacePromptSpec } from './visual-contract';

/**
 * Cliente del worker SAM 2 (services/sam2-worker). El worker vive fuera del
 * proceso web — en Railway debe desplegarse como servicio aparte; aquí solo se
 * consume su API HTTP. VISUAL_SAM_URL lo localiza, VISUAL_SAM_TOKEN lo protege.
 */

export class SamClientError extends Error {
  constructor(
    message: string,
    public readonly code: 'unconfigured' | 'http' | 'invalid'
  ) {
    super(message);
    this.name = 'SamClientError';
  }
}

export interface SamSegmentResult {
  maskPng: Buffer;
  score: number;
  width: number;
  height: number;
  model: string;
  device: string;
}

function samBaseUrl(): string {
  const url = process.env.VISUAL_SAM_URL?.trim();
  if (!url) throw new SamClientError('VISUAL_SAM_URL no configurada', 'unconfigured');
  return url.replace(/\/+$/, '');
}

export function isSamConfigured(): boolean {
  return Boolean(process.env.VISUAL_SAM_URL?.trim());
}

export async function samHealth(): Promise<{ ok: boolean; model?: string; device?: string }> {
  if (!isSamConfigured()) return { ok: false };
  try {
    const res = await fetch(`${samBaseUrl()}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? await res.json() : { ok: false };
  } catch {
    return { ok: false };
  }
}

export async function segmentImage(input: {
  image: Buffer;
  prompt: SurfacePromptSpec;
  /** Máscara previa para refinar con los nuevos clics. */
  priorMaskPng?: Buffer;
  signal?: AbortSignal;
}): Promise<SamSegmentResult> {
  const token = process.env.VISUAL_SAM_TOKEN?.trim();
  const res = await fetch(`${samBaseUrl()}/segment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      image_b64: input.image.toString('base64'),
      points: input.prompt.points.map((p) => ({ x: p.x, y: p.y, positive: p.positive })),
      ...(input.prompt.box ? { box: input.prompt.box } : {}),
      ...(input.priorMaskPng ? { mask_b64: input.priorMaskPng.toString('base64') } : {}),
    }),
    signal: input.signal ?? AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new SamClientError(`SAM respondió ${res.status}: ${text}`, 'http');
  }
  const data = (await res.json()) as {
    mask_png_b64?: string;
    score?: number;
    width?: number;
    height?: number;
    model?: string;
    device?: string;
  };
  if (!data.mask_png_b64) throw new SamClientError('Respuesta de SAM sin máscara', 'invalid');
  return {
    maskPng: Buffer.from(data.mask_png_b64, 'base64'),
    score: Number(data.score ?? 0),
    width: Number(data.width ?? 0),
    height: Number(data.height ?? 0),
    model: String(data.model ?? ''),
    device: String(data.device ?? ''),
  };
}
