// Genera docs/UNIVERSO-agentes.pdf — documento completo del sistema de agentes.
// Uso: node scripts/gen-universo-doc.mjs
import PDFDocument from 'pdfkit';
import { createWriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';

const OUT = 'docs/UNIVERSO-agentes.pdf';
mkdirSync('docs', { recursive: true });

const doc = new PDFDocument({ size: 'LETTER', margins: { top: 56, bottom: 56, left: 60, right: 60 }, info: {
  Title: 'UNIVERSO — Sistema de Agentes IA en UNIK',
  Author: 'UNIK System',
  Subject: 'Arquitectura, agentes, herramientas, seguridad y estado actual',
}});
doc.pipe(createWriteStream(OUT));

const NAVY = '#12263a';
const ACCENT = '#0f6fff';
const GRAY = '#5a6472';
const LIGHT = '#eef2f7';
const W = doc.page.width - 120;

function h1(t) {
  doc.moveDown(0.6).font('Helvetica-Bold').fontSize(17).fillColor(NAVY).text(t);
  doc.moveTo(doc.x, doc.y + 2).lineTo(doc.x + W, doc.y + 2).lineWidth(1).strokeColor(ACCENT).stroke();
  doc.moveDown(0.4);
}
function h2(t) { doc.moveDown(0.4).font('Helvetica-Bold').fontSize(12.5).fillColor(ACCENT).text(t).moveDown(0.15); }
function p(t, opts = {}) { doc.font('Helvetica').fontSize(10).fillColor('#222').text(t, { lineGap: 2.5, ...opts }); }
function bullet(t) { doc.font('Helvetica').fontSize(10).fillColor('#222').text(`•  ${t}`, { indent: 10, lineGap: 2 }); }
function kv(k, v) {
  doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text(`${k}: `, { continued: true });
  doc.font('Helvetica').fillColor('#222').text(v, { lineGap: 2 });
}
function mono(t) {
  doc.font('Courier').fontSize(8.5).fillColor('#1c2b3a');
  doc.text(t, { lineGap: 1.5 });
  doc.font('Helvetica');
}
function note(t) {
  const y = doc.y;
  doc.roundedRect(doc.x, y, W, doc.heightOfString(t, { width: W - 20 }) + 14, 4).fill(LIGHT);
  doc.font('Helvetica-Oblique').fontSize(9.5).fillColor('#33404f').text(t, doc.x + 10, y + 7, { width: W - 20 });
  doc.moveDown(0.6);
}
function pageBreak() { doc.addPage(); }
function table(rows, widths) {
  const startX = doc.x;
  for (const [i, row] of rows.entries()) {
    const head = i === 0;
    const y = doc.y;
    let maxH = 0;
    row.forEach((cell, c) => {
      const w = widths[c];
      const hh = doc.heightOfString(cell, { width: w - 10 });
      if (hh > maxH) maxH = hh;
    });
    const rowH = maxH + 8;
    if (y + rowH > doc.page.height - 70) doc.addPage();
    const yy = doc.y;
    if (head) doc.rect(startX, yy, widths.reduce((a, b) => a + b, 0), rowH).fill(NAVY);
    row.forEach((cell, c) => {
      const x = startX + widths.slice(0, c).reduce((a, b) => a + b, 0);
      doc.font(head ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.8)
        .fillColor(head ? '#fff' : '#222')
        .text(cell, x + 5, yy + 4, { width: widths[c] - 10, lineGap: 1 });
    });
    doc.y = yy + rowH;
    doc.moveTo(startX, doc.y).lineTo(startX + widths.reduce((a, b) => a + b, 0), doc.y).lineWidth(0.4).strokeColor('#ccd').stroke();
  }
  doc.moveDown(0.5);
}

// ============================== PORTADA ==============================
doc.moveDown(4);
doc.font('Helvetica-Bold').fontSize(34).fillColor(NAVY).text('UNIVERSO', { align: 'center' });
doc.font('Helvetica').fontSize(15).fillColor(ACCENT).text('Sistema de Agentes IA en UNIK', { align: 'center' });
doc.moveDown(1);
doc.font('Helvetica').fontSize(11).fillColor(GRAY).text('Documento técnico completo: arquitectura, agentes, herramientas,\nseguridad, modelos, costos y estado actual.', { align: 'center' });
doc.moveDown(3);
doc.font('Helvetica').fontSize(9.5).fillColor(GRAY).text(`Generado: ${new Date().toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' })}`, { align: 'center' });
doc.text('Código: /src/modules/agents, /src/modules/ai, /src/modules/venues', { align: 'center' });
doc.text('Flag principal: UNIK_AGENT_RUNTIME_V2 (apagado por default)', { align: 'center' });
pageBreak();

// ============================== 1. RESUMEN ==============================
h1('1. Qué es UNIVERSO');
p(`UNIVERSO es la capa de agentes de UNIK. En vez de un solo copiloto que responde preguntas, hay un equipo de IA: un agente principal (UNIK Central, badge JEFE) que entiende al usuario, decide qué hacer, delega en especialistas, usa herramientas reales (base de datos, internet, navegador, computadora virtual, APIs) y reporta con evidencia.`);
p(`El diseño no reescribe nada: envuelve el orquestador existente, sus ~220 herramientas, JEV (el decisor ligero), missions, venue y jobs. Todo corre detrás del flag UNIK_AGENT_RUNTIME_V2 y es aditivo en base de datos.`);
h2('Principios rectores');
bullet('Un solo interlocutor: el usuario habla con el JEFE; los especialistas trabajan detrás.');
bullet('Honestidad dura: solo se afirma lo que una tool ejecutó de verdad en ese turno.');
bullet('Toda acción con efecto (enviar, pagar, borrar, publicar) pide aprobación humana.');
bullet('Barato por default: modelos chicos para rutina, modelos grandes solo cuando aportan.');
bullet('Observable: cada turno es un AgentRun con eventos, tokens y costo medido.');

// ============================== 2. ARQUITECTURA ==============================
h1('2. Arquitectura general');
p('Flujo de un mensaje del usuario:');
mono(
`usuario → POST /assistant/api/chat
   → executeAgentTurn (agent-runtime)         [persona + allowlist + modelo del agente]
      → JEV routing envelope                  [1 llamada: path, dominios, delegación, riesgo]
      → runAssistant (orquestador)
         → selectToolsForTurn                 [menú de tools por dominio]
         → ToolGateway (policy paso 4d)        [grants, autonomía×efecto, presupuesto]
         → tools: DB / web / venue / composio / archivos / media
         → delegateTask → AgentTask (DAG)      [workers en sesión fresca]
         → AiProposal si el efecto lo requiere [aprobación humana]
      → AgentRun + AgentEvent (traceId, tokens, costo)
   → SSE: tokens, tool_call, workspace.*, agent.task, agent.message
   → UI: chat + OpsPanel (pantalla viva, terminal, misiones, costo)`);
h2('Piezas principales');
table([
  ['Capa', 'Módulo', 'Qué hace'],
  ['Identidad', 'agents/agent-service', 'Principal auto-creado por usuario, CRUD de especialistas, AgentVersion por cambio de persona.'],
  ['Runtime', 'agents/agent-runtime', 'Inyecta persona al system prompt, intersecta tools con allowlist, aplica modelDefault.'],
  ['Routing', 'ai/decisions/routing-envelope', 'JEV decide 10 cosas en UNA llamada (600 ms, fallback heurístico).'],
  ['Delegación', 'agents/delegation + task-graph', 'delegateTask con cápsula ≤8k, DAG con dependsOn, fan-out máx 4.'],
  ['Ejecución', 'ai/tools/* (~220 tools)', 'DB, web, venue, Composio, documentos, media, memoria.'],
  ['Gobernanza', 'agents/policy (ToolGateway)', 'Grants tool:/effect:, matriz autonomía×efecto, presupuesto por periodo.'],
  ['Memoria', 'agents/memory-router', 'Scopes tenant→user→agent→thread; modos full/on_demand/off.'],
  ['Tiempo real', 'ai/workspace-events + SSE', 'Eventos workspace.* a la 3ª columna (pantalla, páginas, terminal).'],
  ['Venue', 'venues/*', 'Computadora virtual desechable (Daytona) + navegador + exec + archivos.'],
  ['Rutinas', 'agents/trigger-service', 'trigger.tick cada 60 s: time/condition/entity_change/webhook/playbook.'],
], [110, 150, 240]);

// ============================== 3. AGENTES ==============================
pageBreak();
h1('3. Los agentes');
h2('3.1 UNIK Central (JEFE)');
p(`Se crea solo la primera vez que el usuario abre el asistente (kind=principal, fijado arriba del sidebar). Tiene persona propia, acceso completo a las tools habilitadas, y es quien decide delegar. El usuario nunca coordina especialistas a mano.`);
h2('3.2 Especialistas');
p(`Agentes creados por el usuario (NewAgentSheet) o por el JEFE vía delegación. Cada uno tiene: nombre, icono/color, persona (system prompt), toolAllowlist (subconjunto de tools), modelDefault, nivel de autonomía, venuePolicy y presupuesto. Editar la persona crea un AgentVersion (historial).`);
h2('3.3 Workers transitorios');
p(`Cuando el JEFE delega, el worker corre en sesión fresca con una cápsula de contexto (objetivo + datos + restricciones, ≤8k — nunca el historial completo). Al terminar reporta al padre por AgentMessage; el usuario ve el reporte plegado en el chat y la task en el terminal del OpsPanel.`);
h2('3.4 Task DAG (task-graph)');
bullet('dependsOn entre tasks: una task no arranca hasta que sus dependencias cierran.');
bullet('Fan-out máximo 4 delegaciones por turno.');
bullet('Cancelar una task cancela en cascada sus descendientes.');
bullet('Cada task es un AgentRun hijo (linaje parentRunId/rootRunId — costos atribuibles).');

// ============================== 4. JEV ==============================
h1('4. JEV — el decisor ligero');
p(`JEV es un modelo chico y rápido que actúa como árbitro de metadatos, no como redactor. En cada turno resuelve el "routing envelope" en una sola llamada con deadline de 600 ms:`);
bullet('path: respuesta directa, tools, RAG o delegación.');
bullet('domains: qué dominios toca (ventas, clientes, venue, web…).');
bullet('delegation: si conviene fan-out a especialistas.');
bullet('modelClass: simple | standard | complex | computer.');
bullet('risk: si el plan toca efectos que requieren aprobación.');
p(`Si JEV falla o expira, un fallback heurístico (regex de dominios + clasificador local) decide — el sistema nunca se queda sin router. La decisión queda en AgentEvent tipo "route" para métricas de costo de router.`);
h2('Dónde NO entra JEV');
p('JEV no lee pantallas ni escribe respuestas al usuario: clasifica y frena. Las acciones riesgosas las evalúa por paso (efecto read-equivalent vs external_send vs destructive) y el ToolGateway ejecuta la política.');

// ============================== 5. SUPERFICIES ==============================
pageBreak();
h1('5. Las 3 superficies de control');
p('El agente puede actuar sobre tres superficies, todas visibles en el OpsPanel:');
table([
  ['Superficie', 'Qué es', 'Estado'],
  ['Computadora virtual', 'Sandbox Daytona desechable: navegador Chromium (browser), terminal (venueExec), filesystem, screenshots. Session con lease central y reaper de idle.', 'Implementado'],
  ['Páginas web del agente', 'Páginas abiertas por tools web (fetch_url, web_search, web_crawl, browser). El panel las lista con contenido extraído.', 'Implementado'],
  ['Apps por API', 'Toolkits de Composio conectados por el usuario (Gmail, Calendar, Slack, etc.) gobernados por policies y roles.', 'Implementado'],
  ['Computadora local (Mac)', 'App Electron con icono flotante + computer-use local vía cola de acts. Plan completo escrito.', 'Plan — no implementado'],
], [105, 290, 105]);
h2('5.1 Computer use en la VM');
p(`El navegador corre dentro del sandbox: un browser-controller.mjs (node, puerto 3100) recibe acciones (open, click, type, scroll, extract, screenshot, pdf, tabs, secureInput…) y las ejecuta con playwright-core + chromium provisionados dentro de la imagen.`);
bullet('Cada acción devuelve screenshot → evento workspace.screen → el panel muestra la página viva (chat izquierda, navegador real derecha).');
bullet('provision.sh instala node + playwright-core + chromium dentro del sandbox; los hosts de infra (npm, nodejs.org, debian, Playwright CDN) pasan aunque haya allowlist de dominios.');
bullet('El controller escucha 0.0.0.0 con token x-unik-token por request; pkill antes de respawn sana sesiones viejas; browserAct se auto-cura una vez por sesión.');

// ============================== 6. MODELOS ==============================
h1('6. Modelos y costo (OpenRouter + OpenAI)');
p('El model-router asigna el modelo más barato que puede hacer el trabajo. Elección explícita del usuario siempre gana. Turnos de computadora usan el tier dedicado.');
table([
  ['Tarea (AiTask)', 'Uso', 'Default'],
  ['simple', 'Saludos, confirmaciones, aclaraciones sin datos.', 'fallbackDeployment'],
  ['routine', 'Consultas del día a día (ventas, clientes, mensajes).', 'deployment'],
  ['complex', 'Análisis, reportes, planes multi-paso, documentos.', 'deployment'],
  ['utility', 'Resúmenes, digest, borradores, re-ranking (fondo).', 'utilityModel → routine'],
  ['judge', 'Juez de calidad de respuestas.', 'qualityJudgeModel → routine'],
  ['vision', 'Extracción de imágenes/facturas (necesita ver).', 'vision-capable → primary'],
  ['computer', 'Computer use: navegar, clic, escribir, leer pantalla.', 'computerUseModel → UNIK_COMPUTER_MODEL → gemini-2.5-flash (OR) → routine'],
], [80, 235, 185]);
note('google/gemini-2.5-flash ~ $0.30/1M input, $2.50/1M output — el mejor calidad/precio con visión+tools+1M ctx del catálogo. Turnos computer se le escapan de los tiers de texto para no pagar el modelo grande en cada screenshot.');

// ============================== 7. TOOLS ==============================
pageBreak();
h1('7. Herramientas (~220 registradas)');
h2('Familias principales');
bullet('Datos UNIK: querySalesOrders, universalSearch, getTopProducts, getSalesTrend, clientes, inventario, cotizaciones, facturas, pagos, paquetes, compras…');
bullet('Web: web_search (Tavily o Sonar-OpenRouter fallback), fetch_url, web_crawl, web_research.');
bullet('Venue: browser (open/click/type/extract/screenshot/pdf/secureInput), browserProfile (sesiones por sitio), venueExec, venueReadFile/WriteFile/ListFiles, venueScreenshot, VenuePlaybooks.');
bullet('Apps/API: tools de Composio por toolkit conectado (gateway externo con policies y roles).');
bullet('Documentos y media: composeDocument, artifacts, generación de imágenes/video/audio vía providers, attachments multi-tipo.');
bullet('Agentes: delegateTask, mensajes entre agentes, triggers/rutinas, memoria (remember/recall).');
h2('Selección por turno');
p(`selectToolsForTurn ofrece al modelo solo el subconjunto relevante (por dominios detectados + contexto de página), respetando enabledTools del admin y el toolAllowlist del agente. ContextTags acotan por superficie (chat, inbox, assistant…).`);

// ============================== 8. SEGURIDAD ==============================
h1('8. Seguridad, privacidad y aprobaciones');
h2('8.1 Gobernanza (ToolGateway — paso 4d de executeTool)');
bullet('AgentGrant permit/deny/require_approval por tool:x o effect:x.');
bullet('Matriz autonomía×efecto: read < write < external_send < destructive; autonomía del agente acota hasta dónde llega sin aprobación.');
bullet('Presupuesto por agente/periodo: se agota → la acción se bloquea.');
h2('8.2 Aprobaciones');
p(`AiProposal es la tarjeta de aprobación. Las acciones con efecto externo (enviar, comprar, publicar, borrar, usar perfil guardado, credenciales) se pausan hasta que el usuario aprueba en el panel. El modelo declara intent=send/pay/purchase/publish/delete y el gateway decide.`);
h2('8.3 Credenciales — secureInput');
p(`Cuando una página pide login/tarjeta, el modelo llama browser action=secureInput declarando los campos. El usuario los escribe en un formulario enmascarado de su panel; el controller los teclea directo en la página (useCredential). Los valores jamás pasan por el modelo, el chat ni la base de datos.`);
h2('8.4 Pantallas — memory-only');
p(`Las capturas de pantalla son efímeras: viajan por SSE y por GET /venue/state (Cache-Control: no-store) y mueren ahí. stripScreenData las quita del audit (AiToolCall.result), del mensaje tool persistido y del contexto del modelo — para "ver" la pantalla el modelo usa analyzeImage (resultado acotado), nunca el base64.`);
h2('8.5 Datos no confiables');
p(`Resultados de web_search, fetch_url, web_crawl, browser y venue* llegan envueltos en <untrusted>: son datos, nunca instrucciones. Prompt injection en páginas se reporta, no se obedece.`);
h2('8.6 Kill switches');
bullet('UNIK_VENUE_ENABLED=false apaga toda la capa venue.');
bullet('venueEnabled / webSearchEnabled / webFetchEnabled en Admin → Asistente.');
bullet('UNIK_AGENT_RUNTIME_V2 apaga el runtime multiagente completo.');
bullet('Roles/permisos por tool (p. ej. browser.use) y allowedRoleKeys en tools externas.');

// ============================== 9. MEMORIA ==============================
pageBreak();
h1('9. Memoria');
p('memory-router organiza la memoria en scopes con modo por agente:');
table([
  ['Scope', 'Qué guarda', 'Quién lo ve'],
  ['tenant', 'Hechos de la empresa (políticas, datos de negocio).', 'Todos los agentes del tenant'],
  ['user', 'Preferencias y hechos del usuario.', 'Agentes de ese usuario'],
  ['agent', 'Conocimiento propio del agente (su rol, aprendizajes).', 'Ese agente'],
  ['thread', 'Contexto del hilo/conversación.', 'Esa conversación'],
], [70, 250, 180]);
bullet('Modos: full (inyecta al prompt), on_demand (solo vía tools — workers), off.');
bullet('AiMemory persistido con tenantId/agentId/conversationId — sin fugas cross-tenant.');

// ============================== 10. RUTINAS ==============================
h1('10. Rutinas, triggers y misiones');
h2('10.1 Triggers (always-on)');
p(`trigger.tick corre cada 60 s y evalúa triggers del usuario:`);
bullet('time — horarios/cron ("cada lunes 8am").');
bullet('entity_change — cuando cambia una entidad vigilada (orden, cliente).');
bullet('condition — sondas deterministas sin LLM (tools read-only whitelisted); solo despierta agente si hay novedad.');
bullet('webhook — disparo externo.');
bullet('playbook — corre un VenuePlaybook grabado sin LLM: repetición exacta de un flujo web aprendido una vez.');
h2('10.2 Misiones');
p(`Trabajos largos con objetivo, tasks (DAG) y progreso vivo. MissionCard muestra tasks en curso; el terminal del OpsPanel enlista agent.task en tiempo real. Las misiones pueden correr en segundos planos y reportan al terminar.`);

// ============================== 11. OBSERVABILIDAD ==============================
h1('11. Observabilidad y costo');
bullet('AgentRun por turno/delegación: traceId, linaje, modelo, tokens in/out, costo estimado.');
bullet('AgentEvent: journal del run (routing envelope, cada tool con duración, errores).');
bullet('VenueSession: minutos facturados (billedMinutes) → UsageMeter dim "venue".');
bullet('GET /assistant/api/usage → {llm, venue, jev, runs, spent} medido real.');
bullet('OpsPanel: SUPERFICIES (3), TERMINAL VIVO (tools en curso), pantalla venue, misiones, vigilancias, aprobaciones pendientes, costo del equipo.');

// ============================== 12. APIS ==============================
pageBreak();
h1('12. APIs del sistema de agentes');
table([
  ['Ruta', 'Contenido'],
  ['GET/POST /app/assistant/api/agents', 'Lista del equipo / crear especialista'],
  ['PATCH/DELETE /agents/[id]', 'Editar (crea AgentVersion) / archivar (principal no se archiva)'],
  ['POST /chat', 'Turno del asistente; acepta agentId (fija el agente del hilo)'],
  ['GET /runs/[id]', 'Run + eventos + DAG de tasks'],
  ['POST /tasks/[id]/cancel', 'Cancelar task + cascada'],
  ['GET/POST/PATCH/DELETE /triggers', 'Rutinas'],
  ['GET /workspace', 'Workspace central + lease actual'],
  ['GET /usage', 'Costos medidos {llm, venue, jev, runs, spent}'],
  ['GET /venue/state', 'Pantalla viva + secure-inputs pendientes (no-store)'],
  ['POST /venue/secure-input', 'El usuario envía valores enmascarados al controller'],
], [210, 290]);

// ============================== 13. FRONT ==============================
h1('13. Frontend');
bullet('AgentSidebar — "Tu equipo" (JEFE fijado), misiones recientes, "Descargar app" (PWA).');
bullet('OpsPanel — 3ª columna: superficies, pantalla viva, terminal, misiones, vigilancias, aprobaciones, costo.');
bullet('AssistantWidget — FAB flotante con el chat del agente en todas las páginas excepto /app/assistant.');
bullet('MissionCard / ActivityCard / AgentMessageCard / RoutineChip / NewAgentSheet / TweaksPanel / AgentAvatar.');
bullet('meta.agent (avatar por respuesta), meta.agentMessages (fold "Mensajes de X"), meta.routineCreated (chip).');
bullet('SSE: workspace.* en assistant:{conversationId}; agent.task/agent.message en user:{id}.');

// ============================== 14. CONFIG ==============================
h1('14. Configuración');
h2('Variables de entorno');
table([
  ['Variable', 'Qué hace'],
  ['UNIK_AGENT_RUNTIME_V2', 'Activa el runtime multiagente (default apagado).'],
  ['UNIK_VENUE_ENABLED', 'Kill-switch global de venues.'],
  ['DAYTONA_API_KEY / API_URL / TARGET', 'Proveedor de la computadora virtual.'],
  ['UNIK_COMPUTER_MODEL', 'Override del modelo de computer use.'],
  ['OPENROUTER_API_KEY', 'Habilita el catálogo OpenRouter (modelos baratos, Sonar search, Gemini Flash).'],
  ['TAVILY_API_KEY', 'Búsqueda web primaria (sin ella cae a Sonar vía OpenRouter).'],
  ['UNIK_JOB_WORKER_ENABLED', 'Jobs/triggers/reaper de venues en proceso.'],
], [170, 330]);
h2('Settings en Admin → Asistente');
p('providerConfigs (llaves por proveedor), reparto de modelos por tarea (incluido computerUseModel), enabledTools, venueEnabled, venueImage, límites de venue, webDomainAllowlist/Denylist, webSearchEnabled, guardrails, rate limits.');

// ============================== 15. ESTADO ==============================
pageBreak();
h1('15. Estado actual (honesto)');
h2('Implementado y en main');
bullet('Runtime multiagente completo (identidad, delegación, DAG, triggers, gateway, memoria, tenancy semilla).');
bullet('Venue Daytona: exec, archivos, navegador con screenshots vivos, secureInput, perfiles de sesión, playbooks.');
bullet('OpsPanel con pantalla en vivo, terminal, superficies, costos; widget flotante; PWA instalable.');
bullet('Router con tier computer dedicado (Gemini Flash vía OpenRouter) y fallback heurístico de JEV.');
bullet('Privacidad de pantallas: efímeras, stripScreenData, no-store.');
bullet('Búsqueda web con fallback Sonar vía OpenRouter.');
h2('Pendiente / limitaciones conocidas');
bullet('Multiempresa duro: tenantId existe en todo el schema pero el resolver cae a "unik" hasta que haya una segunda empresa real.');
bullet('Job worker corre dentro del proceso web (durable pero comparte proceso); separación prevista cuando haya carga.');
bullet('Evals automáticos de routing/seguridad definidos en el plan, aún no escritos.');
bullet('App de escritorio Mac + computadora local: plan completo aprobado (Electron, bubble flotante, acts por cola, LocalVenue como 4º provider) — sin implementar.');
bullet('Verificación end-to-end real en producción: continua y manual (venue, browser, search, aprobaciones).');

// ============================== 16. GLOSARIO ==============================
h1('16. Glosario');
kv('JEV', 'Decisor ligero (routing envelope, clasificaciones, gating de riesgo).');
kv('Venue', 'Computadora desechable del agente (Daytona hoy; Mac local en plan).');
kv('AgentRun / AgentEvent', 'La grabación de cada turno con linaje, tokens y costo.');
kv('AgentTask', 'Unidad de delegación dentro del DAG (cápsula + dependsOn).');
kv('Workspace / Lease', 'La venue central compartida con candado por run.');
kv('ToolGateway', 'La puerta que autoriza cada tool por grants/efecto/presupuesto.');
kv('secureInput', 'Canal para que el usuario teclee secretos directo a la página.');
kv('Playbook', 'Flujo web grabado que se repite determinísticamente sin LLM.');
kv('OpsPanel', 'Tercera columna: superficies, pantalla viva, terminal, costos.');
kv('stripScreenData', 'Sanitizador que expulsa capturas del audit/historial/contexto.');

doc.end();
console.log('PDF generado en', OUT);
