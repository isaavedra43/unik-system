import { z } from 'zod';
import { registerTool } from './registry';

/**
 * renderInteractiveUi — the agent's freeform canvas ("Open Generative UI" pattern,
 * implemented natively so it stays inside UNIK's truth and approval pipeline).
 *
 * The model emits self-contained HTML/CSS/JS for a one-shot interface: a product
 * comparator, a calculator, a live filterable table, a mini simulation. The chat
 * renders it inside a sandboxed iframe (opaque origin — no cookies, storage or
 * DOM of UNIK) whose CSP forbids network calls back out: `connect-src 'none'`,
 * `form-action 'none'`. The only way the generated UI talks to UNIK is the
 * postMessage bridge (`window.unik.*`), and every action lands as a normal chat
 * message subject to the same approvals.
 *
 * The tool itself only validates + echoes the payload; the iframe does the rest.
 * Nothing is executed server-side.
 */

const MAX_HTML = 90_000;
const MAX_CSS = 40_000;
const MAX_JS = 50_000;

/**
 * Things a generated interface must never contain: credential capture and
 * hidden data exfiltration. `connect-src 'none'` in the iframe already blocks
 * fetch/XHR/WS; this rejects the UI at the tool layer so the model gets an
 * actionable error instead of a silently-dead page.
 */
const FORBIDDEN_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /type\s*=\s*["']?password/i, why: 'campos de contraseña' },
  { re: /type\s*=\s*["']?hidden[^>]*value\s*=\s*["'][^"']{8,}/i, why: 'campos ocultos con datos' },
  { re: /<form[^>]*action\s*=\s*["']https?:/i, why: 'formularios que envían a un sitio externo' },
  { re: /localStorage|sessionStorage|document\.cookie|indexedDB|navigator\.credentials/i, why: 'acceso a credenciales o storage del navegador' },
  { re: /import\s*\(/, why: 'imports dinámicos' },
];

export function findForbiddenUiCode(code: string): string | null {
  for (const { re, why } of FORBIDDEN_PATTERNS) {
    if (re.test(code)) return why;
  }
  return null;
}

registerTool({
  name: 'renderInteractiveUi',
  description:
    'Dibuja una interfaz interactiva dentro del chat: comparadores con filtros, calculadoras, tablas ordenables, simulaciones, dashboards, juegos de datos. Pásale HTML (obligatorio), CSS y JS opcionales, autocontenidos — pueden usar CDNs comunes (Chart.js, D3, Tailwind). NUNCA pidas credenciales, contraseñas ni datos de pago dentro de la interfaz, y no la uses para texto plano (usa markdown). La interfaz se muestra al usuario tal cual — no repitas el código en tu respuesta, solo explica qué hace.',
  category: 'system',
  enabledByDefault: true,
  resultTrust: 'trusted',
  timeoutMs: 15_000,
  contextTags: ['all'],
  parameters: z.object({
    title: z.string().min(2).max(120).describe('Nombre corto de la interfaz, ej. "Comparador de tarifas".'),
    html: z.string().min(20).max(MAX_HTML).describe('HTML del cuerpo de la interfaz, autocontenido.'),
    css: z.string().max(MAX_CSS).optional().describe('CSS propio (opcional).'),
    js: z.string().max(MAX_JS).optional().describe('JS de la interfaz (opcional). Puede llamar unik.prompt(texto), unik.openLink(url) y unik.copy(texto).'),
    height: z.number().int().min(120).max(1200).optional().describe('Alto sugerido en px (default ~360).'),
  }),
  summarize: (a) => `Interfaz interactiva: "${String((a as Record<string, unknown>).title ?? '')}"`,
  execute: async (_actor, args) => {
    const a = args as { title: string; html: string; css?: string; js?: string; height?: number };
    const code = `${a.html}\n${a.js ?? ''}`;
    const forbidden = findForbiddenUiCode(code);
    if (forbidden) {
      return {
        error: `La interfaz fue rechazada por seguridad: contiene ${forbidden}. Reescríbela sin eso — una interfaz del chat nunca pide credenciales ni envía datos a sitios externos.`,
      };
    }
    return {
      rendered: true,
      kind: 'interactive_ui',
      title: a.title,
      html: a.html,
      css: a.css ?? '',
      js: a.js ?? '',
      height: a.height ?? null,
      note: 'La interfaz ya se muestra al usuario dentro del chat en un área segura. No repitas el código — explica en una línea qué puede hacer con ella.',
    };
  },
});
