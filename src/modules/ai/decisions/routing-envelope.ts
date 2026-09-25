import { decide, answerBool, answerChoice, type DecisionResult } from './decision-engine';
import type { JevQuestion } from './jev-client';
import { classifyTask } from '../model-router';
import { detectDomains } from '../tool-selector';

/**
 * Routing Envelope V2 — UNA decisión Jev batch por turno (UNIVERSO, fase B3).
 *
 * En vez de N llamadas dispersas, el router pregunta todo de una vez:
 * camino (fast/standard/deep), dominios, necesidades (RAG, browser, computer,
 * delegación), clase de modelo, paralelización, riesgo y valor de memoria.
 *
 * Reglas duras:
 * - Jev DECIDE, nunca redacta.
 * - Deadline ~600ms: `decide` hereda el timeout; sin retry en fast path.
 * - Si Jev no responde o responde por debajo del piso de confianza →
 *   `heuristicRoute()` (mismas reglas que hoy, `classifyTask` + detectDomains).
 * - `riskClass` nunca baja por debajo de lo que pide la tool ejecutada: el
 *   envelope es una ESTIMACIÓN pre-turno; el candado real sigue siendo
 *   `resolveEffect`/`approvalPolicy` del registry por tool call.
 */

export type RoutePath = 'fast' | 'standard' | 'deep';
export type RiskClass = 'read' | 'draft' | 'internal_task' | 'external_send' | 'business_write' | 'destructive';
export type DelegateKind = 'researcher' | 'analyst' | 'programmer' | 'watcher' | 'messenger' | 'any';

export interface RoutingEnvelope {
  path: RoutePath;
  domains: string[];
  needsRag: boolean;
  needsBrowser: boolean;
  needsComputer: boolean;
  needsDelegation: boolean;
  delegateTo: DelegateKind | null;
  spawnVsReuse: 'spawn' | 'reuse' | null;
  modelClass: 'utility' | 'standard' | 'deep';
  parallelizable: boolean;
  fanout: number;
  riskClass: RiskClass;
  needsApproval: boolean;
  memoryWorthy: boolean;
  source: 'jev' | 'jev-cache' | 'heuristic';
  durationMs: number;
}

export interface RouteTurnInput {
  message: string;
  page?: string;
  attachmentKinds?: Array<'image' | 'document' | 'audio' | 'video' | 'other'>;
  planFirst?: boolean;
  autoTrigger?: boolean;
  recentToolNames?: string[];
  userId?: string;
  conversationId?: string;
}

const ROUTE_QUESTIONS: Record<string, JevQuestion> = {
  path: {
    type: 'choice',
    instructions: 'Camino óptimo para este turno.',
    criteria: {
      fast: 'lookup simple, lectura directa o conversación sin razonamiento profundo',
      standard: 'análisis moderado, varias lecturas o síntesis RAG',
      deep: 'multi-paso, alto impacto, planificación, código, estrategia o datos en conflicto',
    },
  },
  needsRag: {
    type: 'noul',
    instructions: 'La respuesta necesita conocimiento de la base documental (manuales, políticas, procedimientos).',
    criteria: { true: 'requiere documentos/manuales internos', false: 'solo datos operativos o conversación' },
  },
  needsBrowser: {
    type: 'noul',
    instructions: 'El turno requiere navegar la web (búsqueda, sitios, datos en vivo).',
    criteria: { true: 'necesita internet/búsqueda web', false: 'se resuelve con datos internos' },
  },
  needsComputer: {
    type: 'noul',
    instructions: 'El turno requiere operar una computadora/app con UI (clics, formularios, sitios sin API).',
    criteria: { true: 'hay que operar una interfaz', false: 'basta con APIs/tools' },
  },
  needsDelegation: {
    type: 'noul',
    instructions: 'Conviene delegar a un agente especialista/subagente en vez de responder directo.',
    criteria: { true: 'trabajo especializado, largo o paralelizable', false: 'el principal lo resuelve mejor' },
  },
  delegateTo: {
    type: 'choice',
    instructions: 'Si se delega, qué tipo de especialista conviene más.',
    criteria: {
      researcher: 'investigación web/documental',
      analyst: 'datos del ERP, reportes, comparaciones',
      programmer: 'código, bugs, scripts',
      watcher: 'monitoreo continuo',
      messenger: 'comunicación con terceros',
      any: 'cualquiera sirve',
    },
  },
  spawnVsReuse: {
    type: 'choice',
    instructions: 'Si se delega: subagente transitorio o especialista persistente del equipo.',
    criteria: { spawn: 'tarea puntual que no volverá', reuse: 'trabajo recurrente de un especialista' },
  },
  parallelizable: {
    type: 'noul',
    instructions: 'El trabajo se puede partir en subtareas independientes que corran en paralelo.',
    criteria: { true: 'subtareas sin dependencias', false: 'secuencial' },
  },
  riskClass: {
    type: 'choice',
    instructions: 'Clase de riesgo MÁXIMA que el turno probablemente tocará.',
    criteria: {
      read: 'solo lectura',
      draft: 'borradores sin envío',
      internal_task: 'tareas internas',
      external_send: 'mensajes a terceros',
      business_write: 'escrituras ERP',
      destructive: 'acciones irreversibles',
    },
  },
  memoryWorthy: {
    type: 'noul',
    instructions: 'El turno produce un hecho, preferencia o procedimiento que vale recordar.',
    criteria: { true: 'hay algo durable que aprender', false: 'descartable' },
  },
};

const ROUTE_DEADLINE_MS = 600;
const MAX_FANOUT = 4;

/** Fallback determinista: las mismas reglas que ya gobiernan el asistente. */
export function heuristicRoute(input: RouteTurnInput): RoutingEnvelope {
  const t0 = Date.now();
  const classification = classifyTask({
    message: input.message,
    attachmentKinds: input.attachmentKinds,
    planFirst: input.planFirst,
    autoTrigger: input.autoTrigger,
    recentToolNames: input.recentToolNames,
  });
  const domains = detectDomains(input.message);
  const msg = input.message.toLowerCase();
  const needsBrowser = /\b(busca en (la )?web|internet|navega|abre el sitio|precio online|competencia online)\b/.test(msg);
  const needsComputer = /\b(entra a|abre la (p[aá]gina|app|web)|llena el formulario|haz clic|inicia sesi[oó]n)\b/.test(msg);
  const path: RoutePath = classification.tier === 'simple' ? 'fast' : classification.tier === 'complex' ? 'deep' : 'standard';
  return {
    path,
    domains,
    needsRag: false,
    needsBrowser,
    needsComputer,
    needsDelegation: false,
    delegateTo: null,
    spawnVsReuse: null,
    modelClass: path === 'deep' ? 'deep' : path === 'fast' ? 'utility' : 'standard',
    parallelizable: domains.length >= 2,
    fanout: 1,
    riskClass: 'read',
    needsApproval: false,
    memoryWorthy: /\b(recuerda|guarda|aprende|no olvides)\b/.test(msg),
    source: 'heuristic',
    durationMs: Date.now() - t0,
  };
}

function mapEnvelope(res: DecisionResult, input: RouteTurnInput): RoutingEnvelope {
  const fallback = heuristicRoute(input);
  const path =
    (answerChoice(res, 'path', ['fast', 'standard', 'deep']) as RoutePath | null) ?? fallback.path;
  const risk =
    (answerChoice(res, 'riskClass', [
      'read', 'draft', 'internal_task', 'external_send', 'business_write', 'destructive',
    ]) as RiskClass | null) ?? fallback.riskClass;
  const delegateTo = answerChoice(res, 'delegateTo', [
    'researcher', 'analyst', 'programmer', 'watcher', 'messenger', 'any',
  ]) as DelegateKind | null;
  const spawnVsReuse = answerChoice(res, 'spawnVsReuse', ['spawn', 'reuse']) as 'spawn' | 'reuse' | null;
  const needsDelegation = answerBool(res, 'needsDelegation') ?? fallback.needsDelegation;
  const parallelizable = answerBool(res, 'parallelizable') ?? fallback.parallelizable;
  return {
    path,
    domains: detectDomains(input.message),
    needsRag: answerBool(res, 'needsRag') ?? fallback.needsRag,
    needsBrowser: answerBool(res, 'needsBrowser') ?? fallback.needsBrowser,
    needsComputer: answerBool(res, 'needsComputer') ?? fallback.needsComputer,
    needsDelegation,
    delegateTo: needsDelegation ? delegateTo : null,
    spawnVsReuse: needsDelegation ? spawnVsReuse : null,
    modelClass: path === 'deep' ? 'deep' : path === 'fast' ? 'utility' : 'standard',
    parallelizable,
    fanout: parallelizable ? MAX_FANOUT : 1,
    riskClass: risk,
    needsApproval: risk !== 'read' && risk !== 'draft' && risk !== 'internal_task',
    memoryWorthy: answerBool(res, 'memoryWorthy') ?? fallback.memoryWorthy,
    source: res.cached ? 'jev-cache' : 'jev',
    durationMs: res.durationMs,
  };
}

/**
 * Enruta un turno. Nunca lanza: cualquier fallo de Jev cae al heurístico.
 * `bypassCache` para trabajo programado (mismo mensaje ≠ mismo contexto).
 */
export async function routeTurn(input: RouteTurnInput): Promise<RoutingEnvelope> {
  // Sin contenido real no hay nada que decidir: fast directo, cero costo.
  if (!input.message.trim() && !input.attachmentKinds?.length) {
    return { ...heuristicRoute(input), path: 'fast', modelClass: 'utility' };
  }
  const state = {
    message: input.message.slice(0, 4000),
    page: input.page ?? null,
    attachments: input.attachmentKinds ?? [],
    planFirst: Boolean(input.planFirst),
    autoTrigger: Boolean(input.autoTrigger),
    recentTools: input.recentToolNames ?? [],
  };
  const res = await decide(state, ROUTE_QUESTIONS, {
    timeoutMs: ROUTE_DEADLINE_MS,
    userId: input.userId,
    conversationId: input.conversationId,
  });
  if (!res) return heuristicRoute(input);
  return mapEnvelope(res, input);
}
