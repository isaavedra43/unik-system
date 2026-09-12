export type CopilotMode = 'active' | 'on_demand' | 'paused';

export interface CopilotToolRecord {
  id: string;
  toolName: string;
  args: unknown;
  result: unknown;
  durationMs: number;
  success: boolean;
  errorCode: string | null;
}

export interface CopilotMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments: string }> | null;
  toolCallRecords?: CopilotToolRecord[];
  createdAt: string;
}

export interface CopilotProposal {
  id: string;
  toolName: string;
  summary: string;
  effect: string;
  expiresAt: string;
  args?: unknown;
  recipient?: string | null;
  status?: string;
  error?: string | null;
}

export type ActionKind = 'reply' | 'task' | 'lookup' | 'status' | 'note' | 'escalate' | 'send' | 'other';

export interface SuggestedAction {
  label: string;
  instruction: string;
  kind: ActionKind;
}

export interface SuggestedActionsData {
  situation: string;
  sentiment: 'positivo' | 'neutral' | 'negativo' | 'molesto';
  urgency: 'baja' | 'media' | 'alta';
  actions: SuggestedAction[];
}

export interface DraftData {
  draft: string;
  rationale: string | null;
}

export interface LiveStep {
  id: string;
  name: string;
  status: 'running' | 'done' | 'failed';
}

export const AUTO_PREFIX = '⟦auto:';

export function autoKind(content: string | null | undefined): 'open' | 'inbound' | null {
  if (!content || !content.startsWith(AUTO_PREFIX)) return null;
  return content.startsWith(`${AUTO_PREFIX}inbound`) ? 'inbound' : 'open';
}

export const MODE_META: Record<CopilotMode, { label: string; hint: string }> = {
  active: {
    label: 'Activo',
    hint: 'Analiza por su cuenta al abrir la conversación y cada vez que el cliente escribe.',
  },
  on_demand: {
    label: 'A petición',
    hint: 'Solo actúa cuando tú le hablas.',
  },
  paused: {
    label: 'Pausa',
    hint: 'Apagado por completo: no analiza ni responde.',
  },
};

/** Human labels for tool activity ("qué está haciendo") — falls back to the tool name. */
const TOOL_LABELS: Record<string, { running: string; done: string }> = {
  suggestNextActions: { running: 'Preparando acciones', done: 'Acciones listas' },
  proposeInboxDraft: { running: 'Redactando respuesta', done: 'Borrador listo' },
  draftReply: { running: 'Redactando respuesta', done: 'Borrador listo' },
  updateInboxConversation: { running: 'Actualizando la conversación', done: 'Conversación actualizada' },
  addInboxNote: { running: 'Guardando nota interna', done: 'Nota interna guardada' },
  sendInboxMessage: { running: 'Preparando envío', done: 'Envío propuesto' },
  getConversationMessages: { running: 'Releyendo la conversación', done: 'Conversación releída' },
  listInboxConversations: { running: 'Revisando la bandeja', done: 'Bandeja revisada' },
  listCommitments: { running: 'Revisando compromisos', done: 'Compromisos revisados' },
  createCommitment: { running: 'Registrando compromiso', done: 'Compromiso registrado' },
  getContactFile: { running: 'Consultando expediente en Zoho', done: 'Expediente consultado' },
  getContactDetail: { running: 'Consultando contacto', done: 'Contacto consultado' },
  queryContacts: { running: 'Buscando contacto', done: 'Contacto buscado' },
  querySalesOrders: { running: 'Revisando órdenes de venta', done: 'Órdenes revisadas' },
  getSalesOrderDetail: { running: 'Abriendo orden de venta', done: 'Orden consultada' },
  queryInvoices: { running: 'Revisando facturas', done: 'Facturas revisadas' },
  queryPayments: { running: 'Revisando pagos', done: 'Pagos revisados' },
  queryPackages: { running: 'Revisando envíos', done: 'Envíos revisados' },
  queryProducts: { running: 'Buscando productos', done: 'Productos revisados' },
  getProductSearch: { running: 'Buscando productos', done: 'Productos revisados' },
  searchKnowledgeLibrary: { running: 'Buscando en la biblioteca', done: 'Biblioteca consultada' },
  universalSearch: { running: 'Buscando en todo UNIK', done: 'Búsqueda completa' },
  getDatabaseOverview: { running: 'Revisando datos disponibles', done: 'Datos revisados' },
  sendInternalChatMessage: { running: 'Preparando aviso al equipo', done: 'Aviso propuesto' },
};

export function toolLabel(name: string, status: LiveStep['status'] | 'done' = 'done'): string {
  const meta = TOOL_LABELS[name];
  if (meta) return status === 'running' ? meta.running : meta.done;
  const pretty = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return status === 'running' ? `Consultando ${pretty}` : `Consulté ${pretty}`;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function parseSuggestedActions(args: unknown): SuggestedActionsData | null {
  const obj = asObject(args);
  if (!obj || !Array.isArray(obj.actions)) return null;
  const actions = obj.actions
    .map((a) => asObject(a))
    .filter((a): a is Record<string, unknown> => Boolean(a))
    .map((a) => ({
      label: String(a.label ?? '').trim(),
      instruction: String(a.instruction ?? '').trim(),
      kind: (typeof a.kind === 'string' ? a.kind : 'other') as ActionKind,
    }))
    .filter((a) => a.label && a.instruction);
  if (actions.length === 0) return null;
  return {
    situation: String(obj.situation ?? ''),
    sentiment: (obj.sentiment as SuggestedActionsData['sentiment']) ?? 'neutral',
    urgency: (obj.urgency as SuggestedActionsData['urgency']) ?? 'media',
    actions,
  };
}

export function parseDraft(args: unknown): DraftData | null {
  const obj = asObject(args);
  if (!obj) return null;
  const body = typeof obj.body === 'string' ? obj.body : typeof obj.draft === 'string' ? obj.draft : null;
  if (!body || !body.trim()) return null;
  return { draft: body, rationale: typeof obj.rationale === 'string' ? obj.rationale : null };
}
