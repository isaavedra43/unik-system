import { z } from 'zod';
import { registerTool } from './registry';
import {
  createQuoteSchema,
  quoteItemSchema,
  scenarioSchema,
  toDecimal,
} from '@/modules/quotes/quotes-contract';
import {
  approveQuote,
  buildCommercialPackage,
  createQuote,
  getBooksMode,
  getQuote,
  QuoteError,
  requestApproval,
  simulateScenarios,
} from '@/modules/quotes/quotes-service';

/**
 * Quotes tools. Drafting, simulation and packaging are automatic; creating
 * the OFFICIAL estimate in Zoho Books is `business_write`, so the executor
 * ALWAYS turns it into an AiProposal that a human approves in the chat. A
 * spoken or written request for an official quote never reaches Books by
 * itself.
 */

const quoteIdSchema = z.string().min(1).max(64).describe('Id de la cotización en UNIK');

function money(value: string | number, currency: string): string {
  return `${new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2 }).format(Number(value))} ${currency}`;
}

registerTool({
  name: 'prepareQuote',
  description:
    'Prepara una cotización en BORRADOR (no oficial) a partir de partidas: calcula subtotal, impuestos y total. No crea nada en Zoho Books.',
  category: 'sales',
  enabledByDefault: true,
  requiredPermission: 'quotes.use',
  effect: 'draft',
  parameters: createQuoteSchema.extend({
    items: z.array(quoteItemSchema).min(1).max(200),
  }),
  execute: async (actor, args) => {
    const quote = await createQuote(actor, args);
    return {
      quoteId: quote.id,
      status: quote.status,
      version: quote.version,
      contentHash: quote.contentHash,
      customerName: quote.customerName,
      currency: quote.currency,
      subtotal: quote.subtotal,
      tax: quote.tax,
      total: quote.total,
      booksMode: getBooksMode().mock ? 'mock' : 'real',
      note: 'Borrador creado. Para hacerla oficial se requiere solicitar aprobación y que una persona la apruebe.',
    };
  },
});

registerTool({
  name: 'simulateQuoteScenarios',
  description:
    'Simula escenarios comerciales sobre una cotización (descuento %, multiplicador de cantidad, tasa de impuesto) y compara totales. No modifica la cotización.',
  category: 'sales',
  enabledByDefault: true,
  requiredPermission: 'quotes.use',
  effect: 'read',
  parameters: z.object({
    quoteId: quoteIdSchema,
    scenarios: z.array(scenarioSchema).min(1).max(10),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { quoteId: string; scenarios: z.infer<typeof scenarioSchema>[] };
    return simulateScenarios(actor, args.quoteId, args.scenarios);
  },
});

registerTool({
  name: 'buildCommercialPackage',
  description:
    'Genera el paquete comercial completo (PDF): cotización, fichas de producto del catálogo y condiciones comerciales. Devuelve el id del documento para descargarlo.',
  category: 'sales',
  enabledByDefault: true,
  requiredPermission: 'quotes.use',
  effect: 'draft',
  timeoutMs: 120_000,
  parameters: z.object({ quoteId: quoteIdSchema }),
  execute: async (actor, rawArgs) => {
    const { quoteId } = rawArgs as { quoteId: string };
    const result = await buildCommercialPackage(actor, quoteId);
    return {
      ...result,
      downloadPath: `/app/files/api/objects/${result.documentId}/access?disposition=attachment`,
    };
  },
});

registerTool({
  name: 'requestQuoteApproval',
  description:
    'Solicita la aprobación humana de una cotización en borrador (pasa a pendiente de aprobación). No la crea en Zoho Books.',
  category: 'sales',
  enabledByDefault: true,
  requiredPermission: 'quotes.use',
  effect: 'internal_task',
  parameters: z.object({ quoteId: quoteIdSchema }),
  execute: async (actor, rawArgs) => {
    const { quoteId } = rawArgs as { quoteId: string };
    const quote = await requestApproval(actor, quoteId);
    return {
      quoteId: quote.id,
      status: quote.status,
      contentHash: quote.contentHash,
      total: quote.total,
      currency: quote.currency,
      note: 'Pendiente de aprobación por una persona con permiso quotes.approve.',
    };
  },
});

const approveArgsSchema = z.object({
  quoteId: quoteIdSchema,
  customerName: z.string().min(1).max(200).describe('Cliente tal como aparece en la cotización'),
  total: z.string().min(1).describe('Total exacto de la cotización (cadena decimal)'),
  currency: z.string().length(3),
  contentHash: z
    .string()
    .min(8)
    .describe('contentHash actual de la cotización (de prepareQuote/requestQuoteApproval)'),
});

registerTool({
  name: 'approveOfficialQuote',
  description:
    'Crea la cotización OFICIAL en Zoho Books. Requiere aprobación explícita de una persona con permiso quotes.approve: esta herramienta siempre genera una propuesta que el usuario debe aprobar en el chat.',
  category: 'sales',
  enabledByDefault: true,
  requiredPermission: 'quotes.approve',
  effect: 'business_write',
  approvalPolicy: 'require_approval',
  timeoutMs: 90_000,
  parameters: approveArgsSchema,
  summarize: (args) => {
    const a = args as z.infer<typeof approveArgsSchema>;
    const mode = getBooksMode().mock ? ' [modo simulado: NO se crea en Books real]' : '';
    return `Crear cotización oficial en Zoho Books para ${a.customerName} por ${money(a.total, a.currency)} (cotización ${a.quoteId}, hash ${a.contentHash.slice(0, 12)})${mode}`;
  },
  execute: async (actor, rawArgs, ctx) => {
    const args = rawArgs as z.infer<typeof approveArgsSchema>;
    const quote = await getQuote(actor, args.quoteId);
    // The proposal shows customer and total: refuse if they no longer describe the quote.
    if (quote.customerName !== args.customerName) {
      throw new QuoteError('El cliente de la propuesta no coincide con la cotización', 409);
    }
    if (!toDecimal(quote.total).equals(toDecimal(args.total)) || quote.currency !== args.currency) {
      throw new QuoteError('El total de la propuesta no coincide con la cotización actual', 409);
    }
    const result = await approveQuote(actor, args.quoteId, {
      expectedContentHash: args.contentHash,
      proposalId: ctx.approvedProposalId,
    });
    return {
      quoteId: result.quote.id,
      status: result.quote.status,
      zohoEstimateId: result.quote.zohoEstimateId,
      books: result.books,
      uncertain: result.uncertain,
      note: result.uncertain
        ? 'Resultado incierto: verificar en Zoho Books antes de reintentar.'
        : result.books?.mock
          ? 'Creada en modo SIMULADO (mock): no existe en Zoho Books real.'
          : 'Creada en Zoho Books.',
    };
  },
});
