import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hasAnyPermission, hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { getAiSettings } from '@/modules/ai/ai-admin-config-service';
import { runAssistant, type OrchestratorContext } from '@/modules/ai/ai-orchestrator';
import { getModelById } from '@/modules/ai/model-catalog';
import { AUTO_MODEL_ID } from '@/modules/ai/model-router';
import { getConversation as getAiConversation } from '@/modules/ai/ai-sessions-service';
import {
  autoTriggerMessage,
  getOrCreateSurfaceConversation,
  getSurfaceMode,
  listSurfaceConversations,
  shouldRunAutoTurn,
  type SurfaceRef,
} from '@/modules/ai/copilot-surfaces';
import { areaMemberPermissionKeys } from '@/modules/agents/permissions';
import {
  listPendingProposals,
  listProposalsForScope,
  toProposalDTO,
} from '@/modules/extensions/proposals-service';
import { authorizeOperationsChannel } from '@/modules/operations/events-service';
import { myWorkOthersActivityAt } from '@/modules/operations/mywork-activity';
import { isAreaKey, type AreaKey } from '@/modules/operations/types';
import { canViewArea } from '@/modules/operations/work-items-service';
import { jsonError, operationsCopilotErrorResponse, readCopilotJson } from './_http';

/**
 * Shared server logic of the operations copilot surfaces (plan 5.2):
 *
 * - `GET/POST /app/operations/api/areas/[key]/copilot`   (surface `area`)
 * - `GET/POST /app/operations/api/cases/[id]/copilot`    (surface `case`)
 * - `GET/POST /app/operations/api/mywork/copilot`        (surface `mywork`)
 * - `GET/POST /app/admin/control-tower/api/copilot`      (surface `control_tower`)
 *
 * Same contract as the chat and inbox copilots: ONE assistant (`runAssistant`),
 * one hidden AI thread per (user, surface), SSE with a `: ping` comment every
 * 15 s, `GET ?list=1 | ?thread= | ?new=1`, and `POST {message} | {trigger}`
 * where automatic triggers only run in `active` mode and only when the thread
 * has no turn after the surface anchor (`shouldRunAutoTurn`).
 *
 * The client may send `context` (the visible table): it reaches the AI only as
 * `context.tableContext`, which the orchestrator bounds and wraps as untrusted
 * data. Agent turns (`context.agent`) can never be requested from HTTP: the
 * body schema strips unknown keys and the surface fields are fixed here.
 */

export {
  COPILOT_MAX_BODY_CHARS,
  OperationsCopilotError,
  jsonError,
  operationsCopilotErrorResponse,
  readCopilotJson,
  requireCopilotUser,
  requireOperationsUser,
} from './_http';

export const SSE_HEARTBEAT_MS = 15_000;
/** Host id of the single Control Tower surface (`SURFACE_CONTEXT_KEY.control_tower = 'scope'`). */
export const CONTROL_TOWER_SCOPE = 'company';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

/** Triggers a person's panel may send; agent triggers only exist in background turns. */
export const COPILOT_HUMAN_TRIGGERS = ['open', 'inbound', 'action_failed'] as const;

export const copilotPostSchema = z
  .object({
    message: z.string().min(1).max(8000).optional(),
    trigger: z.enum(COPILOT_HUMAN_TRIGGERS).optional(),
    /** For action_failed: which tool and what error, so the copilot fixes it on its own. */
    detail: z
      .object({ tool: z.string().max(80).optional(), error: z.string().max(800).optional() })
      .optional(),
    model: z.string().max(120).optional(),
    threadId: z.string().max(120).optional(),
    /** Host data evaluated on this turn (e.g. the visible rows). Forwarded as `tableContext`. */
    context: z.record(z.unknown()).optional(),
  })
  .refine((v) => Boolean(v.message) !== Boolean(v.trigger), {
    message: 'Envía "message" o "trigger", no ambos',
  });

export type CopilotPostInput = z.infer<typeof copilotPostSchema>;

export interface OperationsSurfaceSpec {
  surface: SurfaceRef;
  /** Page the surface lives on (context.page for the assistant). */
  page: string;
  /** Surface fields of the orchestrator context, fixed by the server. */
  context: Pick<OrchestratorContext, 'areaKey' | 'caseId' | 'myWork' | 'controlTower'>;
  /** Last activity of the host: automatic triggers run only if the thread has no turn after it. */
  anchor: () => Promise<Date>;
  pausedMessage: string;
}

// ---------------------------------------------------------------------------
// Anchors of the anti-loop rule (plan 5.2)
// ---------------------------------------------------------------------------

/**
 * Events written by the AI layer itself (`ai.turn`, `ai.turn_skipped`…) never
 * move an anchor, so background agent turns do not wake people's copilots.
 */
const NOT_AI_EVENT = { NOT: { type: { startsWith: 'ai.' } } };

/** Area → last operational event of the area. */
export async function areaActivityAnchor(areaKey: string): Promise<Date> {
  const last = await prisma.operationalEvent.findFirst({
    where: { areaKey, ...NOT_AI_EVENT },
    orderBy: { occurredAt: 'desc' },
    select: { occurredAt: true },
  });
  return last?.occurredAt ?? new Date(0);
}

/** Case → last event of the case (or its last activity when it has none yet). */
export async function caseActivityAnchor(caseId: string): Promise<Date> {
  const last = await prisma.operationalEvent.findFirst({
    where: { caseId, ...NOT_AI_EVENT },
    orderBy: { occurredAt: 'desc' },
    select: { occurredAt: true },
  });
  if (last) return last.occurredAt;
  const operationalCase = await prisma.operationalCase.findUnique({
    where: { id: caseId },
    select: { lastActivityAt: true },
  });
  return operationalCase?.lastActivityAt ?? new Date(0);
}

/**
 * Mi trabajo → last change of the user's open work made by someone else (or the system): the
 * person's own actions never count, so they never wake their own copilot.
 */
export async function myWorkActivityAnchor(userId: string): Promise<Date> {
  return myWorkOthersActivityAt(userId);
}

/** A model a person may pick for a copilot turn: `auto`, a catalog model or one configured by the admin. */
export async function isSelectableModel(model: string): Promise<boolean> {
  if (model === AUTO_MODEL_ID || getModelById(model)) return true;
  try {
    const settings = await getAiSettings();
    const configured = [
      settings.deployment,
      settings.fallbackDeployment,
      settings.routingSimpleModel,
      settings.routingStandardModel,
      settings.routingComplexModel,
      settings.utilityModel,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return configured.includes(model);
  } catch {
    return false;
  }
}

/** Control Tower → last operational event of the company. */
export async function companyActivityAnchor(): Promise<Date> {
  const last = await prisma.operationalEvent.findFirst({
    where: NOT_AI_EVENT,
    orderBy: { recordedAt: 'desc' },
    select: { recordedAt: true },
  });
  return last?.recordedAt ?? new Date(0);
}

// ---------------------------------------------------------------------------
// Surface specs
// ---------------------------------------------------------------------------

export function areaSurfaceSpec(areaKey: AreaKey): OperationsSurfaceSpec {
  return {
    surface: { kind: 'area', id: areaKey },
    page: `/app/areas/${areaKey}/trabajo`,
    context: { areaKey },
    anchor: () => areaActivityAnchor(areaKey),
    pausedMessage: 'El copiloto del área está apagado',
  };
}

export function caseSurfaceSpec(caseId: string): OperationsSurfaceSpec {
  return {
    surface: { kind: 'case', id: caseId },
    page: `/app/operations/cases/${caseId}`,
    context: { caseId },
    anchor: () => caseActivityAnchor(caseId),
    pausedMessage: 'El copiloto de expedientes está apagado',
  };
}

export function myWorkSurfaceSpec(user: Pick<CurrentUser, 'id'>): OperationsSurfaceSpec {
  return {
    surface: { kind: 'mywork', id: user.id },
    page: '/app/mywork',
    context: { myWork: true },
    anchor: () => myWorkActivityAnchor(user.id),
    pausedMessage: 'El copiloto de Mi trabajo está apagado',
  };
}

export function controlTowerSurfaceSpec(): OperationsSurfaceSpec {
  return {
    surface: { kind: 'control_tower', id: CONTROL_TOWER_SCOPE },
    page: '/app/admin/control-tower',
    context: { controlTower: true },
    anchor: companyActivityAnchor,
    pausedMessage: 'El copiloto del Control Tower está apagado',
  };
}

// ---------------------------------------------------------------------------
// Access to each surface (server side; the UI only hides)
// ---------------------------------------------------------------------------

/**
 * Area copilot: `operations.view`, the permissions of the area module (the
 * same mapping as the area channel: Ventas → crm.* / sales_orders.view,
 * Inventario → inventory.*…), or whoever `canViewArea` admits (channel member,
 * lead, responsible or backup). Returns the error response or null.
 */
export async function checkAreaCopilotAccess(
  user: CurrentUser,
  areaKey: string
): Promise<NextResponse | null> {
  if (!isAreaKey(areaKey)) return jsonError(404, 'Área no encontrada', 'not_found');
  if (hasPermission(user, 'operations.view')) return null;
  const moduleKeys = areaMemberPermissionKeys(areaKey);
  if (moduleKeys.length > 0 && hasAnyPermission(user, moduleKeys)) return null;
  if (await canViewArea(user, areaKey)) return null;
  return jsonError(403, 'No tienes acceso a esta área', 'forbidden');
}

/**
 * Case copilot: whoever may follow the case (`authorizeOperationsChannel`:
 * operations.view, owner, owner/backup of one of its work items, room member).
 * Without access the answer is 403 whether or not the case exists.
 */
export async function checkCaseCopilotAccess(
  user: CurrentUser,
  caseId: string
): Promise<NextResponse | null> {
  if (!ID_PATTERN.test(caseId)) return jsonError(404, 'Expediente no encontrado', 'not_found');
  if (!(await authorizeOperationsChannel(user, 'case', caseId))) {
    return jsonError(403, 'No tienes acceso a este expediente', 'forbidden');
  }
  const exists = await prisma.operationalCase.findUnique({
    where: { id: caseId },
    select: { id: true },
  });
  return exists ? null : jsonError(404, 'Expediente no encontrado', 'not_found');
}

/** Control Tower copilot: `operations.admin` (super admins included). */
export function checkControlTowerAccess(user: CurrentUser): NextResponse | null {
  return hasPermission(user, 'operations.admin')
    ? null
    : jsonError(403, 'Sin permiso para el Control Tower', 'forbidden');
}

// ---------------------------------------------------------------------------
// GET / POST
// ---------------------------------------------------------------------------

/**
 * Propuestas de IA que la superficie muestra a esta persona (plan 5.4:
 * «`listProposalsForScope(actor, caseId)` alimenta la sala»).
 *
 * - siempre las de su propio hilo aquí (`listPendingProposals(userId, conv)`);
 * - en expediente y área, además las del ALCANCE que todavía puede decidir
 *   (responsable, suplente o permiso del alcance, y las que esperan una segunda
 *   firma que ella puede dar). Sin esto, la propuesta de un agente —que nace en
 *   la conversación del bot— sólo era decidible desde la tarjeta del chat o
 *   desde Mi trabajo, nunca desde la sala que el plan designa.
 *
 * «Mi trabajo» y la Torre de Control no tienen alcance de sala: siguen igual.
 */
export async function surfaceProposals(
  user: CurrentUser,
  spec: OperationsSurfaceSpec,
  conversationId: string
): Promise<ReturnType<typeof toProposalDTO>[]> {
  const scopeFilter =
    spec.surface.kind === 'case'
      ? { caseId: spec.surface.id }
      : spec.surface.kind === 'area'
        ? { areaKey: spec.surface.id }
        : null;
  const [own, scoped] = await Promise.all([
    listPendingProposals(user.id, conversationId),
    scopeFilter ? listProposalsForScope(user, scopeFilter) : Promise.resolve([]),
  ]);
  const byId = new Map<string, (typeof own)[number]>();
  for (const row of [...own, ...scoped]) if (!byId.has(row.id)) byId.set(row.id, row);
  return [...byId.values()]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(toProposalDTO);
}

/** GET — thread of this user on the surface (`?list=1`, `?thread=<id>`, `?new=1`). */
export async function handleSurfaceGet(
  request: Request,
  user: CurrentUser,
  spec: OperationsSurfaceSpec
): Promise<NextResponse> {
  try {
    const q = new URL(request.url).searchParams;
    if (q.get('list') === '1') {
      return NextResponse.json({ threads: await listSurfaceConversations(user, spec.surface) });
    }
    const [{ id: conversationId }, mode] = await Promise.all([
      getOrCreateSurfaceConversation(user, spec.surface, {
        threadId: q.get('thread'),
        createNew: q.get('new') === '1',
      }),
      getSurfaceMode(user.id, spec.surface.kind),
    ]);
    const [thread, proposals] = await Promise.all([
      getAiConversation(conversationId, user.id),
      surfaceProposals(user, spec, conversationId),
    ]);
    return NextResponse.json({
      conversationId,
      mode,
      messages: thread.messages,
      proposals,
    });
  } catch (err) {
    return operationsCopilotErrorResponse(err);
  }
}

export type SurfaceTurnPlan =
  | { kind: 'run'; conversationId: string; text: string; input: CopilotPostInput }
  | { kind: 'response'; response: NextResponse };

/** Decides what a POST does: run a turn (with its message) or answer right away. */
export async function planSurfaceTurn(
  request: Request,
  user: CurrentUser,
  spec: OperationsSurfaceSpec
): Promise<SurfaceTurnPlan> {
  try {
    const parsed = copilotPostSchema.safeParse(await readCopilotJson(request));
    if (!parsed.success) {
      return {
        kind: 'response',
        response: NextResponse.json(
          {
            error: parsed.error.issues[0]?.message ?? 'Datos inválidos',
            code: 'invalid_request',
          },
          { status: 400 }
        ),
      };
    }
    const input = parsed.data;
    if (input.model && !(await isSelectableModel(input.model))) {
      return {
        kind: 'response',
        response: jsonError(400, 'Ese modelo no está disponible', 'invalid_model'),
      };
    }
    const mode = await getSurfaceMode(user.id, spec.surface.kind);
    if (mode === 'paused') {
      return { kind: 'response', response: jsonError(409, spec.pausedMessage, 'paused') };
    }
    const conversationId = (
      await getOrCreateSurfaceConversation(user, spec.surface, { threadId: input.threadId })
    ).id;
    let text: string;
    if (input.trigger === 'action_failed') {
      // A failed approved action: the copilot diagnoses and retries regardless of proactivity.
      text = autoTriggerMessage('action_failed', spec.surface.kind, input.detail);
    } else if (input.trigger) {
      if (mode !== 'active') {
        return { kind: 'response', response: NextResponse.json({ skipped: true, reason: 'mode' }) };
      }
      if (!(await shouldRunAutoTurn(conversationId, await spec.anchor()))) {
        return {
          kind: 'response',
          response: NextResponse.json({ skipped: true, reason: 'up_to_date' }),
        };
      }
      text = autoTriggerMessage(input.trigger, spec.surface.kind);
    } else {
      text = input.message as string;
    }
    return { kind: 'run', conversationId, text, input };
  } catch (err) {
    return { kind: 'response', response: operationsCopilotErrorResponse(err) };
  }
}

/** The orchestrator context of a person's turn on the surface. */
export function surfaceTurnContext(
  spec: OperationsSurfaceSpec,
  input: Pick<CopilotPostInput, 'context'>
): OrchestratorContext {
  return {
    page: spec.page,
    ...spec.context,
    ...(input.context ? { tableContext: input.context } : {}),
  };
}

/** POST — one copilot turn on the surface, streamed as SSE. */
export async function handleSurfacePost(
  request: Request,
  user: CurrentUser,
  spec: OperationsSurfaceSpec
): Promise<Response> {
  const plan = await planSurfaceTurn(request, user, spec);
  if (plan.kind === 'response') return plan.response;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let clientGone = false;
      const enqueue = (chunk: string) => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          clientGone = true;
        }
      };
      const send = (event: unknown) => enqueue(`data: ${JSON.stringify(event)}\n\n`);
      // Keep long copilot turns alive through proxies (an SSE comment every 15 s).
      const heartbeat = setInterval(() => enqueue(`: ping ${Date.now()}\n\n`), SSE_HEARTBEAT_MS);
      try {
        send({ type: 'meta', data: { conversationId: plan.conversationId } });
        for await (const event of runAssistant({
          conversationId: plan.conversationId,
          message: plan.text,
          actor: user,
          context: surfaceTurnContext(spec, plan.input),
          model: plan.input.model,
        })) {
          send(event);
        }
      } catch (e) {
        send({
          type: 'error',
          data: { message: e instanceof Error ? e.message : 'Error desconocido' },
        });
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
