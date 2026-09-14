import type { TaskTier } from './model-router';
import type { AttachmentKind } from './ai-attachments-service';

/**
 * Per-turn working instructions appended at the END of the system prompt.
 *
 * The base prompt is long and general; models follow the most recent, most
 * specific instruction best. So for the turns that matter most (analysis,
 * attachments, documents) the orchestrator adds a short, concrete protocol
 * for THIS turn: what to read, what to cross-check, how to structure the
 * answer and what is forbidden. Pure — unit tested.
 */

export interface TurnDirectiveInput {
  message: string;
  tier: TaskTier;
  /** Kinds of the files attached to this message. */
  attachmentKinds: AttachmentKind[];
  /** Kinds of files sent earlier in the conversation and re-injected this turn. */
  priorAttachmentKinds: AttachmentKind[];
  voice?: boolean;
  autoTrigger?: boolean;
  /** The turn's model thinks before answering and sees images: it can transcribe photos itself. */
  modelReasonsWithVision?: boolean;
}

const DOC_REQUEST = /\b(pdf|word|docx|documento|reporte|informe|archivo|expórtalo|exporta|descargar|imprimir)\b/i;
const ANALYSIS_REQUEST = /\b(tabla|cruza|cruce|compar|júnt|junt|agrup|clasific|analiz|anális|revis|concilia|por qu[eé]|motivo|raz[oó]n)\b/i;

export function buildTurnDirectives(input: TurnDirectiveInput): string {
  if (input.voice || input.autoTrigger) return '';
  const norm = input.message.toLowerCase();
  const hasImages = input.attachmentKinds.includes('image') || input.priorAttachmentKinds.includes('image');
  const hasDocs =
    input.attachmentKinds.includes('document') || input.attachmentKinds.includes('text') ||
    input.priorAttachmentKinds.includes('document') || input.priorAttachmentKinds.includes('text');
  const hasAttachments = hasImages || hasDocs;
  const wantsDocument = DOC_REQUEST.test(norm);
  const wantsAnalysis = ANALYSIS_REQUEST.test(norm);
  const lines: string[] = [];

  if (hasAttachments && (input.tier === 'complex' || wantsAnalysis || wantsDocument)) {
    lines.push(
      '## INSTRUCCIONES PARA ESTE TURNO (adjuntos + análisis)',
      'Trabaja como un analista senior y entrega TODO en este mismo turno. Protocolo:',
      input.modelReasonsWithVision
        ? `1. Lee los adjuntos que tienes en el mensaje${input.priorAttachmentKinds.length > 0 ? ' (incluye los enviados en mensajes anteriores, re-adjuntados aquí)' : ''}. Transcribe TÚ cada foto línea por línea con cuidado en los dígitos (no llames readAttachment salvo que una imagen no esté en tu contexto o sea ilegible). Un PDF/Excel/CSV ya viene como texto: úsalo directo.`
        : `1. Lee los adjuntos que tienes en el mensaje${input.priorAttachmentKinds.length > 0 ? ' (incluye los enviados en mensajes anteriores, re-adjuntados aquí)' : ''}. Para cada FOTO o imagen con texto, llama readAttachment (mode="table", validateOrders=true) — una llamada por imagen, todas en paralelo — y usa ESA transcripción (trae "orderCheck" con los folios que no existen y su lectura probable). Un PDF/Excel/CSV ya viene como texto: úsalo directo.`,
      '2. Cruza contra el sistema: reúne TODOS los folios/números y llama lookupSalesOrdersByNumber UNA sola vez con todos (cliente, vendedor, ticket, pago). Un folio inexistente con sugerencia = lectura errónea: usa la sugerencia y dilo ("23364 no existe; corresponde a 23354").',
      '3. Clasifica cada registro con las categorías que el usuario pidió o, si no las dio, con grupos operativos claros (p. ej. Producción/material, Recolección, Envío/programación, Entregado/cierre, Pago, Sin nota). No inventes categorías que la fuente no diga: si "Producción" no dice "con proveedor", explícalo en una línea.',
      '4. Responde en este orden, sin omitir nada: (a) 2-4 líneas con los números clave (total del sistema, cuántos tienen nota, faltantes, lecturas dudosas); (b) tabla resumen por grupo con conteo y % cuya suma sea EXACTAMENTE el total; (c) UNA tabla markdown por grupo con orden, cliente, ticket/pago del sistema y la nota literal — todas las filas, aunque pasen de 8; (d) discrepancias sistema vs nota (anotado como entregado pero abierto en el sistema, pagos, folios sin nota, folios que no existen); (e) 3-5 prioridades accionables.',
      '5. Prohibido: decir "un momento", "voy a…", "procedo a…" o entregar una parte y prometer el resto; usar generateTable/generatePdfReport para tablas que armaste tú; escribir imágenes markdown "![...]()" ni enlaces a artefactos (las tarjetas se muestran solas).',
      wantsDocument
        ? '6. El usuario pide un archivo: al terminar el análisis llama composeDocument con cover (KPIs), "1. Resumen ejecutivo", "Prioridades", una tabla por grupo (title con el conteo), "Discrepancias / casos a revisar", tabla maestra con TODOS los registros y appendix.includeAttachments=true. Las filas de cada tabla deben coincidir con el conteo del título.'
        : '6. Cierra ofreciendo el documento (PDF/Word) con composeDocument si el usuario lo quiere; no lo generes sin que lo pida.'
    );
    return lines.join('\n');
  }

  if (wantsDocument && input.tier !== 'simple') {
    lines.push(
      '## INSTRUCCIONES PARA ESTE TURNO (documento)',
      '- Si el documento resume un análisis de esta conversación (adjuntos, cruces, agrupaciones), usa composeDocument y escribe TÚ el contenido completo: cover con KPIs, resumen ejecutivo, prioridades, una tabla por grupo con todas sus filas, discrepancias, tabla maestra y appendix.includeAttachments=true si hubo fotos. Si necesitas releer un adjunto anterior, llama readAttachment antes.',
      '- Si el documento es el volcado de una consulta de datos (ventas de un periodo, órdenes filtradas), usa generatePdfReport/generateExcelReport: el sistema pone las filas.',
      '- Entrega en este turno; no digas "un momento". Al entregar, resume en 2-4 líneas qué contiene.'
    );
    return lines.join('\n');
  }

  if (input.tier === 'complex') {
    lines.push(
      '## INSTRUCCIONES PARA ESTE TURNO (tarea compleja)',
      '- Obtén los datos con las tools necesarias (en paralelo cuando sean independientes), verifica cifras antes de afirmar, y entrega la respuesta COMPLETA en este turno: contexto en 1-2 líneas, hallazgos con cifras, tabla(s) cuando haya más de 3 registros, y recomendaciones concretas.',
      '- Nunca digas "un momento" ni prometas trabajo posterior; nunca escribas imágenes markdown ni enlaces a artefactos.'
    );
    return lines.join('\n');
  }

  return '';
}

/** Phrases that mean the model stopped mid-task instead of finishing. Pure. */
export function looksUnfinished(answer: string): boolean {
  const text = answer.trim();
  if (text.length === 0) return false;
  const tail = text.slice(-400).toLowerCase();
  return /\b(un momento|dame un momento|en un momento|voy a (crear|generar|armar|hacer|preparar|organizar|proceder)|procedo a|ahora (voy|procederé|generaré|crearé)|permíteme (un momento|generar|crear)|a continuación (generaré|crearé))\b/.test(tail) && !/\bconfianza:/i.test(tail.slice(-120));
}

/** Removes markdown images (artifacts render as cards; "![título](url)" shows as a broken "!"). Pure. */
export function stripMarkdownImages(answer: string): string {
  return answer.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*!\s*$/gm, '');
}
