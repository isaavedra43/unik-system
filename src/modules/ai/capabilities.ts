/**
 * Capability map — qué puede hacer el agente ESTE turno, en términos humanos.
 *
 * Tres trabajos:
 *
 * 1. Honestidad — el system prompt lista qué capacidades están ON/OFF para que
 *    el modelo admita límites en vez de improvisar ("busqué en internet" sin
 *    haber corrido ninguna tool web es el fallo que esto previene).
 * 2. Routing — intención → capacidad requerida. Si el usuario pide algo que una
 *    capacidad apagada cubriría, se inyecta una nota determinística diciéndole
 *    al modelo que lo admita; si está encendida pero el selector la dejó fuera,
 *    las tools se fuerzan dentro del menú ofrecido.
 * 3. Badge — las fuentes que aparecen en la UI se derivan de los nombres de
 *    tools que REALMENTE corrieron, no de texto que el modelo escribe.
 *
 * Puro, sin I/O — testeable.
 */

export type CapabilityId =
  | 'erp'
  | 'web'
  | 'browser'
  | 'computer'
  | 'docs'
  | 'comms'
  | 'extensions'
  | 'memory'
  | 'missions'
  | 'media'
  | 'ui';

export interface CapabilityDef {
  id: CapabilityId;
  /** Etiqueta humana (se muestra en prompt y panel admin). */
  label: string;
  /** Nombres de tools que la satisfacen. */
  tools: RegExp;
  /** Dónde se habilita (se muestra cuando está OFF). */
  enableHint?: string;
}

export const CAPABILITY_DEFS: readonly CapabilityDef[] = [
  {
    id: 'erp',
    label: 'datos del negocio (ventas, inventario, clientes, finanzas, cotizaciones)',
    tools: /^(query|get|list|find|search|lookup|compare|audit|count|extract|read)\w*$|^universalSearch$|^getDatabaseOverview$|^getModuleList$|^checkStock\w*$/,
  },
  {
    id: 'web',
    label: 'búsqueda y lectura de internet (web_search, web_research, fetch_url, web_crawl)',
    tools: /^(web_search|web_research|web_crawl|fetch_url)$/,
    enableHint: 'Admin → Asistente IA → Internet y Agentes: activa la búsqueda web y configura la API key (Tavily). Además el permiso web.search en el rol.',
  },
  {
    id: 'browser',
    label: 'navegador dentro de la computadora virtual (abrir páginas, clicks, formularios)',
    tools: /^(browser|browserProfile|venueScreenshot)$/,
    enableHint: 'Admin → Asistente IA → "Computadora virtual" activa y DAYTONA_API_KEY configurada.',
  },
  {
    id: 'computer',
    label: 'computadora virtual (terminal, archivos, scripts)',
    tools: /^venue(Exec|ReadFile|WriteFile|ListFiles)$/,
    enableHint: 'Admin → Asistente IA → venueEnabled + DAYTONA_API_KEY.',
  },
  {
    id: 'docs',
    label: 'documentos y reportes (PDF, Excel, Word, CSV, gráficas)',
    tools: /^(composeDocument|generatePdfReport|generateExcelReport|generateWordReport|generateCsvExport|generateChart|generateTable|renderView|previewQuote|getQuotePdf|listArtifacts|shareArtifact|getArtifactSpec|findShareableDocument)$/,
  },
  {
    id: 'comms',
    label: 'mensajería y comunicación (bandeja, chat interno, campañas, notificaciones, llamadas)',
    tools: /^(send\w+|notify\w+|draft\w+|propose\w+|createCommitment|createChatEvent|createCampaignDraft|scheduleFollowUp|addInboxNote|pinChatMessage|startInternalCall|startOutboundCall|callContact|pauseCallAi|suggestAssignee)$/,
  },
  {
    id: 'extensions',
    label: 'extensiones conectadas (MCP, APIs importadas, Composio, skills)',
    tools: /(__|composio\w+|runSkill|listSkills|getSkillRunStatus)/,
  },
  {
    id: 'memory',
    label: 'memoria persistente',
    tools: /^(recallMemory|saveFact|rememberForUser|listUserMemory|forgetMemory)$/,
  },
  {
    id: 'missions',
    label: 'misiones y rutinas programadas',
    tools: /^(proposeMission|listMissions|missionStatus|controlMission|saveVenuePlaybook|listVenuePlaybooks|runVenuePlaybook)$/,
  },
  {
    id: 'media',
    label: 'generación y análisis de imágenes y video',
    tools: /^(generateImage|generateVideo|generateReportImage|analyzeImage)$/,
    enableHint: 'Instala/aprueba una extensión de generación de media (p. ej. Higgsfield MCP) en Admin → Extensiones.',
  },
  {
    id: 'ui',
    label: 'interfaces interactivas dentro del chat (calculadoras, comparadores, filtros, simulaciones)',
    tools: /^(renderInteractiveUi|renderUi|renderView|generateChart|generateTable)$/,
  },
];

export interface CapabilityStatus {
  id: CapabilityId;
  label: string;
  available: boolean;
  enableHint?: string;
}

/** Capacidades encendidas/apagadas a partir de las tools REALMENTE disponibles para el actor. */
export function capabilitiesFromTools(tools: ReadonlyArray<{ name: string }>): CapabilityStatus[] {
  return CAPABILITY_DEFS.map((def) => ({
    id: def.id,
    label: def.label,
    available: tools.some((t) => def.tools.test(t.name)),
    enableHint: def.enableHint,
  }));
}

/**
 * Bloque del system prompt: lista qué puede y qué NO puede hacer el asistente
 * en este turno + el contrato de honestidad sobre fuentes.
 */
export function capabilityPromptBlock(caps: CapabilityStatus[]): string {
  const on = caps.filter((c) => c.available);
  const off = caps.filter((c) => !c.available);
  const lines = [
    '## Capacidades disponibles en este turno',
    ...on.map((c) => `- SÍ: ${c.label}`),
    ...off.map((c) => `- NO: ${c.label} — está deshabilitada o sin configurar`),
    '',
    'REGLA DE FUENTES (inquebrantable): solo puedes afirmar que usaste una fuente si su tool aparece en tus resultados DE ESTE TURNO. Si pides/implicas una capacidad marcada NO, dilo claramente en una frase y ofrece la alternativa disponible. NUNCA sustituyas "buscar en internet" por "buscar en la base de datos" sin decirlo, ni afirmes haber enviado/generado/navegado algo que no ejecutó una tool. Un "no encontré X" también afirma que buscaste — solo vale si la tool corrió.',
  ];
  return lines.join('\n');
}

// ─── Intent → capability ──────────────────────────────────────────────────────

interface IntentRule {
  cap: CapabilityId;
  /** Cómo se describe la intención en la nota al modelo. */
  phrase: string;
  re: RegExp;
}

const INTENT_RULES: readonly IntentRule[] = [
  {
    cap: 'web',
    phrase: 'búsqueda o lectura en internet',
    re: /\b(internet|la web|google|en l[íi]nea|online|amazon|mercado\s?libre|linkedin|facebook|instagram|tiktok|youtube|twitter|x\.com|redes sociales|p[áa]ginas? web|sitios? web|publicaciones|competencia en la web|tendencias)\b/i,
  },
  {
    cap: 'browser',
    phrase: 'operar un navegador (abrir páginas, hacer clic, llenar formularios)',
    re: /\b(navega(r|do)?|navegador|haz ?clic|llena (el|este|ese) formulario|inicia(r)? sesi[óo]n|entra a|abre (una |la |el )?(p[aá]gina|sitio|web|url|link|google)|edita en|reserva|reservaci[óo]n|hazme una reserva|como si fueras? usuario|carrito|agr[ée]ga\w* (al|a la) (carrito|cesta|compra)|checkout|compra(rlo|rla|rmelo|rmela|r)? en (amazon|mercado|la tienda|línea|linea))\b/i,
  },
  {
    cap: 'computer',
    phrase: 'computadora virtual (terminal y archivos)',
    re: /\b(computadora virtual|m[áa]quina virtual|sandbox|ejecuta (el )?(comando|script)|corre (el )?(script|comando)|la terminal)\b/i,
  },
  {
    cap: 'media',
    phrase: 'generación o análisis de imagen/video',
    re: /\b(genera|cr[eé]\w*|diseña|dibuja|haz|hazme|quiero)\b\w*\s*(me\s+)?(una\s+|un\s+|este\s+|esta\s+|te\s+)?(imagen|foto|logo|banner|ilustraci[óo]n|video|v[íi]deo|render)\b|\b(analiza|lee|interpreta|revisa|qué dice|que dice)\w*\s+(esta\s+|la\s+|este\s+|mi\s+)?(imagen|foto|fotograf[íi]a|captura|screenshot|escaneo|plano)\b/i,
  },
  {
    cap: 'docs',
    phrase: 'generar un documento o reporte',
    re: /\b(reporte|documento|pdf|excel|word|presentaci[óo]n|csv|infograf[íi]a|documento formal)\b/i,
  },
  {
    cap: 'ui',
    phrase: 'una interfaz interactiva en el chat',
    re: /\b(calculadora|comparador|comparativa|compa\w+ (estos|estas|los|las|de)|interactiv[oa]|simulaci[óo]n|simula(r|dor)|dashboard|panel|visualiza(r|ción)|gr[áa]fic[ao] interactiv[ao]|filtros? interactivos?)\b/i,
  },
];

/** Capacidades que el mensaje del usuario pide explícitamente. */
export function detectRequiredCapabilities(message: string): Array<{ cap: CapabilityId; phrase: string }> {
  const hits: Array<{ cap: CapabilityId; phrase: string }> = [];
  for (const rule of INTENT_RULES) {
    if (rule.re.test(message)) hits.push({ cap: rule.cap, phrase: rule.phrase });
  }
  return hits;
}

/**
 * Nota que se inyecta al system prompt cuando el usuario pide una capacidad que
 * está APAGADA: le ordena al modelo admitirlo en vez de simularla.
 */
export function missingCapabilityNote(
  missing: Array<{ cap: CapabilityId; phrase: string }>,
  caps: CapabilityStatus[]
): string {
  if (missing.length === 0) return '';
  const lines = missing.map((m) => {
    const hint = caps.find((c) => c.id === m.cap)?.enableHint;
    return (
      `- El usuario pidió ${m.phrase} pero esa capacidad NO está disponible en este turno.` +
      (hint ? ` Para habilitarla: ${hint}` : '') +
      ' Admítelo en una frase honesta ("ahora mismo no puedo buscar en internet…"), ofrece la alternativa real más cercana y sugiere habilitarla. PROHIBIDO simular que lo hiciste o presentar resultados internos como si fueran de esa fuente.'
    );
  });
  return ['## Aviso de capacidad faltante', ...lines].join('\n');
}

/**
 * Tools que deben estar en el menú aunque el selector las haya dejado fuera:
 * si el intent pide una capacidad DISPONIBLE, sus tools entran siempre (el tier
 * simple o el dominio elegido no pueden ocultarle al modelo lo que pidió).
 */
export function forcedToolNames(
  required: Array<{ cap: CapabilityId }>,
  tools: ReadonlyArray<{ name: string }>
): Set<string> {
  const forced = new Set<string>();
  for (const r of required) {
    const def = CAPABILITY_DEFS.find((d) => d.id === r.cap);
    if (!def) continue;
    for (const t of tools) if (def.tools.test(t.name)) forced.add(t.name);
  }
  return forced;
}

// ─── Badge de fuentes determinístico ─────────────────────────────────────────

interface SourceLabelRule {
  label: string;
  tools: RegExp;
}

const SOURCE_LABELS: readonly SourceLabelRule[] = [
  { label: 'búsqueda web', tools: /^web_search$/ },
  { label: 'investigación web', tools: /^web_research$/ },
  { label: 'páginas web', tools: /^(fetch_url|web_crawl)$/ },
  { label: 'navegador', tools: /^(browser|browserProfile)$/ },
  { label: 'computadora virtual', tools: /^venue\w+$/ },
  { label: 'memoria', tools: /^(recallMemory|saveFact|rememberForUser|listUserMemory|forgetMemory)$/ },
  { label: 'mensaje enviado', tools: /^send\w+$/ },
  { label: 'notificación', tools: /^notify\w+$/ },
  { label: 'propuesta para tu aprobación', tools: /^(propose\w+|draft\w+|create\w+|update\w+|schedule\w+|save\w+)$/ },
  { label: 'documento generado', tools: /^(composeDocument|generatePdfReport|generateExcelReport|generateWordReport|generateCsvExport|getQuotePdf|previewQuote)$/ },
  { label: 'visual generado', tools: /^(generateChart|generateTable|renderView|generateReportImage|generateImage|generateVideo)$/ },
  { label: 'interfaz interactiva', tools: /^(renderInteractiveUi|renderUi)$/ },
  { label: 'extensión externa', tools: /(__|composioExecute)/ },
  { label: 'biblioteca de conocimiento', tools: /^searchKnowledgeLibrary$/ },
  { label: 'llamada', tools: /^(callContact|startInternalCall|startOutboundCall|pauseCallAi)$/ },
];

/**
 * Etiquetas humanas de las fuentes que el turno usó DE VERDAD — la UI muestra
 * esto en vez de lo que el modelo se autodeclaró.
 */
export function describeSourcesUsed(toolNames: string[]): string {
  const labels: string[] = [];
  for (const rule of SOURCE_LABELS) {
    if (toolNames.some((n) => rule.tools.test(n))) labels.push(rule.label);
  }
  // Base de datos: cualquier tool interna de lectura que no haya sido etiquetada.
  const dataToolRan = toolNames.some(
    (n) => /^(query|get|list|find|search|lookup|compare|audit|count|extract|read)\w*$|^universalSearch$/.test(n)
  );
  if (dataToolRan) labels.push('base de datos UNIK');
  if (labels.length === 0 && toolNames.length > 0) labels.push('herramientas internas');
  return labels.join(' · ');
}
