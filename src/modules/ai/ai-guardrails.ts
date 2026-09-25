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
  /olvida\s+(todo|tus|las)\s+/i,
  /disregard\s+(all|previous|prior)/i,
  /new\s+instructions?:/i,
  /nuevas?\s+instrucci[oó]n(es)?:/i,
  /modo\s+(desarrollador|dios|admin)/i,
  /developer\s+mode/i,
  /sin\s+aprobaci[oó]n/i,
  /(dame|env[ií]a|manda|exporta)\s+(toda\s+)?la\s+(base|lista)\s+de\s+(clientes|contactos|tel[eé]fonos)/i,
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


/** True when the text carries an instruction-like pattern (used to flag untrusted content). */
export function containsInjection(text: string | null | undefined): boolean {
  if (!text) return false;
  return PROMPT_INJECTION_PATTERNS.some((p) => p.test(text));
}

/**
 * Wraps external content (customer messages, documents, search results) so the
 * model treats it as data. Neutralizes closing tags inside the content and adds
 * a flag when it looks like an injection attempt.
 */
export function wrapUntrusted(text: string, source: string): string {
  const safe = text.replace(/<\/?untrusted[^>]*>/gi, '[tag]');
  const flagged = containsInjection(safe) ? ' posible_manipulacion="true"' : '';
  return `<untrusted source="${source}"${flagged}>\n${safe}\n</untrusted>`;
}

/**
 * Second-layer injection check for untrusted external content (web pages,
 * browser extracts, venue output): the regex pass (`containsInjection`) is
 * instant; Jev adds a semantic pass that catches phrasing no regex was taught.
 * Returns true when EITHER layer flags the content. Never throws — a failed
 * decision call falls back to the regex verdict.
 */
export async function isInjectionAttempt(
  text: string,
  source: string,
  opts: { userId?: string; conversationId?: string } = {}
): Promise<boolean> {
  if (containsInjection(text)) return true;
  try {
    const { decide, answerBool } = await import('./decisions/decision-engine');
    const { injectionCheckDecision } = await import('./decisions/decision-points');
    const gate = injectionCheckDecision(text, source);
    const result = await decide(gate.state, gate.questions, opts);
    return answerBool(result, 'injection_attempt') === true;
  } catch {
    return false;
  }
}
