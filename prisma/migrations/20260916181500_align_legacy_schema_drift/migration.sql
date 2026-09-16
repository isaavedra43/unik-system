-- Corrección de deriva HEREDADA entre el conjunto de migraciones y `prisma/schema.prisma`.
--
-- Contexto: `prisma migrate diff --from-migrations prisma/migrations
-- --to-schema-datamodel prisma/schema.prisma` no quedaba vacío, es decir, una base
-- construida con `prisma migrate deploy` (el camino de Railway) NO era la base que
-- describe el esquema que usa el cliente de Prisma. Los cinco desajustes son anteriores
-- al programa Neural Operations (migraciones 20260904..20260913) y ninguno pertenece a
-- los modelos nuevos de operaciones, compras, manufactura, contabilidad, CRM o logística.
--
-- Esta migración NO borra tablas, ni columnas, ni datos. Los únicos `DROP` son de
-- restricciones que se vuelven a crear en la misma transacción con la definición
-- correcta, y el único `RENAME` es de un índice.
--
-- Bloqueos: `ADD CONSTRAINT ... FOREIGN KEY` toma `SHARE ROW EXCLUSIVE` sobre la tabla
-- hija y valida las filas existentes. Son tablas de detalle pequeñas
-- (InvoiceItem/PackageItem/PurchaseOrderItem/AiAttachment); aun así conviene aplicarla
-- en la ventana de despliegue y no con carga de escritura encima.

-- ---------------------------------------------------------------------------
-- 1. AiAttachment.messageId: la relación `message AiMessage? @relation(..., onDelete: SetNull)`
--    existe en el esquema, pero 20260909120000_add_ai_attachment_message_relation sólo creó
--    el índice y nunca la llave foránea (a diferencia de AiArtifact, que sí la recibió en
--    20260913160500_artifact_message_relation). Sin la FK, borrar un AiMessage dejaba
--    adjuntos apuntando a un mensaje inexistente en vez de poner el campo en NULL.
--    Se limpian primero los huérfanos, igual que hizo la migración de AiArtifact.
-- ---------------------------------------------------------------------------
UPDATE "AiAttachment" a SET "messageId" = NULL
WHERE a."messageId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "AiMessage" m WHERE m.id = a."messageId");

ALTER TABLE "AiAttachment" DROP CONSTRAINT IF EXISTS "AiAttachment_messageId_fkey";
ALTER TABLE "AiAttachment" ADD CONSTRAINT "AiAttachment_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "AiMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Tres llaves foráneas creadas con `ON DELETE CASCADE` pero sin `ON UPDATE`, con lo
--    que Postgres les puso `ON UPDATE NO ACTION`. Prisma genera `ON UPDATE CASCADE` para
--    una relación requerida, así que la definición desplegada no era la del esquema.
--    (Origen: 20260910140000, 20260910150000 y 20260910160000.)
-- ---------------------------------------------------------------------------
ALTER TABLE "PackageItem" DROP CONSTRAINT IF EXISTS "PackageItem_packageId_fkey";
ALTER TABLE "PackageItem" ADD CONSTRAINT "PackageItem_packageId_fkey"
    FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InvoiceItem" DROP CONSTRAINT IF EXISTS "InvoiceItem_invoiceId_fkey";
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrderItem" DROP CONSTRAINT IF EXISTS "PurchaseOrderItem_purchaseOrderId_fkey";
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_purchaseOrderId_fkey"
    FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. internal_chat_config: el esquema declara `id String @id @default("singleton")` y
--    `value String` sin default. La tabla se creó sin default en `id`
--    (20260910120000) y la columna `value` se agregó con `DEFAULT ''`
--    (20260910170000, necesario entonces para poder añadirla NOT NULL sobre filas
--    existentes). Sólo cambian los defaults: ninguna fila se toca y `value` sigue NOT NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE "internal_chat_config" ALTER COLUMN "id" SET DEFAULT 'singleton';
ALTER TABLE "internal_chat_config" ALTER COLUMN "value" DROP DEFAULT;

-- ---------------------------------------------------------------------------
-- 4. IntegrationEntityState: 20260904120000 creó el índice con el nombre completo
--    `..._needsSync_remoteModifiedAt_idx` (71 caracteres), que Postgres truncó a 63 →
--    `..._needsSync_remoteModifi`. Prisma abrevia distinto y conserva el sufijo:
--    `..._needsSync_remoteMo_idx`. Mismo índice, nombre distinto.
--    El bloque tolera las tres situaciones posibles (nombre viejo, nombre nuevo, ambos).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  old_name CONSTANT text := 'IntegrationEntityState_source_entityType_needsSync_remoteModifi';
  new_name CONSTANT text := 'IntegrationEntityState_source_entityType_needsSync_remoteMo_idx';
  has_old boolean;
  has_new boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = old_name AND c.relkind = 'i' AND n.nspname = current_schema()
  ) INTO has_old;
  SELECT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = new_name AND c.relkind = 'i' AND n.nspname = current_schema()
  ) INTO has_new;

  IF has_new AND has_old THEN
    EXECUTE format('DROP INDEX %I', old_name);
  ELSIF has_old THEN
    EXECUTE format('ALTER INDEX %I RENAME TO %I', old_name, new_name);
  ELSIF NOT has_new THEN
    EXECUTE format(
      'CREATE INDEX %I ON "IntegrationEntityState"("source", "entityType", "needsSync", "remoteModifiedAt")',
      new_name
    );
  END IF;
END $$;
