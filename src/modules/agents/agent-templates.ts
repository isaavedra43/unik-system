import type { TriggerAction, TriggerSpec } from './trigger-service';

/**
 * Plantillas de agentes UNIVERSO — los casos de uso del brief (director
 * matutino, vendedor autónomo, rescate de cotizaciones, coordinador de
 * pedidos, investigador de competencia…) listos para crear con un clic.
 *
 * Datos puros: este módulo se importa desde el cliente (NewAgentSheet,
 * AssistantChat) y desde el server. Nada aquí toca Prisma ni servicios.
 *
 * - `toolAllowlist` solo ACOTA el menú del dueño (ver ai-orchestrator): un
 *   agente nunca gana tools que el usuario no tiene. Vacío = todas.
 * - `autonomy`: 'auto' corre lecturas/borradores solo; 'approval' pide
 *   confirmación para todo lo que tenga efecto (mensajes, cambios).
 * - `routine`: trigger `time` que se crea junto al agente si el usuario lo
 *   deja activado en el formulario. `tz` fija la hora local del negocio.
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

export interface AgentTemplate {
  id: string;
  name: string;
  /** ≤ 200 caracteres (el servidor recorta). */
  purpose: string;
  /** Clave de AGENT_ICONS. */
  icon: string;
  /** Índice de la paleta (--agent-hue-N). */
  color: number;
  /** Caso de uso del brief al que responde. */
  useCase: string;
  persona: string;
  toolAllowlist: string[];
  autonomy: AgentAutonomy;
  venuePolicy: AgentVenuePolicy;
  routine?: AgentRoutine;
  /** Primeros mensajes sugeridos una vez creado. */
  starters: string[];
}

export const BUSINESS_TZ = 'America/Mexico_City';

/** Tools que cualquier especialista necesita para orientarse y reportar. */
const CORE_TOOLS = [
  'getCurrentUserContext',
  'getSystemTime',
  'universalSearch',
  'rememberForUser',
  'listUserMemory',
  'proposePlan',
  'loadMoreTools',
  'renderInteractiveUi',
  'renderView',
  'generateTable',
  'readAttachment',
  'listConversationAttachments',
  'searchKnowledgeLibrary',
];

const WEB_TOOLS = ['web_search', 'web_research', 'web_crawl', 'fetch_url'];

const VENUE_TOOLS = [
  'browser',
  'browserProfile',
  'venueScreenshot',
  'venueExec',
  'venueListFiles',
  'venueReadFile',
  'venueWriteFile',
];

const REPORT_TOOLS = [
  'generatePdfReport',
  'generateExcelReport',
  'generateCsvExport',
  'generateChart',
  'generateReportImage',
  'listArtifacts',
];

const SALES_READ_TOOLS = [
  'getDashboardSummary',
  'getSalesOrdersSummary',
  'getCashSales',
  'getDailyRevenue',
  'getRevenueAnalysis',
  'getSalesKPIs',
  'comparePeriods',
  'getSalesTrend',
  'getTopProducts',
  'getTopCustomers',
  'getSalesBySalesperson',
  'getSalesByLocation',
  'getSalesByStatus',
  'getSalesByPaymentMethod',
  'getSalesAlerts',
  'getSalesVelocity',
  'getSalesForecast',
  'querySalesOrders',
  'searchSalesOrders',
  'getSalesOrderDetail',
  'getOrdersWithBalance',
];

const MESSAGING_TOOLS = [
  'listInboxConversations',
  'getConversationMessages',
  'draftReply',
  'sendInboxMessage',
  'sendMessageToContact',
  'scheduleFollowUp',
  'createCommitment',
  'listCommitments',
  'addInboxNote',
  'updateInboxConversation',
  'listAttachableDocuments',
  'findShareableDocument',
  'shareArtifact',
];

const STYLE_RULES =
  'Escribe breve y accionable: primero el resultado, luego una lista corta solo si aporta. ' +
  'Nunca inventes datos ni digas que ejecutaste algo que no ejecutaste. ' +
  'Cuando una acción tenga efecto externo (mensajes, cambios, envíos) prepárala y pide aprobación en vez de improvisar.';

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'morning-director',
    name: 'Director matutino',
    purpose:
      'Te entrega cada mañana el briefing del negocio: ventas, efectivo, cobranza, stock y bloqueos.',
    icon: 'ops',
    color: 5,
    useCase: 'Caso 1 · Director matutino',
    persona: [
      'Eres «Director matutino», el especialista de UNIVERSO que abre el día del dueño.',
      'Tu función: preparar un briefing de máximo 8 líneas con ventas de ayer vs. la semana pasada, efectivo del día, cobranza vencida, stock bajo y pedidos bloqueados; cierra siempre con las 3 decisiones que el dueño debe tomar hoy.',
      'Usa cifras reales del ERP (nunca estimaciones sin decirlo) y una tarjeta o gráfica cuando ayude a ver la tendencia.',
      STYLE_RULES,
    ].join(' '),
    toolAllowlist: [
      ...CORE_TOOLS,
      ...SALES_READ_TOOLS,
      ...REPORT_TOOLS,
      'getAccountsReceivable',
      'getBalanceAging',
      'getLowStockAlerts',
      'getStockMovement',
      'getDealBlockers',
      'getWorkDigest',
      'getRecentActivity',
      'getTeamPerformance',
      'getHourlySalesPattern',
      'getWeekdaySalesPattern',
      'auditPendingDeliveries',
      'getCashCloseReconciliation',
      'notifyUser',
    ],
    autonomy: 'auto',
    venuePolicy: 'shared',
    routine: {
      type: 'time',
      spec: { atHour: 7, atMinute: 30, tz: BUSINESS_TZ },
      action: {
        kind: 'run',
        goal: 'Prepara el briefing matutino: ventas de ayer vs. la semana pasada, efectivo, cobranza vencida, stock bajo y pedidos bloqueados. Máximo 8 líneas más una tarjeta; termina con las 3 decisiones que debo tomar hoy.',
      },
      label: 'Todos los días a las 7:30',
    },
    starters: [
      'Dame el briefing de hoy',
      '¿Qué cambió respecto a la semana pasada?',
      '¿Qué pedidos están bloqueados y por qué?',
    ],
  },
  {
    id: 'prospector',
    name: 'Vendedor autónomo',
    purpose:
      'Busca prospectos en internet, los investiga y redacta el primer contacto para tu aprobación.',
    icon: 'sales',
    color: 4,
    useCase: 'Caso 2 · Vendedor autónomo',
    persona: [
      'Eres «Vendedor autónomo», el especialista de prospección de UNIVERSO.',
      'Tu función: encontrar prospectos que encajen con el catálogo del negocio, verificar su sitio y redes con el navegador, calificarlos (giro, tamaño, señal de necesidad) y redactar el primer mensaje personalizado.',
      'Nunca envías nada sin aprobación: dejas cada contacto listo con nombre, canal, mensaje y por qué encaja. Registra en memoria los prospectos ya contactados para no repetirlos.',
      STYLE_RULES,
    ].join(' '),
    toolAllowlist: [
      ...CORE_TOOLS,
      ...WEB_TOOLS,
      ...VENUE_TOOLS,
      ...MESSAGING_TOOLS,
      'queryContacts',
      'getContactDetail',
      'getContactFile',
      'findDuplicateContacts',
      'getProductCatalog',
      'getProductSearch',
      'queryProducts',
      'getProductDetail',
      'getCustomerPriceHistory',
      'findReactivationOpportunities',
      'draftQuoteFromRequest',
      'previewQuote',
      'generateExcelReport',
    ],
    autonomy: 'approval',
    venuePolicy: 'dedicated',
    routine: {
      type: 'time',
      spec: { atHour: 8, atMinute: 45, tz: BUSINESS_TZ },
      action: {
        kind: 'run',
        goal: 'Busca 5 prospectos nuevos que encajen con nuestros productos, verifica su sitio web y redacta el primer mensaje para cada uno. No envíes nada: déjalos listos para mi aprobación.',
      },
      label: 'Todos los días a las 8:45',
    },
    starters: [
      'Busca 5 prospectos para nuestro producto estrella y prepara el primer mensaje',
      'Abre el sitio de este prospecto y dime si vale la pena contactarlo',
      '¿Qué clientes inactivos podríamos reactivar esta semana?',
    ],
  },
  {
    id: 'quote-rescue',
    name: 'Rescate de cotizaciones',
    purpose:
      'Detecta cotizaciones sin respuesta, prioriza por monto y prepara el seguimiento con cada cliente.',
    icon: 'msg',
    color: 3,
    useCase: 'Caso 3 · Rescate de cotizaciones',
    persona: [
      'Eres «Rescate de cotizaciones», el especialista de UNIVERSO que evita que las cotizaciones se enfríen.',
      'Tu función: revisar las cotizaciones abiertas, detectar las que llevan más de 3 días sin respuesta, priorizarlas por monto y probabilidad, y preparar un seguimiento por cliente (mensaje corto, argumento y, si aplica, ajuste o alternativa en stock).',
      'Los mensajes se envían solo con aprobación. Registra compromisos y fechas de siguiente contacto.',
      STYLE_RULES,
    ].join(' '),
    toolAllowlist: [
      ...CORE_TOOLS,
      ...MESSAGING_TOOLS,
      'queryQuotes',
      'getQuoteDetail',
      'getQuotePdf',
      'previewQuote',
      'updateQuote',
      'sendQuoteToContact',
      'findSimilarPastQuotes',
      'checkStockForRequest',
      'searchQuoteCustomers',
      'searchQuoteProducts',
      'getCustomerPriceHistory',
      'getCustomerDetails',
      'getCustomerHealth',
      'getDealBlockers',
      'generateExcelReport',
    ],
    autonomy: 'approval',
    venuePolicy: 'shared',
    routine: {
      type: 'time',
      spec: { atHour: 9, atMinute: 0, tz: BUSINESS_TZ },
      action: {
        kind: 'run',
        goal: 'Revisa las cotizaciones sin respuesta de más de 3 días, priorízalas por monto y prepara un seguimiento por cliente listo para mi aprobación.',
      },
      label: 'Todos los días a las 9:00',
    },
    starters: [
      '¿Qué cotizaciones llevan más de 3 días sin respuesta?',
      'Prepara el seguimiento de las 5 cotizaciones más grandes',
      '¿Qué cotización tiene más probabilidad de cerrar esta semana?',
    ],
  },
  {
    id: 'order-coordinator',
    name: 'Coordinador de pedidos',
    purpose:
      'Sigue pedidos con saldo o entrega pendiente y avisa a clientes sobre pago, recolección y retrasos.',
    icon: 'support',
    color: 2,
    useCase: 'Caso 4 · Coordinador de pedidos',
    persona: [
      'Eres «Coordinador de pedidos», el especialista de UNIVERSO que mantiene cada pedido en movimiento.',
      'Tu función: detectar pedidos con saldo pendiente, entrega atrasada o sin confirmación, y preparar el aviso correcto para cada cliente (pago pendiente, listo para recolección, retraso con nueva fecha).',
      'Confirma pagos contra el ERP antes de decir que algo está pagado. Los mensajes salen solo con aprobación; deja constancia en la conversación del cliente.',
      STYLE_RULES,
    ].join(' '),
    toolAllowlist: [
      ...CORE_TOOLS,
      ...MESSAGING_TOOLS,
      'querySalesOrders',
      'searchSalesOrders',
      'lookupSalesOrdersByNumber',
      'getSalesOrderDetail',
      'getSalesOrderFullFile',
      'getOrderItems',
      'getOrdersWithBalance',
      'getSalesByStatus',
      'auditPendingDeliveries',
      'notifyDelayedDeliveries',
      'queryPayments',
      'getPaymentDetail',
      'queryInvoices',
      'getInvoiceDetail',
      'queryPackages',
      'getPackageDetail',
      'getPickupLocation',
      'getCustomerDetails',
      'notifyUser',
    ],
    autonomy: 'approval',
    venuePolicy: 'shared',
    routine: {
      type: 'time',
      spec: { everyMinutes: 120, tz: BUSINESS_TZ },
      action: {
        kind: 'run',
        goal: 'Revisa pedidos con saldo pendiente, entrega atrasada o sin confirmar. Prepara los avisos a clientes (pago, recolección o retraso) y déjalos listos para mi aprobación.',
      },
      label: 'Cada 2 horas',
    },
    starters: [
      '¿Qué pedidos tienen saldo pendiente hoy?',
      'Prepara el aviso de recolección para los pedidos listos',
      '¿Qué entregas van atrasadas y qué les decimos?',
    ],
  },
  {
    id: 'market-scout',
    name: 'Investigador de competencia',
    purpose:
      'Compara precios y promociones de la competencia contra tu catálogo y te entrega un Excel con diferencias.',
    icon: 'research',
    color: 1,
    useCase: 'Caso 5 · Investigación de mercado',
    persona: [
      'Eres «Investigador de competencia», el especialista de UNIVERSO para inteligencia de mercado.',
      'Tu función: buscar y abrir con el navegador los sitios de la competencia, capturar precios, promociones y disponibilidad de los productos comparables a nuestro catálogo, y entregar una tabla con diferencias en porcentaje y una recomendación concreta.',
      'Cita siempre la fuente y la fecha de cada precio. Guarda en memoria los competidores y URLs útiles para la siguiente ronda.',
      STYLE_RULES,
    ].join(' '),
    toolAllowlist: [
      ...CORE_TOOLS,
      ...WEB_TOOLS,
      ...VENUE_TOOLS,
      ...REPORT_TOOLS,
      'getProductCatalog',
      'getProductSearch',
      'queryProducts',
      'getProductDetail',
      'getTopProducts',
      'getCustomerPriceHistory',
      'compareEntities',
      'analyzeImage',
    ],
    autonomy: 'auto',
    venuePolicy: 'dedicated',
    routine: {
      type: 'time',
      spec: { everyMinutes: 7 * 24 * 60, tz: BUSINESS_TZ },
      action: {
        kind: 'run',
        goal: 'Compara precios y promociones de la competencia en nuestros 20 productos más vendidos. Entrégame un Excel con las diferencias y una recomendación de ajuste.',
      },
      label: 'Cada semana',
    },
    starters: [
      'Abre el navegador y compara el precio de nuestro producto estrella con 3 competidores',
      '¿Qué promociones tiene la competencia esta semana?',
      'Hazme un Excel con precios de la competencia para el top 10',
    ],
  },
  {
    id: 'collections',
    name: 'Cobranza',
    purpose:
      'Persigue facturas vencidas, prepara recordatorios por cliente y confirma pagos contra el ERP.',
    icon: 'audit',
    color: 6,
    useCase: 'Cobranza y cartera',
    persona: [
      'Eres «Cobranza», el especialista de UNIVERSO para cartera vencida.',
      'Tu función: revisar cuentas por cobrar, agrupar por antigüedad y cliente, preparar recordatorios con tono correcto según los días de atraso y confirmar pagos recibidos antes de dar algo por cobrado.',
      'Los recordatorios se envían solo con aprobación. Registra promesas de pago como compromisos con fecha.',
      STYLE_RULES,
    ].join(' '),
    toolAllowlist: [
      ...CORE_TOOLS,
      ...MESSAGING_TOOLS,
      'getAccountsReceivable',
      'getBalanceAging',
      'getOrdersWithBalance',
      'draftCollectionReminders',
      'sendBulkMessages',
      'queryInvoices',
      'getInvoiceDetail',
      'queryPayments',
      'getPaymentDetail',
      'getCustomerDetails',
      'getCustomerHealth',
      'generateExcelReport',
      'generatePdfReport',
    ],
    autonomy: 'approval',
    venuePolicy: 'shared',
    routine: {
      type: 'time',
      spec: { atHour: 9, atMinute: 15, tz: BUSINESS_TZ },
      action: {
        kind: 'run',
        goal: 'Revisa la cartera vencida por antigüedad, prepara los recordatorios de hoy por cliente y déjalos listos para mi aprobación. Marca los pagos que ya entraron.',
      },
      label: 'Todos los días a las 9:15',
    },
    starters: [
      '¿Cuánto tenemos vencido y de quién?',
      'Prepara recordatorios para los clientes con más de 30 días',
      '¿Qué pagos entraron ayer?',
    ],
  },
  {
    id: 'sentinel',
    name: 'Vigía',
    purpose: 'Vigila ventas, stock y bloqueos; te avisa solo cuando algo se sale de rango.',
    icon: 'watch',
    color: 7,
    useCase: 'Alertas y vigilancia',
    persona: [
      'Eres «Vigía», el especialista de UNIVERSO que observa los indicadores del negocio.',
      'Tu función: revisar alertas de ventas, stock bajo, velocidad de venta y bloqueos de pedidos; avisar únicamente cuando algo se sale de lo normal, con la cifra, el comparativo y la acción sugerida.',
      'Si no hay nada fuera de rango, responde en una sola línea. No repitas alertas ya reportadas: guarda en memoria lo que ya avisaste.',
      STYLE_RULES,
    ].join(' '),
    toolAllowlist: [
      ...CORE_TOOLS,
      ...SALES_READ_TOOLS,
      'getLowStockAlerts',
      'getStockMovement',
      'getDealBlockers',
      'getIntegrationStatus',
      'getNotifications',
      'notifyUser',
      'sendInternalChatMessage',
      'createChatEvent',
      'generateChart',
    ],
    autonomy: 'auto',
    venuePolicy: 'shared',
    routine: {
      type: 'time',
      spec: { everyMinutes: 240, tz: BUSINESS_TZ },
      action: {
        kind: 'run',
        goal: 'Revisa alertas de ventas, stock bajo y pedidos bloqueados. Si algo se sale de rango, avísame con la cifra y la acción sugerida; si todo está normal, responde en una línea.',
      },
      label: 'Cada 4 horas',
    },
    starters: [
      '¿Hay algo fuera de rango ahora mismo?',
      '¿Qué productos están por agotarse?',
      'Avísame si las ventas de hoy van por debajo del promedio',
    ],
  },
  {
    id: 'analyst',
    name: 'Analista de datos',
    purpose:
      'Cruza ventas, inventario, clientes y pagos para encontrar patrones y entregarlos en tablas y gráficas.',
    icon: 'data',
    color: 8,
    useCase: 'Análisis bajo demanda',
    persona: [
      'Eres «Analista de datos», el especialista analítico de UNIVERSO.',
      'Tu función: responder preguntas de negocio cruzando ventas, inventario, clientes, pagos y compras; entregar el hallazgo en una tabla o gráfica y explicar en dos líneas qué significa y qué harías.',
      'Declara siempre el periodo y el filtro usados. Si faltan datos, dilo en vez de estimar.',
      STYLE_RULES,
    ].join(' '),
    toolAllowlist: [
      ...CORE_TOOLS,
      ...SALES_READ_TOOLS,
      ...REPORT_TOOLS,
      'getCrossTabAnalysis',
      'getSalesByDeliveryMethod',
      'getCustomerRetention',
      'getProductBundles',
      'getSalesRanking',
      'getHourlySalesPattern',
      'getWeekdaySalesPattern',
      'getCustomerSegments',
      'getCustomerDetails',
      'getSalespersonScorecard',
      'getProductCatalog',
      'getStockMovement',
      'getLowStockAlerts',
      'queryPurchaseOrders',
      'queryBills',
      'queryPayments',
      'queryInvoices',
      'compareEntities',
      'getDatabaseOverview',
      'composeDocument',
      'generateWordReport',
    ],
    autonomy: 'auto',
    venuePolicy: 'shared',
    starters: [
      'Compara las ventas de este mes contra el anterior por vendedor',
      '¿Qué productos se venden juntos con más frecuencia?',
      'Hazme una gráfica de ventas por día de la semana',
    ],
  },
];

export function findAgentTemplate(id: string | null | undefined): AgentTemplate | null {
  if (!id) return null;
  return AGENT_TEMPLATES.find((t) => t.id === id) ?? null;
}
