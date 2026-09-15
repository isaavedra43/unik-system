import { PERMISSION_REGISTRY, isKnownPermission, type PermissionKey } from '@/modules/auth/permissions';
import { FINANCE_AGENT_PERMISSIONS } from '@/modules/finance/permissions';
import { MANUFACTURING_AGENT_ACT_PERMISSIONS } from '@/modules/manufacturing/permissions';
import { PURCHASES_AGENT_ACT_PERMISSIONS } from '@/modules/purchases/permissions';
import { AREA_KEYS, type AreaKey } from '@/modules/operations/types';
import { agentBotFor, type AgentBotDefinition, type AgentKey } from './identity-catalog';

/**
 * Permissions of the agent identities and of the area channels (plan 5.1, 5.7, 5.8).
 * Pure module.
 *
 * Bots get a FIXED allowlist per identity: `chat.use`, `operations.view` and the
 * read/action permissions of their area that exist in the code-first registry.
 * Candidate keys of modules not built yet (purchases, manufacturing, finance,
 * CRM) are listed on purpose and filtered by `isKnownPermission`, so they apply
 * only once the module registers them. The list is explicit (never prefixes):
 * administrative, approval, export and configuration permissions are never
 * granted to a bot, and `super_admin` is never assigned (identities.ts).
 *
 * `operations.admin` is excluded even for the administrator bot: it configures
 * the core and is the fallback approver of business approvals.
 */

export const AGENT_BASE_PERMISSIONS = ['chat.use', 'operations.view'] as const;

export interface AgentAreaPermissionCandidates {
  read: readonly string[];
  act: readonly string[];
}

export const AGENT_AREA_PERMISSION_CANDIDATES: Readonly<Record<AreaKey, AgentAreaPermissionCandidates>> = {
  ventas: {
    read: ['sales_orders.view', 'customers.view', 'quotes.view', 'products.view', 'packages.view', 'crm.view', 'crm.radar'],
    // Never `crm.create_sales_order`: creating the order in Zoho is a person's decision.
    act: ['crm.manage'],
  },
  compras: {
    read: ['purchases.view', 'purchase_orders.view', 'vendors.view', 'bills.view', 'products.view'],
    act: [...PURCHASES_AGENT_ACT_PERMISSIONS],
  },
  inventario: {
    read: ['inventory.view', 'products.view'],
    act: ['inventory.count', 'inventory.reserve'],
  },
  manufactura: {
    read: ['manufacturing.view', 'inventory.view', 'products.view'],
    act: [...MANUFACTURING_AGENT_ACT_PERMISSIONS],
  },
  logistica: {
    read: ['logistics.view', 'packages.view'],
    act: ['logistics.dispatch'],
  },
  contabilidad: {
    read: ['finance.view', 'payments.view', 'invoices.view', 'bills.view', 'vendor_credits.view'],
    act: [...FINANCE_AGENT_PERMISSIONS.act],
  },
  administracion: {
    read: [],
    act: ['operations.manage'],
  },
};

/** Keys a bot must never hold, whatever the candidates say (defense in depth). */
export const AGENT_FORBIDDEN_PERMISSIONS: ReadonlySet<string> = new Set([
  'operations.admin',
  'users.view',
  'users.create',
  'users.update',
  'users.change_status',
  'users.assign_roles',
  'users.reset_password',
  'roles.view',
  'roles.create',
  'roles.update',
  'roles.delete',
  'roles.manage_permissions',
  'chat.admin',
  'assistant.admin',
  'inbox.admin',
]);

function uniqueKnown(keys: readonly string[]): PermissionKey[] {
  const out: PermissionKey[] = [];
  for (const key of keys) {
    if (AGENT_FORBIDDEN_PERMISSIONS.has(key)) continue;
    if (!isKnownPermission(key)) continue;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** Exact permissions of an agent definition (registry keys only, stable order). */
export function agentPermissionsForDefinition(def: AgentBotDefinition): PermissionKey[] {
  const area = AGENT_AREA_PERMISSION_CANDIDATES[def.coversAreaKey];
  return uniqueKnown([...AGENT_BASE_PERMISSIONS, ...area.read, ...area.act]);
}

/** Exact permissions of an agent key; unknown keys → [] (fail closed). */
export function agentPermissionsFor(agentKey: AgentKey | string): PermissionKey[] {
  const def = agentBotFor(agentKey);
  return def ? agentPermissionsForDefinition(def) : [];
}

/**
 * Who belongs to an area channel: holders of the area's module permissions
 * (plan 7.2 mapping: Ventas → crm.* / sales_orders.view, Compras → purchases.*,
 * Inventario → inventory.*, Manufactura → manufacturing.*, Logística →
 * logistics.*, Contabilidad → finance.*; Administración → operations.admin).
 * Prefixes are resolved against the registry at call time.
 */
export const AREA_MEMBER_PERMISSION_RULES: Readonly<
  Record<AreaKey, { prefixes: readonly string[]; exact: readonly string[] }>
> = {
  ventas: { prefixes: ['crm.'], exact: ['sales_orders.view'] },
  compras: { prefixes: ['purchases.'], exact: [] },
  inventario: { prefixes: ['inventory.'], exact: [] },
  manufactura: { prefixes: ['manufacturing.'], exact: [] },
  logistica: { prefixes: ['logistics.'], exact: [] },
  contabilidad: { prefixes: ['finance.'], exact: [] },
  administracion: { prefixes: [], exact: ['operations.admin'] },
};

/** Registry keys that make a person a member of the area channel. */
export function areaMemberPermissionKeys(
  areaKey: AreaKey,
  registryKeys: readonly string[] = PERMISSION_REGISTRY.map((p) => p.key)
): string[] {
  const rule = AREA_MEMBER_PERMISSION_RULES[areaKey];
  const known = new Set(registryKeys);
  const keys = new Set<string>();
  for (const key of rule.exact) if (known.has(key)) keys.add(key);
  for (const key of registryKeys) {
    if (rule.prefixes.some((prefix) => key.startsWith(prefix))) keys.add(key);
  }
  return [...keys].sort();
}

export const ALL_AREA_KEYS: readonly AreaKey[] = AREA_KEYS;
