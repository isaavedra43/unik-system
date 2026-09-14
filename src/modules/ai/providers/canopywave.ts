import { createOpenAiCompatibleProvider } from './openai-compatible';

/**
 * Canopy Wave — OpenAI-compatible inference for open models (Kimi, MiniMax, GLM, DeepSeek, Qwen).
 * Docs: https://canopywave.com/docs/get-started/openai-compatible
 *
 * The same base URL serves On-Demand keys and Monthly Subscription (Unlimited Token Plan) keys;
 * which models a key can use is read from GET /models in the admin panel.
 */
export const CANOPYWAVE_ENDPOINT = 'https://inference.canopywave.io/v1';

export const canopywaveProvider = createOpenAiCompatibleProvider({
  id: 'canopywave',
  label: 'Canopy Wave',
  defaultEndpoint: CANOPYWAVE_ENDPOINT,
  apiKeyEnv: 'CANOPYWAVE_API_KEY',
  defaultModel: 'moonshotai/kimi-k2.6',
});
