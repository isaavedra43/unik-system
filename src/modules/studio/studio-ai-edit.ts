import { z } from 'zod';
import { chatCompletion, type ChatMessage } from '@/modules/ai/ai-client';
import type { CurrentUser } from '@/modules/auth/authorization';
import {
  applySelectionEdit,
  contentToPlainText,
  studioBlockSchema,
  type StudioBlock,
  type StudioContent,
} from './studio-content';
import { getDocument, saveDocument, StudioError, type SaveDocumentResult } from './studio-service';

/**
 * "Cambios por selección": the model receives ONLY the selected blocks (plus a
 * plain-text view of the document for context) and must answer with JSON
 * blocks that replace the selection. The result is validated with Zod,
 * retried once on invalid JSON, applied with `applySelectionEdit` (nothing
 * outside the selection can change) and saved as a new version.
 */

export const aiEditRequestSchema = z.object({
  blockIds: z.array(z.string().min(1).max(64)).min(1).max(50),
  instruction: z.string().trim().min(3).max(2000),
  model: z.string().max(120).optional(),
});
export type AiEditRequest = z.infer<typeof aiEditRequestSchema>;

const responseSchema = z.object({ blocks: z.array(studioBlockSchema).max(200) });

const SYSTEM_PROMPT = `Eres el editor del Estudio visual de UNIK. Editas documentos formados por bloques JSON.
Recibirás: el título del documento, una vista de texto del documento completo (solo contexto), los BLOQUES SELECCIONADOS en JSON y una instrucción.
Responde ÚNICAMENTE con un objeto JSON válido de la forma {"blocks":[...]} que contenga los bloques que REEMPLAZAN la selección. Sin explicaciones, sin markdown, sin comentarios.

Tipos de bloque permitidos (campo "type"):
- {"id","type":"heading","level":1|2|3,"text"}
- {"id","type":"paragraph","text"}
- {"id","type":"list","items":[string],"ordered":boolean}
- {"id","type":"table","title"?,"columns":[{"key","header","format"?:"text"|"number"|"currency"|"percentage"|"date","align"?}],"rows":[{key:valor}]}
- {"id","type":"kpi","cards":[{"label","value"}]}
- {"id","type":"image","storageObjectId","alt","caption"?}
- {"id","type":"pageBreak"} · {"id","type":"divider"}

Reglas:
1. Conserva el "id" de cada bloque que sigas usando; para bloques nuevos usa ids nuevos con el prefijo "b_".
2. No inventes cifras ni cambies números, montos o fechas salvo que la instrucción lo pida explícitamente.
3. Si la instrucción pide eliminar la selección, responde {"blocks":[]}.
4. No toques bloques fuera de la selección: solo puedes devolver los que reemplazan la selección.
5. Escribe en español salvo que la instrucción indique otro idioma.`;

function extractJson(raw: string): unknown {
  let text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('La respuesta no contiene JSON');
  return JSON.parse(text.slice(start, end + 1));
}

function parseBlocks(raw: string | null): StudioBlock[] {
  if (!raw) throw new Error('Respuesta vacía del modelo');
  const parsed = responseSchema.safeParse(extractJson(raw));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `JSON inválido: ${issue ? `${issue.path.join('.')} ${issue.message}` : parsed.error.message}`
    );
  }
  return parsed.data.blocks;
}

export interface AiEditResult extends SaveDocumentResult {
  blocks: StudioBlock[];
  model: string;
  attempts: number;
}

/** Pure helper (testable): asks the model for the replacement blocks, retrying once on invalid JSON. */
export async function requestReplacementBlocks(
  input: {
    title: string;
    content: StudioContent;
    selected: StudioBlock[];
    instruction: string;
    userId?: string;
    model?: string;
  },
  complete: typeof chatCompletion = chatCompletion
): Promise<{ blocks: StudioBlock[]; model: string; attempts: number }> {
  const context = contentToPlainText(input.content).slice(0, 8000);
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `Título del documento: ${input.title}`,
        '',
        'Vista de texto del documento (solo contexto, NO la edites):',
        context,
        '',
        'BLOQUES SELECCIONADOS (JSON):',
        JSON.stringify(input.selected),
        '',
        `Instrucción: ${input.instruction}`,
      ].join('\n'),
    },
  ];
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await complete({
      messages,
      temperature: 0.2,
      maxTokens: 4000,
      userId: input.userId,
      model: input.model,
    });
    try {
      return { blocks: parseBlocks(result.content), model: result.model, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      messages.push({ role: 'assistant', content: result.content ?? '' });
      messages.push({
        role: 'user',
        content: `Tu respuesta no fue válida (${lastError}). Responde SOLO con el JSON {"blocks":[...]} siguiendo el esquema.`,
      });
    }
  }
  throw new StudioError(`La IA no devolvió bloques válidos: ${lastError}`, 'invalid', 502);
}

export async function aiEditSelection(
  actor: CurrentUser,
  documentId: string,
  rawRequest: AiEditRequest
): Promise<AiEditResult> {
  const request = aiEditRequestSchema.parse(rawRequest);
  const doc = await getDocument(actor, documentId);
  if (!doc.permissions.canEdit)
    throw new StudioError('Sin permiso para editar este documento', 'forbidden', 403);
  const selectedSet = new Set(request.blockIds);
  const selected = doc.content.blocks.filter((b) => selectedSet.has(b.id));
  if (selected.length !== selectedSet.size) {
    throw new StudioError('Alguno de los bloques seleccionados ya no existe', 'invalid', 400);
  }
  const { blocks, model, attempts } = await requestReplacementBlocks({
    title: doc.title,
    content: doc.content,
    selected,
    instruction: request.instruction,
    userId: actor.id,
    model: request.model,
  });
  const nextContent = applySelectionEdit(doc.content, request.blockIds, { blocks });
  const saved = await saveDocument(actor, documentId, {
    content: nextContent,
    changeSummary: `IA: ${request.instruction.slice(0, 160)}`,
  });
  return { ...saved, blocks, model, attempts };
}
