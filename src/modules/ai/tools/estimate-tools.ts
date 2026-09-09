import { z } from 'zod';
import { registerTool } from './registry';
import { createEstimate } from '@/modules/integrations/zoho/estimates';
import type { CreateEstimatePayload, EstimateLineItem } from '@/modules/integrations/zoho/estimates';

registerTool({
  name: 'createEstimate',
  description:
    'Crea una cotización (estimate) en Zoho Inventory. ' +
    'Requiere un cliente y al menos un item/producto. ' +
    'Devuelve el estimate creado o un error.',
  category: 'sales',
  requiredPermission: 'estimates.create',
  enabledByDefault: true,
  parameters: z.object({
    customerId: z.string().min(1).describe('ID del cliente en Zoho Inventory.'),
    date: z.string().optional().describe('Fecha de la cotización en YYYY-MM-DD.'),
    expiryDate: z.string().optional().describe('Fecha de expiración en YYYY-MM-DD.'),
    estimateNumber: z.string().optional().describe('Número de cotización deseado (opcional).'),
    referenceNumber: z.string().optional().describe('Referencia interna opcional.'),
    salespersonId: z.string().optional().describe('ID del vendedor en Zoho.'),
    currencyCode: z.string().optional().describe('Código de moneda, ej. MXN.'),
    notes: z.string().optional().describe('Notas para el cliente.'),
    lineItems: z
      .array(
        z.object({
          itemId: z.string().min(1).describe('ID del item/producto en Zoho.'),
          name: z.string().optional().describe('Nombre del item (sobrescribe el maestro).'),
          description: z.string().optional().describe('Descripción del item.'),
          quantity: z.number().positive().describe('Cantidad.'),
          unit: z.string().optional().describe('Unidad de medida.'),
          rate: z.number().nonnegative().describe('Precio unitario.'),
          discount: z.union([z.number(), z.string()]).optional().describe('Descuento por item.'),
          taxName: z.string().optional().describe('Nombre del impuesto.'),
          taxPercentage: z.number().optional().describe('Porcentaje de impuesto.'),
        })
      )
      .min(1)
      .describe('Al menos un item es obligatorio.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      customerId: string;
      date?: string;
      expiryDate?: string;
      estimateNumber?: string;
      referenceNumber?: string;
      salespersonId?: string;
      currencyCode?: string;
      notes?: string;
      lineItems: Array<{
        itemId: string;
        name?: string;
        description?: string;
        quantity: number;
        unit?: string;
        rate: number;
        discount?: number | string;
        taxName?: string;
        taxPercentage?: number;
      }>;
    };

    const lineItems: EstimateLineItem[] = args.lineItems.map((item) => ({
      item_id: item.itemId,
      name: item.name,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      rate: item.rate,
      discount: item.discount,
      tax_name: item.taxName,
      tax_percentage: item.taxPercentage,
    }));

    const payload: CreateEstimatePayload = {
      customer_id: args.customerId,
      ...(args.date ? { date: args.date } : {}),
      ...(args.expiryDate ? { expiry_date: args.expiryDate } : {}),
      ...(args.estimateNumber ? { estimate_number: args.estimateNumber } : {}),
      ...(args.referenceNumber ? { reference_number: args.referenceNumber } : {}),
      ...(args.salespersonId ? { salesperson_id: args.salespersonId } : {}),
      ...(args.currencyCode ? { currency_code: args.currencyCode } : {}),
      ...(args.notes ? { notes: args.notes } : {}),
      line_items: lineItems,
    };

    const result = await createEstimate(payload);
    return result;
  },
});
