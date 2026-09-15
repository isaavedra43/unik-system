import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { canAccessAccount } from '@/modules/comms/comms-access';
import { isCrmError, unwrapCrmResult } from '@/modules/crm/crm-helpers';
import { getOpportunityDetail, listOpportunities, listRadarSignals } from '@/modules/crm/crm-queries';
import { createOpportunityFromConversation, moveStage } from '@/modules/crm/opportunities-service';
import { loadPipelineStages } from '@/modules/crm/pipeline-service';
import { explainSignal, getRadarSignal } from '@/modules/crm/radar-service';
import { quoteConversionBlocker, quoteFolio } from '@/modules/crm/sales-order-rules';
import { DEFAULT_PENDING_WRITE_TTL_MS } from '@/modules/integrations/zoho/write-request-ledger';
import { createSalesOrderFromQuote } from '@/modules/crm/sales-order-write-service';
import { OPPORTUNITY_STATUSES, RADAR_KINDS } from '@/modules/crm/types';
import { registerTool, type ToolExecutionContext } from './registry';
import {
  OperationsToolError,
  assertReadingScope,
  canActForArea,
  creationCommandId,
  transitionCommandId,
} from './operations-tool-kit';

/**
 * Sales / CRM tools (plan 6.5 and 6.6) over the CRM services; no other AI or
 * chat. Reads are `read`; `explainRadarSignal` is `internal_task` (one utility
 * model call); `draftRadarMessage` only drafts (sending stays in
 * `sendInboxMessage` with approval); creating an opportunity, moving a stage and
 * creating the sales order in Zoho are `business_write`, so the registry turns
 * them into an approval card first. Writes also check that the actor may act
 * for Ventas (`canActForArea`: bots only in their area, people with the area's
 * permissions or responsibility).
 */

const AREA = 'ventas' as const;
const CRM_CONTEXT_TAGS = ['/app/crm', '/app/inbox', '/app/quotes', '/app/sales'];

type ToolError = { error: string };

async function guarded<T>(run: () => Promise<T>): Promise<T | ToolError> {
  try {
    return await run();
  } catch (error) {
    if (isCrmError(error) || error instanceof OperationsToolError) return { error: error.message };
    throw error;
  }
}

async function assertCanAct(actor: CurrentUser, ctx: ToolExecutionContext | undefined): Promise<void> {
  const reason = await canActForArea(actor, AREA, ctx);
  if (reason) throw new OperationsToolError(reason, 'forbidden');
}

const money = (value: string | null) => (value === null ? null : Number(value));

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

registerTool({
  name: 'listOpportunities',
  description:
    'Lista oportunidades del embudo comercial (CRM): por estado, vendedor ("me" para las mías), etapa, texto (folio OPP-, título o cliente) o siguiente acción vencida. Devuelve folio, cliente, etapa, valor, probabilidad, siguiente acción y enlace.',
  category: 'sales',
  requiredPermission: 'crm.view',
  enabledByDefault: true,
  effect: 'read',
  contextTags: CRM_CONTEXT_TAGS,
  parameters: z.object({
    status: z.array(z.enum(OPPORTUNITY_STATUSES)).max(4).optional().describe('open | won | lost | dormant'),
    salesperson: z.string().max(64).optional().describe('"me" o el id del vendedor'),
    search: z.string().max(120).optional(),
    stageKey: z.string().max(40).optional().describe('Clave de la etapa, p. ej. nuevo, contactado, cotizado, negociacion'),
    nextActionOverdue: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  execute: async (actor, rawArgs, ctx) =>
    guarded(async () => {
      assertReadingScope(actor, AREA, ctx);
      const args = rawArgs as {
        status?: Array<(typeof OPPORTUNITY_STATUSES)[number]>;
        salesperson?: string;
        search?: string;
        stageKey?: string;
        nextActionOverdue?: boolean;
        limit: number;
      };
      let stageId: string | undefined;
      if (args.stageKey) {
        const stage = (await loadPipelineStages()).find((row) => row.key === args.stageKey);
        if (!stage) return { error: `No existe la etapa «${args.stageKey}»` };
        stageId = stage.id;
      }
      const page = await listOpportunities(actor, {
        status: args.status,
        salespersonUserId: args.salesperson,
        search: args.search,
        stageId,
        nextActionOverdue: args.nextActionOverdue,
        limit: args.limit,
      });
      return {
        total: page.total,
        items: page.items.map((item) => ({
          id: item.id,
          number: item.number,
          title: item.title,
          contactName: item.contactName,
          salesperson: item.salespersonName,
          stage: item.stageName,
          status: item.statusLabel,
          estimatedValue: money(item.estimatedValue),
          currency: item.currency,
          probability: item.effectiveProbability,
          nextActionAt: item.nextActionAt,
          nextActionText: item.nextActionText,
          nextActionOverdue: item.nextActionOverdue,
          lastActivityAt: item.lastActivityAt,
          link: `/app/crm/opportunities/${item.id}`,
        })),
      };
    }),
});

registerTool({
  name: 'getOpportunity',
  description:
    'Detalle de una oportunidad (por id o folio OPP-): etapa, valor, siguiente acción, línea de tiempo reciente, cotizaciones, órdenes de venta, expedientes y señales del radar.',
  category: 'sales',
  requiredPermission: 'crm.view',
  enabledByDefault: true,
  effect: 'read',
  contextTags: CRM_CONTEXT_TAGS,
  parameters: z.object({ opportunity: z.string().min(1).max(64).describe('id interno o folio OPP-000123') }),
  execute: async (actor, rawArgs, ctx) =>
    guarded(async () => {
      assertReadingScope(actor, AREA, ctx);
      const { opportunity } = rawArgs as { opportunity: string };
      const detail = await getOpportunityDetail(actor, opportunity);
      const o = detail.opportunity;
      return {
        id: o.id,
        number: o.number,
        title: o.title,
        contactName: o.contactName,
        salesperson: o.salespersonName,
        stage: o.stageName,
        status: o.statusLabel,
        lostReason: o.lostReason,
        estimatedValue: money(o.estimatedValue),
        currency: o.currency,
        probability: o.effectiveProbability,
        expectedCloseAt: o.expectedCloseAt,
        nextActionAt: o.nextActionAt,
        nextActionText: o.nextActionText,
        nextActionOverdue: o.nextActionOverdue,
        conversationIds: detail.conversations.map((conversation) => conversation.id),
        timeline: detail.activities.items.slice(0, 15).map((activity) => ({
          at: activity.at,
          kind: activity.kindLabel,
          summary: activity.summary,
          by: activity.userName,
        })),
        quotes: detail.quotes.map((quote) => ({
          id: quote.id,
          folio: quote.estimateNumber,
          status: quote.statusLabel,
          total: money(quote.total),
          expiryDate: quote.expiryDate,
          convertible: quote.convertible,
        })),
        salesOrders: detail.salesOrders.map((order) => ({ folio: order.salesOrderNumber, status: order.status, total: money(order.total) })),
        cases: detail.cases.map((opCase) => ({ caseNumber: opCase.caseNumber, status: opCase.status, phase: opCase.phase })),
        signals: detail.signals.map((signal) => ({ id: signal.id, kind: signal.kindLabel, score: signal.score, reason: signal.reason })),
        link: `/app/crm/opportunities/${o.id}`,
      };
    }),
});

registerTool({
  name: 'listRadarSignals',
  description:
    'Señales del radar comercial ordenadas por puntuación (sin respuesta, sin seguimiento, cotización por vencer, siguiente acción vencida, objeción abierta, alta intención, recompra atrasada, incidencia de entrega), con el motivo y las cifras.',
  category: 'sales',
  requiredPermission: 'crm.radar',
  enabledByDefault: true,
  effect: 'read',
  contextTags: CRM_CONTEXT_TAGS,
  parameters: z.object({
    salesperson: z.string().max(64).optional().describe('"me", "unassigned" o el id del vendedor'),
    kinds: z.array(z.enum(RADAR_KINDS)).max(RADAR_KINDS.length).optional(),
    minScore: z.number().int().min(0).max(100).optional(),
    limit: z.number().int().min(1).max(30).default(10),
  }),
  execute: async (actor, rawArgs, ctx) =>
    guarded(async () => {
      assertReadingScope(actor, AREA, ctx);
      const args = rawArgs as { salesperson?: string; kinds?: Array<(typeof RADAR_KINDS)[number]>; minScore?: number; limit: number };
      const page = await listRadarSignals(actor, {
        salespersonUserId: args.salesperson,
        kinds: args.kinds,
        minScore: args.minScore,
        limit: args.limit,
      });
      return {
        total: page.total,
        items: page.items.map((signal) => ({
          id: signal.id,
          kind: signal.kindLabel,
          score: signal.score,
          reason: signal.reason,
          customerName: signal.customerName,
          salesperson: signal.salespersonName,
          opportunityId: signal.opportunityId,
          conversationId: signal.conversationId,
          quoteId: signal.quoteId,
          explanation: signal.aiExplanation,
          suggestedMessage: signal.aiSuggestedMessage,
        })),
      };
    }),
});

registerTool({
  name: 'explainRadarSignal',
  description:
    'Pide a la IA la explicación de una señal del radar (por qué importa y qué hacer) y un mensaje sugerido para el cliente. Usa la explicación guardada de las últimas 12 horas salvo force.',
  category: 'sales',
  requiredPermission: 'crm.radar',
  enabledByDefault: true,
  effect: 'internal_task',
  contextTags: CRM_CONTEXT_TAGS,
  parameters: z.object({
    signalId: z.string().min(1).max(64),
    force: z.boolean().optional().describe('true para regenerar aunque exista una explicación reciente'),
  }),
  execute: async (actor, rawArgs, ctx) =>
    guarded(async () => {
      assertReadingScope(actor, AREA, ctx);
      const args = rawArgs as { signalId: string; force?: boolean };
      const signal = await explainSignal(actor, { signalId: args.signalId, force: args.force });
      return {
        signalId: signal.id,
        kind: signal.kindLabel,
        reason: signal.reason,
        explanation: signal.aiExplanation,
        suggestedMessage: signal.aiSuggestedMessage,
        generatedAt: signal.aiGeneratedAt,
      };
    }),
});

registerTool({
  name: 'draftRadarMessage',
  description:
    'Borrador del mensaje para el cliente de una señal del radar, ya generado por explainRadarSignal (no llama a la IA ni envía nada). Para enviarlo usa sendInboxMessage con la conversación indicada, que pide aprobación.',
  category: 'sales',
  requiredPermission: 'crm.radar',
  enabledByDefault: true,
  effect: 'draft',
  contextTags: CRM_CONTEXT_TAGS,
  parameters: z.object({ signalId: z.string().min(1).max(64) }),
  execute: async (actor, rawArgs, ctx) =>
    guarded(async () => {
      assertReadingScope(actor, AREA, ctx);
      const { signalId } = rawArgs as { signalId: string };
      const signal = await getRadarSignal(actor, signalId);
      if (!signal.aiSuggestedMessage) {
        return {
          signalId: signal.id,
          customerName: signal.customerName,
          conversationId: signal.conversationId,
          draft: null,
          note: 'Aún no hay mensaje sugerido para esta señal: pide primero explainRadarSignal.',
        };
      }
      return {
        signalId: signal.id,
        customerName: signal.customerName,
        conversationId: signal.conversationId,
        draft: signal.aiSuggestedMessage,
        note: signal.conversationId
          ? 'Es un borrador: para enviarlo usa sendInboxMessage con esta conversación (requiere aprobación).'
          : 'Es un borrador: la señal no tiene conversación; busca la conversación del cliente antes de enviarlo con sendInboxMessage.',
      };
    }),
});

// ---------------------------------------------------------------------------
// Writes (approval card first)
// ---------------------------------------------------------------------------

const createFromConversationArgs = z.object({
  conversationId: z.string().min(1).max(64),
  title: z.string().min(2).max(160).optional(),
  estimatedValue: z.number().min(0).max(1_000_000_000_000).optional(),
  nextActionAt: z.string().max(40).optional().describe('Fecha ISO de la siguiente acción'),
  nextActionText: z.string().max(240).optional(),
  note: z.string().max(2000).optional(),
});
type CreateFromConversationArgs = z.infer<typeof createFromConversationArgs>;

registerTool({
  name: 'createOpportunityFromConversation',
  description:
    'Crea una oportunidad de venta a partir de una conversación de la bandeja: cliente desde el contacto (y su cliente de Zoho), vendedor = asignado de la conversación, primera etapa del embudo. Si la conversación ya tiene una oportunidad viva, lo indica.',
  category: 'sales',
  requiredPermission: 'crm.manage',
  enabledByDefault: true,
  effect: 'business_write',
  contextTags: CRM_CONTEXT_TAGS,
  parameters: createFromConversationArgs,
  summarize: (rawArgs) => {
    const args = rawArgs as CreateFromConversationArgs;
    return `Crear oportunidad desde la conversación ${args.conversationId}${args.title ? `: «${args.title}»` : ''}`;
  },
  prepareArgs: async (actor, rawArgs) => {
    const args = rawArgs as CreateFromConversationArgs;
    const conversation = await prisma.commConversation.findUnique({
      where: { id: args.conversationId },
      include: { account: true, contact: true },
    });
    if (!conversation) return { error: 'No se encontró la conversación' };
    if (actor.isBot !== true && !canAccessAccount(actor, conversation.account)) {
      return { error: 'No tienes acceso a esta conversación de la bandeja' };
    }
    const existing = await prisma.opportunity.findFirst({
      where: { conversationIds: { has: conversation.id }, status: { in: ['open', 'dormant'] } },
      select: { number: true },
    });
    if (existing) return { error: `La conversación con ${conversation.contact.displayName} ya tiene la oportunidad ${existing.number}` };
    if (args.nextActionAt && Number.isNaN(Date.parse(args.nextActionAt))) return { error: 'La fecha de la siguiente acción no es válida' };
    return { args };
  },
  execute: async (actor, rawArgs, ctx) =>
    guarded(async () => {
      await assertCanAct(actor, ctx);
      const args = rawArgs as CreateFromConversationArgs;
      const commandId = creationCommandId('createOpportunityFromConversation', actor.id, args, ctx);
      const data = unwrapCrmResult(await createOpportunityFromConversation(actor, args, { commandId }));
      return {
        created: data.created,
        opportunityId: data.opportunityId,
        number: data.number,
        message: data.created ? `Oportunidad ${data.number} creada` : `La conversación ya tenía la oportunidad ${data.number}`,
        link: `/app/crm/opportunities/${data.opportunityId}`,
      };
    }),
});

const updateStageArgs = z.object({
  opportunityId: z.string().min(1).max(64),
  stageKey: z.string().min(1).max(40).describe('Clave de la etapa destino (ganado y perdido cierran la oportunidad)'),
  lostReason: z.string().max(500).optional().describe('Obligatorio al mover a una etapa perdida'),
  note: z.string().max(2000).optional(),
});
type UpdateStageArgs = z.infer<typeof updateStageArgs>;

registerTool({
  name: 'updateOpportunityStage',
  description:
    'Mueve una oportunidad a otra etapa del embudo. Mover a la etapa ganada la marca ganada; a la perdida exige el motivo; a una etapa abierta la reabre.',
  category: 'sales',
  requiredPermission: 'crm.manage',
  enabledByDefault: true,
  effect: 'business_write',
  contextTags: CRM_CONTEXT_TAGS,
  parameters: updateStageArgs,
  summarize: (rawArgs) => {
    const args = rawArgs as UpdateStageArgs;
    return `Mover la oportunidad ${args.opportunityId} a la etapa «${args.stageKey}»${args.lostReason ? ` (motivo: ${args.lostReason})` : ''}`;
  },
  prepareArgs: async (_actor, rawArgs) => {
    const args = rawArgs as UpdateStageArgs;
    const opportunity = await prisma.opportunity.findUnique({ where: { id: args.opportunityId }, select: { id: true, stageId: true } });
    if (!opportunity) return { error: 'No se encontró la oportunidad' };
    const stage = (await loadPipelineStages()).find((row) => row.key === args.stageKey);
    if (!stage || !stage.active) return { error: `No existe una etapa activa «${args.stageKey}»` };
    if (stage.kind === 'lost' && (args.lostReason ?? '').trim().length < 3) {
      return { error: 'Indica el motivo por el que se perdió la oportunidad (lostReason)' };
    }
    return { args };
  },
  execute: async (actor, rawArgs, ctx) =>
    guarded(async () => {
      await assertCanAct(actor, ctx);
      const args = rawArgs as UpdateStageArgs;
      const data = unwrapCrmResult(
        await moveStage(
          actor,
          { opportunityId: args.opportunityId, stageKey: args.stageKey, lostReason: args.lostReason, note: args.note },
          { commandId: transitionCommandId('updateOpportunityStage', ctx) }
        )
      );
      return { opportunityId: data.opportunityId, status: data.status, transition: data.transition };
    }),
});

const salesOrderArgs = z.object({
  quote: z.string().min(1).max(64).describe('id interno de la cotización o su folio (p. ej. COT-00042)'),
  opportunityId: z.string().min(1).max(64).optional(),
});
type SalesOrderArgs = z.infer<typeof salesOrderArgs>;

async function findQuote(ref: string) {
  const byId = await prisma.quote.findUnique({ where: { id: ref }, include: { items: true } });
  if (byId) return byId;
  return prisma.quote.findFirst({ where: { estimateNumber: ref }, include: { items: true } });
}

registerTool({
  name: 'createSalesOrderFromQuote',
  description:
    'Crea en Zoho la orden de venta de una cotización ACEPTADA (cliente, referencia = folio de la cotización, vendedor y conceptos), la liga a la oportunidad (la marca ganada) y abre el expediente operativo. No duplica: la misma cotización no se convierte dos veces.',
  category: 'sales',
  requiredPermission: 'crm.create_sales_order',
  // Opt-in: the real POST is validated against the Zoho organization first (flag crmSalesOrderWrite).
  enabledByDefault: false,
  effect: 'business_write',
  contextTags: CRM_CONTEXT_TAGS,
  parameters: salesOrderArgs,
  summarize: (rawArgs) => `Crear en Zoho la orden de venta de la cotización ${(rawArgs as SalesOrderArgs).quote}`,
  prepareArgs: async (_actor, rawArgs) => {
    const args = rawArgs as SalesOrderArgs;
    const quote = await findQuote(args.quote.trim());
    if (!quote) return { error: 'No se encontró la cotización' };
    const blocker = quoteConversionBlocker(quote);
    if (blocker) return { error: blocker };
    const converted = await prisma.salesOrderWriteRequest.findFirst({
      where: { quoteId: quote.id, status: 'completed' },
      select: { id: true },
    });
    if (converted) return { error: `La cotización ${quoteFolio(quote)} ya se convirtió en una orden de venta` };
    const inFlight = await prisma.salesOrderWriteRequest.findFirst({
      where: { quoteId: quote.id, status: 'pending', createdAt: { gte: new Date(Date.now() - DEFAULT_PENDING_WRITE_TTL_MS) } },
      select: { id: true },
    });
    if (inFlight) return { error: `La cotización ${quoteFolio(quote)} ya se está convirtiendo en orden de venta` };
    return { args: { quote: quote.id, ...(args.opportunityId ? { opportunityId: args.opportunityId } : {}) } };
  },
  execute: async (actor, rawArgs, ctx) =>
    guarded(async () => {
      await assertCanAct(actor, ctx);
      const args = rawArgs as SalesOrderArgs;
      const quote = await findQuote(args.quote.trim());
      if (!quote) return { error: 'No se encontró la cotización' };
      // One key per approved proposal, or per quote and actor (never per day): a retry, on any day, is the same request.
      const requestKey = ctx?.approvedProposalId ? `proposal:${ctx.approvedProposalId}:sales_order` : `ai:so:${quote.id}:${actor.id}`;
      const result = await createSalesOrderFromQuote(actor, { quoteId: quote.id, requestKey, opportunityId: args.opportunityId });
      return {
        salesOrderId: result.salesOrderId,
        zohoSalesOrderId: result.zohoSalesOrderId,
        salesOrderNumber: result.salesOrderNumber,
        estimateNumber: result.estimateNumber,
        total: money(result.total),
        currency: result.currencyCode,
        opportunityNumber: result.opportunityNumber,
        replayed: result.replayed,
        mock: result.mock,
        link: `/app/sales/orders/${result.salesOrderId}`,
      };
    }),
});
