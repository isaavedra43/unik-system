-- Remove the visual studio, internal requests and local quotes modules.
-- Order matters: children (FK) first, then parents.
DROP TABLE IF EXISTS "StudioExport";
DROP TABLE IF EXISTS "StudioDocumentVersion";
DROP TABLE IF EXISTS "StudioTemplate";
DROP TABLE IF EXISTS "StudioDocument";
DROP TABLE IF EXISTS "InternalRequestEvent";
DROP TABLE IF EXISTS "InternalRequest";
DROP TABLE IF EXISTS "Quote";
