import type { ProviderId } from './providers/types';

/**
 * Curated model catalog with rich metadata for the model selector UI.
 *
 * Each model entry includes:
 * - power: 1-10 scale for the selector UI (like Devin's model picker)
 * - bestFor: short description of ideal use cases
 * - contextWindow: max input tokens
 * - maxOutput: max output tokens
 * - speed: 'fast' | 'medium' | 'slow'
 * - costPer1M: USD per 1M tokens (input/output)
 * - capabilities: what the model can do
 * - description: human-readable description for tooltips
 * - available: whether this provider is implemented (not a stub)
 */

export type ModelSpeed = 'fast' | 'medium' | 'slow';
export type ModelCapability = 'vision' | 'tool_use' | 'streaming' | 'json_mode' | 'audio' | 'reasoning';

export interface ModelInfo {
  id: string;
  provider: ProviderId;
  label: string;
  power: number; // 1-10
  bestFor: string;
  contextWindow: number;
  maxOutput: number;
  speed: ModelSpeed;
  costPer1M: { input: number; output: number };
  capabilities: ModelCapability[];
  description: string;
  available: boolean; // false = provider stub, not yet implemented
}

export const MODEL_CATALOG: ModelInfo[] = [
  // ============================================================
  // OpenAI
  // ============================================================
  {
    id: 'gpt-4o',
    provider: 'openai',
    label: 'GPT-4o',
    power: 9,
    bestFor: 'Razonamiento complejo, análisis, código, visión',
    contextWindow: 128_000,
    maxOutput: 16_384,
    speed: 'medium',
    costPer1M: { input: 2.5, output: 10.0 },
    capabilities: ['vision', 'tool_use', 'streaming', 'json_mode'],
    description: 'El modelo más capaz de OpenAI. Multimodal (texto + imagen). Excelente para análisis complejo, razonamiento y uso de tools.',
    available: true,
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    label: 'GPT-4o Mini',
    power: 6,
    bestFor: 'Tareas rápidas, clasificación, resúmenes, Q&A',
    contextWindow: 128_000,
    maxOutput: 16_384,
    speed: 'fast',
    costPer1M: { input: 0.15, output: 0.6 },
    capabilities: ['vision', 'tool_use', 'streaming', 'json_mode'],
    description: 'Rápido y económico. 80% de la calidad de GPT-4o a 6% del costo. Ideal para consultas frecuentes.',
    available: true,
  },
  {
    id: 'gpt-4.1',
    provider: 'openai',
    label: 'GPT-4.1',
    power: 8,
    bestFor: 'Razonamiento avanzado, código, contexto largo',
    contextWindow: 1_050_000,
    maxOutput: 32_768,
    speed: 'medium',
    costPer1M: { input: 2.0, output: 8.0 },
    capabilities: ['vision', 'tool_use', 'streaming', 'json_mode'],
    description: 'Modelo de nueva generación con contexto de 1M tokens. Mejor que GPT-4o en programación y razonamiento largo.',
    available: true,
  },
  {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    label: 'GPT-4.1 Mini',
    power: 7,
    bestFor: 'Tareas balanceadas, contexto largo, costo eficiente',
    contextWindow: 1_050_000,
    maxOutput: 32_768,
    speed: 'fast',
    costPer1M: { input: 0.4, output: 1.6 },
    capabilities: ['vision', 'tool_use', 'streaming', 'json_mode'],
    description: 'Balance entre potencia y costo. Contexto de 1M tokens a un precio accesible.',
    available: true,
  },
  {
    id: 'o1',
    provider: 'openai',
    label: 'o1',
    power: 10,
    bestFor: 'Razonamiento profundo, ciencia, matemáticas, análisis complejo',
    contextWindow: 200_000,
    maxOutput: 100_000,
    speed: 'slow',
    costPer1M: { input: 15.0, output: 60.0 },
    capabilities: ['reasoning', 'tool_use'],
    description: 'Modelo de razonamiento más profundo de OpenAI. Piensa antes de responder. Ideal para problemas complejos que requieren análisis paso a paso.',
    available: true,
  },
  {
    id: 'o3-mini',
    provider: 'openai',
    label: 'o3-mini',
    power: 8,
    bestFor: 'STEM, matemáticas, programación, razonamiento rápido',
    contextWindow: 200_000,
    maxOutput: 100_000,
    speed: 'medium',
    costPer1M: { input: 1.1, output: 4.4 },
    capabilities: ['reasoning', 'tool_use'],
    description: 'Razonamiento profundo a un costo accesible. Especializado en STEM (ciencia, tecnología, ingeniería, matemáticas).',
    available: true,
  },

  // ============================================================
  // Anthropic Claude
  // ============================================================
  {
    id: 'claude-sonnet-4-5',
    provider: 'anthropic',
    label: 'Claude Sonnet 4.5',
    power: 9,
    bestFor: 'Agentes, programación, análisis, uso de tools',
    contextWindow: 200_000,
    maxOutput: 64_000,
    speed: 'medium',
    costPer1M: { input: 3.0, output: 15.0 },
    capabilities: ['vision', 'tool_use', 'streaming'],
    description: 'El mejor modelo de Anthropic para agentes y programación. Excelente en uso de tools y razonamiento largo.',
    available: false,
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    label: 'Claude Haiku 4.5',
    power: 6,
    bestFor: 'Tareas rápidas, clasificación, resúmenes',
    contextWindow: 200_000,
    maxOutput: 8_192,
    speed: 'fast',
    costPer1M: { input: 1.0, output: 5.0 },
    capabilities: ['vision', 'tool_use', 'streaming'],
    description: 'Rápido y económico de Claude. Ideal para consultas frecuentes y tareas de clasificación.',
    available: false,
  },
  {
    id: 'claude-opus-4-5',
    provider: 'anthropic',
    label: 'Claude Opus 4.5',
    power: 10,
    bestFor: 'Razonamiento profundo, análisis complejo, visión',
    contextWindow: 200_000,
    maxOutput: 32_000,
    speed: 'slow',
    costPer1M: { input: 5.0, output: 25.0 },
    capabilities: ['vision', 'tool_use', 'streaming'],
    description: 'El modelo más potente de Anthropic. Superior en razonamiento complejo y análisis profundo.',
    available: false,
  },

  // ============================================================
  // Google Gemini
  // ============================================================
  {
    id: 'gemini-2.0-flash',
    provider: 'gemini',
    label: 'Gemini 2.0 Flash',
    power: 7,
    bestFor: 'Tareas rápidas, multimodal, alto volumen',
    contextWindow: 1_050_000,
    maxOutput: 8_192,
    speed: 'fast',
    costPer1M: { input: 0.1, output: 0.4 },
    capabilities: ['vision', 'tool_use', 'streaming', 'audio'],
    description: 'Rápido y económico de Google. Contexto de 1M tokens. Multimodal nativo (texto, imagen, audio).',
    available: false,
  },
  {
    id: 'gemini-2.0-flash-lite',
    provider: 'gemini',
    label: 'Gemini 2.0 Flash Lite',
    power: 5,
    bestFor: 'Alto volumen, costo mínimo, tareas simples',
    contextWindow: 1_050_000,
    maxOutput: 8_192,
    speed: 'fast',
    costPer1M: { input: 0.075, output: 0.3 },
    capabilities: ['vision', 'tool_use', 'streaming'],
    description: 'El modelo más económico de Google. Ideal para alto volumen de consultas simples.',
    available: false,
  },

  // ============================================================
  // Local (Ollama / LM Studio)
  // ============================================================
  {
    id: 'llama3.1',
    provider: 'local',
    label: 'Llama 3.1 (8B)',
    power: 5,
    bestFor: 'Tareas generales, 100% local, sin costo de API',
    contextWindow: 128_000,
    maxOutput: 4_096,
    speed: 'medium',
    costPer1M: { input: 0, output: 0 },
    capabilities: ['tool_use', 'streaming'],
    description: 'Modelo local de Meta. 100% privado — ningún dato sale de tu máquina. Sin costo de API.',
    available: false,
  },
  {
    id: 'llama3.1:70b',
    provider: 'local',
    label: 'Llama 3.1 (70B)',
    power: 8,
    bestFor: 'Razonamiento avanzado, 100% local, sin costo de API',
    contextWindow: 128_000,
    maxOutput: 4_096,
    speed: 'slow',
    costPer1M: { input: 0, output: 0 },
    capabilities: ['tool_use', 'streaming'],
    description: 'Modelo local grande de Meta. Potente pero requiere GPU. 100% privado.',
    available: false,
  },
  {
    id: 'qwen2.5',
    provider: 'local',
    label: 'Qwen 2.5 (7B)',
    power: 5,
    bestFor: 'Multilingüe, código, 100% local',
    contextWindow: 32_000,
    maxOutput: 4_096,
    speed: 'fast',
    costPer1M: { input: 0, output: 0 },
    capabilities: ['tool_use', 'streaming'],
    description: 'Modelo local de Alibaba. Excelente en español y código. 100% privado.',
    available: false,
  },
];

/** Returns all models in the catalog. */
export function getAllModels(): ModelInfo[] {
  return MODEL_CATALOG;
}

/** Returns models for a specific provider. */
export function getModelsByProvider(provider: ProviderId): ModelInfo[] {
  return MODEL_CATALOG.filter((m) => m.provider === provider);
}

/** Returns models that are available (provider implemented) and optionally filtered by provider. */
export function getAvailableModels(provider?: ProviderId): ModelInfo[] {
  return MODEL_CATALOG.filter(
    (m) => m.available && (provider ? m.provider === provider : true)
  );
}

/** Finds a model by id. */
export function getModelById(id: string): ModelInfo | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

/** Returns the default model for a provider. */
export function getDefaultModel(provider: ProviderId): ModelInfo {
  return MODEL_CATALOG.find((m) => m.provider === provider && m.available) ?? MODEL_CATALOG[0];
}

/** Returns the provider for a given model id. */
export function getProviderForModel(modelId: string): ProviderId | undefined {
  return getModelById(modelId)?.provider;
}

/** Speed labels in Spanish for the UI. */
export const SPEED_LABELS: Record<ModelSpeed, string> = {
  fast: 'Rápido',
  medium: 'Medio',
  slow: 'Lento',
};

/** Capability labels in Spanish for the UI. */
export const CAPABILITY_LABELS: Record<ModelCapability, string> = {
  vision: 'Visión (imágenes)',
  tool_use: 'Uso de tools',
  streaming: 'Streaming',
  json_mode: 'JSON mode',
  audio: 'Audio',
  reasoning: 'Razonamiento profundo',
};
