import type { TriggerAction, TriggerSpec } from './trigger-service';

/**
 * Plantillas de agentes UNIVERSO — especialistas y EQUIPOS listos para crear
 * con un clic, pensados para los casos de uso del negocio (director que
 * coordina 10 agentes, empresa que arranca a las 6:00, vendedor autónomo,
 * programadores, marketing, finanzas, nuevo negocio…).
 *
 * Datos puros: se importa desde el cliente (diálogo de nuevo agente, estado
 * vacío del chat) y desde el servidor. Nada aquí toca Prisma ni servicios.
 *
 * - `toolAllowlist` solo ACOTA el menú del dueño (ver ai-orchestrator): un
 *   agente nunca gana tools que el usuario no tiene. Vacío = todas.
 * - `autonomy`: 'auto' corre lecturas/borradores/tareas internas solo;
 *   'approval' pide confirmación para todo lo que tenga efecto.
 * - `routine`: trigger `time` que se crea junto al agente si el usuario lo
 *   deja activado. `tz` fija la hora local del negocio.
 */

export type AgentAutonomy = 'auto' | 'notify' | 'approval';
export type AgentVenuePolicy = 'shared' | 'dedicated' | 'ephemeral';

export interface AgentRoutine {
  type: 'time';
  spec: TriggerSpec;
  action: TriggerAction;
  /** Texto humano: "Todos los días a las 7:30". */
  label: string;
}

export type AgentTemplateCategory =
  | 'direccion'
  | 'ventas'
  | 'operaciones'
  | 'finanzas'
  | 'marketing'
  | 'tecnologia'
  | 'oficina';

export interface AgentTemplate {
  id: string;
  name: string;
  /** ≤ 200 caracteres (el servidor recorta). */
  purpose: string;
  /** Clave de AGENT_ICONS. */
  icon: string;
  /** Índice de la paleta (--agent-hue-N). */
  color: number;
  category: AgentTemplateCategory;
  /** Caso de uso al que responde (se muestra como ayuda). */
  useCase: string;
  persona: string;
  toolAllowlist: string[];
  autonomy: AgentAutonomy;
  venuePolicy: AgentVenuePolicy;
  routine?: AgentRoutine;
  /** Primeros mensajes sugeridos una vez creado. */
  starters: string[];
}

export interface AgentTeamTemplate {
  id: string;
  name: string;
  purpose: string;
  icon: string;
  color: number;
  useCase: string;
  /** Ids de AGENT_TEMPLATES que se crean juntos. */
  members: string[];
  /** Qué pedirle al principal (director) una vez creado el equipo. */
  kickoff: string;
}

export const BUSINESS_TZ = 'America/Mexico_City';

export const TEMPLATE_CATEGORY_LABEL: Record<AgentTemplateCategory, string> = {
  direccion: 'Dirección',
  ventas: 'Ventas y clientes',
  operaciones: 'Operaciones',
  finanzas: 'Finanzas',
  marketing: 'Marketing',
  tecnologia: 'Tecnología',
  oficina: 'Oficina',
};

// ---------------------------------------------------------------------------
// Tool groups (nombres reales del registro de tools)
// ---------------------------------------------------------------------------

/** Lo que cualquier especialista necesita para orientarse, recordar y reportar. */
const CORE = [
  'getCurrentUserContext',
  'getSystemTime',
  'universalSearch',
  'getDatabaseOverview',
  'rememberForUser',
  'listUserMemory',
  'recallMemory',
  'saveFact',
  'proposePlan',
  'loadMoreTools',
  'renderInteractiveUi',
  'renderView',
  'generateTable',
  'readAttachment',
  'listConversationAttachments',
  'searchKnowledgeLibrary',
  'notifyUser',
  'listVenuePlaybooks',
  'runVenuePlaybook',
];

const WEB = ['web_search', 'web_research', 'web_crawl', 'fetch_url'];

const BROWSER = ['browser', 'browserProfile', 'venueScreenshot'];

const COMPUTER = [
  'computer',
  'venueExec',
  'venueListFiles',
  'venueReadFile',
  'venueWriteFile',
  'venuePreview',
];

const APPS = ['composioListToolkits', 'composioSearchTools', 'composioConnect', 'composioExecute'];

const REPORTS = [
  'generatePdfReport',
  'generateExcelReport',
  'generateWordReport',
  'generateCsvExport',
  'generateChart',
  'generateReportImage',
  'composeDocument',
  'listArtifacts',
  'shareArtifact',
];

const SALES_DATA = [
  'querySalesOrders',
  'getSalesOrderDetail',
  'getSalesOrderFullFile',
  'lookupSalesOrdersByNumber',
  'getOrdersWithBalance',
  'getDashboardSummary',
  'getDailyRevenue',
  'getRevenueAnalysis',
  'getSalesKPIs',
  'comparePeriods',
  'getSalesTrend',
  'getSalesRanking',
  'getTopProducts',
  'getTopCustomers',
  'getSalesAlerts',
  'getSalesVelocity',
  'getSalesForecast',
  'getCrossTabAnalysis',
];

const CUSTOMERS = [
  'queryContacts',
  'getContactDetail',
  'getContactFile',
  'getCustomerDetails',
  'getCustomerHealth',
  'getCustomerSegments',
  'getCustomerRetention',
  'getCustomerPriceHistory',
  'findReactivationOpportunities',
  'findDuplicateContacts',
];

const INVENTORY = [
  'queryProducts',
  'getProductDetail',
  'getProductCatalog',
  'getProductSearch',
  'getProductDetails',
  'getStockMovement',
  'getLowStockAlerts',
  'checkStockForRequest',
  'findProductRelations',
  'getProductBundles',
];

const PURCHASING = [
  'queryPurchaseOrders',
  'getPurchaseOrderDetail',
  'queryBills',
  'getBillDetail',
  'queryVendorCredits',
  'getVendorCreditDetail',
  'extractDocumentData',
  'draftBillFromDocument',
];

const QUOTES = [
  'queryQuotes',
  'getQuoteDetail',
  'getQuotePdf',
  'previewQuote',
  'createQuote',
  'updateQuote',
  'draftQuoteFromRequest',
  'sendQuoteToContact',
  'findSimilarPastQuotes',
  'searchQuoteCustomers',
  'searchQuoteProducts',
];

const MONEY = [
  'getAccountsReceivable',
  'getBalanceAging',
  'queryInvoices',
  'getInvoiceDetail',
  'queryPayments',
  'getPaymentDetail',
  'getCashCloseReconciliation',
];

const MESSAGING = [
  'listInboxConversations',
  'getConversationMessages',
  'draftReply',
  'sendInboxMessage',
  'sendMessageToContact',
  'sendBulkMessages',
  'scheduleFollowUp',
  'createCommitment',
  'listCommitments',
  'addInboxNote',
  'updateInboxConversation',
  'listAttachableDocuments',
  'findShareableDocument',
];

const TEAM_CHAT = [
  'listChatChannels',
  'getChatChannelMessages',
  'searchChatMessages',
  'summarizeChatChannel',
  'sendInternalChatMessage',
  'createChatEvent',
  'findUsers',
  'suggestAssignee',
];

const LOGISTICS = [
  'queryPackages',
  'getPackageDetail',
  'auditPendingDeliveries',
  'notifyDelayedDeliveries',
  'getPickupLocation',
];

const MARKETING = [
  'listCampaigns',
  'getCampaignStats',
  'draftCampaignContent',
  'createCampaignDraft',
  'generateImage',
  'generateVideo',
  'analyzeImage',
];

const SITES = ['publishSite', 'listSites', 'unpublishSite'];

const uniq = (...groups: string[][]) => [...new Set(groups.flat())];

const STYLE =
  'Escribe breve y accionable: primero el resultado, luego una lista corta solo si aporta. ' +
  'Nunca inventes datos ni digas que ejecutaste algo que no ejecutaste; cita la fuente (tabla del ERP, URL, documento). ' +
  'Cuando una acción tenga efecto externo (mensajes, cambios, envíos, compras, publicaciones) prepárala y pide aprobación.';

const persona = (name: string, role: string, how: string) =>
  [`Eres «${name}», un agente especialista de UNIVERSO.`, role, how, STYLE].join(' ');

const daily = (hour: number, minute: number, goal: string, label: string): AgentRoutine => ({
  type: 'time',
  spec: { atHour: hour, atMinute: minute, tz: BUSINESS_TZ },
  action: { kind: 'run', goal },
  label,
});

const every = (minutes: number, goal: string, label: string): AgentRoutine => ({
  type: 'time',
  spec: { everyMinutes: minutes, tz: BUSINESS_TZ },
  action: { kind: 'run', goal },
  label,
});

// ---------------------------------------------------------------------------
// Especialistas
// ---------------------------------------------------------------------------

export const AGENT_TEMPLATES: AgentTemplate[] = [
  // --- Dirección -----------------------------------------------------------
  {
    id: 'morning-director',
    name: 'Director matutino',
    purpose: 'Cada mañana te entrega el informe ejecutivo: ventas, efectivo, cobranza, stock, correos y bloqueos, con las tareas del día.',
    icon: 'ops',
    color: 5,
    category: 'direccion',
    useCase: 'Empresa que trabaja antes de que despiertes',
    persona: persona(
      'Director matutino',
      'Tu función: preparar el informe ejecutivo del día (máximo 10 líneas + una tarjeta): ventas de ayer vs. semana pasada, efectivo, cobranza vencida, stock en riesgo, pedidos bloqueados, correos urgentes y problemas operativos.',
      'Cierra SIEMPRE con las 3-5 tareas del día asignadas a una persona o área, y con las decisiones que el dueño debe tomar. Si otros agentes del equipo trabajaron en la madrugada, integra sus reportes.'
    ),
    toolAllowlist: uniq(CORE, SALES_DATA, MONEY, INVENTORY, LOGISTICS, REPORTS, TEAM_CHAT, APPS, [
      'getDealBlockers',
      'getWorkDigest',
      'getRecentActivity',
      'getTeamPerformance',
      'getNotifications',
      'listCommitments',
      'createCommitment',
      'delegateTask',
      'listAgents',
    ]),
    autonomy: 'auto',
    venuePolicy: 'shared',
    routine: daily(
      6,
      45,
      'Prepara el informe ejecutivo del día con ventas, efectivo, cobranza, stock, correos urgentes y bloqueos. Termina con las tareas del día asignadas y las decisiones que debo tomar.',
      'Todos los días a las 6:45'
    ),
    starters: ['Dame el informe de hoy', '¿Qué cambió respecto a la semana pasada?', '¿Qué tareas asigno hoy y a quién?'],
  },
  {
    id: 'strategy',
    name: 'Estratega de negocio',
    purpose: 'Evalúa decisiones grandes (abrir sucursal, nueva línea, precios): investiga, arma escenarios financieros y entrega un informe con fuentes.',
    icon: 'library',
    color: 9,
    category: 'direccion',
    useCase: 'Decisiones empresariales complejas',
    persona: persona(
      'Estratega de negocio',
      'Tu función: preparar decisiones complejas con evidencia — ubicaciones, competencia, clientes potenciales, costos inmobiliarios, datos económicos públicos (INEGI, Banxico) y el desempeño real del ERP.',
      'Construye 3 escenarios (conservador, base, optimista) con supuestos explícitos y señala cuáles supuestos mueven más el resultado. Entrega un informe PDF con fuentes.'
    ),
    toolAllowlist: uniq(CORE, WEB, BROWSER, SALES_DATA, CUSTOMERS, MONEY, REPORTS, ['compareEntities']),
    autonomy: 'auto',
    venuePolicy: 'shared',
    starters: [
      '¿Conviene abrir una sucursal en Querétaro? Hazme el análisis completo',
      'Evalúa subir 5 % los precios de la línea más vendida',
    ],
  },
  {
    id: 'investigator',
    name: 'Investigador de incidentes',
    purpose: 'Reconstruye qué pasó con una orden o un problema: cruza pedidos, compras, mensajes, correos y movimientos para una cronología con evidencias.',
    icon: 'audit',
    color: 2,
    category: 'direccion',
    useCase: 'Por qué una orden tiene 15 días de atraso',
    persona: persona(
      'Investigador de incidentes',
      'Tu función: reconstruir la cronología de un caso (una orden atrasada, un cobro equivocado, una queja) usando SOLO evidencia: movimientos del ERP, órdenes de compra, paquetes, conversaciones, chat interno y correo conectado.',
      'Entrega: línea de tiempo con fecha, hecho y fuente; la causa raíz más probable; responsables; y qué cambiar para que no se repita.'
    ),
    toolAllowlist: uniq(CORE, SALES_DATA, PURCHASING, LOGISTICS, MESSAGING, TEAM_CHAT, MONEY, APPS, [
      'getRecentActivity',
      'getCallTranscript',
      'listCalls',
    ]),
    autonomy: 'auto',
    venuePolicy: 'shared',
    starters: ['¿Por qué la orden 23354 lleva 15 días de atraso?', 'Reconstruye qué pasó con el pedido de Constructora Ruiz'],
  },

  // --- Ventas y clientes ---------------------------------------------------
  {
    id: 'prospector',
    name: 'Vendedor autónomo',
    purpose: 'Consigue clientes mientras duermes: investiga empresas, sus proyectos y contactos, registra oportunidades y prepara correos personalizados para tu aprobación.',
    icon: 'sales',
    color: 4,
    category: 'ventas',
    useCase: 'Vendedor que consigue clientes mientras duermes',
    persona: persona(
      'Vendedor autónomo',
      'Tu función: prospectar en lotes (p. ej. 200 constructoras): identificar empresas que encajan con el catálogo, sus proyectos activos y contactos comerciales públicos, calificarlas y registrar oportunidades en el CRM (ERP o CRM conectado).',
      'Prepara correos personalizados por prospecto (qué vimos, por qué encajamos, siguiente paso) y déjalos listos para aprobación; nunca envíes sin aprobación. Registra en memoria a quién ya contactaste. Para lotes grandes, divide en tandas y reporta avance.'
    ),
    toolAllowlist: uniq(CORE, WEB, BROWSER, CUSTOMERS, INVENTORY, MESSAGING, APPS, REPORTS, [
      'draftQuoteFromRequest',
      'previewQuote',
    ]),
    autonomy: 'approval',
    venuePolicy: 'dedicated',
    routine: daily(
      2,
      0,
      'Investiga 25 empresas nuevas que encajen con nuestros productos (proyectos activos y contacto comercial), registra las oportunidades y prepara un correo personalizado por empresa para mi aprobación. No envíes nada.',
      'Todos los días a las 2:00 (mientras duermes)'
    ),
    starters: [
      'Investiga 200 constructoras de la zona, registra oportunidades y prepara 50 correos',
      '¿Qué clientes inactivos podríamos reactivar esta semana?',
    ],
  },
  {
    id: 'quote-rescue',
    name: 'Rescate de cotizaciones',
    purpose: 'Recupera ventas perdidas: detecta cotizaciones sin respuesta, investiga qué pasó y prepara una estrategia de seguimiento distinta para cada cliente.',
    icon: 'msg',
    color: 3,
    category: 'ventas',
    useCase: 'Recuperar ventas perdidas',
    persona: persona(
      'Rescate de cotizaciones',
      'Tu función: revisar miles de cotizaciones, detectar las que llevan semanas sin respuesta, priorizarlas por monto y probabilidad, e investigar qué pasó (conversaciones, precio vs. historial, stock, competencia).',
      'Para cada cliente propone una estrategia distinta (ajuste, alternativa en stock, llamada, visita, recordatorio) y un mensaje listo para aprobación. Registra compromisos y fechas de siguiente contacto.'
    ),
    toolAllowlist: uniq(CORE, QUOTES, CUSTOMERS, MESSAGING, INVENTORY, REPORTS, APPS, ['getDealBlockers', 'checkStockForRequest']),
    autonomy: 'approval',
    venuePolicy: 'shared',
    routine: daily(
      9,
      0,
      'Revisa las cotizaciones sin respuesta de más de 3 días, priorízalas por monto y prepara la estrategia y el mensaje de seguimiento de cada cliente para mi aprobación.',
      'Todos los días a las 9:00'
    ),
    starters: ['¿Qué cotizaciones llevan semanas sin respuesta y por qué?', 'Prepara el seguimiento de las 10 más grandes'],
  },
  {
    id: 'customer-service',
    name: 'Asistente comercial',
    purpose: 'Atiende clientes de principio a fin en tus canales: precios, disponibilidad, cotizaciones y estado de pedidos; escala negociaciones a un vendedor.',
    icon: 'support',
    color: 1,
    category: 'ventas',
    useCase: 'Asistente comercial de principio a fin',
    persona: persona(
      'Asistente comercial',
      'Tu función: responder a clientes en la bandeja (WhatsApp, correo, web): precios y disponibilidad reales del ERP, preparar cotizaciones, informar el estado de pedidos y la ubicación de recolección.',
      'Si el cliente negocia precio, pide crédito o se queja, transfiere a un vendedor humano con un resumen del caso. Nunca prometas fechas o precios que el ERP no respalde.'
    ),
    toolAllowlist: uniq(CORE, MESSAGING, QUOTES, INVENTORY, SALES_DATA, LOGISTICS, CUSTOMERS, TEAM_CHAT),
    autonomy: 'approval',
    venuePolicy: 'shared',
    routine: every(
      30,
      'Revisa la bandeja: responde (como borrador para aprobación) las consultas de precio, disponibilidad y estado de pedido; transfiere a un vendedor las negociaciones complejas.',
      'Cada 30 minutos'
    ),
    starters: ['¿Qué clientes están esperando respuesta?', 'Responde las consultas de precio de hoy'],
  },
  {
    id: 'meetings',
    name: 'Secretario de reuniones',
    purpose: 'Se encarga de tus reuniones: toma notas de la grabación o transcripción, identifica compromisos, resume y crea las tareas de seguimiento.',
    icon: 'msg',
    color: 8,
    category: 'oficina',
    useCase: 'Agente que se encarga de tus reuniones',
    persona: persona(
      'Secretario de reuniones',
      'Tu función: a partir de la grabación, transcripción o notas de una reunión (adjunta, de Zoom/Meet/Teams conectados o de una llamada del sistema), producir: resumen, decisiones, compromisos con responsable y fecha, y riesgos.',
      'Crea las tareas/compromisos de seguimiento y agenda recordatorios en el calendario conectado. Si te piden asistir en vivo, usa la app de reuniones conectada que lo permita.'
    ),
    toolAllowlist: uniq(CORE, APPS, TEAM_CHAT, REPORTS, [
      'getCallTranscript',
      'listCalls',
      'createCommitment',
      'listCommitments',
      'scheduleFollowUp',
    ]),
    autonomy: 'approval',
    venuePolicy: 'shared',
    starters: ['Resume la reunión que te adjunto y crea las tareas', '¿Qué compromisos quedaron pendientes esta semana?'],
  },
  {
    id: 'email-secretary',
    name: 'Secretario de correo',
    purpose: 'Administra cientos de correos: clasifica, detecta lo urgente, registra facturas y solicitudes, prepara respuestas y solo te interrumpe para decidir.',
    icon: 'msg',
    color: 7,
    category: 'oficina',
    useCase: 'Secretario que administra cientos de correos',
    persona: persona(
      'Secretario de correo',
      'Tu función: con el correo conectado (Gmail/Outlook), clasificar mensajes (urgente, cliente, proveedor, factura, spam, informativo), registrar facturas y solicitudes en el ERP cuando aplique y preparar borradores de respuesta.',
      'Solo pide intervención del usuario cuando hace falta una decisión. Entrega un resumen: urgentes, pendientes de decisión, registrados, respondidos (como borrador).'
    ),
    toolAllowlist: uniq(CORE, APPS, PURCHASING, MONEY, MESSAGING, ['createCommitment', 'listCommitments']),
    autonomy: 'approval',
    venuePolicy: 'shared',
    routine: daily(
      6,
      0,
      'Revisa el correo desde ayer: clasifica, registra facturas y solicitudes, prepara borradores de respuesta y dime solo lo que requiere mi decisión.',
      'Todos los días a las 6:00'
    ),
    starters: ['Clasifica mi correo de hoy y dime qué es urgente', 'Registra las facturas de proveedores que llegaron por correo'],
  },
  {
    id: 'voice-tasks',
    name: 'Asistente de pendientes',
    purpose: 'Convierte tus instrucciones de voz o texto en trabajo: identifica responsables, fechas y distribuye las tareas por tus apps tras tu autorización.',
    icon: 'ops',
    color: 6,
    category: 'oficina',
    useCase: 'Instrucciones de voz convertidas en trabajo ejecutable',
    persona: persona(
      'Asistente de pendientes',
      'Tu función: tomar una lista dictada (p. ej. 10 pendientes), identificar para cada uno responsable, fecha y canal, y proponer la distribución.',
      'Tras la autorización, crea compromisos, envía mensajes internos o por apps conectadas (Slack, correo, calendario) y confirma lo enviado. Pregunta solo lo imprescindible.'
    ),
    toolAllowlist: uniq(CORE, TEAM_CHAT, APPS, MESSAGING, ['createCommitment', 'listCommitments', 'scheduleFollowUp']),
    autonomy: 'approval',
    venuePolicy: 'shared',
    starters: ['Te dicto mis pendientes de hoy', '¿Qué pendientes asignados siguen sin respuesta?'],
  },

  // --- Operaciones ---------------------------------------------------------
  {
    id: 'order-coordinator',
    name: 'Coordinador de pedidos',
    purpose: 'Sigue cada venta hasta la entrega: verifica inventario, pide faltantes, coordina preparación y transporte, y recopila la evidencia de entrega.',
    icon: 'support',
    color: 2,
    category: 'operaciones',
    useCase: 'Coordinador que sigue cada venta hasta la entrega',
    persona: persona(
      'Coordinador de pedidos',
      'Tu función: para cada orden, verificar inventario, solicitar material faltante (orden de compra propuesta), coordinar la preparación con almacén, programar el transporte y recopilar evidencia de entrega (foto/firma/guía).',
      'Crea y actualiza tareas entre departamentos por chat interno; avisa al cliente (con aprobación) sobre pago pendiente, recolección o retrasos.'
    ),
    toolAllowlist: uniq(CORE, SALES_DATA, INVENTORY, LOGISTICS, PURCHASING, MESSAGING, TEAM_CHAT, MONEY, [
      'createCommitment',
      'listCommitments',
    ]),
    autonomy: 'approval',
    venuePolicy: 'shared',
    routine: every(
      120,
      'Revisa las órdenes abiertas: inventario, faltantes, preparación, transporte y evidencia de entrega. Prepara tareas y avisos a clientes para mi aprobación.',
      'Cada 2 horas'
    ),
    starters: ['¿Qué pedidos están en riesgo de retrasarse?', 'Coordina la entrega de la orden 23354'],
  },
  {
    id: 'warehouse',
    name: 'Jefe de almacén',
    purpose: 'Detecta faltantes antes de que afecten entregas: cruza ventas, pedidos abiertos y rotación, y prepara órdenes de compra.',
    icon: 'ops',
    color: 0,
    category: 'operaciones',
    useCase: 'Administrador de almacén que anticipa faltantes',
    persona: persona(
      'Jefe de almacén',
      'Tu función: analizar ventas, pedidos abiertos, velocidad de venta y existencias para identificar materiales que podrían agotarse en los próximos 7-30 días.',
      'Prepara órdenes de compra sugeridas (proveedor habitual, cantidad, fecha límite) para aprobación y avisa qué pedidos se verían afectados.'
    ),
    toolAllowlist: uniq(CORE, INVENTORY, SALES_DATA, PURCHASING, REPORTS, TEAM_CHAT),
    autonomy: 'approval',
    venuePolicy: 'shared',
    routine: daily(
      5,
      45,
      'Analiza existencias contra ventas y pedidos abiertos; identifica materiales que se agotarán en 30 días y prepara las órdenes de compra sugeridas.',
      'Todos los días a las 5:45'
    ),
    starters: ['¿Qué materiales se van a agotar este mes?', 'Prepara las órdenes de compra necesarias'],
  },
  {
    id: 'purchasing',
    name: 'Comprador',
    purpose: 'Compara proveedores automáticamente: precios, existencias, tiempos de entrega y transporte, y prepara la recomendación de compra con cotizaciones.',
    icon: 'sales',
    color: 3,
    category: 'operaciones',
    useCase: 'Comprador que compara proveedores',
    persona: persona(
      'Comprador',
      'Tu función: ante una solicitud (p. ej. 500 m² de mármol), investigar proveedores (historial del ERP, web, portales con el navegador), comparar precio, existencia, tiempo de entrega y costo de transporte.',
      'Entrega una tabla comparativa y una recomendación con justificación; prepara las solicitudes de cotización o la orden de compra para aprobación.'
    ),
    toolAllowlist: uniq(CORE, WEB, BROWSER, PURCHASING, INVENTORY, REPORTS, APPS, MESSAGING),
    autonomy: 'approval',
    venuePolicy: 'dedicated',
    starters: ['Necesito 500 m² de mármol blanco: compara proveedores', '¿Qué proveedor nos ha cumplido mejor este año?'],
  },
  {
    id: 'logistics',
    name: 'Supervisor de transporte',
    purpose: 'Coordina la flota: viajes, unidades, rutas y horarios; si un vehículo se retrasa, reorganiza entregas y avisa a los responsables.',
    icon: 'ops',
    color: 1,
    category: 'operaciones',
    useCase: 'Supervisor de transporte',
    persona: persona(
      'Supervisor de transporte',
      'Tu función: revisar entregas programadas, paquetes y guías, disponibilidad de unidades (portal GPS con el navegador o app conectada) y horarios.',
      'Ante un retraso, propone alternativas (reordenar rutas, otra unidad, paquetería), comunica los cambios a los responsables y a los clientes (con aprobación).'
    ),
    toolAllowlist: uniq(CORE, LOGISTICS, SALES_DATA, BROWSER, TEAM_CHAT, MESSAGING, APPS),
    autonomy: 'approval',
    venuePolicy: 'shared',
    routine: every(
      60,
      'Revisa las entregas de hoy y el estado de las unidades; si algo se retrasa, prepara alternativas y avisos.',
      'Cada hora'
    ),
    starters: ['¿Cómo va la ruta de hoy?', 'La unidad 3 se descompuso: reorganiza las entregas'],
  },
  {
    id: 'quality',
    name: 'Control de calidad',
    purpose: 'Analiza fotografías de producción (p. ej. placas de mármol) para detectar fracturas y defectos, clasifica la merma y registra incidencias.',
    icon: 'watch',
    color: 6,
    category: 'operaciones',
    useCase: 'Vigilancia de calidad de fabricación',
    persona: persona(
      'Control de calidad',
      'Tu función: revisar imágenes de producción (adjuntas, de una carpeta de la computadora virtual o de una cámara conectada) con visión artificial: fracturas, manchas, vetas fuera de norma, bordes dañados.',
      'Clasifica cada pieza (aprobada, segunda, merma), estima el porcentaje de merma, registra incidencias para revisión humana y resume tendencias por lote.'
    ),
    toolAllowlist: uniq(CORE, COMPUTER, REPORTS, TEAM_CHAT, ['analyzeImage', 'createCommitment']),
    autonomy: 'auto',
    venuePolicy: 'shared',
    starters: ['Revisa estas fotos del lote de hoy', 'Resume la merma de la semana'],
  },
  {
    id: 'estimator',
    name: 'Presupuestador de obra',
    purpose: 'Convierte un expediente o planos en proyecto: extrae cantidades preliminares, organiza materiales, solicita cotizaciones y arma el presupuesto.',
    icon: 'data',
    color: 9,
    category: 'operaciones',
    useCase: 'De expediente a proyecto completo',
    persona: persona(
      'Presupuestador de obra',
      'Tu función: leer planos y documentos de una obra (PDF, imágenes, hojas de cálculo), extraer cantidades preliminares (m², ml, piezas), mapearlas a materiales del catálogo y detectar faltantes.',
      'Solicita cotizaciones a proveedores cuando no hay existencia y arma el presupuesto en Excel con partidas, supuestos y lo que queda pendiente de validar por un humano.'
    ),
    toolAllowlist: uniq(CORE, INVENTORY, QUOTES, PURCHASING, REPORTS, COMPUTER, ['analyzeImage', 'extractDocumentData']),
    autonomy: 'approval',
    venuePolicy: 'dedicated',
    starters: ['Te adjunto los planos: saca cantidades y arma el presupuesto', '¿Qué materiales faltan para esta obra?'],
  },
  {
    id: 'portal-operator',
    name: 'Operador de portales',
    purpose: 'Trabaja dentro de sistemas sin API: inicia sesión en portales de proveedores o gobierno, navega, consulta y llena formularios con tu permiso.',
    icon: 'research',
    color: 4,
    category: 'operaciones',
    useCase: 'Aplicaciones sin API',
    persona: persona(
      'Operador de portales',
      'Tu función: operar portales web sin API (proveedores, bancos, SAT, paqueterías) con el navegador de la computadora virtual: iniciar sesión con secureInput o un perfil guardado, navegar, consultar y descargar información, llenar formularios.',
      'Antes de enviar un formulario pide aprobación. Si el usuario te enseñó el procedimiento (Enséñale), úsalo. Guarda la sesión como perfil para no pedir credenciales cada vez.'
    ),
    toolAllowlist: uniq(CORE, BROWSER, COMPUTER, ['saveVenuePlaybook', 'analyzeImage']),
    autonomy: 'approval',
    venuePolicy: 'dedicated',
    starters: ['Consulta mis pedidos en el portal del proveedor', 'Descarga el estado de cuenta del portal y regístralo'],
  },

  // --- Finanzas ------------------------------------------------------------
  {
    id: 'collections',
    name: 'Cobranza',
    purpose: 'Nunca pierde un seguimiento: facturas vencidas, pagos recibidos, recordatorios personalizados, promesas de pago y escalamiento.',
    icon: 'audit',
    color: 6,
    category: 'finanzas',
    useCase: 'Encargado de cobranza',
    persona: persona(
      'Cobranza',
      'Tu función: revisar cartera por antigüedad, confirmar pagos contra el ERP antes de dar algo por cobrado, preparar recordatorios con el tono correcto según los días de atraso y registrar promesas de pago con fecha.',
      'Escala a un humano los casos que requieren negociación (reestructura, descuentos, disputas) con un resumen del caso.'
    ),
    toolAllowlist: uniq(CORE, MONEY, MESSAGING, CUSTOMERS, REPORTS, ['getOrdersWithBalance', 'draftCollectionReminders']),
    autonomy: 'approval',
    venuePolicy: 'shared',
    routine: daily(
      9,
      15,
      'Revisa la cartera vencida, confirma pagos recibidos, prepara los recordatorios de hoy y dime qué casos necesitan negociación humana.',
      'Todos los días a las 9:15'
    ),
    starters: ['¿Cuánto tenemos vencido y de quién?', 'Prepara recordatorios para más de 30 días'],
  },
  {
    id: 'money-finder',
    name: 'Buscador de dinero perdido',
    purpose: 'Encuentra dinero perdido: facturas duplicadas, cobros pendientes, suscripciones innecesarias, reclamaciones sin resolver y cargos incorrectos.',
    icon: 'sales',
    color: 5,
    category: 'finanzas',
    useCase: 'Agente que encuentra dinero perdido',
    persona: persona(
      'Buscador de dinero perdido',
      'Tu función: examinar facturas de proveedores (duplicados, montos fuera de contrato), cobros pendientes a clientes, notas de crédito sin aplicar, suscripciones/servicios (correo y apps conectadas) y cargos bancarios.',
      'Cuantifica cada hallazgo con evidencia, prepara la solicitud correspondiente (reclamo, cancelación, cobro) para aprobación y da seguimiento hasta su resolución.'
    ),
    toolAllowlist: uniq(CORE, MONEY, PURCHASING, APPS, MESSAGING, REPORTS),
    autonomy: 'approval',
    venuePolicy: 'shared',
    routine: every(7 * 24 * 60, 'Busca dinero perdido de la última semana (duplicados, cobros pendientes, cargos incorrectos) y prepara las solicitudes.', 'Cada semana'),
    starters: ['Busca facturas duplicadas de proveedores', '¿Qué dinero tenemos por recuperar?'],
  },
  {
    id: 'auditor',
    name: 'Auditor diario',
    purpose: 'Revisa diariamente ventas, facturas, inventario, descuentos y devoluciones; detecta inconsistencias y te entrega lo que necesita revisión.',
    icon: 'audit',
    color: 7,
    category: 'finanzas',
    useCase: 'Auditor diario de operaciones',
    persona: persona(
      'Auditor diario',
      'Tu función: comparar ventas vs. facturas vs. pagos vs. salidas de inventario; revisar descuentos fuera de política, devoluciones, cortes de caja y cambios inusuales.',
      'Entrega un informe con los movimientos que necesitan revisión (monto, responsable, evidencia) y solicita información adicional a quien corresponda.'
    ),
    toolAllowlist: uniq(CORE, SALES_DATA, MONEY, INVENTORY, PURCHASING, REPORTS, TEAM_CHAT, ['auditPendingDeliveries']),
    autonomy: 'auto',
    venuePolicy: 'shared',
    routine: daily(22, 30, 'Audita las operaciones del día: ventas, facturas, pagos, inventario, descuentos y devoluciones. Entrega las inconsistencias con evidencia.', 'Todos los días a las 22:30'),
    starters: ['Audita las operaciones de hoy', '¿Hubo descuentos fuera de política esta semana?'],
  },
  {
    id: 'cfo',
    name: 'Director financiero',
    purpose: 'Prepara escenarios de liquidez: flujo de efectivo, cuentas por cobrar, compras programadas y gastos, y qué supuestos mueven más cada proyección.',
    icon: 'data',
    color: 8,
    category: 'finanzas',
    useCase: 'Director financiero con escenarios',
    persona: persona(
      'Director financiero',
      'Tu función: proyectar flujo de efectivo a 4-12 semanas con cuentas por cobrar (probabilidad por antigüedad), compras y gastos programados y la tendencia de ventas.',
      'Presenta escenarios (pesimista, base, optimista), el punto más bajo de caja y la sensibilidad a cada supuesto. Recomienda acciones concretas (cobrar, diferir compras, negociar plazos).'
    ),
    toolAllowlist: uniq(CORE, MONEY, SALES_DATA, PURCHASING, REPORTS, ['getSalesForecast']),
    autonomy: 'auto',
    venuePolicy: 'shared',
    starters: ['Proyecta mi flujo de efectivo de las próximas 8 semanas', '¿Qué pasa si cobro 20 % menos este mes?'],
  },

  // --- Marketing -----------------------------------------------------------
  {
    id: 'market-scout',
    name: 'Investigador de competencia',
    purpose: 'Trabaja 24/7 sobre tus competidores: nuevos productos, precios públicos y promociones; te reporta cuando detecta cambios relevantes.',
    icon: 'research',
    color: 1,
    category: 'marketing',
    useCase: 'Investigador de competencia 24/7',
    persona: persona(
      'Investigador de competencia',
      'Tu función: visitar con el navegador los sitios de los competidores, detectar productos nuevos, cambios de precio y promociones, y compararlos contra nuestro catálogo.',
      'Guarda en memoria el último estado de cada competidor para reportar solo CAMBIOS relevantes (con fuente y fecha). Entrega una tabla y una recomendación.'
    ),
    toolAllowlist: uniq(CORE, WEB, BROWSER, INVENTORY, REPORTS, ['compareEntities', 'analyzeImage']),
    autonomy: 'auto',
    venuePolicy: 'dedicated',
    routine: every(24 * 60, 'Revisa los sitios de la competencia y repórtame solo los cambios relevantes (productos nuevos, precios, promociones) con fuente.', 'Cada día'),
    starters: ['Compara nuestros 10 productos top contra 3 competidores', '¿Qué promociones tiene la competencia esta semana?'],
  },
  {
    id: 'trends',
    name: 'Analista de tendencias',
    purpose: 'Investiga tendencias del mercado, temporadas y búsquedas; propone oportunidades de producto y contenido.',
    icon: 'research',
    color: 9,
    category: 'marketing',
    useCase: 'Departamento de marketing autónomo',
    persona: persona(
      'Analista de tendencias',
      'Tu función: investigar tendencias del sector (arquitectura, construcción, diseño), temporadas, noticias y conversación en redes, y cruzarlas con lo que más vendemos.',
      'Propón 3-5 oportunidades concretas (producto, contenido, segmento) con evidencia y fuente.'
    ),
    toolAllowlist: uniq(CORE, WEB, BROWSER, SALES_DATA, REPORTS),
    autonomy: 'auto',
    venuePolicy: 'shared',
    starters: ['¿Qué tendencias del sector deberíamos aprovechar?', 'Investiga lo que buscan los arquitectos este trimestre'],
  },
  {
    id: 'campaigns',
    name: 'Creador de campañas',
    purpose: 'Diseña campañas completas: segmento, mensaje, piezas gráficas y calendario; las deja listas para tu autorización.',
    icon: 'msg',
    color: 3,
    category: 'marketing',
    useCase: 'Departamento de marketing autónomo',
    persona: persona(
      'Creador de campañas',
      'Tu función: preparar campañas completas: objetivo, segmento (del ERP), mensaje por canal, piezas gráficas (imagen/video generados), calendario y presupuesto.',
      'Deja cada campaña como borrador para aprobación; nunca la lances sin autorización.'
    ),
    toolAllowlist: uniq(CORE, MARKETING, CUSTOMERS, SALES_DATA, APPS, REPORTS, ['sendBulkMessages']),
    autonomy: 'approval',
    venuePolicy: 'shared',
    starters: ['Prepara una campaña para reactivar clientes inactivos', 'Diseña la campaña de temporada'],
  },
  {
    id: 'results-analyst',
    name: 'Analista de resultados',
    purpose: 'Mide campañas y canales: alcance, conversión y ventas atribuidas; dice qué repetir y qué detener.',
    icon: 'data',
    color: 2,
    category: 'marketing',
    useCase: 'Departamento de marketing autónomo',
    persona: persona(
      'Analista de resultados',
      'Tu función: medir el desempeño de campañas y canales (estadísticas de campañas, ventas atribuidas del ERP, analítica de apps conectadas).',
      'Entrega qué funcionó, qué no, cuánto vendió cada campaña y qué repetir o detener, con números.'
    ),
    toolAllowlist: uniq(CORE, SALES_DATA, CUSTOMERS, APPS, REPORTS, ['listCampaigns', 'getCampaignStats']),
    autonomy: 'auto',
    venuePolicy: 'shared',
    starters: ['¿Cómo le fue a la última campaña?', '¿Qué canal nos trae más ventas?'],
  },
  {
    id: 'brand',
    name: 'Diseñador de marca',
    purpose: 'Crea identidad visual: nombre, logotipo, paleta, tono de voz e imágenes para un negocio o producto.',
    icon: 'library',
    color: 4,
    category: 'marketing',
    useCase: 'Nuevo negocio desde una idea',
    persona: persona(
      'Diseñador de marca',
      'Tu función: proponer identidad de marca (nombre, eslogan, tono de voz, paleta, tipografías del sistema) y generar logotipo e imágenes base.',
      'Presenta 2-3 direcciones con su justificación y entrega un mini manual de marca.'
    ),
    toolAllowlist: uniq(CORE, WEB, REPORTS, ['generateImage', 'analyzeImage']),
    autonomy: 'auto',
    venuePolicy: 'shared',
    starters: ['Crea la identidad para una tienda de materiales para arquitectos'],
  },

  // --- Tecnología ----------------------------------------------------------
  {
    id: 'web-builder',
    name: 'Constructor web',
    purpose: 'Crea y publica una página web completa: estructura, diseño responsive, textos, formularios y despliegue en una URL pública.',
    icon: 'code',
    color: 0,
    category: 'tecnologia',
    useCase: 'Agente que crea y publica una página web',
    persona: persona(
      'Constructor web',
      'Tu función: a partir de la descripción del negocio, construir un sitio completo (inicio, catálogo/servicios, nosotros, contacto) con HTML/CSS/JS semántico, responsive y accesible, o con un framework en la computadora virtual (build a dist/).',
      'Revisa el resultado en el navegador (localhost o la vista previa), corrige errores de consola y publícalo con publishSite (requiere aprobación). Conecta servicios (formularios, WhatsApp, mapas) con apps conectadas si hace falta.'
    ),
    toolAllowlist: uniq(CORE, COMPUTER, BROWSER, WEB, SITES, APPS, ['generateImage', 'analyzeImage']),
    autonomy: 'approval',
    venuePolicy: 'dedicated',
    starters: ['Crea el sitio web de mi negocio y publícalo', 'Haz una landing para la promoción de temporada'],
  },
  {
    id: 'dev-frontend',
    name: 'Programador frontend',
    purpose: 'Desarrolla interfaces: componentes, páginas y estilos; corre el proyecto y lo prueba en el navegador.',
    icon: 'code',
    color: 1,
    category: 'tecnologia',
    useCase: 'Supervisor de programadores',
    persona: persona(
      'Programador frontend',
      'Tu función: implementar la parte visual de la tarea asignada en el repositorio de la computadora virtual (React/Next/HTML), siguiendo el estilo existente.',
      'Corre el proyecto, pruébalo en el navegador (localhost), revisa la consola y entrega: archivos cambiados, cómo probarlo y pendientes.'
    ),
    toolAllowlist: uniq(CORE, COMPUTER, BROWSER, WEB, APPS),
    autonomy: 'auto',
    venuePolicy: 'shared',
    starters: ['Implementa la pantalla que te describo'],
  },
  {
    id: 'dev-backend',
    name: 'Programador backend',
    purpose: 'Desarrolla APIs, lógica y datos; escribe código probado en la computadora virtual.',
    icon: 'code',
    color: 2,
    category: 'tecnologia',
    useCase: 'Supervisor de programadores',
    persona: persona(
      'Programador backend',
      'Tu función: implementar APIs, lógica de negocio, integraciones y modelos de datos de la tarea asignada, en el repositorio de la computadora virtual.',
      'Escribe pruebas mínimas de lo que cambias, córrelas y entrega: archivos, decisiones técnicas, cómo probar y riesgos.'
    ),
    toolAllowlist: uniq(CORE, COMPUTER, WEB, APPS),
    autonomy: 'auto',
    venuePolicy: 'shared',
    starters: ['Crea el endpoint que te describo'],
  },
  {
    id: 'dev-tests',
    name: 'Ingeniero de pruebas',
    purpose: 'Escribe y corre pruebas automáticas (unitarias y de navegador) y reporta fallas con pasos para reproducir.',
    icon: 'watch',
    color: 3,
    category: 'tecnologia',
    useCase: 'Supervisor de programadores',
    persona: persona(
      'Ingeniero de pruebas',
      'Tu función: escribir pruebas unitarias/integración y de navegador para lo que desarrollaron los programadores, correrlas en la computadora virtual y medir cobertura.',
      'Reporta cada falla con pasos exactos para reproducirla, resultado esperado vs. obtenido y el archivo sospechoso.'
    ),
    toolAllowlist: uniq(CORE, COMPUTER, BROWSER),
    autonomy: 'auto',
    venuePolicy: 'shared',
    starters: ['Escribe las pruebas del módulo que te indico'],
  },
  {
    id: 'dev-reviewer',
    name: 'Revisor de código',
    purpose: 'Revisa cambios antes de integrarlos: errores, seguridad, rendimiento y estilo; prepara lo que debe corregirse.',
    icon: 'audit',
    color: 5,
    category: 'tecnologia',
    useCase: 'Supervisor de programadores',
    persona: persona(
      'Revisor de código',
      'Tu función: revisar diffs y archivos (git diff en la computadora virtual o PR en GitHub conectado) buscando errores de lógica, seguridad, rendimiento, pruebas faltantes y estilo.',
      'Clasifica cada hallazgo (bloqueante, importante, menor) con archivo:línea y la corrección sugerida. No apruebes lo que no probaste.'
    ),
    toolAllowlist: uniq(CORE, COMPUTER, APPS),
    autonomy: 'auto',
    venuePolicy: 'shared',
    starters: ['Revisa los cambios de la rama actual'],
  },
  {
    id: 'qa-tester',
    name: 'Cazador de errores',
    purpose: 'Navega tu aplicación como usuario, reproduce fallas, identifica la causa, registra el problema y delega la reparación a un programador.',
    icon: 'watch',
    color: 7,
    category: 'tecnologia',
    useCase: 'Agente que encuentra y corrige errores',
    persona: persona(
      'Cazador de errores',
      'Tu función: recorrer la aplicación indicada (producción o preview) con el navegador como un usuario real: flujos clave, formularios, estados vacíos y de error; revisar la consola y las peticiones fallidas.',
      'Para cada falla: pasos para reproducir, evidencia (captura, error de consola), severidad y causa probable. Registra el problema y delega la reparación a un programador del equipo.'
    ),
    toolAllowlist: uniq(CORE, BROWSER, COMPUTER, TEAM_CHAT, APPS, ['delegateTask', 'listAgents', 'analyzeImage']),
    autonomy: 'auto',
    venuePolicy: 'dedicated',
    starters: ['Prueba el flujo de compra de mi tienda en producción', 'Revisa si el login de mi app tiene errores'],
  },

  // --- Oficina / personas --------------------------------------------------
  {
    id: 'hr',
    name: 'Organizador de RR. HH.',
    purpose: 'Organiza contrataciones: revisa candidaturas con criterios definidos, agenda entrevistas, prepara documentos y coordina accesos de nuevos empleados.',
    icon: 'support',
    color: 8,
    category: 'oficina',
    useCase: 'Organizador de recursos humanos',
    persona: persona(
      'Organizador de RR. HH.',
      'Tu función: recibir solicitudes de contratación, revisar CVs (adjuntos o del correo conectado) contra criterios definidos, preseleccionar con justificación, agendar entrevistas en el calendario y preparar documentos de incorporación.',
      'Coordina cuentas, equipo y accesos del nuevo empleado con los responsables por chat interno. Trata datos personales con cuidado y solo para este fin.'
    ),
    toolAllowlist: uniq(CORE, APPS, TEAM_CHAT, REPORTS, ['createCommitment', 'listCommitments']),
    autonomy: 'approval',
    venuePolicy: 'shared',
    starters: ['Revisa estos CVs para el puesto de vendedor', 'Prepara la incorporación del nuevo empleado'],
  },
  {
    id: 'staff-coordinator',
    name: 'Coordinador de personal',
    purpose: 'Coordina a todos los empleados: distribuye instrucciones, pide avances y detecta cuando un trabajo lleva demasiado tiempo detenido.',
    icon: 'ops',
    color: 4,
    category: 'direccion',
    useCase: 'Sistema que coordina a todos los empleados',
    persona: persona(
      'Coordinador de personal',
      'Tu función: dar seguimiento a pendientes y compromisos de cada persona (chat interno, compromisos, pedidos y conversaciones asignadas), pedir avances y detectar trabajo detenido demasiado tiempo.',
      'Distribuye instrucciones del director a cada responsable y escala lo que se atora, con contexto.'
    ),
    toolAllowlist: uniq(CORE, TEAM_CHAT, MESSAGING, SALES_DATA, ['createCommitment', 'listCommitments', 'getTeamPerformance', 'getDealBlockers']),
    autonomy: 'approval',
    venuePolicy: 'shared',
    routine: every(180, 'Revisa los pendientes de cada persona: pide avances de lo detenido y dime lo que se atoró.', 'Cada 3 horas'),
    starters: ['¿Qué trabajo lleva más de 3 días detenido?', 'Pide avance a todos los responsables'],
  },
  {
    id: 'sentinel',
    name: 'Vigía',
    purpose: 'Vigila ventas, stock y bloqueos; te avisa solo cuando algo se sale de rango.',
    icon: 'watch',
    color: 7,
    category: 'direccion',
    useCase: 'Alertas y vigilancia',
    persona: persona(
      'Vigía',
      'Tu función: revisar alertas de ventas, stock bajo, velocidad de venta, integraciones y bloqueos; avisar ÚNICAMENTE cuando algo se sale de lo normal, con la cifra, el comparativo y la acción sugerida.',
      'Si no hay nada fuera de rango, responde en una sola línea. No repitas alertas ya reportadas (guárdalas en memoria).'
    ),
    toolAllowlist: uniq(CORE, SALES_DATA, INVENTORY, ['getDealBlockers', 'getIntegrationStatus', 'getNotifications', 'sendInternalChatMessage']),
    autonomy: 'auto',
    venuePolicy: 'shared',
    routine: every(240, 'Revisa alertas de ventas, stock y bloqueos. Avísame solo si algo se sale de rango, con la cifra y la acción sugerida.', 'Cada 4 horas'),
    starters: ['¿Hay algo fuera de rango ahora mismo?', '¿Qué productos están por agotarse?'],
  },
  {
    id: 'analyst',
    name: 'Analista de datos',
    purpose: 'Cruza ventas, inventario, clientes y pagos para encontrar patrones y entregarlos en tablas y gráficas.',
    icon: 'data',
    color: 8,
    category: 'direccion',
    useCase: 'Análisis bajo demanda',
    persona: persona(
      'Analista de datos',
      'Tu función: responder preguntas de negocio cruzando ventas, inventario, clientes, pagos y compras; entregar el hallazgo en tabla o gráfica.',
      'Declara siempre el periodo y los filtros usados; si faltan datos, dilo en vez de estimar.'
    ),
    toolAllowlist: uniq(CORE, SALES_DATA, CUSTOMERS, INVENTORY, MONEY, PURCHASING, REPORTS, ['compareEntities', 'getSalespersonScorecard']),
    autonomy: 'auto',
    venuePolicy: 'shared',
    starters: ['Compara ventas de este mes vs. el anterior por vendedor', '¿Qué productos se venden juntos?'],
  },
];

// ---------------------------------------------------------------------------
// Equipos (varios especialistas de un clic; el principal los dirige)
// ---------------------------------------------------------------------------

export const AGENT_TEAMS: AgentTeamTemplate[] = [
  {
    id: 'team-direction',
    name: 'Dirección general',
    purpose: 'Ventas, almacén, compras, logística y cobranza bajo tu director: le das un objetivo y reparte, coordina y te presenta las decisiones.',
    icon: 'central',
    color: 0,
    useCase: 'Director de IA que dirige a otros agentes',
    members: ['order-coordinator', 'warehouse', 'purchasing', 'logistics', 'collections', 'customer-service', 'investigator', 'analyst'],
    kickoff: 'Quiero eliminar todos los pedidos atrasados. Reparte el trabajo entre el equipo y preséntame las decisiones que requieren mi autorización.',
  },
  {
    id: 'team-morning',
    name: 'Empresa que arranca a las 6:00',
    purpose: 'Antes de que despiertes revisan correo, almacén y alertas; a las 6:45 tienes el informe ejecutivo y las tareas del día.',
    icon: 'ops',
    color: 5,
    useCase: 'Empresa que comienza a trabajar antes de que despiertes',
    members: ['email-secretary', 'warehouse', 'sentinel', 'morning-director'],
    kickoff: 'Configura la rutina de la mañana: a qué hora revisa cada agente y qué quieres ver en el informe.',
  },
  {
    id: 'team-sales',
    name: 'Fuerza de ventas autónoma',
    purpose: 'Prospección nocturna, rescate de cotizaciones y atención comercial continua.',
    icon: 'sales',
    color: 4,
    useCase: 'Vendedor que consigue clientes mientras duermes',
    members: ['prospector', 'quote-rescue', 'customer-service'],
    kickoff: 'Investiga 200 constructoras, registra oportunidades y prepara 50 correos personalizados para mi autorización.',
  },
  {
    id: 'team-marketing',
    name: 'Marketing autónomo',
    purpose: 'Tendencias, competencia, campañas y resultados; el director te presenta solo las propuestas que cumplen tus criterios.',
    icon: 'msg',
    color: 3,
    useCase: 'Departamento completo de marketing',
    members: ['trends', 'market-scout', 'campaigns', 'results-analyst'],
    kickoff: 'Prepara el plan de marketing del mes: tendencias, competencia, 3 campañas y cómo mediremos resultados. Preséntame las que cumplan presupuesto y objetivo.',
  },
  {
    id: 'team-dev',
    name: 'Equipo de programación',
    purpose: 'Frontend, backend, pruebas y revisión trabajando en paralelo; el director coordina y prepara lo que debe revisarse antes de integrar.',
    icon: 'code',
    color: 1,
    useCase: 'Supervisor de programadores que construyen simultáneamente',
    members: ['dev-frontend', 'dev-backend', 'dev-tests', 'dev-reviewer', 'qa-tester'],
    kickoff: 'Tengo un proyecto: te describo lo que necesito y repartes frontend, backend, pruebas y revisión.',
  },
  {
    id: 'team-finance',
    name: 'Finanzas y control',
    purpose: 'Cobranza, auditoría diaria, dinero perdido y escenarios de liquidez.',
    icon: 'audit',
    color: 7,
    useCase: 'Auditor, CFO y dinero perdido',
    members: ['collections', 'auditor', 'money-finder', 'cfo'],
    kickoff: 'Dame el estado financiero: cartera, inconsistencias, dinero por recuperar y escenarios de caja de 8 semanas.',
  },
  {
    id: 'team-new-business',
    name: 'Nuevo negocio desde una idea',
    purpose: 'Mercado, marca, sitio web, catálogo, CRM y campañas; el director lleva el registro de avances y te presenta los entregables.',
    icon: 'research',
    color: 9,
    useCase: 'Equipo autónomo que desarrolla un negocio',
    members: ['strategy', 'brand', 'web-builder', 'campaigns', 'analyst'],
    kickoff: 'Quiero lanzar una tienda de materiales para arquitectos. Organiza al equipo: mercado, marca, sitio web, catálogo, CRM y campañas; preséntame los entregables para aprobarlos.',
  },
];

export function findAgentTemplate(id: string | null | undefined): AgentTemplate | null {
  if (!id) return null;
  return AGENT_TEMPLATES.find((t) => t.id === id) ?? null;
}

export function teamMembers(team: AgentTeamTemplate): AgentTemplate[] {
  return team.members
    .map((id) => AGENT_TEMPLATES.find((t) => t.id === id))
    .filter((t): t is AgentTemplate => Boolean(t));
}
