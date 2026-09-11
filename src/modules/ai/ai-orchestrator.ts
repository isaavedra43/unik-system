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

  // Track the last data tool result so we can auto-inject it into artifact tools
  let lastToolRows: Record<string, unknown>[] | null = null;
  let lastToolName: string | null = null;
  let lastToolArgs: Record<string, unknown> | null = null;
  let lastToolResult: Record<string, unknown> | null = null;

  // Scan conversation history for the last tool result with data rows
  // This handles "generame un excel con la info que te pedi" (data from a previous message)
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'tool' && m.content) {
      try {
        const parsed = JSON.parse(m.content);
        if (parsed && typeof parsed === 'object' && !parsed.error) {
          lastToolResult = parsed as Record<string, unknown>;
          // Find ALL arrays of objects in the result
          const allArrays: Record<string, Record<string, unknown>[]> = {};
          for (const key of Object.keys(parsed)) {
            const val = parsed[key];
            if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
              allArrays[key] = val as Record<string, unknown>[];
            }
          }
          // Use the first array as the default rows (for simple mode)
          const firstKey = Object.keys(allArrays)[0];
          if (firstKey) {
            lastToolRows = allArrays[firstKey];
            // Find the tool name and args from the previous assistant message's toolCalls
            for (let j = i - 1; j >= 0; j--) {
              const am = history[j];
              if (am.role === 'assistant' && am.toolCalls) {
                const calls = am.toolCalls as Array<{ name: string; arguments: string }>;
                if (calls.length > 0) {
                  lastToolName = calls[calls.length - 1].name;
                  try {
                    lastToolArgs = JSON.parse(calls[calls.length - 1].arguments);
                  } catch {
                    lastToolArgs = null;
                  }
                }
                break;
              }
            }
          }
          break;
        }
      } catch {
        // Not JSON, skip
      }
    }
  }

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
      : dateRange === 'all' ? ' (Histórico)'
      : '';

    // For querySalesOrders, build title from filters
    if (toolName === 'querySalesOrders') {
      const parts: string[] = ['Ventas'];
      const paymentMethods = toolArgs?.paymentMethods as string[] | undefined;
      const deliveryMethod = toolArgs?.deliveryMethod as string | undefined;
      const customer = toolArgs?.customer as string | undefined;
      const salesperson = toolArgs?.salesperson as string | undefined;
      const product = toolArgs?.product as string | undefined;
      const groupBy = toolArgs?.groupBy as string | undefined;

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
      }
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

        // Auto-inject rows and title for artifact tools when the IA didn't pass them
        if (ARTIFACT_TOOLS.has(tc.name)) {
          if (!argsObj.rows && !argsObj.sections && lastToolRows && lastToolRows.length > 0) {
            console.log(`[ai-orchestrator] Auto-injecting ${lastToolRows.length} rows from ${lastToolName} into ${tc.name}`);
            argsObj.rows = lastToolRows;
          }
          // Auto-inject sections for PDF when the tool result has multiple arrays
          if (tc.name === 'generatePdfReport' && !argsObj.sections && !argsObj.rows && lastToolResult) {
            const allArrays: Record<string, Record<string, unknown>[]> = {};
            for (const key of Object.keys(lastToolResult)) {
              const val = lastToolResult[key];
              if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
                allArrays[key] = val as Record<string, unknown>[];
              }
            }
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
            const cards: Array<{ label: string; value: string }> = [];
            const scalarFields: Record<string, string> = {
              totalRevenue: 'Total',
              totalOrders: 'Órdenes',
              totalBalance: 'Saldo',
              total: 'Total',
              count: 'Órdenes',
              totalQuantity: 'Cantidad',
            };
            for (const [key, label] of Object.entries(scalarFields)) {
              const val = lastToolResult[key];
              if (val !== undefined && val !== null) {
                const numStr = String(val);
                if (label === 'Total' || label === 'Saldo') {
                  cards.push({ label, value: `$${Number(numStr).toLocaleString('es-MX', { minimumFractionDigits: 2 })}` });
                } else {
                  cards.push({ label, value: numStr });
                }
              }
              if (cards.length >= 4) break;
            }
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

      // Track the last data tool result for auto-injection into artifact tools
      if (result.success && result.result && typeof result.result === 'object' && !ARTIFACT_TOOLS.has(tc.name)) {
        const toolResult = result.result as Record<string, unknown>;
        // Preserve the COMPLETE result for multi-section PDF injection
        lastToolResult = toolResult;
        // Find ALL arrays of objects in the result (not just the first)
        const allArrays: Record<string, Record<string, unknown>[]> = {};
        for (const key of Object.keys(toolResult)) {
          const val = toolResult[key];
          if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
            allArrays[key] = val as Record<string, unknown>[];
          }
        }
        // Use the first array as the default rows (for simple mode)
        const firstKey = Object.keys(allArrays)[0];
        if (firstKey) {
          lastToolRows = allArrays[firstKey];
          lastToolName = tc.name;
          lastToolArgs = (parsedArgs as Record<string, unknown>) ?? null;
        }
      }

      // If the tool generated an artifact, emit an artifact event
      if (result.success && result.result && typeof result.result === 'object') {
        const toolResult = result.result as Record<string, unknown>;
        if (toolResult.artifactId && toolResult.type) {
          yield {
            type: 'artifact',
            data: {
              artifactId: toolResult.artifactId,
              type: toolResult.type,
              title: toolResult.title,
              filename: toolResult.filename,
              downloadUrl: toolResult.downloadUrl,
              inlineRender: toolResult.inlineRender,
              rowCount: toolResult.rowCount,
              sizeBytes: toolResult.sizeBytes,
              pageCount: toolResult.pageCount,
              chartType: toolResult.chartType,
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
