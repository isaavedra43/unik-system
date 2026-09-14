/**
 * Per-turn tool selection.
 *
 * The assistant has ~150 tools and OpenAI accepts at most 128 per request
 * (and every offered tool costs prompt tokens). Instead of sending everything,
 * each turn offers: a CORE set that is always available, the tools used
 * recently in the conversation, and the tools most relevant to the message
 * (keyword + domain scoring). `loadMoreTools` lets the model pull any other
 * tool by topic in one extra step, so nothing is ever unreachable.
 *
 * Pure functions (no I/O) — unit tested.
 */

export interface SelectableTool {
  name: string;
  description: string;
  category?: string;
  effect?: string;
  contextTags?: string[];
}

export interface ToolSelectionInput<T extends SelectableTool> {
  tools: T[];
  message: string;
  /** Tools already used in this conversation (kept so follow-ups keep working). */
  recentToolNames?: string[];
  /** Always offered (surface tools, etc.). */
  pinned?: string[];
  maxTools: number;
}

export interface ToolSelectionResult<T extends SelectableTool> {
  offered: T[];
  dropped: T[];
  domains: string[];
}

/** Hard limit of the OpenAI Chat Completions API. */
export const PROVIDER_MAX_TOOLS = 128;

/** Tools that are always offered: orientation, universal data, documents, memory, meta. */
export const CORE_TOOL_NAMES: readonly string[] = [
  'loadMoreTools',
  'proposePlan',
  'getCurrentUserContext',
  'getSystemTime',
  'universalSearch',
  'getDatabaseOverview',
  'querySalesOrders',
  'getSalesOrderDetail',
  'queryContacts',
  'queryProducts',
  'searchKnowledgeLibrary',
  'rememberForUser',
  'generateTable',
  'generatePdfReport',
  'generateExcelReport',
  'generateChart',
  'listArtifacts',
  'getArtifactSpec',
  'sendMessageToContact',
  'sendInternalChatMessage',
  'getRecentActivity',
  'listConversationAttachments',
];

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'para', 'como', 'con', 'que', 'del', 'las', 'los', 'una', 'uno', 'por', 'sin', 'mas', 'muy', 'este', 'esta', 'esto', 'esos', 'esas',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'not', 'all', 'any', 'you', 'your', 'devuelve', 'usa', 'usala',
  'sobre', 'entre', 'cada', 'cuando', 'donde', 'tiene', 'tienen', 'hay', 'ser', 'son', 'sus', 'sea', 'sean', 'solo', 'tambien',
  'siempre', 'nunca', 'antes', 'despues', 'puede', 'pueden', 'debe', 'deben', 'hacer', 'hace', 'segun', 'lista', 'listar', 'obtiene',
]);

/** Word stems (first 5 chars) — handles Spanish inflection: cotizacion/cotizaciones/cotizame → "cotiz". */
export function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalizeText(text).split(' ')) {
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    out.add(w.length > 5 ? w.slice(0, 5) : w);
  }
  return out;
}

/** English tool-name words → Spanish vocabulary users actually type. */
const SYNONYMS: Record<string, string[]> = {
  sales: ['ventas', 'venta', 'vendido', 'vendimos', 'vender'],
  sale: ['ventas', 'venta'],
  order: ['orden', 'ordenes', 'pedido', 'pedidos'],
  orders: ['orden', 'ordenes', 'pedido', 'pedidos'],
  quote: ['cotizacion', 'cotizaciones', 'cotiza', 'cotizame', 'presupuesto', 'estimate'],
  quotes: ['cotizacion', 'cotizaciones', 'cotiza', 'cotizame', 'presupuesto'],
  invoice: ['factura', 'facturas', 'facturar', 'cfdi'],
  invoices: ['factura', 'facturas', 'facturar', 'cfdi'],
  payment: ['pago', 'pagos', 'cobro', 'cobros', 'cobranza', 'abono'],
  payments: ['pago', 'pagos', 'cobro', 'cobros', 'cobranza', 'abono'],
  purchase: ['compra', 'compras', 'proveedor', 'proveedores'],
  bill: ['factura', 'facturas', 'proveedor', 'bill', 'gasto'],
  bills: ['factura', 'facturas', 'proveedor', 'gastos'],
  vendor: ['proveedor', 'proveedores'],
  credit: ['credito', 'creditos', 'nota'],
  credits: ['credito', 'creditos', 'notas'],
  package: ['paquete', 'paquetes', 'envio', 'envios', 'entrega', 'entregas', 'guia'],
  packages: ['paquete', 'paquetes', 'envio', 'envios', 'entrega', 'entregas', 'guia'],
  product: ['producto', 'productos', 'articulo', 'material', 'materiales', 'loseta', 'piel', 'catalogo'],
  products: ['producto', 'productos', 'articulo', 'material', 'materiales', 'catalogo'],
  stock: ['existencia', 'existencias', 'inventario', 'stock', 'disponible'],
  inventory: ['inventario', 'existencias', 'stock'],
  customer: ['cliente', 'clientes'],
  customers: ['cliente', 'clientes'],
  contact: ['contacto', 'contactos', 'cliente', 'proveedor', 'telefono'],
  contacts: ['contacto', 'contactos', 'clientes', 'proveedores'],
  call: ['llama', 'llamar', 'llamada', 'marca', 'marcale', 'marcar', 'telefono', 'hablar'],
  calls: ['llamadas', 'llamada', 'llamar'],
  outbound: ['llamada', 'marcar'],
  transcript: ['transcripcion', 'grabacion', 'llamada'],
  message: ['mensaje', 'mensajes', 'whatsapp', 'sms', 'escribele', 'mandale', 'manda', 'envia', 'enviale', 'avisale', 'dile'],
  messages: ['mensajes', 'mensaje', 'chat'],
  bulk: ['masivo', 'varios', 'todos', 'lista'],
  chat: ['chat', 'canal', 'equipo', 'interno'],
  channel: ['canal', 'canales', 'chat'],
  channels: ['canales', 'canal', 'chat'],
  internal: ['interno', 'interna', 'equipo', 'compañero'],
  inbox: ['bandeja', 'conversacion', 'conversaciones', 'whatsapp'],
  conversation: ['conversacion', 'conversaciones', 'bandeja', 'chat'],
  conversations: ['conversaciones', 'conversacion', 'bandeja'],
  draft: ['borrador', 'redacta', 'redactar', 'propuesta', 'responde'],
  reply: ['responde', 'respuesta', 'contesta', 'contestar'],
  campaign: ['campaña', 'campañas', 'campana', 'campanas', 'promocion'],
  campaigns: ['campañas', 'campaña', 'campanas'],
  knowledge: ['manual', 'politica', 'politicas', 'biblioteca', 'conocimiento', 'ficha', 'documento', 'procedimiento'],
  library: ['biblioteca', 'manual', 'documentos', 'catalogo'],
  memory: ['memoria', 'recuerda', 'recordar', 'olvida', 'preferencia'],
  remember: ['recuerda', 'recordar', 'guarda', 'anota'],
  forget: ['olvida', 'olvidar', 'borra'],
  report: ['reporte', 'reportes', 'informe', 'resumen'],
  pdf: ['pdf', 'reporte', 'documento'],
  excel: ['excel', 'xlsx', 'hoja'],
  word: ['word', 'docx', 'documento'],
  csv: ['csv', 'exportar', 'exporta'],
  export: ['exporta', 'exportar', 'descargar'],
  chart: ['grafica', 'grafico', 'graficas', 'chart'],
  table: ['tabla', 'tablas', 'listado'],
  image: ['imagen', 'foto', 'jpg', 'png'],
  digest: ['digest', 'resumen', 'kpi', 'kpis', 'como voy', 'desempeño', 'desempeno'],
  work: ['trabajo', 'jornada', 'dia', 'hoy'],
  skill: ['skill', 'skills', 'receta', 'recetas', 'rutina'],
  skills: ['skills', 'skill', 'recetas', 'rutinas'],
  run: ['ejecuta', 'ejecutar', 'corre', 'lanza'],
  delivery: ['entrega', 'entregas', 'reparto', 'obra', 'domicilio', 'recoger'],
  deliveries: ['entregas', 'entrega', 'reparto', 'obra', 'pendientes'],
  delayed: ['retraso', 'retrasos', 'atrasado', 'atrasadas', 'tarde'],
  pending: ['pendiente', 'pendientes', 'falta', 'faltan'],
  cash: ['efectivo', 'caja', 'corte'],
  close: ['corte', 'cierre', 'cerrar'],
  reconciliation: ['conciliacion', 'corte', 'cuadre', 'cuadrar'],
  receivable: ['cobrar', 'cobranza', 'saldo', 'saldos', 'adeudo', 'deuda', 'deben'],
  balance: ['saldo', 'saldos', 'adeudo', 'deuda', 'balance'],
  aging: ['antiguedad', 'vencido', 'vencidos', 'morosidad'],
  collection: ['cobranza', 'cobrar', 'recordatorio', 'saldo'],
  trend: ['tendencia', 'tendencias', 'evolucion', 'historico'],
  forecast: ['pronostico', 'proyeccion', 'estimacion', 'prediccion'],
  velocity: ['ritmo', 'velocidad', 'frecuencia'],
  pattern: ['patron', 'patrones', 'horario', 'horas'],
  hourly: ['hora', 'horas', 'horario'],
  weekday: ['dia', 'dias', 'semana', 'lunes', 'martes', 'sabado'],
  top: ['top', 'mejores', 'mayores', 'principales', 'ranking'],
  ranking: ['ranking', 'mejores', 'top', 'quien vende'],
  health: ['salud', 'riesgo', 'estado'],
  reactivation: ['inactivo', 'inactivos', 'reactivar', 'recuperar', 'perdidos'],
  opportunities: ['oportunidad', 'oportunidades'],
  blockers: ['bloqueo', 'bloqueos', 'falta', 'trabado', 'detenido'],
  deal: ['pedido', 'orden', 'venta', 'negocio'],
  follow: ['seguimiento', 'recordatorio', 'recordar', 'pendiente'],
  survey: ['encuesta', 'satisfaccion', 'opinion'],
  satisfaction: ['satisfaccion', 'encuesta'],
  event: ['evento', 'reunion', 'agenda', 'cita', 'junta'],
  pickup: ['recoger', 'recoge', 'ubicacion', 'bodega', 'direccion', 'mapa', 'maps'],
  location: ['ubicacion', 'direccion', 'sucursal', 'bodega', 'mapa'],
  document: ['documento', 'documentos', 'archivo', 'factura', 'recibo', 'pdf', 'adjunto'],
  extract: ['extrae', 'extraer', 'lee', 'leer', 'datos', 'ocr', 'factura', 'recibo'],
  attachments: ['adjunto', 'adjuntos', 'archivo', 'archivos', 'subi', 'subido'],
  attachable: ['adjuntar', 'catalogo', 'documento'],
  plan: ['plan', 'planea', 'planear', 'pasos', 'estrategia'],
  more: ['mas', 'otra', 'otras', 'herramienta', 'herramientas', 'tool', 'tools'],
  tools: ['herramientas', 'herramienta', 'funciones', 'puedes'],
  user: ['usuario', 'usuarios', 'quien soy', 'mi'],
  module: ['modulo', 'modulos', 'sistema'],
  time: ['hora', 'fecha', 'hoy', 'dia'],
  notifications: ['notificacion', 'notificaciones', 'aviso', 'avisos', 'alerta'],
  integration: ['integracion', 'zoho', 'sincronizacion', 'sync'],
  status: ['estado', 'estatus', 'situacion'],
  search: ['busca', 'buscar', 'encuentra', 'donde', 'localiza'],
  overview: ['panorama', 'resumen', 'general', 'base'],
  database: ['base', 'datos', 'sistema'],
  artifact: ['archivo', 'reporte', 'documento', 'generado'],
  artifacts: ['archivos', 'reportes', 'documentos', 'generados'],
  share: ['comparte', 'compartir', 'enlace', 'link', 'url'],
  assignee: ['asigna', 'asignar', 'reparte', 'responsable'],
  salesperson: ['vendedor', 'vendedores', 'vendedora', 'equipo'],
  scorecard: ['desempeño', 'desempeno', 'rendimiento', 'vendedor'],
  team: ['equipo', 'vendedores', 'compañeros'],
  performance: ['rendimiento', 'desempeño', 'desempeno'],
  bundles: ['juntos', 'combinado', 'acompaña'],
  relations: ['relacion', 'relaciones', 'juntos'],
  retention: ['retencion', 'recurrente', 'regresa', 'vuelve'],
  segments: ['segmento', 'segmentos', 'tipo de cliente'],
  compare: ['compara', 'comparar', 'versus', 'contra', 'diferencia'],
  periods: ['periodo', 'periodos', 'mes', 'meses', 'año', 'semana'],
  entities: ['sucursal', 'vendedor', 'producto', 'cliente'],
  crosstab: ['cruce', 'cruzado', 'matriz'],
  alerts: ['alerta', 'alertas', 'aviso'],
  revenue: ['ingreso', 'ingresos', 'facturacion', 'ventas'],
  daily: ['diario', 'diaria', 'dia', 'hoy'],
  kpis: ['kpi', 'kpis', 'indicadores', 'metricas'],
  dashboard: ['dashboard', 'resumen', 'ejecutivo', 'panorama'],
  summary: ['resumen', 'resume', 'resumir'],
  summarize: ['resume', 'resumen', 'resumir'],
  pin: ['fija', 'fijar', 'destaca'],
  low: ['bajo', 'poco', 'agotado', 'agotarse'],
  movement: ['movimiento', 'movimientos', 'entradas', 'salidas'],
  price: ['precio', 'precios', 'costo', 'tarifa'],
  history: ['historial', 'historico', 'anteriores', 'pasadas'],
  similar: ['similar', 'similares', 'parecida', 'anteriores'],
  past: ['anteriores', 'pasadas', 'previas'],
  check: ['revisa', 'verifica', 'checa', 'hay'],
  request: ['pedido', 'solicitud', 'piden', 'quiere'],
  preview: ['previsualiza', 'preview', 'vista', 'antes'],
  create: ['crea', 'crear', 'genera', 'generar', 'nueva', 'nuevo', 'hazme', 'arma'],
  update: ['actualiza', 'edita', 'editar', 'cambia', 'modifica', 'corrige'],
  send: ['manda', 'mandar', 'envia', 'enviar', 'mandale', 'enviale'],
  start: ['inicia', 'iniciar', 'empieza', 'comienza'],
  pause: ['pausa', 'detener', 'para'],
  approve: ['aprueba', 'aprobar', 'autoriza'],
  cleanup: ['limpia', 'limpiar', 'borra', 'elimina'],
  list: ['lista', 'listado', 'cuales', 'que hay'],
  get: [],
  query: ['consulta', 'dime', 'cuanto', 'cuantos', 'cuantas', 'cuales', 'muestra'],
  find: ['busca', 'encuentra', 'detecta'],
  detail: ['detalle', 'detalles', 'info', 'informacion'],
  details: ['detalle', 'detalles', 'info'],
  file: ['expediente', 'archivo', 'ficha'],
  duplicate: ['duplicado', 'duplicados', 'repetido'],
  commitment: ['compromiso', 'compromisos', 'promesa', 'acordado'],
  commitments: ['compromisos', 'compromiso', 'promesas'],
  note: ['nota', 'notas', 'apunte'],
  next: ['siguiente', 'siguientes', 'proximo', 'que hago'],
  actions: ['acciones', 'accion', 'que hago', 'sugerencias'],
  audit: ['auditoria', 'revisa', 'revision', 'verifica'],
  content: ['contenido', 'texto', 'copy'],
  stats: ['estadisticas', 'metricas', 'resultados'],
  word_report: ['word'],
  generate: ['genera', 'generar', 'crea', 'hazme', 'arma'],
  ai: ['ia', 'asistente', 'voz'],
  contact_file: ['expediente'],
};

interface DomainRule {
  domain: string;
  test: RegExp;
  categories: string[];
  tools: string[];
}

/** Coarse intent → categories/tools boost. Regexes run on the normalized message. */
const DOMAIN_RULES: DomainRule[] = [
  { domain: 'quotes', test: /\bcotiz|presupuest|estimate/, categories: [], tools: ['queryQuotes', 'getQuoteDetail', 'searchQuoteCustomers', 'searchQuoteProducts', 'previewQuote', 'createQuote', 'updateQuote', 'getQuotePdf', 'draftQuoteFromRequest', 'sendQuoteToContact', 'findSimilarPastQuotes', 'checkStockForRequest', 'getCustomerPriceHistory'] },
  { domain: 'sales', test: /\bvent|\borden|pedido|vendi|efectivo|corte|caja|pie de obra|entreg|reparto/, categories: ['sales'], tools: ['querySalesOrders', 'getSalesOrderDetail', 'auditPendingDeliveries', 'getCashCloseReconciliation', 'getOrdersWithBalance', 'notifyDelayedDeliveries', 'getDealBlockers'] },
  { domain: 'invoices', test: /factur|cfdi|timbr/, categories: ['invoices'], tools: ['queryInvoices', 'getInvoiceDetail', 'queryBills', 'getBillDetail', 'extractDocumentData', 'draftBillFromDocument'] },
  { domain: 'payments', test: /\bpago|\bcobr|abono|saldo|adeud|deud|deben|moros|vencid|antigued/, categories: ['payments', 'finance'], tools: ['queryPayments', 'getPaymentDetail', 'getAccountsReceivable', 'getBalanceAging', 'getOrdersWithBalance', 'draftCollectionReminders'] },
  { domain: 'purchases', test: /compra|proveedor|\bbill|gasto/, categories: ['purchases'], tools: ['queryPurchaseOrders', 'getPurchaseOrderDetail', 'queryBills', 'getBillDetail', 'queryVendorCredits', 'getVendorCreditDetail', 'draftBillFromDocument', 'extractDocumentData'] },
  { domain: 'inventory', test: /inventar|existenc|stock|\bproduct|articul|material|catalog|\bsku\b|loseta|piel|bajo stock|agot/, categories: ['inventory', 'products'], tools: ['queryProducts', 'getProductDetail', 'getProductCatalog', 'getStockMovement', 'getLowStockAlerts', 'getProductDetails', 'getProductSearch', 'checkStockForRequest', 'findProductRelations', 'getProductBundles'] },
  { domain: 'customers', test: /client|contact|expedient|telefon|correo|inactiv|reactiv|salud|riesgo/, categories: ['contacts'], tools: ['queryContacts', 'getContactDetail', 'getContactFile', 'getTopCustomers', 'getCustomerDetails', 'getCustomerSegments', 'getCustomerRetention', 'getCustomerHealth', 'findReactivationOpportunities', 'findDuplicateContacts', 'getCustomerPriceHistory'] },
  { domain: 'packages', test: /paquet|env[ií]o|guia|paqueter|transport|rastre/, categories: ['packages'], tools: ['queryPackages', 'getPackageDetail', 'notifyDelayedDeliveries'] },
  { domain: 'analytics', test: /tendenc|pronost|proyecc|compar|versus|\bvs\b|ranking|\btop\b|mejores|kpi|indicador|metric|desempe|rendimient|anomal|analiz|analisis|retenc|segment|patron|horari|ritmo|crec|cay|baj[oó]|subi/, categories: ['sales', 'finance'], tools: ['getTopProducts', 'getSalesTrend', 'getSalesRanking', 'getHourlySalesPattern', 'getWeekdaySalesPattern', 'comparePeriods', 'getSalesKPIs', 'getDashboardSummary', 'getCrossTabAnalysis', 'compareEntities', 'getTeamPerformance', 'getSalesForecast', 'getSalesAlerts', 'getSalesVelocity', 'getProductBundles', 'getRevenueAnalysis', 'getDailyRevenue', 'getSalespersonScorecard', 'getCustomerRetention'] },
  { domain: 'documents', test: /reporte|informe|\bpdf\b|excel|xlsx|word|docx|\bcsv\b|grafic|tabla|imagen|foto|export|descarg|archivo|documento/, categories: ['export'], tools: ['generatePdfReport', 'generateExcelReport', 'generateWordReport', 'generateCsvExport', 'generateChart', 'generateReportImage', 'generateTable', 'listArtifacts', 'cleanupArtifacts', 'getArtifactSpec', 'shareArtifact', 'listAttachableDocuments', 'findShareableDocument'] },
  { domain: 'messaging', test: /mensaje|whatsapp|\bsms\b|manda|envia|escribe|avisa|dile|contesta|respond|recordatorio|masivo|campa/, categories: ['communication'], tools: ['sendMessageToContact', 'sendBulkMessages', 'sendInboxMessage', 'draftReply', 'listInboxConversations', 'getConversationMessages', 'listCommitments', 'createCommitment', 'scheduleFollowUp', 'getPickupLocation', 'listAttachableDocuments', 'findShareableDocument', 'shareArtifact', 'listCampaigns', 'getCampaignStats', 'draftCampaignContent', 'createCampaignDraft', 'approveCampaign', 'draftSatisfactionSurvey', 'draftCollectionReminders', 'notifyDelayedDeliveries'] },
  { domain: 'chat', test: /chat|canal|equipo|compa[ñn]er|interno|fija|pinea|reunion|evento|agenda|junta/, categories: [], tools: ['listChatChannels', 'getChatChannelMessages', 'searchChatMessages', 'summarizeChatChannel', 'proposeChatDraft', 'pinChatMessage', 'sendInternalChatMessage', 'createChatEvent', 'startInternalCall', 'suggestAssignee'] },
  { domain: 'calls', test: /llam|marc[aá]|telefon|habl[ae]|\bvoz\b|grabaci|transcrip/, categories: [], tools: ['callContact', 'startInternalCall', 'startOutboundCall', 'listCalls', 'getCallTranscript', 'pauseCallAi'] },
  { domain: 'pickup', test: /recog|ubicaci|direccion|bodega|mapa|maps|donde estan|horario/, categories: [], tools: ['getPickupLocation', 'sendMessageToContact'] },
  { domain: 'knowledge', test: /manual|politic|procedim|biblioteca|conocimient|ficha|garantia|instalaci|especificaci|que dice|promoci|catalogo|folleto|lista de precio/, categories: ['knowledge'], tools: ['searchKnowledgeLibrary', 'listAttachableDocuments', 'findShareableDocument'] },
  { domain: 'memory', test: /recuerd|memoria|olvid|preferenc|anota|apunta/, categories: [], tools: ['rememberForUser', 'listUserMemory', 'forgetMemory'] },
  { domain: 'skills', test: /skill|receta|rutina|automatiz/, categories: ['skill'], tools: ['listSkills', 'runSkill', 'getSkillRunStatus'] },
  { domain: 'digest', test: /como voy|mi dia|jornada|que hice|digest|ponme al dia|resumen del dia|pendientes de hoy/, categories: [], tools: ['getWorkDigest', 'getRecentActivity', 'getNotifications', 'getDealBlockers'] },
  { domain: 'attachments', test: /adjunt|subi|archivo|factura|recibo|extrae|\bocr\b|lee el|leer el|documento/, categories: [], tools: ['listConversationAttachments', 'extractDocumentData', 'draftBillFromDocument'] },
  { domain: 'system', test: /integraci|zoho|sincroniz|notificaci|modulo|sistema|quien soy|permiso/, categories: ['system'], tools: ['getIntegrationStatus', 'getNotifications', 'getModuleList', 'getCurrentUserContext'] },
  { domain: 'planning', test: /\bplan\b|planea|paso a paso|primero.*luego|trimestral|anual|completo|integral/, categories: [], tools: ['proposePlan'] },
];

export function detectDomains(message: string): string[] {
  const norm = normalizeText(message);
  return DOMAIN_RULES.filter((r) => r.test.test(norm)).map((r) => r.domain);
}

function splitCamel(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .split(' ')
    .filter(Boolean);
}

const keywordCache = new WeakMap<object, { nameStems: Set<string>; descStems: Set<string> }>();

function toolKeywords(tool: SelectableTool): { nameStems: Set<string>; descStems: Set<string> } {
  const cached = keywordCache.get(tool);
  if (cached) return cached;
  const nameWords = splitCamel(tool.name);
  const nameStems = new Set<string>();
  for (const w of nameWords) {
    for (const s of stems(w)) nameStems.add(s);
    for (const syn of SYNONYMS[w] ?? []) for (const s of stems(syn)) nameStems.add(s);
  }
  const descStems = stems(tool.description.slice(0, 400));
  const value = { nameStems, descStems };
  keywordCache.set(tool, value);
  return value;
}

export function scoreTool(
  tool: SelectableTool,
  messageStems: Set<string>,
  domainRules: DomainRule[],
  recent: Set<string>
): number {
  let score = 0;
  const { nameStems, descStems } = toolKeywords(tool);
  for (const s of messageStems) {
    if (nameStems.has(s)) score += 3;
    else if (descStems.has(s)) score += 1;
  }
  for (const rule of domainRules) {
    if (rule.tools.includes(tool.name)) score += 6;
    else if (tool.category && rule.categories.includes(tool.category)) score += 2;
  }
  if (recent.has(tool.name)) score += 8;
  return score;
}

/**
 * Chooses which tools to offer this turn. Deterministic: core + pinned first,
 * then by relevance score (ties keep registration order), capped at maxTools
 * (never above the provider limit).
 */
export function selectToolsForTurn<T extends SelectableTool>(input: ToolSelectionInput<T>): ToolSelectionResult<T> {
  const cap = Math.max(8, Math.min(input.maxTools, PROVIDER_MAX_TOOLS));
  const norm = normalizeText(input.message);
  const domainRules = DOMAIN_RULES.filter((r) => r.test.test(norm));
  const messageStems = stems(input.message);
  const recent = new Set(input.recentToolNames ?? []);
  const always = new Set<string>([...CORE_TOOL_NAMES, ...(input.pinned ?? [])]);

  if (input.tools.length <= cap) {
    return { offered: input.tools, dropped: [], domains: domainRules.map((r) => r.domain) };
  }

  const scored = input.tools.map((tool, index) => ({
    tool,
    index,
    core: always.has(tool.name),
    score: scoreTool(tool, messageStems, domainRules, recent),
  }));
  scored.sort((a, b) => {
    if (a.core !== b.core) return a.core ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    return a.index - b.index;
  });
  const offered = scored.slice(0, cap);
  const dropped = scored.slice(cap);
  // Keep the model's tools in a stable order (registration order) so prompts cache well.
  offered.sort((a, b) => a.index - b.index);
  return {
    offered: offered.map((s) => s.tool),
    dropped: dropped.map((s) => s.tool),
    domains: domainRules.map((r) => r.domain),
  };
}

/** Tools matching a free-text topic (used by `loadMoreTools`). */
export function findToolsByTopic<T extends SelectableTool>(tools: T[], topic: string, limit = 30): T[] {
  const norm = normalizeText(topic);
  const domainRules = DOMAIN_RULES.filter((r) => r.test.test(norm));
  const topicStems = stems(topic);
  const scored = tools
    .map((tool, index) => ({ tool, index, score: scoreTool(tool, topicStems, domainRules, new Set()) }))
    .filter((s) => s.score > 0);
  scored.sort((a, b) => (a.score !== b.score ? b.score - a.score : a.index - b.index));
  return scored.slice(0, limit).map((s) => s.tool);
}
