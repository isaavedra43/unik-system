import type { CurrentUser } from '@/modules/auth/authorization';
import { chatCompletionStream, type ChatMessage, type ToolSpec, type ContentPart } from './ai-client';
import { AiApiError } from './ai-client';
import { buildSystemPrompt } from './ai-context-builder';
import {
  getAvailableTools,
  executeTool,
  toOpenAiTools,
} from './tools/index';
import { getAiSettings } from './ai-admin-config-service';
import {
  getMessages,
  addMessage,
  autoTitleConversation,
} from './ai-sessions-service';
import { recordAiToolCall } from './ai-audit';
import { checkRateLimit, recordTokenUsage } from './ai-rate-limit';
import { validateInput, validateOutput } from './ai-guardrails';
import { processAttachment, type AttachmentResult } from './ai-attachments-service';
import { prisma } from '@/lib/prisma';
import { buildReportSubtitle, buildSummaryCards } from './ai-report-helpers';
import { ARTIFACT_TOOL_NAMES, collectRowArrays, findLastDataToolResult } from './ai-history-data';

interface OrchestratorAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  storagePath: string;
}

interface OrchestratorInput {
  conversationId: string;
  message: string;
  actor: CurrentUser;
  context?: { page?: string; voice?: boolean };
  /** Optional model override — user can pick a model in the chat UI. */
  model?: string;
  /** Optional attachments (images/PDFs uploaded by the user). */
  attachments?: OrchestratorAttachment[];
}

interface OrchestratorEvent {
  type: 'token' | 'tool_call_start' | 'tool_call_end' | 'artifact' | 'done' | 'error';
  data?: unknown;
}

const EXPORT_MAX_ROWS = 5000;
const EXPORT_PAGE_SIZE = 200; // querySalesOrders' Zod max

function firstRowArray(result: Record<string, unknown> | null | undefined): Record<string, unknown>[] | null {
  if (!result) return null;
  const arrays = collectRowArrays(result);
  const firstKey = Object.keys(arrays)[0];
  return firstKey ? arrays[firstKey] : null;
}

/**
 * Chat tool results are paginated so the model's context stays small, but a report must hold
 * every matching row. When the last data result was a partial page, re-run the same tool with
 * the same filters page by page (never through the model) and concatenate the rows.
 */
async function fetchAllRowsForExport(
  toolName: string | null,
  toolArgs: Record<string, unknown> | null,
  lastResult: Record<string, unknown> | null,
  fallbackRows: Record<string, unknown>[],
  actor: CurrentUser
): Promise<Record<string, unknown>[]> {
  if (!toolName || !toolArgs || !lastResult) return fallbackRows;
  const total = Number(lastResult.total ?? lastResult.totalOrders ?? NaN);
  const showing = Number(lastResult.showing ?? fallbackRows.length);
  const totalPages = Number(lastResult.totalPages ?? 1);
  const paginated = Number.isFinite(total) && (total > showing || totalPages > 1);
  if (!paginated || !('page' in toolArgs || 'pageSize' in toolArgs || lastResult.mode === 'list')) {
    return fallbackRows;
  }

  const all: Record<string, unknown>[] = [];
  const pages = Math.min(Math.ceil(total / EXPORT_PAGE_SIZE), Math.ceil(EXPORT_MAX_ROWS / EXPORT_PAGE_SIZE));
  for (let page = 1; page <= pages; page++) {
    const res = await executeTool(toolName, actor, { ...toolArgs, page, pageSize: EXPORT_PAGE_SIZE });
    if (!res.success || !res.result || typeof res.result !== 'object') break;
    const rows = firstRowArray(res.result as Record<string, unknown>);
    if (!rows || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < EXPORT_PAGE_SIZE) break;
  }
  return all.length >= fallbackRows.length ? all : fallbackRows;
}

export async function* runAssistant(
  input: OrchestratorInput
): AsyncGenerator<OrchestratorEvent> {
  // 1. Check if AI is enabled (before any work)
  const settings = await getAiSettings();
  if (!settings.isEnabled) {
    yield { type: 'error', data: { message: 'El asistente está desactivado temporalmente.' } };
    return;
  }

  // 2. Validate input
  const inputValidation = validateInput(input.message, settings.inputMaxLength);
  if (!inputValidation.valid) {
    yield { type: 'error', data: { message: inputValidation.error } };
    return;
  }

  // 3. Rate limit
  const rateLimit = checkRateLimit(
    input.actor.id,
    settings.maxMessagesPerMinute,
    settings.maxTokensPerDay
  );
  if (!rateLimit.allowed) {
    yield {
      type: 'error',
      data: {
        message: `Límite de mensajes alcanzado. Reinicia en ${new Date(rateLimit.resetAt).toLocaleTimeString('es-MX')}.`,
      },
    };
    return;
  }

  // 4. Persist user message
  const userMessage = await addMessage(input.conversationId, 'user', input.message, null, 0, 0, 0);
  await autoTitleConversation(input.conversationId, input.message);

  // 4.5. Associate attachments with the user message
  if (input.attachments && input.attachments.length > 0) {
    try {
      await prisma.aiAttachment.updateMany({
        where: { id: { in: input.attachments.map((a) => a.id) } },
        data: { messageId: userMessage.id },
      });
    } catch (err) {
      console.error('[orchestrator] Error associating attachments:', err);
    }
  }

  // 5. Load history
  const history = await getMessages(
    input.conversationId,
    input.actor.id,
    settings.maxConversationMessages
  );

  // 6. Build system prompt
  const systemPrompt = await buildSystemPrompt(input.actor, input.context);

  // 7. Build messages
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          content: m.content ?? '',
          tool_call_id: m.toolCallId ?? '',
        };
      }
      if (m.role === 'assistant' && m.toolCalls) {
        const toolCalls = m.toolCalls as Array<{ id: string; name: string; arguments: string }>;
        return {
          role: 'assistant' as const,
          content: m.content,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      }
      return {
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content ?? '',
      };
    }),
  ];

  // 7.5. Process attachments — inject multimodal content into the last user message
  if (input.attachments && input.attachments.length > 0) {
    // Find the last user message (the one just added)
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    if (lastUserIdx >= 0) {
      const userText = messages[lastUserIdx].content as string;
      const contentParts: ContentPart[] = [{ type: 'text', text: userText }];

      // Process each attachment
      for (const att of input.attachments) {
        try {
          const attResult: AttachmentResult = {
            id: att.id,
            fileName: att.fileName,
            mimeType: att.mimeType,
            sizeBytes: 0,
            storagePath: att.storagePath,
          };
          const processed = await processAttachment(attResult);

          if (processed.type === 'image') {
            // Add image content part for OpenAI Vision
            contentParts.push({
              type: 'image_url',
              image_url: { url: processed.dataUrl },
            });
          } else if (processed.type === 'text') {
            // Add extracted text as a text content part
            const label = att.mimeType === 'application/pdf'
              ? `[Contenido del PDF "${att.fileName}"]`
              : `[Contenido del archivo "${att.fileName}"]`;
            contentParts.push({
              type: 'text',
              text: `${label}:\n${processed.content}`,
            });
          }
        } catch (err) {
          console.error(`[orchestrator] Error processing attachment ${att.fileName}:`, err);
          contentParts.push({
            type: 'text',
            text: `[Error al procesar el archivo "${att.fileName}"]`,
          });
        }
      }

      // Replace the last user message with multimodal content
      messages[lastUserIdx] = {
        role: 'user',
        content: contentParts,
      };
    }
  }

  // 8. Get available tools
  const availableTools = getAvailableTools(input.actor, settings.enabledTools);
  const toolSpecs: ToolSpec[] = toOpenAiTools(availableTools);

  // Resolve effective model: user override > default
  const effectiveModel = input.model ?? settings.deployment;
  const fallbackModel = settings.fallbackDeployment;

  // 9. Agent loop (max maxToolIterations)
  let iteration = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let usingFallback = false;

  // Track the last DATA tool result so we can auto-inject it into artifact tools.
  // Seeded from the conversation history ("generame un excel con la info que te pedí"), skipping
  // artifact results and resolving the originating call by toolCallId — see ai-history-data.ts.
  const seed = findLastDataToolResult(history);
  let lastToolRows: Record<string, unknown>[] | null = seed?.rows ?? null;
  let lastToolName: string | null = seed?.toolName ?? null;
  let lastToolArgs: Record<string, unknown> | null = seed?.toolArgs ?? null;
  let lastToolResult: Record<string, unknown> | null = seed?.result ?? null;

  // Tools that consume rows (and therefore get them auto-injected). generateChart is handled
  // separately (labels/series), listArtifacts/cleanupArtifacts take no data at all.
  const ARTIFACT_TOOLS = new Set([
    'generatePdfReport',
    'generateExcelReport',
    'generateCsvExport',
    'generateReportImage',
    'generateTable',
  ]);

  /**
   * Builds a dynamic report title based on the tool name and its arguments.
   * Works with querySalesOrders (the universal sales tool) and other tools.
   */
  function buildDynamicTitle(toolName: string, toolArgs: Record<string, unknown> | null): string {
    const dateRange = toolArgs?.dateRange as string | undefined;
    const dateLabel = dateRange === 'today' ? ' de Hoy'
      : dateRange === 'yesterday' ? ' de Ayer'
      : dateRange === 'this_week' ? ' de Esta Semana'
      : dateRange === 'this_month' ? ' de Este Mes'
      : dateRange === 'last_month' ? ' del Mes Pasado'
      : dateRange === 'last_7_days' ? ' de los Últimos 7 Días'
      : dateRange === 'last_30_days' ? ' de los Últimos 30 Días'
      : dateRange === 'this_year' ? ' de Este Año'
      : dateRange === 'last_year' ? ' del Año Pasado'
      : dateRange === 'all' ? ' (Histórico)'
      : '';

    // For querySalesOrders, build title from filters
    if (toolName === 'querySalesOrders') {
      const parts: string[] = ['Ventas'];
      const paymentMethods = toolArgs?.paymentMethods as string[] | undefined;
      const deliveryMethod = toolArgs?.deliveryMethod as string | undefined;
      const deliveryType = toolArgs?.deliveryType as string | undefined;
      const shippingLocation = toolArgs?.shippingLocation as string | undefined;
      const customer = toolArgs?.customer as string | undefined;
      const salesperson = toolArgs?.salesperson as string | undefined;
      const product = toolArgs?.product as string | undefined;
      const groupBy = toolArgs?.groupBy as string | undefined;
      const ticketStatus = toolArgs?.ticketStatus as string | undefined;
      const shippedStatus = toolArgs?.shippedStatus as string | undefined;
      const paidStatus = toolArgs?.paidStatus as string | undefined;
      const invoicedStatus = toolArgs?.invoicedStatus as string | undefined;
      const status = toolArgs?.status as string | undefined;

      // A status filter changes WHAT the report is about — it must be visible in the title so a
      // narrowed result ("55 pendientes") is never mistaken for the full set ("76 ventas").
      const statusLabel = (v: string | undefined, map: Array<[RegExp, string]>): string | null => {
        if (!v) return null;
        const n = v.toLowerCase();
        for (const [re, label] of map) if (re.test(n)) return label;
        return v;
      };
      const ticketLabel = statusLabel(ticketStatus, [
        [/pendiente de entrega|por entregar|sin entregar|no entregad|falta/, 'Pendientes de Entrega'],
        [/no (se ha )?cerrad|sin cerrar|abiert/, 'Abiertas (sin cerrar)'],
        [/entregad/, 'Entregadas'],
        [/cerrad|terminad|finalizad/, 'Cerradas'],
        [/transito/, 'En Tránsito'],
        [/pendiente de envio/, 'Pendientes de Envío'],
      ]);
      const shippedLabel = statusLabel(shippedStatus, [
        [/por entregar|por enviar|pendiente|no enviad|sin enviar/, 'Sin Salir de Bodega'],
        [/entregad|enviad/, 'Enviadas'],
      ]);
      const paidLabel = statusLabel(paidStatus, [
        [/con saldo|adeudo|deben|credito/, 'con Saldo Pendiente'],
        [/sin pagar|no pagad|pendiente|por cobrar/, 'No Pagadas'],
        [/parcial|abonad/, 'Parcialmente Pagadas'],
        [/pagad|liquidad|cobrad/, 'Pagadas'],
      ]);
      const invoicedLabel = statusLabel(invoicedStatus, [
        [/sin facturar|no facturad|por facturar|pendiente/, 'Sin Facturar'],
        [/facturad/, 'Facturadas'],
      ]);
      const orderLabel = statusLabel(status, [
        [/borrador|draft/, 'en Borrador'],
        [/anulad|cancelad|void/, 'Anuladas'],
        [/cerrad|closed/, 'Cerradas'],
        [/confirmad/, 'Confirmadas'],
      ]);
      if (ticketLabel) parts.push(ticketLabel);
      else if (shippedLabel) parts.push(shippedLabel);
      if (paidLabel) parts.push(paidLabel);
      if (invoicedLabel) parts.push(invoicedLabel);
      if (orderLabel && !ticketLabel) parts.push(orderLabel);

      if (paymentMethods && paymentMethods.length > 0) {
        if (paymentMethods.length === 1) {
          const pm = paymentMethods[0];
          parts.push(pm === 'EFECTIVO' ? 'en Efectivo'
            : pm === 'EFECTIVO EN BODEGA' ? 'en Efectivo en Bodega'
            : pm === 'TRANSFERENCIA' ? 'por Transferencia'
            : pm === 'DEPOSITO' ? 'por Depósito'
            : pm === 'TARJETA' ? 'con Tarjeta'
            : `por ${pm}`);
        } else {
          parts.push(`por ${paymentMethods.join(' + ')}`);
        }
      }
      if (deliveryMethod) {
        parts.push(deliveryMethod.toLowerCase().includes('pie') ? 'a Pie de Obra'
          : deliveryMethod.toLowerCase().includes('recoge') ? 'Recoge en Bodega'
          : deliveryMethod.toLowerCase().includes('instal') ? 'Instalación a Domicilio'
          : deliveryMethod);
      } else if (deliveryType) {
        parts.push(
          deliveryType === 'pie_de_obra' ? 'a Pie de Obra'
            : deliveryType === 'recoge_en_bodega' ? 'Recoge en Bodega'
            : deliveryType === 'instalacion' ? 'con Instalación'
            : deliveryType === 'domicilio' ? 'a Domicilio'
            : 'con Entrega a Cliente'
        );
      }
      if (shippingLocation) parts.push(`en ${shippingLocation}`);
      if (product) parts.push(`de ${product}`);
      if (customer) parts.push(`de ${customer}`);
      if (salesperson) parts.push(`de ${salesperson}`);
      if (groupBy === 'product') parts.push('por Producto');
      if (groupBy === 'paymentMethod') parts.push('por Método de Pago');
      if (groupBy === 'deliveryMethod') parts.push('por Método de Entrega');
      if (groupBy === 'salesperson') parts.push('por Vendedor');
      if (groupBy === 'location') parts.push('por Sucursal');
      if (groupBy === 'status') parts.push('por Estado');
      if (groupBy === 'customer') parts.push('por Cliente');
      if (groupBy === 'date') parts.push('por Fecha');

      return `${parts.join(' ')}${dateLabel}`;
    }

    // For universalSearch
    if (toolName === 'universalSearch') {
      return `Resultados de Búsqueda: ${toolArgs?.query ?? ''}`;
    }

    // For getDatabaseOverview
    if (toolName === 'getDatabaseOverview') {
      return 'Panorama de Datos UNIK';
    }

    // For new module tools — build dynamic titles with filters
    if (toolName === 'queryPurchaseOrders') {
      const parts: string[] = ['Órdenes de Compra'];
      if (toolArgs?.vendor) parts.push(`de ${toolArgs.vendor}`);
      if (toolArgs?.status) parts.push(`(${toolArgs.status})`);
      return `${parts.join(' ')}${dateLabel}`;
    }
    if (toolName === 'queryBills') {
      const parts: string[] = ['Facturas de Compra'];
      if (toolArgs?.vendor) parts.push(`de ${toolArgs.vendor}`);
      if (toolArgs?.status) parts.push(`(${toolArgs.status})`);
      return `${parts.join(' ')}${dateLabel}`;
    }
    if (toolName === 'queryVendorCredits') {
      const parts: string[] = ['Créditos de Proveedor'];
      if (toolArgs?.vendor) parts.push(`de ${toolArgs.vendor}`);
      if (toolArgs?.status) parts.push(`(${toolArgs.status})`);
      return `${parts.join(' ')}${dateLabel}`;
    }
    if (toolName === 'queryPayments') {
      const parts: string[] = ['Pagos'];
      if (toolArgs?.customer) parts.push(`de ${toolArgs.customer}`);
      if (toolArgs?.paymentMode) parts.push(`en ${toolArgs.paymentMode}`);
      return `${parts.join(' ')}${dateLabel}`;
    }
    if (toolName === 'queryInvoices') {
      const parts: string[] = ['Facturas'];
      if (toolArgs?.customer) parts.push(`de ${toolArgs.customer}`);
      if (toolArgs?.status) parts.push(`(${toolArgs.status})`);
      return `${parts.join(' ')}${dateLabel}`;
    }
    if (toolName === 'queryPackages') {
      const parts: string[] = ['Paquetes'];
      if (toolArgs?.customer) parts.push(`de ${toolArgs.customer}`);
      if (toolArgs?.carrier) parts.push(`(${toolArgs.carrier})`);
      if (toolArgs?.status) parts.push(`(${toolArgs.status})`);
      return `${parts.join(' ')}${dateLabel}`;
    }
    if (toolName === 'queryProducts') {
      const parts: string[] = ['Catálogo de Productos'];
      if (toolArgs?.category) parts.push(`— ${toolArgs.category}`);
      if (toolArgs?.brand) parts.push(`— ${toolArgs.brand}`);
      if (toolArgs?.lowStock) parts.push('(Stock Bajo)');
      return parts.join(' ');
    }
    if (toolName === 'queryContacts') {
      const parts: string[] = ['Contactos'];
      if (toolArgs?.contactType === 'customer') parts[0] = 'Clientes';
      else if (toolArgs?.contactType === 'vendor') parts[0] = 'Proveedores';
      return parts.join(' ');
    }

    // Static title map for other tools
    const titleMap: Record<string, string> = {
      getTopProducts: 'Productos Más Vendidos',
      getSalesTrend: 'Tendencia de Ventas',
      getTopCustomers: 'Top Clientes',
      getAccountsReceivable: 'Cuentas por Cobrar',
      getRevenueAnalysis: 'Análisis de Ingresos',
      getDailyRevenue: 'Ingresos Diarios',
      getSalesRanking: 'Ranking de Ventas',
      getSalesKPIs: 'KPIs de Ventas',
      getDashboardSummary: 'Resumen Ejecutivo',
      getProductCatalog: 'Catálogo de Productos',
      getLowStockAlerts: 'Alertas de Bajo Stock',
      getTeamPerformance: 'Rendimiento del Equipo',
      getSalesForecast: 'Pronóstico de Ventas',
      getSalesAlerts: 'Alertas de Ventas',
      getBalanceAging: 'Antigüedad de Saldos',
      getCustomerRetention: 'Retención de Clientes',
      getProductBundles: 'Productos Comprados Juntos',
    };
    return titleMap[toolName] ?? 'Reporte UNIK';
  }

  while (iteration < settings.maxToolIterations) {
    iteration++;

    let iterationContent = '';
    let iterationToolCalls: Array<{ id: string; name: string; arguments: string }> | undefined;
    let finishReason: string | undefined;

    const modelToUse = usingFallback ? fallbackModel : effectiveModel;

    try {
      for await (const chunk of chatCompletionStream({
        messages,
        tools: toolSpecs.length > 0 ? toolSpecs : undefined,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        userId: input.actor.id,
        conversationId: input.conversationId,
        model: modelToUse,
      })) {
      if (chunk.delta) {
        iterationContent += chunk.delta;
        yield { type: 'token', data: { delta: chunk.delta } };
      }
      if (chunk.toolCalls) {
        iterationToolCalls = chunk.toolCalls;
      }
      if (chunk.finishReason) {
        finishReason = chunk.finishReason;
      }
      if (chunk.usage) {
        totalPromptTokens += chunk.usage.promptTokens;
        totalCompletionTokens += chunk.usage.completionTokens;
        recordTokenUsage(input.actor.id, chunk.usage.totalTokens);
      }
    }
    } catch (err) {
      // Handle 429 rate limit: try fallback model
      if (err instanceof AiApiError && err.code === 'rate_limit' && !usingFallback && fallbackModel) {
        console.warn(`[ai-orchestrator] Rate limited on ${modelToUse}, falling back to ${fallbackModel}`);
        usingFallback = true;
        iteration--; // Don't count this failed attempt
        continue;
      }
      // Re-throw other errors
      throw err;
    }

    // If no tool calls, we're done
    if (!iterationToolCalls || iterationToolCalls.length === 0 || finishReason === 'stop') {
      // Validate output for potential leaked secrets
      const outputValidation = validateOutput(iterationContent);
      if (!outputValidation.valid && (outputValidation.warnings?.length ?? 0) > 0) {
        // Log warnings but don't block the response — the guardrail is heuristic
        console.warn('[ai-orchestrator] Output validation warnings:', outputValidation.warnings);
      }
      await addMessage(
        input.conversationId,
        'assistant',
        iterationContent,
        null,
        totalPromptTokens,
        totalCompletionTokens,
        0
      );
      yield {
        type: 'done',
        data: {
          content: iterationContent,
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
        },
      };
      return;
    }

    // Has tool calls: persist assistant message with tool_calls
    const assistantMessage = await addMessage(
      input.conversationId,
      'assistant',
      iterationContent,
      iterationToolCalls,
      totalPromptTokens,
      totalCompletionTokens,
      0
    );

    // Add to context
    messages.push({
      role: 'assistant',
      content: iterationContent || null,
      tool_calls: iterationToolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    // Execute each tool call
    for (const tc of iterationToolCalls) {
      yield { type: 'tool_call_start', data: { name: tc.name, args: tc.arguments } };

      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(tc.arguments);
      } catch {
        parsedArgs = {};
      }

      // Inject conversationId for artifact tools that need it
      if (parsedArgs && typeof parsedArgs === 'object') {
        const argsObj = parsedArgs as Record<string, unknown>;
        if (!argsObj.conversationId) {
          argsObj.conversationId = input.conversationId;
        }

        // Auto-inject rows and title for artifact tools
        if (ARTIFACT_TOOLS.has(tc.name)) {
          const modelRows = Array.isArray(argsObj.rows) ? (argsObj.rows as Record<string, unknown>[]) : null;
          const subsetOnly = argsObj.subsetOnly === true;
          if (!argsObj.sections && !subsetOnly && lastToolRows && lastToolRows.length > 0) {
            // The rows of a report ALWAYS come from the data tool, never from what the model
            // re-typed: hand-typed rows are (a) a partial page ("solo algunos renglones"), and
            // (b) already-formatted strings ("$1,797.00") that break totals ("$NaN").
            // Chat results are paginated (pageSize ≤ 200) so the model's context stays small,
            // but a report must contain EVERY matching row — re-run the data tool page by page
            // (never through the model) when the last result was only a partial page.
            const exportRows = await fetchAllRowsForExport(lastToolName, lastToolArgs, lastToolResult, lastToolRows, input.actor);
            if (modelRows && modelRows.length > exportRows.length) {
              // The model has more rows than we can reproduce (e.g. it merged several results):
              // keep its rows rather than silently dropping data.
              console.log(`[ai-orchestrator] Keeping ${modelRows.length} model rows for ${tc.name} (system has ${exportRows.length})`);
            } else {
              if (modelRows) {
                console.log(`[ai-orchestrator] Replacing ${modelRows.length} model-typed rows with ${exportRows.length} rows from ${lastToolName} for ${tc.name}`);
              } else {
                console.log(`[ai-orchestrator] Auto-injecting ${exportRows.length} rows from ${lastToolName} into ${tc.name}`);
              }
              argsObj.rows = exportRows;
            }
          }
          if (!argsObj.subtitle && lastToolName === 'querySalesOrders') {
            argsObj.subtitle = buildReportSubtitle(lastToolArgs, lastToolResult);
          }
          // Auto-inject sections for PDF when the tool result has multiple arrays
          if (tc.name === 'generatePdfReport' && !argsObj.sections && !argsObj.rows && lastToolResult) {
            const allArrays = collectRowArrays(lastToolResult);
            if (Object.keys(allArrays).length > 1) {
              const sectionLabels: Record<string, string> = {
                byPaymentMethod: 'Por Método de Pago',
                byStatus: 'Por Estado',
                bySalesperson: 'Por Vendedor',
                byLocation: 'Por Sucursal',
                byDeliveryMethod: 'Por Método de Entrega',
                byCustomer: 'Por Cliente',
                byProduct: 'Por Producto',
                byDate: 'Por Fecha',
                orders: 'Órdenes',
                topProducts: 'Productos Más Vendidos',
                topCustomers: 'Top Clientes',
              };
              argsObj.sections = Object.entries(allArrays).map(([key, rows]) => ({
                title: sectionLabels[key] ?? key,
                rows,
              }));
              console.log(`[ai-orchestrator] Auto-injecting ${Object.keys(allArrays).length} sections from ${lastToolName} into ${tc.name}`);
            }
          }
          if (!argsObj.title && lastToolName) {
            // Build title dynamically based on tool name AND its arguments
            argsObj.title = buildDynamicTitle(lastToolName, lastToolArgs);
          }

          // Auto-inject summary cards from scalar fields in the last tool result
          if (!argsObj.summaryCards && lastToolResult) {
            const cards = buildSummaryCards(lastToolResult);
            if (cards.length > 0) {
              argsObj.summaryCards = cards;
            }
          }
        }

        // Auto-inject chart params for generateChart
        if (tc.name === 'generateChart' && lastToolRows && lastToolRows.length > 0) {
          if (!argsObj.title) {
            argsObj.title = buildDynamicTitle(lastToolName ?? '', lastToolArgs);
          }
          if (!argsObj.chartType) {
            argsObj.chartType = 'bar';
          }
          if (!argsObj.labels && lastToolRows.length > 0) {
            // Use 'customer' or 'number' or first string field as labels
            const firstRow = lastToolRows[0];
            let labelKey = 'customer';
            if (!('customer' in firstRow)) {
              // Find first string field
              for (const k of Object.keys(firstRow)) {
                if (typeof firstRow[k] === 'string' && k !== 'date' && k !== 'status') {
                  labelKey = k;
                  break;
                }
              }
            }
            argsObj.labels = lastToolRows.map((r) => String(r[labelKey] ?? '').slice(0, 30));
          }
          if (!argsObj.series && lastToolRows.length > 0) {
            // Use 'total' or first numeric field as values
            const firstRow = lastToolRows[0];
            let valueKey = 'total';
            if (!('total' in firstRow)) {
              for (const k of Object.keys(firstRow)) {
                const v = firstRow[k];
                if (typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v)) && v !== '')) {
                  valueKey = k;
                  break;
                }
              }
            }
            const values = lastToolRows.map((r) => Number(r[valueKey] ?? 0));
            argsObj.series = [{ label: argsObj.title as string, values }];
          }
        }
      }

      const result = await executeTool(tc.name, input.actor, parsedArgs);

      // Track the last DATA tool result for auto-injection into artifact tools
      if (
        result.success &&
        result.result &&
        typeof result.result === 'object' &&
        !ARTIFACT_TOOL_NAMES.has(tc.name) &&
        !(result.result as Record<string, unknown>).error
      ) {
        const toolResult = result.result as Record<string, unknown>;
        // Use the first array as the default rows (for simple mode); preserve the COMPLETE
        // result for multi-section PDF injection and KPI cards.
        const allArrays = collectRowArrays(toolResult);
        const firstKey = Object.keys(allArrays)[0];
        if (firstKey) {
          lastToolResult = toolResult;
          lastToolRows = allArrays[firstKey];
          lastToolName = tc.name;
          lastToolArgs = (parsedArgs as Record<string, unknown>) ?? null;
        }
      }

      // If the tool generated one or more artifacts, emit an artifact event per artifact.
      // (generateReportImage returns MULTIPLE artifacts — "Parte 1 de 3", "Parte 2 de 3"...—
      // when the data doesn't fit in a single image, instead of silently truncating.)
      if (result.success && result.result && typeof result.result === 'object') {
        const toolResult = result.result as Record<string, unknown>;
        const artifactList = Array.isArray(toolResult.artifacts)
          ? (toolResult.artifacts as Array<Record<string, unknown>>)
          : toolResult.artifactId && toolResult.type
            ? [toolResult]
            : [];
        for (const a of artifactList) {
          yield {
            type: 'artifact',
            data: {
              artifactId: a.artifactId,
              type: a.type,
              title: a.title,
              filename: a.filename,
              downloadUrl: a.downloadUrl,
              inlineRender: a.inlineRender,
              rowCount: a.rowCount,
              sizeBytes: a.sizeBytes,
              pageCount: a.pageCount,
              chartType: a.chartType,
            },
          };
        }
      }

      // Audit tool call
      await recordAiToolCall({
        messageId: assistantMessage.id,
        toolName: tc.name,
        args: parsedArgs,
        result: result.result,
        durationMs: result.durationMs,
        success: result.success,
        errorCode: result.error,
      });

      // Add result to context
      messages.push({
        role: 'tool',
        content: JSON.stringify(result.success ? result.result : { error: result.error }),
        tool_call_id: tc.id,
      });

      // Persist tool message
      await addMessage(
        input.conversationId,
        'tool',
        JSON.stringify(result.success ? result.result : { error: result.error }),
        null,
        0,
        0,
        result.durationMs,
        tc.id
      );

      yield {
        type: 'tool_call_end',
        data: {
          name: tc.name,
          success: result.success,
          durationMs: result.durationMs,
        },
      };
    }

    // Loop: call the active provider again with tool results
  }

  // Reached iteration limit
  yield {
    type: 'error',
    data: { message: 'El asistente alcanzó el límite de iteraciones de tools.' },
  };
}
