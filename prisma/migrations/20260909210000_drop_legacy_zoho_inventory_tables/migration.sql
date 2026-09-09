-- DropLegacyZohoInventoryTables
-- Elimina las tablas legacy del intento anterior de modulos Zoho Inventory
-- que ya no forman parte del schema actual de Prisma.
--
-- Estas tablas fueron creadas por la migracion fallida 20260909160000
-- y no tienen modelo correspondiente en prisma/schema.prisma.
--
-- REGLAS:
--   - NO tocar SalesOrder, SalesOrderItem
--   - NO tocar IntegrationEntityState, IntegrationSnapshot, IntegrationSyncRun,
--     IntegrationConfig, IntegrationApiCall
--   - NO tocar User ni tablas de chat/IA
--   - DROP TABLE IF EXISTS para idempotencia
--   - Orden: hijos primero, padres despues (foreign keys)
--   - CASCADE para eliminar constraints dependientes
--
-- Tablas eliminadas (en orden de dependencia FK):
--   1. SalesOrderPackageItem  (FK -> SalesOrderPackage)
--   2. SalesOrderPackage       (FK -> SalesOrder, que NO se elimina)
--   3. InvoicePayment          (FK -> Invoice)
--   4. InvoiceItem             (FK -> Invoice)
--   5. Invoice                 (posible FK -> Vendor)
--   6. ProductComponent        (FK -> Product)
--   7. Product                 (posible FK -> Vendor)
--   8. Vendor

-- Nivel 1: tablas hijas (dependen de padres que se eliminaran)
DROP TABLE IF EXISTS "SalesOrderPackageItem" CASCADE;
DROP TABLE IF EXISTS "InvoicePayment" CASCADE;
DROP TABLE IF EXISTS "InvoiceItem" CASCADE;
DROP TABLE IF EXISTS "ProductComponent" CASCADE;

-- Nivel 2: tablas padre (referenciadas por las hijas)
DROP TABLE IF EXISTS "SalesOrderPackage" CASCADE;
DROP TABLE IF EXISTS "Invoice" CASCADE;
DROP TABLE IF EXISTS "Product" CASCADE;

-- Nivel 3: tabla raiz (sin dependientes restantes)
DROP TABLE IF EXISTS "Vendor" CASCADE;
