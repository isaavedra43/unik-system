import { prisma } from '@/lib/prisma';
import { MyWorkBoard } from '@/components/operations/MyWorkBoard';
import {
  myWorkRole,
  parseFocusWorkItem,
  parseMyWorkView,
  type MyWorkApproval,
  type MyWorkFocusNotice,
  type MyWorkItem,
  type MyWorkProposal,
} from '@/components/operations/mywork-model';
import { PageHeader } from '@/components/ui/composite';
import { hasPermission, requireAuthenticatedUser, type CurrentUser } from '@/modules/auth/authorization';
import { listPendingProposals, toProposalDTO } from '@/modules/extensions/proposals-service';
import { redactDeep } from '@/modules/extensions/secrets';
import { listPendingApprovals, type PendingApprovalDTO } from '@/modules/operations/approvals-service';
import { AREA_LABELS, isAreaKey } from '@/modules/operations/types';
import { myWorkOthersActivityAt } from '@/modules/operations/mywork-activity';
import {
  getWorkItem,
  isWorkItemOpenStatus,
  listMyWorkItems,
  missingEvidenceForWorkItems,
  workItemPermissions,
  type WorkItemDTO,
} from '@/modules/operations/work-items-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "Mi trabajo" (plan 5.7): every signed-in user sees the work items they own or
 * cover as backup, the next action, their pending approvals and the copilot of
 * the surface. Actions go through `POST /app/operations/api/commands` (or the
 * offline queue); the core checks again who may act.
 */

const OPEN_LIMIT = 200;
const CLOSED_LIMIT = 50;

interface SearchParams {
  vista?: string | string[];
  /** Work item named by a notification (`/app/mywork?workItem=<id>`). */
  workItem?: string | string[];
}

function toMyWorkItems(user: CurrentUser, items: WorkItemDTO[], missing: Map<string, string[]>): MyWorkItem[] {
  return items.map((item) => ({
    ...item,
    role: myWorkRole(item, user.id),
    permissions: workItemPermissions(user, item),
    missingEvidence: missing.get(item.id) ?? [],
  }));
}

/** The work item of a notification that is not among the open ones: closed, or not reachable. */
async function focusNoticeFor(
  user: CurrentUser,
  workItemId: string | null,
  openItems: WorkItemDTO[]
): Promise<MyWorkFocusNotice | null> {
  if (!workItemId || openItems.some((item) => item.id === workItemId)) return null;
  try {
    const item = await getWorkItem(user, workItemId);
    return isWorkItemOpenStatus(item.status) ? { kind: 'missing', title: item.title } : { kind: 'closed', title: item.title };
  } catch {
    return { kind: 'missing', title: null };
  }
}

async function toApprovalViews(rows: PendingApprovalDTO[]): Promise<MyWorkApproval[]> {
  if (rows.length === 0) return [];
  const userIds = [...new Set(rows.map((r) => r.requestedByUserId))];
  const caseIds = [...new Set(rows.map((r) => r.caseId).filter((id): id is string => Boolean(id)))];
  const [users, cases] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
    caseIds.length > 0
      ? prisma.operationalCase.findMany({
          where: { id: { in: caseIds } },
          select: { id: true, caseNumber: true },
        })
      : Promise.resolve([]),
  ]);
  const names = new Map(users.map((u) => [u.id, u.name]));
  const caseNumbers = new Map(cases.map((c) => [c.id, c.caseNumber]));
  return rows.map((row) => ({
    id: row.id,
    scopeLabel: row.scopeLabel,
    targetType: row.targetType,
    targetId: row.targetId,
    amount: row.amount,
    currency: row.currency,
    requiredApprovals: row.requiredApprovals,
    approvals: row.approvals,
    requestedByName: names.get(row.requestedByUserId) ?? null,
    caseId: row.caseId,
    caseNumber: row.caseId ? (caseNumbers.get(row.caseId) ?? null) : null,
    areaLabel: row.areaKey && isAreaKey(row.areaKey) ? AREA_LABELS[row.areaKey] : null,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    version: row.version,
  }));
}

function toProposalViews(user: CurrentUser, rows: Parameters<typeof toProposalDTO>[0][]): MyWorkProposal[] {
  return rows.map((row) => {
    const dto = toProposalDTO(row);
    return {
      id: dto.id,
      toolName: dto.toolName,
      summary: dto.summary,
      effect: dto.effect,
      expiresAt: dto.expiresAt,
      args: redactDeep(dto.args),
      recipient: dto.recipient,
      status: dto.status,
      error: dto.error,
      conversationId: dto.conversationId,
      createdAt: dto.createdAt,
      awaitingSecondApproval: dto.awaitingSecondApproval,
      signedByMe: dto.awaitingSecondApproval && dto.decisionBy === user.id,
    };
  });
}

/** A secondary block that fails becomes a notice instead of breaking the page. */
async function settle<T>(promise: Promise<T>, label: string): Promise<{ value: T | null; warning: string | null }> {
  try {
    return { value: await promise, warning: null };
  } catch (err) {
    console.error(
      JSON.stringify({
        component: 'mywork-page',
        event: 'load_failed',
        part: label,
        message: err instanceof Error ? err.message : String(err),
      })
    );
    return { value: null, warning: `No se pudieron cargar ${label}. Recarga la página para intentarlo de nuevo.` };
  }
}

export default async function MyWorkPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requireAuthenticatedUser();
  const params = await searchParams;
  const view = parseMyWorkView(Array.isArray(params.vista) ? params.vista[0] : params.vista);
  const focusWorkItemId = parseFocusWorkItem(params.workItem);
  const now = new Date();
  const canUseAssistant = hasPermission(user, 'assistant.use');

  const [open, closed, approvals, proposals, othersActivity] = await Promise.all([
    listMyWorkItems(user, { scope: 'open', limit: OPEN_LIMIT }, { now }),
    view === 'closed'
      ? listMyWorkItems(user, { scope: 'closed', limit: CLOSED_LIMIT }, { now })
      : Promise.resolve(null),
    settle(listPendingApprovals(user, { limit: 50, now }).then(toApprovalViews), 'las aprobaciones de negocio'),
    settle(listPendingProposals(user).then((rows) => toProposalViews(user, rows)), 'las propuestas de la IA'),
    canUseAssistant ? settle(myWorkOthersActivityAt(user.id), 'la actividad reciente') : Promise.resolve({ value: null, warning: null }),
  ]);
  const [missingEvidence, focusNotice] = await Promise.all([
    missingEvidenceForWorkItems(open.items),
    focusNoticeFor(user, focusWorkItemId, open.items),
  ]);
  const othersActivityAt = othersActivity.value && othersActivity.value.getTime() > 0 ? othersActivity.value.toISOString() : null;

  return (
    <div className="grid gap-4">
      <PageHeader
        title="Mi trabajo"
        description="Lo que tienes a cargo y lo que cubres como suplente, ordenado por vencimiento."
      />
      <MyWorkBoard
        user={{ id: user.id, name: user.name }}
        view={view}
        openItems={toMyWorkItems(user, open.items, missingEvidence)}
        closedItems={closed ? toMyWorkItems(user, closed.items, new Map()) : null}
        openTruncated={open.nextCursor !== null}
        approvals={approvals.value ?? []}
        proposals={proposals.value ?? []}
        warnings={[approvals.warning, proposals.warning].filter((w): w is string => Boolean(w))}
        nowIso={now.toISOString()}
        canUseAssistant={canUseAssistant}
        canCount={hasPermission(user, 'inventory.count')}
        activityAt={othersActivityAt}
        focusWorkItemId={view === 'open' ? focusWorkItemId : null}
        focusNotice={view === 'open' ? focusNotice : null}
      />
    </div>
  );
}
