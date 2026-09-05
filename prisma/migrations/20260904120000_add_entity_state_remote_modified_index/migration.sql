-- Additive index to support fetching pending entities ordered by
-- remoteModifiedAt DESC (most recently modified first).
-- This is critical for the incremental sync pipeline: new/recent orders
-- must be processed before historical backlog.
--
-- The composite index [source, entityType, needsSync, remoteModifiedAt]
-- allows PostgreSQL to satisfy the query:
--   WHERE source = 'zoho' AND entityType = 'sales_order' AND needsSync = true
--   ORDER BY remoteModifiedAt DESC, externalId ASC
--   LIMIT N
-- with an index-only scan when needsSync = true is selective enough.

CREATE INDEX IF NOT EXISTS "IntegrationEntityState_source_entityType_needsSync_remoteModifiedAt_idx"
  ON "IntegrationEntityState"("source", "entityType", "needsSync", "remoteModifiedAt");
