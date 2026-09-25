import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool, type ToolEffect } from './registry';
import { getAiSettings } from '../ai-admin-config-service';
import {
  acquireVenue, emitVenueEvent, isVenueEnabled, isBrowserToolEnabled,
  listBrowserProfiles, loadBrowserProfileState, saveBrowserProfile,
  VenueUnavailableError,
} from '@/modules/venues/venue-manager';
import { isUrlDenied } from '@/modules/web/fetch-service';
import type { BrowserActInput, BrowserActResult } from '@/modules/venues/venue';

/**
 * Venue + browser tools — the agent's hands inside a disposable computer.
 *
 * Filters applied here (server-side, the model never decides them):
 *   - acquireVenue enforces venueEnabled, UNIK_VENUE_ENABLED, concurrency
 *     and the daily minutes budget — every call.
 *   - `browser` resolveEffect: navigate/read are free; click/type/press are
 *     read-but-audited; submit/intent=send|pay|purchase|publish|delete and
 *     credential use produce AiProposal (byte-bound approval).
 *   - `browser` also re-validates `open` URLs against the web deny/allowlist.
 *   - `venueExec` resolveEffect runs the Jev exfiltration screen — flagged
 *     commands are promoted to external_send (approval required).
 *   - `browserProfile` save/use always require approval; the storageState is
 *     AES-256-GCM ciphertext at rest and never enters prompts or logs.
 *   - every result is resultTrust:'untrusted' — wrapped before the model.
 */

const RISKY_INTENTS = new Set(['send', 'pay', 'purchase', 'publish', 'delete', 'post', 'buy']);

function browserEffect(args: unknown): ToolEffect {
  const a = args as { action?: string; intent?: string };
  const action = a.action ?? 'open';
  if (action === 'submit' || action === 'useCredential') return 'external_send';
  if (a.intent && RISKY_INTENTS.has(String(a.intent).toLowerCase())) return 'external_send';
  return 'read';
}

const secureFieldSchema = z.object({
  selector: z.string().min(1).max(500).describe('Selector CSS del campo en la página'),
  label: z.string().min(1).max(200).describe('Etiqueta que verá el usuario (p. ej. "Correo de Amazon")'),
  sensitive: z.boolean().optional().describe('true = contraseña/tarjeta — se muestra enmascarado'),
});

const browserParams = z.object({
  action: z.enum([
    'open', 'back', 'forward', 'click', 'type', 'press', 'scroll',
    'extract', 'screenshot', 'pdf', 'tabs', 'newTab', 'closeTab',
    'waitFor', 'submit', 'secureInput',
  ]),
  url: z.string().url().max(2000).optional(),
  selector: z.string().max(500).optional(),
  text: z.string().max(4000).optional(),
  key: z.string().max(50).optional(),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  amount: z.number().int().min(50).max(3000).optional(),
  extractMode: z.string().max(500).optional(),
  tabId: z.string().max(20).optional(),
  timeoutMs: z.number().int().min(1000).max(60_000).optional(),
  intent: z.string().max(40).optional().describe('Qué intenta la acción (send/pay/purchase/publish/delete la marcan para aprobación)'),
  /** secureInput: campos que el USUARIO escribe en un formulario seguro del panel. Nunca pasan por ti ni por el chat. */
  fields: z.array(secureFieldSchema).min(1).max(8).optional(),
  message: z.string().max(500).optional().describe('secureInput: instrucción breve para el usuario'),
});

registerTool({
  name: 'browser',
  description:
    'Opera un navegador dentro de la computadora virtual: abrir páginas, hacer click, escribir, extraer contenido, screenshots, PDF. Las acciones que envían/publican/compran requieren aprobación del usuario. Cuando la página pida login, tarjeta u otro dato sensible usa action=secureInput: el usuario lo escribe en un formulario seguro de su panel y se teclea directo en la página — nunca pasa por ti ni por el chat. Tras pedirlo, dile que lo escriba en el panel "Espacio de trabajo" y que te avise; no continúes hasta que confirme.',
  category: 'venue',
  enabledByDefault: false,
  requiredPermission: 'browser.use',
  resultTrust: 'untrusted',
  timeoutMs: 300_000,
  maxResultBytes: 60_000,
  contextTags: ['all'],
  isAvailable: isBrowserToolEnabled,
  parameters: browserParams,
  resolveEffect: (_actor, args) => browserEffect(args),
  summarize: (a) => {
    const p = a as { action: string; url?: string; selector?: string; intent?: string; fields?: { label: string }[] };
    if (p.action === 'secureInput') {
      return `Solicitud de datos seguros: ${(p.fields ?? []).map((f) => f.label).join(', ')}`;
    }
    const target = p.url ?? p.selector ?? '';
    return `Navegador: ${p.action}${target ? ` ${target}` : ''}${p.intent ? ` (${p.intent})` : ''}`;
  },
  prepareArgs: async (_actor, args) => {
    const p = args as { action: string; url?: string };
    if (p.url) {
      const settings = await getAiSettings();
      const denied = isUrlDenied(
        p.url,
        (settings.webDomainAllowlist ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean),
        (settings.webDomainDenylist ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean)
      );
      if (denied) return { error: denied };
    }
    return { args };
  },
  execute: async (actor, args) => {
    const input = args as BrowserActInput & {
      fields?: { selector: string; label: string; sensitive?: boolean }[];
      message?: string;
    };
    try {
      const venue = await acquireVenue({ userId: actor.id, purpose: 'browser' });

      // secureInput — user takeover: the model declares which page fields it
      // needs; the user types the values in a masked form in their workspace
      // panel; a dedicated route types them into the page via useCredential.
      // Values never pass through the model, the chat log or this result.
      if (input.action === 'secureInput') {
        const fields = (input.fields ?? []).slice(0, 8);
        if (fields.length === 0) return { error: 'fields requerido para secureInput' };
        const requestId = crypto.randomUUID();
        const session = await prisma.venueSession.findUnique({ where: { id: venue.id } });
        const meta = (session?.metadata as Record<string, unknown> | null) ?? {};
        const cutoff = Date.now() - 30 * 60_000;
        const pending = [
          ...((meta.pendingSecureInputs as { id: string; ts: string }[] | undefined) ?? [])
            .filter((r) => new Date(r.ts).getTime() > cutoff),
          {
            id: requestId,
            fields,
            message: input.message ?? null,
            ts: new Date().toISOString(),
          },
        ].slice(-5);
        await prisma.venueSession.update({
          where: { id: venue.id },
          data: { metadata: { ...meta, pendingSecureInputs: pending } },
        });
        await emitVenueEvent(venue.id, 'secure_input_request', { requestId, fields: fields.length });
        return {
          awaitingUserInput: true,
          inputRequest: { id: requestId, fields, message: input.message ?? null },
          venueSessionId: venue.id,
          note: 'El usuario debe escribir los datos en el formulario seguro de su panel "Espacio de trabajo". No continúes hasta que confirme.',
        };
      }

      const result = await venue.browserAct(input);
      await emitVenueEvent(venue.id, 'browser_action', {
        action: input.action,
        url: result.url,
        ok: result.ok,
        error: result.error ?? null,
      });
      // Secret material never leaves in the result.
      const safeResult = { ...(result as BrowserActResult & { stateJson?: string }) };
      delete safeResult.stateJson;
      return safeResult;
    } catch (err) {
      if (err instanceof VenueUnavailableError) return { error: err.message };
      throw err;
    }
  },
});

registerTool({
  name: 'browserProfile',
  description:
    'Gestiona perfiles de navegador por sitio (sesión iniciada): list guarda los perfiles del usuario, save guarda la sesión actual de un host, use la restaura. Guardar/usar perfiles siempre pide aprobación.',
  category: 'venue',
  enabledByDefault: false,
  requiredPermission: 'browser.use',
  resultTrust: 'untrusted',
  timeoutMs: 300_000,
  contextTags: ['all'],
  isAvailable: isBrowserToolEnabled,
  parameters: z.object({
    action: z.enum(['list', 'save', 'use']),
    host: z.string().max(200).optional().describe('Dominio del perfil, p. ej. fleet.ejemplo.mx'),
    name: z.string().max(100).optional().describe('Nombre humano del perfil (para save)'),
  }),
  resolveEffect: (_actor, args) => ((args as { action?: string }).action === 'list' ? 'read' : 'external_send'),
  summarize: (a) => {
    const p = a as { action: string; host?: string; name?: string };
    return p.action === 'list'
      ? 'Listar perfiles de navegador'
      : p.action === 'save'
        ? `Guardar sesión de navegador de ${p.host ?? '?'} como "${p.name ?? '?'}"`
        : `Restaurar sesión de navegador en ${p.host ?? '?'}`;
  },
  execute: async (actor, args) => {
    const p = args as { action: 'list' | 'save' | 'use'; host?: string; name?: string };
    if (p.action === 'list') {
      return { profiles: await listBrowserProfiles(actor.id) };
    }
    const host = (p.host ?? '').trim().toLowerCase();
    if (!host) return { error: 'host requerido' };
    const venue = await acquireVenue({ userId: actor.id, purpose: 'browser-profile' });

    if (p.action === 'save') {
      const captured = await venue.browserAct({ action: 'captureState' });
      if (!captured.ok || !captured.stateJson) {
        return { error: captured.error ?? 'No se pudo capturar el estado del navegador' };
      }
      await saveBrowserProfile({ userId: actor.id, name: p.name?.trim() || host, host, stateJson: captured.stateJson });
      await emitVenueEvent(venue.id, 'profile_saved', { host });
      return { saved: true, host, name: p.name?.trim() || host };
    }

    // use — restore an encrypted profile into the live context.
    const profile = await loadBrowserProfileState(actor.id, host);
    if (!profile) return { error: `No hay perfil guardado para ${host}` };
    const applied = await venue.browserAct({ action: 'applyState', stateJson: profile.stateJson });
    if (!applied.ok) return { error: applied.error ?? 'No se pudo aplicar el perfil' };
    await emitVenueEvent(venue.id, 'profile_applied', { host });
    return { applied: true, host };
  },
});

registerTool({
  name: 'venueExec',
  description:
    'Ejecuta un comando de shell DENTRO de la computadora virtual (sandbox desechable, nunca en el servidor). Para scripts, builds, procesamiento de archivos.',
  category: 'venue',
  enabledByDefault: false,
  requiredPermission: 'venue.exec',
  resultTrust: 'untrusted',
  timeoutMs: 320_000,
  maxResultBytes: 64_000,
  contextTags: ['all'],
  isAvailable: isVenueEnabled,
  parameters: z.object({
    command: z.string().min(1).max(4000),
    cwd: z.string().max(500).optional(),
    timeoutSec: z.number().int().min(1).max(300).optional(),
  }),
  resolveEffect: async (_actor, args) => {
    // Jev screens for exfiltration/external effects — flagged commands need approval.
    const { command, cwd } = args as { command: string; cwd?: string };
    try {
      const { decide, answerBool } = await import('../decisions/decision-engine');
      const { execRiskDecision } = await import('../decisions/decision-points');
      const gate = execRiskDecision(command, cwd);
      const result = await decide(gate.state, gate.questions, {});
      if (answerBool(result, 'external_effect') === true) return 'external_send';
    } catch {
      // Jev down → keep default internal_task (sandbox is disposable anyway).
    }
    return 'internal_task';
  },
  summarize: (a) => `Ejecutar en computadora virtual: ${(a as { command: string }).command.slice(0, 120)}`,
  execute: async (actor, args) => {
    const { command, cwd, timeoutSec } = args as { command: string; cwd?: string; timeoutSec?: number };
    const venue = await acquireVenue({ userId: actor.id, purpose: 'exec' });
    const res = await venue.exec(command, { cwd, timeoutSec });
    await emitVenueEvent(venue.id, 'exec', { command: command.slice(0, 200), exitCode: res.exitCode });
    return { exitCode: res.exitCode, output: res.stdout };
  },
});

registerTool({
  name: 'venueReadFile',
  description: 'Lee un archivo del workspace de la computadora virtual.',
  category: 'venue',
  enabledByDefault: false,
  requiredPermission: 'venue.files',
  resultTrust: 'untrusted',
  timeoutMs: 90_000,
  maxResultBytes: 200_000,
  contextTags: ['all'],
  isAvailable: isVenueEnabled,
  parameters: z.object({ path: z.string().min(1).max(1000) }),
  summarize: (a) => `Leer archivo del venue: ${(a as { path: string }).path}`,
  execute: async (actor, args) => {
    const venue = await acquireVenue({ userId: actor.id, purpose: 'files' });
    const content = await venue.readFile((args as { path: string }).path);
    return { path: (args as { path: string }).path, content };
  },
});

registerTool({
  name: 'venueListFiles',
  description: 'Lista archivos y carpetas de un directorio en la computadora virtual.',
  category: 'venue',
  enabledByDefault: false,
  requiredPermission: 'venue.files',
  resultTrust: 'untrusted',
  timeoutMs: 90_000,
  contextTags: ['all'],
  isAvailable: isVenueEnabled,
  parameters: z.object({ path: z.string().min(1).max(1000).default('/') }),
  summarize: (a) => `Listar archivos del venue: ${(a as { path: string }).path}`,
  execute: async (actor, args) => {
    const venue = await acquireVenue({ userId: actor.id, purpose: 'files' });
    return { files: await venue.listFiles((args as { path: string }).path) };
  },
});

registerTool({
  name: 'venueWriteFile',
  description: 'Escribe un archivo en el workspace de la computadora virtual (máx 2MB).',
  category: 'venue',
  enabledByDefault: false,
  requiredPermission: 'venue.files',
  resultTrust: 'untrusted',
  timeoutMs: 90_000,
  contextTags: ['all'],
  isAvailable: isVenueEnabled,
  parameters: z.object({
    path: z.string().min(1).max(1000),
    content: z.string().max(2_000_000),
  }),
  summarize: (a) => `Escribir archivo en el venue: ${(a as { path: string }).path}`,
  execute: async (actor, args) => {
    const { path: p, content } = args as { path: string; content: string };
    const venue = await acquireVenue({ userId: actor.id, purpose: 'files' });
    await venue.writeFile(p, content);
    await emitVenueEvent(venue.id, 'file_write', { path: p, bytes: content.length });
    return { written: true, path: p, bytes: content.length };
  },
});

registerTool({
  name: 'venueScreenshot',
  description: 'Captura la pantalla de la computadora virtual (qué ve el agente ahora mismo).',
  category: 'venue',
  enabledByDefault: false,
  requiredPermission: 'browser.use',
  resultTrust: 'untrusted',
  timeoutMs: 120_000,
  maxResultBytes: 8_000_000,
  contextTags: ['all'],
  isAvailable: isVenueEnabled,
  parameters: z.object({}),
  summarize: () => 'Capturar pantalla de la computadora virtual',
  execute: async (actor) => {
    const venue = await acquireVenue({ userId: actor.id, purpose: 'screenshot' });
    const shot = await venue.screenshot();
    await emitVenueEvent(venue.id, 'screenshot', {});
    return { imageBase64: shot.imageBase64, mimeType: shot.mimeType };
  },
});
