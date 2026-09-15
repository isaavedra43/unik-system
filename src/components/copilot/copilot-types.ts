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

export interface TurnMeta {
  model?: string;
  routing?: { tier?: string; reason?: string; routed?: boolean };
  confidence?: 'verified' | 'estimate' | 'assumption' | null;
  confidenceNote?: string | null;
  tools?: { calls?: number; cachedHits?: number; parallelBatches?: number; offered?: number; loadedMore?: number };
  judge?: { score?: number; issues?: string[]; summary?: string };
  planFirst?: boolean;
  /** One-click follow-ups the assistant proposed at the end of the answer. */
  followUps?: string[];
}

export interface MessageFeedbackData {
  rating: number;
  comment: string | null;
}

export interface CopilotMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments: string }> | null;
  toolCallRecords?: CopilotToolRecord[];
  meta?: TurnMeta | null;
  feedback?: MessageFeedbackData | null;
  artifacts?: Array<{
    artifactId: string;
    type: 'pdf' | 'xlsx' | 'docx' | 'csv' | 'table' | 'chart' | 'image';
    title: string;
    filename?: string;
    downloadUrl?: string;
    inlineRender?: boolean;
    rowCount?: number;
    sizeBytes?: number;
    pageCount?: number;
    chartType?: string;
    shared?: boolean;
    storageObjectId?: string;
    mimeType?: string;
    quoteId?: string;
    createdAt?: string;
  }>;
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
  /** Approver scope proposals (agents layer): who proposed and who may decide. */
  proposedBy?: string | null;
  approverScope?: { caseId?: string; areaKey?: string; userIds: string[]; permission?: string } | null;
  decisionBy?: string | null;
  secondDecisionBy?: string | null;
  /** First signature given; another person with permission must give the second one. */
  awaitingSecondApproval?: boolean;
  /** The tool needs two distinct signatures: approving first only records the first one. */
  requiresSecondApproval?: boolean;
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
  status: 'running' | 'done' | 'failed' | 'pending';
  /** Failure reason (or the tool's own `error` field) shown under a red chip. */
  detail?: string | null;
}

export const AUTO_PREFIX = '⟦auto:';

export const AUTO_EVENT_KINDS = [
  'open',
  'inbound',
  'action_failed',
  'interpret_request',
  'unblock',
  'triage',
  'replan_check',
  'stuck_review',
  'mention',
  'digest',
] as const;
export type AutoEventKind = (typeof AUTO_EVENT_KINDS)[number];

export function autoKind(content: string | null | undefined): AutoEventKind | null {
  if (!content || !content.startsWith(AUTO_PREFIX)) return null;
  const name = /^⟦auto:([a-z_]+)⟧/.exec(content)?.[1];
  // Unknown or malformed triggers keep the historical reading: an "open" analysis.
  return name && (AUTO_EVENT_KINDS as readonly string[]).includes(name) ? (name as AutoEventKind) : 'open';
}

/** Surfaces whose proactivity is stored per kind in `AiUserPreference.surfaceModes`. */
export type CopilotSurfaceModeKind = 'inbox' | 'chat' | 'area' | 'case' | 'mywork' | 'control_tower';

/** Where a copilot surface stores its proactivity: a literal column (inbox/chat) or `surfaceModes.<kind>`. */
export type CopilotPreferenceKey = 'inboxCopilotMode' | 'chatCopilotMode' | `surfaceModes.${CopilotSurfaceModeKind}`;

/** PATCH body for `/app/assistant/api/preferences` that changes only this surface's mode. */
export function preferencePatchFor(key: CopilotPreferenceKey, mode: CopilotMode): Record<string, unknown> {
  if (key.startsWith('surfaceModes.')) {
    return { surfaceModes: { [key.slice('surfaceModes.'.length)]: mode } };
  }
  return { [key]: mode };
}

/** Client-side twin of the server trigger: sent when an approved action failed so the AI fixes it. */
export function actionFailedMessage(tool: string, error: string): string {
  const clean = error.replace(/\s+/g, ' ').slice(0, 600);
  return `${AUTO_PREFIX}action_failed⟧ La acción que el usuario APROBÓ (${tool}) FALLÓ con este error: "${clean}". Explica en una línea qué pasó y CORRÍGELO TÚ AHORA: si es un producto/cliente que no coincide, búscalo con las tools y vuelve a proponer la acción corregida; si es un dato inválido (precio 0, unidad, fecha), corrígelo y vuelve a proponer; si es configuración (Zoho, credenciales, permisos), dilo claramente e indica qué debe hacer el administrador. No pidas al usuario que lo haga a mano si tú puedes hacerlo.`;
}

export const AUTO_EVENT_LABELS: Record<AutoEventKind, string> = {
  open: 'Analicé el contexto al abrir',
  inbound: 'Llegó algo nuevo · reanalicé',
  action_failed: 'Una acción aprobada falló · la IA la está corrigiendo',
  interpret_request: 'Llegó una solicitud con texto libre · la IA la interpreta',
  unblock: 'Algo venció o se trabó · la IA busca destrabarlo',
  triage: 'Se abrió una incidencia · la IA la clasifica',
  replan_check: 'Cambió el plan · la IA revisa la promesa al cliente',
  stuck_review: 'Expediente sin avance · la IA revisa qué lo detiene',
  mention: 'Mencionaron a la IA en el chat',
  digest: 'Resumen del día',
};

/** Result of an executed tool that must open something in the UI (call dock, internal call). */
export interface UiAction {
  kind: 'join_call' | 'open_url';
  callId?: string;
  label?: string | null;
  aiCall?: boolean;
  url?: string;
  reason?: string;
}

/** Derives the UI action from a tool's (approved) result. */
export function uiActionFromResult(toolName: string, result: unknown): UiAction | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (r.error) return null;
  if ((toolName === 'callContact' || toolName === 'startOutboundCall') && typeof r.callId === 'string') {
    return { kind: 'join_call', callId: r.callId, label: (r.to as string | undefined) ?? (r.phone as string | undefined) ?? null, aiCall: r.mode === 'ai' };
  }
  if (toolName === 'startInternalCall' && typeof r.openUrl === 'string') return { kind: 'open_url', url: r.openUrl, reason: 'internal_call' };
  return null;
}

/** Runs a UI action: joins the floating call dock or opens the internal call. Client only. */
export function performUiAction(action: UiAction): void {
  if (typeof window === 'undefined') return;
  if (action.kind === 'join_call' && action.callId) {
    window.dispatchEvent(new CustomEvent('unik:call:join', { detail: { callId: action.callId, label: action.label ?? null, aiCall: Boolean(action.aiCall) } }));
  } else if (action.kind === 'open_url' && action.url) {
    const url = action.url.replace(/^https?:\/\/[^/]+/, '') || action.url;
    window.location.assign(url);
  }
}

/** Call / link inside the "Resultado: {…}" JSON of an approved system note (so the card can open it). */
export function extractResultAction(text: string): UiAction | null {
  const callId = /"callId"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  if (callId) {
    const to = /"to"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? /"phone"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null;
    return { kind: 'join_call', callId, label: to, aiCall: /"mode"\s*:\s*"ai"/.test(text) };
  }
  const openUrl = /"openUrl"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  if (openUrl) return { kind: 'open_url', url: openUrl, reason: 'internal_call' };
  return null;
}

/** "falló: <motivo>. Acción: …" → the reason, for the red system card. */
export function extractFailureReason(text: string): string | null {
  const m = /fall[oó]:\s*([^]*?)(?:\.\s+Acción:|\s+Acción:|$)/.exec(text);
  const reason = m?.[1]?.trim();
  return reason && reason.length > 0 ? reason.slice(0, 400) : null;
}

export const MODE_META: Record<CopilotMode, { label: string; hint: string }> = {
  active: {
    label: 'Activo',
    hint: 'Analiza por su cuenta al abrir la conversación y cada vez que alguien escribe.',
  },
  on_demand: {
    label: 'A petición',
    hint: 'Solo actúa cuando tú le hablas.',
  },
  paused: {
    label: 'Apagado',
    hint: 'El copiloto está en pausa en esta superficie. Se cambia en Asistente IA → Preferencias y memoria.',
  },
};

/** Where the unified AI configuration lives (one place for every surface). */
export const AI_SETTINGS_HREF = '/app/assistant?settings=1';

/** Human labels for tool activity ("qué está haciendo") — falls back to the tool name. */
export const TOOL_LABELS: Record<string, { running: string; done: string }> = {
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
  findShareableDocument: { running: 'Buscando el archivo autorizado', done: 'Archivo autorizado revisado' },
  universalSearch: { running: 'Buscando en todo UNIK', done: 'Búsqueda completa' },
  getDatabaseOverview: { running: 'Revisando datos disponibles', done: 'Datos revisados' },
  sendInternalChatMessage: { running: 'Preparando aviso al equipo', done: 'Aviso propuesto' },
  proposeChatDraft: { running: 'Redactando mensaje para el equipo', done: 'Borrador listo' },
  listChatChannels: { running: 'Revisando canales del chat', done: 'Canales revisados' },
  getChatChannelMessages: { running: 'Releyendo el canal', done: 'Canal releído' },
  searchChatMessages: { running: 'Buscando en el chat', done: 'Búsqueda en chat completa' },
  summarizeChatChannel: { running: 'Resumiendo el canal', done: 'Resumen listo' },
  pinChatMessage: { running: 'Fijando mensaje', done: 'Mensaje fijado' },
  queryQuotes: { running: 'Revisando cotizaciones', done: 'Cotizaciones revisadas' },
  createQuote: { running: 'Preparando cotización en Zoho', done: 'Cotización propuesta' },
  updateQuote: { running: 'Preparando cambios de cotización', done: 'Cambios propuestos' },
  getQuotePdf: { running: 'Obteniendo PDF de Zoho', done: 'PDF listo' },
  rememberForUser: { running: 'Guardando en tu memoria', done: 'Recuerdo propuesto' },
  listUserMemory: { running: 'Revisando tu memoria', done: 'Memoria revisada' },
  listSkills: { running: 'Revisando tus skills', done: 'Skills revisadas' },
  runSkill: { running: 'Ejecutando skill', done: 'Skill ejecutada' },
  generatePdfReport: { running: 'Generando PDF', done: 'PDF generado' },
  generateExcelReport: { running: 'Generando Excel', done: 'Excel generado' },
  generateWordReport: { running: 'Generando Word', done: 'Word generado' },
  generateCsvExport: { running: 'Exportando CSV', done: 'CSV listo' },
  generateChart: { running: 'Dibujando gráfica', done: 'Gráfica lista' },
  generateReportImage: { running: 'Generando imagen', done: 'Imagen lista' },
  generateTable: { running: 'Armando tabla', done: 'Tabla lista' },
  loadMoreTools: { running: 'Cargando más herramientas', done: 'Herramientas cargadas' },
  proposePlan: { running: 'Armando el plan', done: 'Plan propuesto' },
  listConversationAttachments: { running: 'Revisando adjuntos', done: 'Adjuntos revisados' },
  extractDocumentData: { running: 'Leyendo el documento', done: 'Documento extraído' },
  readAttachment: { running: 'Leyendo el adjunto', done: 'Adjunto leído' },
  composeDocument: { running: 'Redactando el documento', done: 'Documento listo' },
  lookupSalesOrdersByNumber: { running: 'Cruzando folios con el sistema', done: 'Folios cruzados' },
  reviewAnswer: { running: 'Revisando la respuesta', done: 'Respuesta revisada' },
  draftAnswer: { running: 'Redactando la respuesta', done: 'Respuesta redactada' },
  draftBillFromDocument: { running: 'Preparando factura de proveedor', done: 'Borrador de factura listo' },
  callContact: { running: 'Preparando llamada', done: 'Llamada propuesta' },
  startInternalCall: { running: 'Preparando llamada interna', done: 'Llamada interna lista' },
  sendMessageToContact: { running: 'Preparando mensaje', done: 'Mensaje propuesto' },
  sendBulkMessages: { running: 'Preparando envío masivo', done: 'Envío masivo propuesto' },
  draftQuoteFromRequest: { running: 'Armando cotización en Zoho', done: 'Cotización en borrador' },
  sendQuoteToContact: { running: 'Preparando envío de cotización', done: 'Envío de cotización propuesto' },
  getPickupLocation: { running: 'Buscando ubicación de bodega', done: 'Ubicación lista' },
  getWorkDigest: { running: 'Calculando tu digest', done: 'Digest listo' },
  // Operations layer
  getCaseSnapshot: { running: 'Revisando el expediente', done: 'Expediente revisado' },
  explainCase: { running: 'Explicando el expediente', done: 'Expediente explicado' },
  listAreaWorkItems: { running: 'Revisando trabajos del área', done: 'Trabajos del área revisados' },
  findResponsible: { running: 'Buscando al responsable', done: 'Responsable encontrado' },
  summarizeAreaDay: { running: 'Resumiendo el día del área', done: 'Resumen del área listo' },
  proposeDeliveryPlan: { running: 'Armando plan de entrega', done: 'Plan de entrega propuesto' },
  createAreaRequest: { running: 'Enviando solicitud a otra área', done: 'Solicitud enviada' },
  acknowledgeAreaRequest: { running: 'Confirmando recepción de la solicitud', done: 'Solicitud recibida' },
  respondAreaRequest: { running: 'Preparando respuesta a la solicitud', done: 'Respuesta propuesta' },
  openIncident: { running: 'Abriendo incidencia', done: 'Incidencia abierta' },
  escalateCase: { running: 'Escalando el expediente', done: 'Expediente escalado' },
  assignWorkItem: { running: 'Asignando el trabajo', done: 'Trabajo asignado' },
  completeWorkItem: { running: 'Preparando cierre del trabajo', done: 'Cierre propuesto' },
  postCaseNote: { running: 'Anotando en la sala del expediente', done: 'Nota publicada' },
  requestStockVerification: { running: 'Pidiendo verificación de existencias', done: 'Verificación solicitada' },
  reserveStock: { running: 'Preparando apartado de material', done: 'Apartado propuesto' },
  createPurchaseRequest: { running: 'Preparando solicitud de compra', done: 'Solicitud de compra propuesta' },
  createProductionOrder: { running: 'Preparando orden de producción', done: 'Orden de producción propuesta' },
  assignCarrier: { running: 'Preparando asignación de transportista', done: 'Transportista propuesto' },
  recordExpense: { running: 'Preparando registro de gasto', done: 'Gasto propuesto' },
  authorizePayment: { running: 'Preparando autorización de pago', done: 'Autorización propuesta' },
  researchSourcing: { running: 'Investigando proveedores', done: 'Proveedores investigados' },
  myNextActions: { running: 'Ordenando tus pendientes', done: 'Pendientes ordenados' },
  startWorkItem: { running: 'Iniciando el trabajo', done: 'Trabajo iniciado' },
  recordCount: { running: 'Preparando el conteo', done: 'Conteo propuesto' },
  getCompanyPulse: { running: 'Tomando el pulso de la empresa', done: 'Pulso de la empresa listo' },
  findStuckCases: { running: 'Buscando expedientes atorados', done: 'Expedientes atorados revisados' },
  whoIsBlocking: { running: 'Buscando quién está bloqueando', done: 'Bloqueos identificados' },
  simulateDelay: { running: 'Simulando el retraso', done: 'Simulación lista' },
  concludeAgentTurn: { running: 'Cerrando el turno', done: 'Turno cerrado' },
  proposeAreaAction: { running: 'Redactando borrador de operaciones', done: 'Borrador listo' },
};

export interface PlanStep {
  n: number;
  title: string;
  tool?: string;
  detail?: string;
  needsApproval?: boolean;
}

export interface PlanData {
  goal: string;
  steps: PlanStep[];
  assumptions: string[];
  deliverable: string | null;
}

/** Plan proposed with `proposePlan` (from the tool call args). */
export function parsePlan(args: unknown): PlanData | null {
  const obj = asObject(args);
  if (!obj || typeof obj.goal !== 'string' || !Array.isArray(obj.steps)) return null;
  const steps = obj.steps
    .map((st, i) => {
      const o = asObject(st);
      if (!o || typeof o.title !== 'string') return null;
      return {
        n: i + 1,
        title: o.title,
        tool: typeof o.tool === 'string' ? o.tool : undefined,
        detail: typeof o.detail === 'string' ? o.detail : undefined,
        needsApproval: o.needsApproval === true,
      } as PlanStep;
    })
    .filter((st): st is PlanStep => st !== null);
  if (steps.length === 0) return null;
  return {
    goal: obj.goal,
    steps,
    assumptions: Array.isArray(obj.assumptions) ? obj.assumptions.filter((a): a is string => typeof a === 'string') : [],
    deliverable: typeof obj.deliverable === 'string' ? obj.deliverable : null,
  };
}

/** Message the host sends when the user confirms a plan. */
export const RUN_PLAN_MESSAGE = 'Ejecuta el plan propuesto tal cual, paso por paso, e infórmame el avance de cada paso.';

/** Spanish titles of the approval cards of side-effecting tools. */
export const PROPOSAL_TOOL_TITLES: Readonly<Record<string, string>> = {
  sendInboxMessage: 'Enviar mensaje al cliente',
  sendMessageToContact: 'Enviar mensaje al contacto',
  sendBulkMessages: 'Envío a varios contactos',
  sendQuoteToContact: 'Enviar cotización con PDF de Zoho',
  sendInternalChatMessage: 'Enviar por chat interno',
  callContact: 'Llamada telefónica',
  startOutboundCall: 'Llamada telefónica',
  createQuote: 'Crear cotización en Zoho Books',
  updateQuote: 'Editar cotización en Zoho Books',
  approveCampaign: 'Aprobar campaña',
  cleanupArtifacts: 'Limpiar archivos generados',
  respondAreaRequest: 'Responder solicitud de área',
  completeWorkItem: 'Completar trabajo',
  reserveStock: 'Apartar material',
  createPurchaseRequest: 'Crear solicitud de compra',
  createProductionOrder: 'Crear orden de producción',
  assignCarrier: 'Asignar transportista',
  recordExpense: 'Registrar gasto',
  authorizePayment: 'Autorizar pago',
  recordCount: 'Registrar conteo',
  startWorkItem: 'Iniciar trabajo',
  createAreaRequest: 'Enviar solicitud a otra área',
  escalateCase: 'Escalar expediente',
  openIncident: 'Abrir incidencia',
  assignWorkItem: 'Asignar trabajo',
};

/** Spanish title of a proposal: known tools, their progress label, human text as is, else a generic title. Pure. */
export function proposalTitle(toolName: string): string {
  const known = PROPOSAL_TOOL_TITLES[toolName];
  if (known) return known;
  const label = TOOL_LABELS[toolName]?.done;
  if (label) return label;
  // A human text (e.g. "Propuesta de la IA") is shown as it is; an identifier never is.
  if (/\s/.test(toolName.trim())) return toolName.trim();
  return 'Acción propuesta por la IA';
}

/** Whether `next` activity is later than `previous` (ISO dates; other text counts only when it changes). Pure. */
export function isNewerActivity(previous: string | null, next: string): boolean {
  if (!previous) return true;
  const nextTime = Date.parse(next);
  const previousTime = Date.parse(previous);
  if (Number.isNaN(nextTime) || Number.isNaN(previousTime)) return previous !== next;
  return nextTime > previousTime;
}

/** Operations surfaces a person can open (sent by the preferences API). */
export interface OperationsSurfaceAccess {
  mywork: boolean;
  case: boolean;
  controlTower: boolean;
  area: boolean;
}

/** Without the API answer only the surfaces every person has are shown. */
export const DEFAULT_SURFACE_ACCESS: OperationsSurfaceAccess = { mywork: true, case: true, controlTower: false, area: false };

/** Preference rows of the operations surfaces the person can use. Pure. */
export function visibleSurfaceRows<T extends { key: 'mywork' | 'area' | 'case' | 'control_tower' }>(
  rows: readonly T[],
  access: OperationsSurfaceAccess
): T[] {
  return rows.filter((row) =>
    row.key === 'control_tower' ? access.controlTower : row.key === 'area' ? access.area : row.key === 'case' ? access.case : access.mywork
  );
}

export function toolLabel(name: string, status: 'running' | 'done' = 'done'): string {
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

const SENTIMENTS = new Set(['positivo', 'neutral', 'negativo', 'molesto']);
const URGENCIES = new Set(['baja', 'media', 'alta']);

/** Tolerant to the model's variants: {title,text}, {name,prompt}, plain strings… */
export function parseSuggestedActions(args: unknown): SuggestedActionsData | null {
  const obj = asObject(args);
  if (!obj) return null;
  const rawList = Array.isArray(obj.actions) ? obj.actions : Array.isArray(obj.suggestions) ? obj.suggestions : Array.isArray(obj.options) ? obj.options : null;
  if (!rawList) return null;
  const actions = rawList
    .map((a) => {
      if (typeof a === 'string') return { label: a.trim().slice(0, 60), instruction: a.trim(), kind: 'other' as ActionKind };
      const o = asObject(a);
      if (!o) return null;
      const label = String(o.label ?? o.title ?? o.name ?? o.action ?? '').trim();
      const instruction = String(o.instruction ?? o.prompt ?? o.command ?? o.text ?? o.description ?? o.detail ?? label).trim();
      return { label: (label || instruction).slice(0, 60), instruction, kind: (typeof o.kind === 'string' ? o.kind : 'other') as ActionKind };
    })
    .filter((a): a is { label: string; instruction: string; kind: ActionKind } => Boolean(a && a.label && a.instruction));
  if (actions.length === 0) return null;
  const sentiment = String(obj.sentiment ?? '').toLowerCase();
  const urgency = String(obj.urgency ?? '').toLowerCase();
  return {
    situation: String(obj.situation ?? obj.summary ?? obj.reading ?? ''),
    sentiment: (SENTIMENTS.has(sentiment) ? sentiment : 'neutral') as SuggestedActionsData['sentiment'],
    urgency: (URGENCIES.has(urgency) ? urgency : 'media') as SuggestedActionsData['urgency'],
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
