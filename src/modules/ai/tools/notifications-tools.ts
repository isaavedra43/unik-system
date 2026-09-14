import { z } from 'zod';
import { registerTool } from './registry';
import { findUsersByQuery } from '@/modules/notifications/audience';
import { notifyUser } from '@/modules/notifications/notification-service';
import { getNotificationSettings } from '@/modules/notifications/preferences-service';
import { NOTIFICATION_CATALOG } from '@/modules/notifications/catalog';

/**
 * Notifications from the assistant: "avísale a Karla que la OV-1234 ya se
 * pagó". The recipient gets an in-app notification and a push on their phone,
 * attributed to the requesting user. Internal effect: no approval card.
 */

registerTool({
  name: 'findUsers',
  description:
    'Busca usuarios de UNIK por nombre, usuario o email para dirigirles un aviso, un mensaje o una llamada interna. Devuelve id, nombre y usuario.',
  category: 'system',
  enabledByDefault: true,
  effect: 'read',
  contextTags: ['all'],
  parameters: z.object({
    query: z.string().min(1).max(80).describe('Nombre, usuario o email (parcial)'),
  }),
  execute: async (actor, rawArgs) => {
    const { query } = rawArgs as { query: string };
    const users = await findUsersByQuery(query, { excludeUserId: actor.id, limit: 10 });
    return { users, count: users.length };
  },
});

const notifyArgs = z.object({
  to: z
    .array(z.string().min(1).max(120))
    .min(1)
    .max(20)
    .describe('Destinatarios: nombre, usuario, email o id de usuario. Uno o varios.'),
  message: z.string().min(1).max(600).describe('Texto del aviso (claro y corto, en español)'),
  title: z.string().max(120).optional().describe('Título opcional. Por defecto: "<tu nombre> te avisa"'),
  url: z
    .string()
    .max(500)
    .optional()
    .describe('Ruta interna a abrir al tocar el aviso (ej. /app/sales/orders/abc). Solo rutas de UNIK.'),
  urgent: z.boolean().optional().describe('true = ignora horario silencioso y muteos del destinatario'),
});

registerTool({
  name: 'notifyUser',
  description:
    'Envía un aviso (notificación en la app + push al teléfono) a uno o varios usuarios de UNIK de parte del usuario actual. Úsalo cuando te pidan "avísale a…", "notifica a…", "dile a … que…". No sirve para clientes externos (para eso usa WhatsApp/SMS).',
  category: 'communication',
  enabledByDefault: true,
  effect: 'internal_task',
  contextTags: ['all'],
  parameters: notifyArgs,
  summarize: (args) => {
    const a = args as z.infer<typeof notifyArgs>;
    return `Avisar a ${a.to.join(', ')}: "${a.message.slice(0, 80)}"`;
  },
  execute: async (actor, rawArgs) => {
    const args = notifyArgs.parse(rawArgs);
    const url = args.url && args.url.startsWith('/app') ? args.url : null;
    const resolved: Array<{ query: string; user: { id: string; name: string; username: string } | null; candidates?: string[] }> = [];
    for (const query of args.to) {
      const matches = await findUsersByQuery(query, { excludeUserId: actor.id, limit: 5 });
      const byId = matches.find((u) => u.id === query);
      if (byId) resolved.push({ query, user: byId });
      else if (matches.length === 1) resolved.push({ query, user: matches[0] });
      else resolved.push({ query, user: null, candidates: matches.map((u) => `${u.name} (@${u.username})`) });
    }

    const ambiguous = resolved.filter((r) => !r.user);
    if (ambiguous.length > 0) {
      return {
        sent: [],
        error: 'No pude identificar a todos los destinatarios. Pregunta al usuario a quién se refiere.',
        unresolved: ambiguous.map((r) => ({ query: r.query, candidates: r.candidates ?? [] })),
      };
    }

    const sent: Array<{ userId: string; name: string; inApp: boolean; push: boolean }> = [];
    for (const r of resolved) {
      const user = r.user!;
      const result = await notifyUser({
        userId: user.id,
        actorUserId: actor.id,
        category: 'ai_user_message',
        title: args.title?.trim() || `${actor.name} te avisa`,
        body: args.message,
        url,
        metadata: { fromUserId: actor.id, fromName: actor.name, urgent: Boolean(args.urgent) },
        push: {
          tag: `ai-msg:${actor.id}:${user.id}`,
          renotify: true,
          urgency: args.urgent ? 'high' : 'normal',
          requireInteraction: Boolean(args.urgent),
        },
      });
      sent.push({ userId: user.id, name: user.name, inApp: result.inApp, push: result.push });
    }
    return {
      sent,
      note: 'Aviso registrado en la app de cada destinatario; el push llega si tienen notificaciones activas en su teléfono.',
    };
  },
});

registerTool({
  name: 'getMyNotificationSettings',
  description:
    'Muestra la configuración de notificaciones del usuario actual (push activo, horario silencioso, categorías). Para cambiarla, indícale que vaya a /app/account/notifications.',
  category: 'system',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({}),
  execute: async (actor) => {
    const settings = await getNotificationSettings(actor.id);
    return {
      pushEnabled: settings.pushEnabled,
      quietHours:
        settings.quietHoursStart !== null && settings.quietHoursEnd !== null
          ? `${settings.quietHoursStart}:00 – ${settings.quietHoursEnd}:00 (${settings.timezone})`
          : null,
      mutedUntil: settings.mutedUntil,
      categories: NOTIFICATION_CATALOG.map((c) => ({
        key: c.key,
        label: c.label,
        ...settings.categories[c.key],
      })),
      settingsUrl: '/app/account/notifications',
    };
  },
});
