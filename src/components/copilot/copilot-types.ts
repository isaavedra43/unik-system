export interface TurnMeta {
  model?: string;
  routing?: { tier?: string; reason?: string; routed?: boolean };
  confidence?: 'verified' | 'estimate' | 'assumption' | null;
  confidenceNote?: string | null;
  /** Server-derived list of the sources that REALLY ran ("búsqueda web · base de datos UNIK"). */
  sourcesLabel?: string | null;
  tools?: {
    calls?: number;
    cachedHits?: number;
    parallelBatches?: number;
    offered?: number;
    loadedMore?: number;
  };
  judge?: { score?: number; issues?: string[]; summary?: string };
  planFirst?: boolean;
  /** One-click follow-ups the assistant proposed at the end of the answer. */
  followUps?: string[];
  /** The model's thinking for this turn (truncated) — shown collapsed under "Pensamiento". */
  reasoning?: string;
  /** Which agent produced this turn (multi-agent runs). */
  agent?: { id?: string; name?: string; color?: number; icon?: string } | null;
  /** Folded inter-agent chatter: "Mensajes de Investigador y Cobranza". */
  agentMessages?: { agents?: string[]; summary?: string } | null;
  /** A routine/vigil was created this turn → RoutineChip. */
  routineCreated?: { name?: string; schedule?: string } | null;
}

export interface MessageFeedbackData {
  rating: number;
  comment: string | null;
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

export const AUTO_PREFIX = '⟦auto:';

export type AutoEventKind = 'open' | 'inbound' | 'action_failed' | 'team';

export function autoKind(content: string | null | undefined): AutoEventKind | null {
  if (!content || !content.startsWith(AUTO_PREFIX)) return null;
  if (content.startsWith(`${AUTO_PREFIX}action_failed`)) return 'action_failed';
  if (content.startsWith(`${AUTO_PREFIX}team`)) return 'team';
  return content.startsWith(`${AUTO_PREFIX}inbound`) ? 'inbound' : 'open';
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
  team: 'Tu equipo terminó · el director revisa y consolida los resultados',
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
  if (
    (toolName === 'callContact' || toolName === 'startOutboundCall') &&
    typeof r.callId === 'string'
  ) {
    return {
      kind: 'join_call',
      callId: r.callId,
      label: (r.to as string | undefined) ?? (r.phone as string | undefined) ?? null,
      aiCall: r.mode === 'ai',
    };
  }
  if (toolName === 'startInternalCall' && typeof r.openUrl === 'string')
    return { kind: 'open_url', url: r.openUrl, reason: 'internal_call' };
  return null;
}

/** Runs a UI action: joins the floating call dock or opens the internal call. Client only. */
export function performUiAction(action: UiAction): void {
  if (typeof window === 'undefined') return;
  if (action.kind === 'join_call' && action.callId) {
    window.dispatchEvent(
      new CustomEvent('unik:call:join', {
        detail: {
          callId: action.callId,
          label: action.label ?? null,
          aiCall: Boolean(action.aiCall),
        },
      })
    );
  } else if (action.kind === 'open_url' && action.url) {
    const url = action.url.replace(/^https?:\/\/[^/]+/, '') || action.url;
    window.location.assign(url);
  }
}

/** Call / link inside the "Resultado: {…}" JSON of an approved system note (so the card can open it). */
export function extractResultAction(text: string): UiAction | null {
  const callId = /"callId"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  if (callId) {
    const to =
      /"to"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? /"phone"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null;
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

/** Human labels for tool activity ("qué está haciendo") — falls back to the tool name. */
const TOOL_LABELS: Record<string, { running: string; done: string }> = {
  draftReply: { running: 'Redactando respuesta', done: 'Borrador listo' },
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
  findShareableDocument: {
    running: 'Buscando el archivo autorizado',
    done: 'Archivo autorizado revisado',
  },
  universalSearch: { running: 'Buscando en todo UNIK', done: 'Búsqueda completa' },
  getDatabaseOverview: { running: 'Revisando datos disponibles', done: 'Datos revisados' },
  sendInternalChatMessage: { running: 'Preparando aviso al equipo', done: 'Aviso propuesto' },
  findUsers: { running: 'Buscando usuarios', done: 'Usuarios encontrados' },
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
  composioListToolkits: { running: 'Revisando tus apps conectadas', done: 'Apps revisadas' },
  composioSearchTools: {
    running: 'Buscando la herramienta adecuada',
    done: 'Herramienta encontrada',
  },
  composioConnect: { running: 'Preparando la conexión', done: 'Conexión preparada' },
  composioExecute: { running: 'Usando tu app externa', done: 'App externa consultada' },
  proposePlan: { running: 'Armando el plan', done: 'Plan propuesto' },
  proposeMission: { running: 'Armando la misión', done: 'Misión propuesta' },
  listMissions: { running: 'Revisando misiones', done: 'Misiones revisadas' },
  missionStatus: { running: 'Consultando la misión', done: 'Misión consultada' },
  controlMission: { running: 'Actualizando la misión', done: 'Misión actualizada' },
  recallMemory: { running: 'Recordando', done: 'Memoria consultada' },
  saveFact: { running: 'Guardando hecho', done: 'Hecho propuesto' },
  renderView: { running: 'Dibujando visual', done: 'Visual listo' },
  saveVenuePlaybook: { running: 'Guardando automatización', done: 'Automatización propuesta' },
  listVenuePlaybooks: { running: 'Revisando automatizaciones', done: 'Automatizaciones revisadas' },
  runVenuePlaybook: { running: 'Ejecutando automatización', done: 'Automatización ejecutada' },
  listConversationAttachments: { running: 'Revisando adjuntos', done: 'Adjuntos revisados' },
  extractDocumentData: { running: 'Leyendo el documento', done: 'Documento extraído' },
  readAttachment: { running: 'Leyendo el adjunto', done: 'Adjunto leído' },
  composeDocument: { running: 'Redactando el documento', done: 'Documento listo' },
  lookupSalesOrdersByNumber: { running: 'Cruzando folios con el sistema', done: 'Folios cruzados' },
  reviewAnswer: { running: 'Revisando la respuesta', done: 'Respuesta revisada' },
  draftAnswer: { running: 'Redactando la respuesta', done: 'Respuesta redactada' },
  draftBillFromDocument: {
    running: 'Preparando factura de proveedor',
    done: 'Borrador de factura listo',
  },
  callContact: { running: 'Preparando llamada', done: 'Llamada propuesta' },
  startInternalCall: { running: 'Preparando llamada interna', done: 'Llamada interna lista' },
  sendMessageToContact: { running: 'Preparando mensaje', done: 'Mensaje propuesto' },
  sendBulkMessages: { running: 'Preparando envío masivo', done: 'Envío masivo propuesto' },
  draftQuoteFromRequest: { running: 'Armando cotización en Zoho', done: 'Cotización en borrador' },
  sendQuoteToContact: {
    running: 'Preparando envío de cotización',
    done: 'Envío de cotización propuesto',
  },
  getPickupLocation: { running: 'Buscando ubicación de bodega', done: 'Ubicación lista' },
  getWorkDigest: { running: 'Calculando tu digest', done: 'Digest listo' },
  web_search: { running: 'Buscando en internet', done: 'Busqué en internet' },
  fetch_url: { running: 'Leyendo la página', done: 'Leí la página' },
  web_crawl: { running: 'Recorriendo el sitio', done: 'Sitio recorrido' },
  web_research: { running: 'Investigando en internet', done: 'Investigación web lista' },
  analyzeImage: { running: 'Analizando la imagen', done: 'Imagen analizada' },
  generateImage: { running: 'Generando la imagen', done: 'Imagen generada' },
  generateVideo: { running: 'Generando el video', done: 'Video generado' },
  renderInteractiveUi: { running: 'Construyendo interfaz', done: 'Interfaz interactiva lista' },
  browser: { running: 'Usando el navegador', done: 'Navegación lista' },
  browserProfile: { running: 'Gestionando la sesión del sitio', done: 'Sesión del sitio lista' },
  venueExec: { running: 'Ejecutando en la terminal', done: 'Comando ejecutado' },
  venueScreenshot: { running: 'Tomando captura', done: 'Captura lista' },
  venueListFiles: { running: 'Revisando archivos', done: 'Archivos revisados' },
  venueReadFile: { running: 'Leyendo archivo', done: 'Archivo leído' },
  venueWriteFile: { running: 'Escribiendo archivo', done: 'Archivo escrito' },
  venuePreview: { running: 'Abriendo vista previa', done: 'Vista previa lista' },
  computer: { running: 'Usando la computadora', done: 'Acción en la computadora' },
  publishSite: { running: 'Publicando el sitio web', done: 'Sitio publicado' },
  listSites: { running: 'Revisando tus sitios', done: 'Sitios revisados' },
  unpublishSite: { running: 'Actualizando el sitio', done: 'Sitio actualizado' },
  delegateTask: { running: 'Delegando al equipo', done: 'Tarea delegada' },
  listAgents: { running: 'Revisando el equipo', done: 'Equipo revisado' },
  callMcpTool: { running: 'Usando herramienta MCP', done: 'Herramienta MCP lista' },
  executeApiOperation: { running: 'Consultando la API', done: 'API consultada' },
};

/**
 * Step line with the meaningful argument when there is one — "Buscando en
 * internet: arena de gato", "Leyendo https://x.com/…" — like ChatGPT's rail.
 */
export function toolStepLabel(
  name: string,
  args: unknown,
  status: 'running' | 'done' = 'done'
): string {
  const base = toolLabel(name, status);
  const obj = asObject(args);
  if (!obj) return base;
  if (obj.action === 'secureInput') {
    return status === 'running' ? 'Pidiendo datos seguros' : 'Te pedí datos en el panel';
  }
  const detail =
    (typeof obj.query === 'string' && obj.query.trim()) ||
    (typeof obj.url === 'string' && safeHostOrUrl(obj.url)) ||
    (typeof obj.topic === 'string' && obj.topic.trim()) ||
    (typeof obj.prompt === 'string' && obj.prompt.trim().slice(0, 60)) ||
    (Array.isArray(obj.queries) && typeof obj.queries[0] === 'string' && obj.queries[0].trim()) ||
    (typeof obj.fileName === 'string' && obj.fileName.trim()) ||
    '';
  return detail ? `${base}: ${String(detail).slice(0, 90)}` : base;
}

/** Show the host for a URL, the raw text otherwise. Never throws on junk input. */
function safeHostOrUrl(raw: string): string {
  try {
    return new URL(raw).hostname || raw.slice(0, 60);
  } catch {
    return raw.slice(0, 60);
  }
}

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
    assumptions: Array.isArray(obj.assumptions)
      ? obj.assumptions.filter((a): a is string => typeof a === 'string')
      : [],
    deliverable: typeof obj.deliverable === 'string' ? obj.deliverable : null,
  };
}

export interface MissionCardData {
  missionId: string;
  goal: string;
  steps: Array<{ title: string; status: string }>;
  schedule?: string | null;
  /** Status from the tool result ("awaiting_approval", "active"…) — live values come from the mission API. */
  initialStatus?: string;
}

/** Mission proposed with `proposeMission` (missionId from the tool result, plan from args). */
export function parseMission(args: unknown, result: unknown): MissionCardData | null {
  const a = asObject(args);
  const r = asObject(result);
  if (!a || typeof a.goal !== 'string') return null;
  const missionId = r && typeof r.missionId === 'string' ? r.missionId : null;
  if (!missionId) return null;
  const steps = Array.isArray(a.steps)
    ? a.steps
        .filter((s): s is string => typeof s === 'string')
        .map((title) => ({ title, status: 'pending' }))
    : [];
  return {
    missionId,
    goal: a.goal,
    steps,
    schedule: typeof a.schedule === 'string' ? a.schedule : null,
    initialStatus: typeof r?.status === 'string' ? r.status : undefined,
  };
}

/** Message the host sends when the user confirms a plan. */
export const RUN_PLAN_MESSAGE =
  'Ejecuta el plan propuesto tal cual, paso por paso, e infórmame el avance de cada paso.';

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
