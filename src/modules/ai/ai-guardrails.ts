/**
 * Input/output guardrails for the AI assistant.
 * Detects potential prompt injection and validates message size.
 */

const PROMPT_INJECTION_PATTERNS = [
  /ignora(r)?\s+(las?\s+)?instrucciones/i,
  /ignore\s+(all\s+)?(previous\s+)?instructions/i,
  /actúa\s+como/i,
  /act\s+as/i,
  /system\s+prompt/i,
  /eres\s+ahora/i,
  /you\s+are\s+now/i,
  /revela(r)?\s+(tus?\s+)?instrucciones/i,
  /show\s+me\s+(your\s+)?(system\s+)?prompt/i,
];

interface InputValidationResult {
  valid: boolean;
  error?: string;
  warnings?: string[];
}

interface OutputValidationResult {
  valid: boolean;
  warnings?: string[];
}

export function validateInput(text: string, maxLength = 10_000): InputValidationResult {
  if (!text || text.trim().length === 0) {
    return { valid: false, error: 'Mensaje vacío' };
  }
  if (text.length > maxLength) {
    return {
      valid: false,
      error: `Mensaje demasiado largo (máx ${maxLength.toLocaleString('es-MX')} caracteres)`,
    };
  }

  const warnings: string[] = [];
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      warnings.push(`Posible prompt injection detectado: patrón "${pattern.source}"`);
    }
  }

  return { valid: true, warnings };
}

export function validateOutput(text: string): OutputValidationResult {
  const warnings: string[] = [];
  // Heuristic: detect possible leaked secrets
  if (/sk-[a-zA-Z0-9]{20,}/.test(text)) {
    warnings.push('Output contiene posible API key');
  }
  if (/(AZURE_OPENAI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|OLLAMA_API_KEY)/i.test(text)) {
    warnings.push('Output menciona variable de entorno sensible');
  }

  return { valid: warnings.length === 0, warnings };
}
