import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool, type ToolEffect } from './registry';
import { getAiSettings } from '../ai-admin-config-service';
import {
  acquireVenue, emitVenueEvent, isVenueEnabled,
  listBrowserProfiles, loadBrowserProfileState, saveBrowserProfile,
  VenueUnavailableError,
} from '@/modules/venues/venue-manager';
import { isUrlDenied } from '@/modules/web/fetch-service';
import type { BrowserActInput, BrowserActResult, DesktopActInput } from '@/modules/venues/venue';
import { shq } from '@/modules/venues/daytona-venue';

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
  // Page JS can submit forms or trigger payments — same gate as submit.
  if (action === 'evaluate' || action === 'upload') return 'external_send';
  if (a.intent && RISKY_INTENTS.has(String(a.intent).toLowerCase())) return 'external_send';
  return 'read';
}

const secureFieldSchema = z
  .object({
    selector: z.string().min(1).max(500).optional().describe('Selector CSS del campo'),
    ref: z.number().int().min(1).max(2000).optional().describe('Número del campo según el último snapshot'),
    label: z.string().min(1).max(200).describe('Etiqueta que verá el usuario (p. ej. "Correo de Amazon")'),
    sensitive: z.boolean().optional().describe('true = contraseña/tarjeta — se muestra enmascarado'),
  })
  .refine((f) => Boolean(f.selector) || typeof f.ref === 'number', {
    message: 'Cada campo necesita selector o ref',
  });

const browserParams = z.object({
  action: z.enum([
    'open', 'snapshot', 'click', 'type', 'select', 'hover', 'press', 'scroll',
    'back', 'forward', 'reload', 'extract', 'screenshot', 'pdf', 'tabs', 'newTab',
    'switchTab', 'closeTab', 'waitFor', 'submit', 'console', 'evaluate', 'upload', 'secureInput',
  ]),
  url: z.string().max(2000).optional().describe('open/newTab: URL o dominio (ej. "proveedor.com")'),
  ref: z.number().int().min(1).max(2000).optional().describe('Número del elemento según el último snapshot (preferido)'),
  target: z.string().max(200).optional().describe('Texto visible del elemento cuando no tienes ref'),
  selector: z.string().max(500).optional().describe('Selector CSS (último recurso)'),
  text: z.string().max(4000).optional().describe('type: texto a escribir'),
  value: z.string().max(300).optional().describe('select: opción (etiqueta o valor)'),
  key: z.string().max(50).optional().describe('press: tecla (Enter, Tab, Escape, ArrowDown…)'),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  amount: z.number().int().min(50).max(4000).optional(),
  extractMode: z.string().max(500).optional().describe("extract: 'readable' (default) o selector CSS"),
  script: z.string().max(4000).optional().describe('evaluate: expresión JS que corre en la página (pruebas/QA)'),
  files: z.array(z.string().max(500)).max(10).optional().describe('upload: rutas de archivos dentro de la computadora virtual'),
  tabId: z.string().max(20).optional(),
  timeoutMs: z.number().int().min(1000).max(60_000).optional(),
  look: z.boolean().optional().describe('true = además de la acción, mira la pantalla (modelos con visión)'),
  intent: z
    .string()
    .max(40)
    .optional()
    .describe('Qué intenta la acción (send/pay/purchase/publish/delete la marcan para aprobación)'),
  /** secureInput: campos que el USUARIO escribe en un formulario seguro del panel. Nunca pasan por ti ni por el chat. */
  fields: z.array(secureFieldSchema).min(1).max(8).optional(),
  message: z.string().max(500).optional().describe('secureInput: instrucción breve para el usuario'),
});

registerTool({
  name: 'browser',
  description:
    'Navegador web real (Chromium) dentro de la computadora virtual; el usuario lo ve en vivo en su panel. ' +
    'Flujo: open {url} → snapshot (devuelve los elementos interactivos numerados [ref] y el texto de la página) → ' +
    'click/type/select con {ref} → snapshot otra vez para ver el resultado. Usa extract para leer artículos largos, ' +
    'screenshot para mirar la pantalla (si tu modelo tiene visión), console para errores de la página (pruebas/QA), ' +
    'evaluate para pruebas con JS, upload para subir archivos del sandbox, tabs/switchTab/newTab para pestañas, pdf para guardar la página. ' +
    'Las acciones que envían/publican/compran (submit o intent send|pay|purchase|publish|delete) requieren aprobación. ' +
    'Si la página pide login, tarjeta u otro dato sensible usa action=secureInput con los campos (ref o selector): el usuario lo escribe en un formulario seguro de su panel y se teclea directo en la página — nunca pasa por ti ni por el chat; dile que lo escriba en "Espacio de trabajo" y no continúes hasta que confirme. ' +
    'Si un ref ya no existe, toma otro snapshot.',
  category: 'venue',
  enabledByDefault: false,
  requiredPermission: 'browser.use',
  resultTrust: 'untrusted',
  timeoutMs: 300_000,
  maxResultBytes: 60_000,
  contextTags: ['all'],
  // Browser rides on the venue like exec/files do — the old `browserEnabled`
  // flag was a trap: a full-settings admin save persisted `false` and hid the
  // tool forever while exec kept working. Risky actions still gate on intent.
  isAvailable: isVenueEnabled,
  parameters: browserParams,
  resolveEffect: (_actor, args) => browserEffect(args),
  summarize: (a) => {
    const p = a as { action: string; url?: string; selector?: string; intent?: string; fields?: { label: string }[] };
    if (p.action === 'secureInput') {
      return `Solicitud de datos seguros: ${(p.fields ?? []).map((f) => f.label).join(', ')}`;
    }
    const q = p as { ref?: number; target?: string };
    const target = p.url ?? (q.ref ? `#${q.ref}` : undefined) ?? q.target ?? p.selector ?? '';
    return `Navegador: ${p.action}${target ? ` ${target}` : ''}${p.intent ? ` (${p.intent})` : ''}`;
  },
  prepareArgs: async (_actor, args) => {
    const p = args as { action: string; url?: string };
    if (p.url) {
      // Bare domains are fine for the model to write ("proveedor.com").
      if (!/^https?:\/\//i.test(p.url)) {
        p.url = /^localhost(:\d+)?/i.test(p.url) ? `http://${p.url}` : `https://${p.url}`;
      }
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
      fields?: { selector?: string; ref?: number; label: string; sensitive?: boolean }[];
      message?: string;
      look?: boolean;
    };
    try {
      const venue = await acquireVenue({ userId: actor.id, purpose: 'browser' });

      // secureInput — user takeover: the model declares which page fields it
      // needs; the user types the values in a masked form in their workspace
      // panel; a dedicated route types them into the page via useCredential.
      // Values never pass through the model, the chat log or this result.
      if (input.action === 'secureInput') {
        const fields = (
          (input.fields ?? []) as { selector?: string; ref?: number; label: string; sensitive?: boolean }[]
        ).slice(0, 8);
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

      const { look: _look, ...actInput } = input;
      void _look;
      const result = await venue.browserAct(actInput);
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
  isAvailable: isVenueEnabled,
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
    'Terminal Linux DENTRO de la computadora virtual (sandbox desechable, nunca en el servidor): git, node/npm, python/pip, builds, pruebas, procesamiento de archivos, descargas. ' +
    'Para programar: clona o crea el proyecto en ~/proyectos, escribe archivos con venueWriteFile, corre pruebas aquí. ' +
    'Procesos largos (servidor de desarrollo, "npm run dev") van con background:true y luego venuePreview para verlos en vivo. ' +
    'El usuario ve cada comando y su salida en su panel.',
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
    background: z
      .boolean()
      .optional()
      .describe('true = proceso que sigue corriendo (servidor dev); devuelve pid y ruta del log'),
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
    const { command, cwd, timeoutSec, background } = args as {
      command: string;
      cwd?: string;
      timeoutSec?: number;
      background?: boolean;
    };
    const venue = await acquireVenue({ userId: actor.id, purpose: 'exec' });
    if (background) {
      const log = `/tmp/unik/bg-${Date.now()}.log`;
      const res = await venue.exec(
        `mkdir -p /tmp/unik && nohup sh -c ${shq(command)} > ${log} 2>&1 & echo "UNIK_PID=$!"; sleep 3; tail -20 ${log}`,
        { cwd, timeoutSec: 20 }
      );
      const pid = /UNIK_PID=(\d+)/.exec(res.stdout)?.[1] ?? null;
      await emitVenueEvent(venue.id, 'exec', { command: command.slice(0, 200), background: true });
      return {
        background: true,
        pid,
        log,
        output: res.stdout.replace(/UNIK_PID=\d+\n?/, ''),
        note: `Proceso en segundo plano. Revisa su salida con venueExec "tail -40 ${log}"; si sirve una web, usa venuePreview con su puerto.`,
      };
    }
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

registerTool({
  name: 'computer',
  description:
    'Escritorio Linux REAL de la computadora virtual (distinto del navegador): ventanas, apps, terminal gráfica, gestor de archivos. ' +
    'Cada acción devuelve la pantalla (la ves si tu modelo tiene visión). Coordenadas en píxeles de esa pantalla. ' +
    'Acciones: screenshot, click/doubleClick/rightClick {x,y}, move, drag {x,y,toX,toY}, scroll {x,y,direction}, type {text}, key {key: "enter"|"ctrl+c"…}, ' +
    'openApp {command: "xfce4-terminal"|"firefox"|"thunar"|"libreoffice"…}, windows (lista ventanas), find {role,name} (árbol de accesibilidad → ids), invoke/setValue {nodeId}, wait {seconds}. ' +
    'Para páginas web usa la tool browser (más rápida y precisa); usa computer para apps de escritorio o cuando el usuario pida ver/usar la computadora.',
  category: 'venue',
  enabledByDefault: true,
  requiredPermission: 'browser.use',
  resultTrust: 'untrusted',
  timeoutMs: 180_000,
  maxResultBytes: 6_000_000,
  contextTags: ['all'],
  isAvailable: isVenueEnabled,
  parameters: z.object({
    action: z.enum([
      'screenshot', 'click', 'doubleClick', 'rightClick', 'move', 'drag', 'scroll', 'type', 'key',
      'hotkey', 'openApp', 'windows', 'find', 'invoke', 'setValue', 'wait',
    ]),
    x: z.number().min(0).max(8000).optional(),
    y: z.number().min(0).max(8000).optional(),
    toX: z.number().min(0).max(8000).optional(),
    toY: z.number().min(0).max(8000).optional(),
    direction: z.enum(['up', 'down']).optional(),
    amount: z.number().int().min(1).max(20).optional(),
    text: z.string().max(4000).optional(),
    key: z.string().max(40).optional(),
    command: z.string().max(500).optional(),
    role: z.string().max(60).optional(),
    name: z.string().max(200).optional(),
    nodeId: z.string().max(200).optional(),
    value: z.string().max(2000).optional(),
    seconds: z.number().min(0.2).max(10).optional(),
  }),
  // Operating a desktop is like browsing: reading/clicking is audited but free;
  // anything that sends/pays still goes through the browser/Composio gates.
  resolveEffect: () => 'internal_task',
  summarize: (a) => {
    const p = a as { action: string; x?: number; y?: number; text?: string; command?: string };
    if (p.action === 'openApp') return `Computadora: abrir ${p.command ?? 'app'}`;
    if (p.action === 'type') return `Computadora: escribir "${String(p.text ?? '').slice(0, 40)}"`;
    if (typeof p.x === 'number') return `Computadora: ${p.action} (${p.x}, ${p.y})`;
    return `Computadora: ${p.action}`;
  },
  execute: async (actor, args) => {
    try {
      const venue = await acquireVenue({ userId: actor.id, purpose: 'desktop' });
      const res = await venue.desktopAct(args as DesktopActInput);
      await emitVenueEvent(venue.id, 'desktop_action', {
        action: (args as { action: string }).action,
        ok: res.ok,
        error: res.error ?? null,
      });
      return res.ok
        ? { ...res, screen: res.width && res.height ? `${res.width}x${res.height}` : undefined }
        : { ok: false, error: res.error };
    } catch (err) {
      if (err instanceof VenueUnavailableError) return { error: err.message };
      throw err;
    }
  },
});

registerTool({
  name: 'venuePreview',
  description:
    'Publica temporalmente (hasta 24 h) un puerto de la computadora virtual como URL privada firmada — para que el usuario vea en vivo la web/app que estás construyendo (npm run dev en background). ' +
    'Para revisarla tú mismo, abre http://localhost:PUERTO con la tool browser. Para publicar un sitio de forma permanente usa publishSite.',
  category: 'venue',
  enabledByDefault: true,
  requiredPermission: 'venue.exec',
  resultTrust: 'untrusted',
  timeoutMs: 60_000,
  contextTags: ['all'],
  isAvailable: isVenueEnabled,
  parameters: z.object({
    port: z.number().int().min(1024).max(65535),
    hours: z.number().min(0.1).max(24).optional().describe('Validez del enlace (default 2 h)'),
    label: z.string().max(80).optional().describe('Nombre de lo que se muestra (ej. "Tienda — versión 1")'),
  }),
  resolveEffect: () => 'internal_task',
  summarize: (a) => `Vista previa del puerto ${(a as { port: number }).port}`,
  execute: async (actor, args) => {
    const { port, hours, label } = args as { port: number; hours?: number; label?: string };
    try {
      const venue = await acquireVenue({ userId: actor.id, purpose: 'preview' });
      const url = await venue.previewUrl(port, Math.round((hours ?? 2) * 3600));
      await emitVenueEvent(venue.id, 'preview', { port });
      return {
        url,
        port,
        label: label ?? `Puerto ${port}`,
        expiresInHours: hours ?? 2,
        note: 'Comparte este enlace con el usuario; expira. Si la página no carga, verifica que el servidor escuche en 0.0.0.0.',
      };
    } catch (err) {
      if (err instanceof VenueUnavailableError) return { error: err.message };
      return { error: err instanceof Error ? err.message : 'No se pudo crear la vista previa' };
    }
  },
});
