/**
 * Revisions of a delivered file ("quita los totales", "ponlo en vertical",
 * "agrega la columna vendedor", "cámbiale el título"). The assistant must
 * modify the file it just delivered, not start from scratch: the orchestrator
 * finds the last artifact of the conversation, tells the model what it
 * generated it with, merges the previous generator arguments under the new
 * ones and registers the result as the next VERSION of the same document.
 * Pure helpers — unit tested.
 */

export interface RevisionContext {
  artifactId: string;
  type: string;
  title: string;
  version: number;
  generatedBy: string;
  generatorArgs: Record<string, unknown>;
}

const CHANGE_RE =
  /\b(cambia|c[aá]mbia(?:le|lo|la)?|quita|qu[ií]ta(?:le|lo|la)?|elimina|borra|agrega|agr[eé]ga(?:le|lo)?|añade|a[ñn]ade(?:le)?|incluye|modifica|corrige|corr[ií]ge(?:lo|la)?|ajusta|ordena|ord[eé]nalo|renombra|reemplaza|ponle|p[oó]nle|ponlo|hazlo|vu[eé]lvelo|mu[eé]velo|en vertical|en horizontal|más grande|mas grande|más chico|mas chico|otra vez|de nuevo|regenera|reg[eé]neralo|actualiza el|actualízalo|mismo (reporte|pdf|archivo|documento)|ese (reporte|pdf|archivo|documento|excel|word)|el (reporte|pdf|archivo|documento) (anterior|que hiciste|de arriba))\b/i;
const NEW_REQUEST_RE = /\b(otro (reporte|pdf|archivo)|un nuevo (reporte|pdf|archivo)|desde cero|aparte)\b/i;

/** Does the message ask to change something in a file the assistant already delivered? Pure. */
export function isRevisionRequest(message: string): boolean {
  const text = message.trim();
  if (text.length < 4 || text.startsWith('⟦')) return false;
  if (NEW_REQUEST_RE.test(text)) return false;
  return CHANGE_RE.test(text);
}

/** Argument keys that never carry over: data is re-injected by the system, content is rewritten by the model. */
const NON_CARRIED_KEYS = new Set(['rows', 'sections', 'blocks', 'conversationId', 'subsetOnly', 'revisionOf']);

/**
 * Previous generator args under the model's new args: everything the user did not ask to
 * change stays (title, subtitle, columns, colors, orientation…). `customization` is merged
 * by the caller (user's words of this message win). Pure.
 */
export function mergeRevisionArgs(previous: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(previous)) {
    if (NON_CARRIED_KEYS.has(k) || v === undefined || v === null) continue;
    base[k] = v;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(current)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0 && k in base) continue;
    out[k] = v;
  }
  return out;
}

/** Compact description of what was delivered, for the model (bounded size). */
export function buildRevisionDirective(ctx: RevisionContext): string {
  const args = { ...ctx.generatorArgs };
  for (const k of NON_CARRIED_KEYS) delete args[k];
  let json = JSON.stringify(args);
  if (json.length > 6000) json = `${json.slice(0, 6000)}… (recortado)`;
  return [
    '## CAMBIOS SOBRE EL ÚLTIMO ARCHIVO QUE ENTREGASTE',
    `- Entregaste "${ctx.title}" (${ctx.type.toUpperCase()}, versión ${ctx.version}) generado con la tool ${ctx.generatedBy}.`,
    `- El usuario pide un cambio sobre ESE archivo: vuelve a llamar ${ctx.generatedBy} conservando todo lo demás (título, columnas, orden, colores, secciones, contenido) y aplicando SOLO lo que pidió. El sistema lo registrará como versión ${ctx.version + 1} del mismo documento; no lo presentes como un archivo nuevo ni cambies el título salvo que lo pidan.`,
    ctx.generatedBy === 'composeDocument'
      ? '- Reescribe el contenido completo (todos los bloques y filas) con el cambio aplicado; tu llamada anterior está en el historial.'
      : '- No vuelvas a consultar los datos si el cambio es de presentación: el sistema reutiliza las filas de la consulta original. Si el cambio altera el conjunto (otro filtro/periodo), consulta primero.',
    `- Parámetros con los que se generó: ${json}`,
    '- Dinero (Total/Saldo/fila de totales) solo si el usuario lo pide con palabras en este mensaje o ya estaba en la versión anterior; nunca lo agregues por tu cuenta.',
  ].join('\n');
}
