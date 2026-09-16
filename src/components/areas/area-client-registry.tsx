'use client';

import type { ComponentType, ReactNode } from 'react';
import type { AreaWorkRow } from '@/modules/areas/area-work-row';
import { rowKindLabel } from '@/modules/areas/area-work-row';
import type { EntityColumnDefinition } from '@/modules/shared/entity-workspace-types';

/**
 * Client registry of the areas (plan 7.2): what only the browser needs — how a
 * cell of the area's own row kinds is rendered, the labels of those kinds and
 * the specialized view of the area (Radar, Sourcing, Mapa, Tablero, Despacho,
 * Libro).
 *
 * Every area ships `src/components/areas/<area>/register-client.tsx`, which
 * calls `registerAreaClient('<area>', { ... })` when it is imported;
 * `register-all-client.tsx` loads it on demand. An area that has not written it
 * still works: the default cell renderer covers every common column and the
 * specialized space says, in Spanish, that it is on its way.
 */

export interface AreaSpecialViewProps {
  areaKey: string;
  /** Slug of the specialized space (`radar`, `sourcing`, `mapa`…). */
  slug: string;
  user: { id: string; name: string };
  /** The person may run the area's commands (the server checks again). */
  canAct: boolean;
  /** Search params of the page (`?count=<id>`, `?scan=1`…), already flattened. */
  params: Record<string, string>;
}

export interface AreaDetailExtrasProps {
  areaKey: string;
  /** Slug of the space the row is being seen from (`ordenes`, `rfq`, `trabajo`…). */
  slug: string;
  /** Row kind (`procurement_order`, `rfq`, `goods_receipt`…). */
  rowKind: string;
  /** Id of the record itself (never the `<rowKind>:<id>` of the work centre). */
  entityId: string;
  /** Optimistic version of the row, for the commands that need it. */
  version: number;
  status: string;
  user: { id: string; name: string };
  /** The person may run the area's commands (the server checks again). */
  canAct: boolean;
}

export interface AreaClientModule {
  /**
   * Cell of an area-specific column or row kind. Return `undefined` to let the
   * shared renderer take it (common columns never need an override).
   */
  renderCell?: (row: AreaWorkRow, column: EntityColumnDefinition) => ReactNode | undefined;
  /** Specialized space of the area. */
  SpecialView?: ComponentType<AreaSpecialViewProps>;
  /**
   * Management panel of ONE row of the area, shown in its detail page under the
   * facts (plan 6.1 / 7.1). It is where the flows the generic dialog cannot
   * collect live: a receipt with accepted and rejected quantities per line, the
   * review of an RFQ over its scored comparison, the resolution of a difference.
   * Returning `null` (or not declaring it) leaves the page exactly as it was.
   */
  DetailExtras?: ComponentType<AreaDetailExtrasProps>;
  /** Labels of the area's own row kinds, when they differ from the shared ones. */
  rowKindLabels?: Readonly<Record<string, string>>;
}

type RegistryMap = Map<string, AreaClientModule>;

type GlobalWithRegistry = typeof globalThis & { __unikAreaClientRegistry?: RegistryMap };

function registry(): RegistryMap {
  const scope = globalThis as GlobalWithRegistry;
  if (!scope.__unikAreaClientRegistry) scope.__unikAreaClientRegistry = new Map();
  return scope.__unikAreaClientRegistry;
}

/** Registers the client side of an area (called at module scope by its register-client file). */
export function registerAreaClient(areaKey: string, module: AreaClientModule): void {
  registry().set(areaKey, module);
}

export function getAreaClient(areaKey: string): AreaClientModule {
  return registry().get(areaKey) ?? {};
}

export function isAreaClientRegistered(areaKey: string): boolean {
  return registry().has(areaKey);
}

/** Label of a row kind, letting the area override it. */
export function areaRowKindLabel(areaKey: string, kind: string): string {
  return getAreaClient(areaKey).rowKindLabels?.[kind] ?? rowKindLabel(kind);
}

/** Testing helper. */
export function resetAreaClientRegistry(): void {
  registry().clear();
}
