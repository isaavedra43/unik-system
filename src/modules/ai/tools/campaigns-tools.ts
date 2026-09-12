import { z } from 'zod';
import { registerTool } from './registry';
import {
  createCampaignSchema,
  contentSchema,
  extractVariables,
  renderTemplate,
} from '@/modules/campaigns/campaign-contract';
import {
  approveCampaign,
  CampaignError,
  createCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
} from '@/modules/campaigns/campaign-service';

/**
 * Campaign tools. Listing, stats, content drafting and draft creation are
 * automatic; approving a mass send is `business_write`, so the executor
 * always creates a proposal that a person with campaigns.approve confirms.
 */

const campaignIdSchema = z.string().min(1).max(64).describe('Id de la campaña');

registerTool({
  name: 'listCampaigns',
  description:
    'Lista campañas de WhatsApp/SMS/Telegram con estado, audiencia congelada y presupuesto.',
  category: 'communication',
  enabledByDefault: true,
  requiredPermission: 'campaigns.view',
  effect: 'read',
  parameters: z.object({
    status: z
      .enum([
        'draft',
        'rehearsal',
        'pending_approval',
        'scheduled',
        'running',
        'paused',
        'completed',
        'cancelled',
      ])
      .optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { status?: string; limit?: number };
    const campaigns = await listCampaigns(actor, args);
    return {
      campaigns: campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        channel: c.channel,
        status: c.status,
        audienceCount: c.audience?.count ?? null,
        frozen: c.frozen,
        budgetLimit: c.budgetLimit,
        budgetSpent: c.budgetSpent,
        scheduledAt: c.scheduledAt,
        counts: c.stats.counts,
      })),
    };
  },
});

registerTool({
  name: 'getCampaignStats',
  description:
    'Devuelve el progreso de una campaña: destinatarios por estado, presupuesto gastado y ensayo.',
  category: 'communication',
  enabledByDefault: true,
  requiredPermission: 'campaigns.view',
  effect: 'read',
  parameters: z.object({ campaignId: campaignIdSchema }),
  execute: async (actor, rawArgs) => {
    const { campaignId } = rawArgs as { campaignId: string };
    const c = await getCampaign(actor, campaignId);
    return {
      id: c.id,
      name: c.name,
      channel: c.channel,
      status: c.status,
      audienceCount: c.audience?.count ?? null,
      counts: c.stats.counts,
      total: c.stats.total,
      budgetLimit: c.budgetLimit,
      budgetSpent: c.budgetSpent,
      costPerMessage: c.costPerMessage,
      estimatedCost: c.estimatedCost,
      rehearsal: c.stats.rehearsal ?? null,
      pauseReason: c.stats.pauseReason ?? null,
      scheduledAt: c.scheduledAt,
      startedAt: c.startedAt,
      completedAt: c.completedAt,
    };
  },
});

registerTool({
  name: 'draftCampaignContent',
  description:
    'Redacta o revisa el contenido de una campaña con variables {{nombre}}, {{primer_nombre}}, {{telefono}}, {{email}} y muestra cómo se vería. Si se indica campaignId, guarda el contenido en el borrador (no lo congela ni envía).',
  category: 'communication',
  enabledByDefault: true,
  requiredPermission: 'campaigns.manage',
  effect: 'draft',
  parameters: contentSchema.extend({ campaignId: campaignIdSchema.optional() }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as z.infer<typeof contentSchema> & { campaignId?: string };
    const variables = extractVariables(args.body);
    const sample = renderTemplate(args.body, {
      ...args.variables,
      nombre: 'María López',
      primer_nombre: 'María',
      telefono: '+52••••••1234',
      email: 'maria@ejemplo.com',
    });
    let saved: { campaignId: string; status: string } | null = null;
    if (args.campaignId) {
      const updated = await updateCampaign(actor, args.campaignId, {
        content: { body: args.body, templateKey: args.templateKey, variables: args.variables },
      });
      saved = { campaignId: updated.id, status: updated.status };
    }
    return {
      body: args.body,
      variables,
      unresolved: sample.missing,
      samplePreview: sample.text,
      saved,
      note: 'Contenido en borrador. Para enviar: congelar, ensayar y aprobar por una persona.',
    };
  },
});

registerTool({
  name: 'createCampaignDraft',
  description:
    'Crea una campaña en BORRADOR (canal, cuenta, filtro de audiencia por etiquetas, contenido, presupuesto). No congela ni envía nada.',
  category: 'communication',
  enabledByDefault: true,
  requiredPermission: 'campaigns.manage',
  effect: 'internal_task',
  parameters: createCampaignSchema,
  execute: async (actor, args) => {
    const campaign = await createCampaign(actor, args);
    return {
      campaignId: campaign.id,
      status: campaign.status,
      channel: campaign.channel,
      accountLabel: campaign.accountLabel,
      note: 'Borrador creado. Siguiente paso: congelar audiencia y contenido, ensayar y solicitar aprobación.',
    };
  },
});

const approveArgsSchema = z.object({
  campaignId: campaignIdSchema,
  name: z.string().min(1).max(120).describe('Nombre de la campaña tal como aparece en UNIK'),
  audienceCount: z.number().int().min(1).describe('Destinatarios congelados (de getCampaignStats)'),
  estimatedCost: z.string().min(1).describe('Costo estimado (cadena decimal, de getCampaignStats)'),
  scheduledAt: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe('Fecha/hora ISO de inicio; vacío = ahora'),
  allowPartialBudget: z.boolean().default(false),
});

registerTool({
  name: 'approveCampaign',
  description:
    'Aprueba y programa el envío masivo real de una campaña congelada y ensayada. Siempre requiere la aprobación explícita de una persona con permiso campaigns.approve (propuesta en el chat).',
  category: 'communication',
  enabledByDefault: true,
  requiredPermission: 'campaigns.approve',
  effect: 'business_write',
  approvalPolicy: 'require_approval',
  parameters: approveArgsSchema,
  summarize: (args) => {
    const a = args as z.infer<typeof approveArgsSchema>;
    return `Enviar campaña "${a.name}" a ${a.audienceCount} destinatarios (costo estimado ${a.estimatedCost})${a.scheduledAt ? ` a partir de ${a.scheduledAt}` : ' de inmediato'}`;
  },
  execute: async (actor, rawArgs) => {
    const args = rawArgs as z.infer<typeof approveArgsSchema>;
    const current = await getCampaign(actor, args.campaignId);
    if (current.name !== args.name) {
      throw new CampaignError('El nombre de la propuesta no coincide con la campaña', 409);
    }
    if ((current.audience?.count ?? 0) !== args.audienceCount) {
      throw new CampaignError('La audiencia cambió desde que se propuso la aprobación', 409);
    }
    const approved = await approveCampaign(actor, args.campaignId, {
      scheduledAt: args.scheduledAt,
      allowPartialBudget: args.allowPartialBudget,
    });
    return { campaignId: approved.id, status: approved.status, scheduledAt: approved.scheduledAt };
  },
});
