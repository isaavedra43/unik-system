import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { isComposioEffect } from './composio-effects';

/**
 * UNIK-side governance for Composio toolkits. A toolkit is usable by the
 * assistant only when an administrator enabled it AND the actor holds one of
 * its allowed roles (super_admin always does). Nothing is enabled by default.
 */

export interface ComposioPolicy {
  toolkitSlug: string;
  enabled: boolean;
  allowedRoleKeys: string[];
  effectOverrides: Record<string, string>;
  disabledTools: string[];
  updatedAt: Date;
}

const TTL_MS = 15_000;
let cache: { at: number; rows: Map<string, ComposioPolicy> } | null = null;

export function normalizeToolkitSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

function toPolicy(row: {
  toolkitSlug: string;
  enabled: boolean;
  allowedRoleKeys: string[];
  effectOverrides: Prisma.JsonValue;
  disabledTools: string[];
  updatedAt: Date;
}): ComposioPolicy {
  const overrides: Record<string, string> = {};
  if (
    row.effectOverrides &&
    typeof row.effectOverrides === 'object' &&
    !Array.isArray(row.effectOverrides)
  ) {
    for (const [k, v] of Object.entries(row.effectOverrides)) {
      if (isComposioEffect(v)) overrides[k.toUpperCase()] = v;
    }
  }
  return {
    toolkitSlug: row.toolkitSlug,
    enabled: row.enabled,
    allowedRoleKeys: row.allowedRoleKeys,
    effectOverrides: overrides,
    disabledTools: row.disabledTools.map((t) => t.toUpperCase()),
    updatedAt: row.updatedAt,
  };
}

export async function loadPolicies(force = false): Promise<Map<string, ComposioPolicy>> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const rows = await prisma.composioToolkitPolicy.findMany();
  const map = new Map(rows.map((r) => [r.toolkitSlug, toPolicy(r)] as const));
  cache = { at: Date.now(), rows: map };
  return map;
}

export function invalidatePolicyCache(): void {
  cache = null;
}

export function actorMatchesPolicy(
  actor: CurrentUser,
  policy: ComposioPolicy | undefined
): boolean {
  if (!policy || !policy.enabled) return false;
  if (actor.isSuperAdmin) return true;
  return policy.allowedRoleKeys.some((role) => actor.roleKeys.includes(role));
}

/** Toolkit slugs (lowercase) this actor may use, sorted for stable cache keys. */
export async function allowedToolkitsFor(actor: CurrentUser): Promise<string[]> {
  const policies = await loadPolicies();
  return [...policies.values()]
    .filter((p) => actorMatchesPolicy(actor, p))
    .map((p) => p.toolkitSlug)
    .sort();
}

export async function getPolicy(toolkitSlug: string): Promise<ComposioPolicy | undefined> {
  return (await loadPolicies()).get(normalizeToolkitSlug(toolkitSlug));
}

export interface PolicyPatch {
  enabled?: boolean;
  allowedRoleKeys?: string[];
  effectOverrides?: Record<string, string>;
  disabledTools?: string[];
}

export async function upsertPolicy(
  admin: CurrentUser,
  toolkitSlug: string,
  patch: PolicyPatch
): Promise<ComposioPolicy> {
  const slug = normalizeToolkitSlug(toolkitSlug);
  if (!/^[a-z0-9_]{1,64}$/.test(slug)) throw new Error('Slug de toolkit inválido');
  const overrides: Record<string, string> | undefined = patch.effectOverrides
    ? Object.fromEntries(
        Object.entries(patch.effectOverrides)
          .filter(([, v]) => isComposioEffect(v))
          .map(([k, v]) => [k.toUpperCase(), v])
      )
    : undefined;
  const data = {
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.allowedRoleKeys ? { allowedRoleKeys: [...new Set(patch.allowedRoleKeys)] } : {}),
    ...(overrides ? { effectOverrides: overrides as Prisma.InputJsonValue } : {}),
    ...(patch.disabledTools
      ? { disabledTools: [...new Set(patch.disabledTools.map((t) => t.toUpperCase()))] }
      : {}),
    updatedBy: admin.id,
  };
  const row = await prisma.composioToolkitPolicy.upsert({
    where: { toolkitSlug: slug },
    create: { toolkitSlug: slug, ...data },
    update: data,
  });
  invalidatePolicyCache();
  return toPolicy(row);
}

export async function listPolicies(): Promise<ComposioPolicy[]> {
  return [...(await loadPolicies(true)).values()].sort((a, b) =>
    a.toolkitSlug.localeCompare(b.toolkitSlug)
  );
}
