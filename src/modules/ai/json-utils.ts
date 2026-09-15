/**
 * JSON helpers shared by the AI layer and by the domain services that ask a
 * model for structured data (finance expense extraction, composed documents).
 *
 * Pure module: it registers no tool and has no side effects, so a domain
 * service can import it without loading the tool catalog (a service must never
 * import `ai/tools/*`).
 */

/** Extracts the first JSON object of a model answer (tolerates code fences and prose). */
export function parseJsonObject(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('El modelo no devolvió JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}
