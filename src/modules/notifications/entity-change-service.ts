import { Prisma } from '@prisma/client';
import { notifyUser } from './notification-service';

/**
 * Generic change detection for watched entities ("seguimiento").
 *
 * Every Zoho normalizer calls `recordEntityChange` inside its transaction with
 * the row BEFORE and AFTER the upsert. The service diffs the declared fields,
 * stores one EntityChangeEvent (idempotent per source snapshot) and notifies
 * every active watcher through the central notification service (in-app +
 * push, honoring each user's preferences).
 *
 * Rules (same as the original sales-orders implementation):
 * - First import (no `before`) never produces an event.
 * - Retries never duplicate events (`sourceSnapshotId` is unique).
 * - Only meaningful business fields are compared — never technical timestamps.
 */

export interface ChangeFieldSpec<T> {
  key: keyof T & string;
  label: string;
  /** Custom formatter for the "before → after" summary. */
  format?: (value: unknown) => string;
}

export interface EntityChangeInput<T> {
  entityType: string;
  entityId: string;
  /** Human label used in the notification title, e.g. "Factura INV-00012". */
  label: string;
  /** In-app path of the entity detail. */
  url: string;
  sourceSnapshotId: string;
  sourceRemoteModifiedAt: Date | null;
  before: T | null;
  after: T;
  fields: ReadonlyArray<ChangeFieldSpec<T>>;
  /** Extra diff blocks computed by the caller (e.g. line items). */
  extraChanges?: Record<string, unknown> | null;
  /** User who caused the change (never notified about their own edit). */
  actorUserId?: string | null;
  /** Fine-grained notification type. Defaults to `${entityType}_changed`. */
  notificationType?: string;
  metadata?: Record<string, unknown> | null;
}

export type FieldDiff = Record<string, { before: unknown; after: unknown }>;

export function formatChangeValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (value instanceof Prisma.Decimal) return value.toString();
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  return String(value);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (a instanceof Prisma.Decimal && b instanceof Prisma.Decimal) return a.equals(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return String(a) === String(b);
}

function serialize(value: unknown): unknown {
  if (value instanceof Prisma.Decimal) return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

export function diffEntityFields<T>(
  before: T,
  after: T,
  fields: ReadonlyArray<ChangeFieldSpec<T>>
): FieldDiff {
  const changes: FieldDiff = {};
  for (const field of fields) {
    const b = (before as Record<string, unknown>)[field.key];
    const a = (after as Record<string, unknown>)[field.key];
    if (!valuesEqual(b, a)) changes[field.key] = { before: serialize(b), after: serialize(a) };
  }
  return changes;
}

export function summarizeFieldChanges<T>(
  before: T,
  after: T,
  changes: FieldDiff,
  fields: ReadonlyArray<ChangeFieldSpec<T>>,
  max = 3
): string {
  const specs = new Map(fields.map((f) => [f.key, f]));
  return Object.keys(changes)
    .slice(0, max)
    .map((key) => {
      const spec = specs.get(key as keyof T & string);
      const fmt = spec?.format ?? formatChangeValue;
      const b = (before as Record<string, unknown>)[key];
      const a = (after as Record<string, unknown>)[key];
      return `${spec?.label ?? key}: ${fmt(b)} → ${fmt(a)}`;
    })
    .join(', ');
}

export async function recordEntityChange<T>(
  tx: Prisma.TransactionClient,
  input: EntityChangeInput<T>
): Promise<{ eventId: string | null; changes: FieldDiff }> {
  if (input.before === null) return { eventId: null, changes: {} };

  const existing = await tx.entityChangeEvent.findUnique({
    where: { sourceSnapshotId: input.sourceSnapshotId },
    select: { id: true },
  });
  if (existing) return { eventId: existing.id, changes: {} };

  const fieldChanges = diffEntityFields(input.before, input.after, input.fields);
  const hasExtra = input.extraChanges && Object.keys(input.extraChanges).length > 0;
  if (Object.keys(fieldChanges).length === 0 && !hasExtra) return { eventId: null, changes: {} };

  const changes: Record<string, unknown> = {};
  if (Object.keys(fieldChanges).length > 0) changes.fields = fieldChanges;
  if (hasExtra) Object.assign(changes, input.extraChanges);
  if (input.actorUserId) changes.actorUserId = input.actorUserId;

  const event = await tx.entityChangeEvent.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      sourceSnapshotId: input.sourceSnapshotId,
      sourceRemoteModifiedAt: input.sourceRemoteModifiedAt,
      changes: changes as Prisma.InputJsonValue,
    },
  });

  const watchers = await tx.entityWatch.findMany({
    where: { entityType: input.entityType, entityId: input.entityId, isActive: true },
    select: { userId: true },
  });
  if (watchers.length === 0) return { eventId: event.id, changes: fieldChanges };

  const summary = summarizeFieldChanges(input.before, input.after, fieldChanges, input.fields);
  const body =
    summary ||
    (hasExtra && 'items' in (input.extraChanges ?? {}) ? 'Cambiaron las partidas' : 'Se detectaron cambios');

  for (const watcher of watchers) {
    await notifyUser({
      tx,
      userId: watcher.userId,
      actorUserId: input.actorUserId ?? null,
      category: 'entity_change',
      type: input.notificationType ?? `${input.entityType}_changed`,
      title: `${input.label} tiene cambios`,
      body,
      url: input.url,
      entityType: input.entityType,
      entityId: input.entityId,
      changeEventId: event.id,
      dedupeKey: `change:${event.id}:${watcher.userId}`,
      metadata: input.metadata ?? null,
      push: { tag: `entity:${input.entityType}:${input.entityId}` },
    });
  }
  return { eventId: event.id, changes: fieldChanges };
}
