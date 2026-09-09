-- DropAllObsoleteTables
-- Elimina todas las tablas que existen en la base de datos pero NO tienen
-- modelo correspondiente en prisma/schema.prisma.
--
-- Estas tablas son de modulos que fueron eliminados del codigo en sesiones
-- anteriores (Zoho Inventory, WhatsApp Chat, Estimates, Agent Tasks, etc.)
-- pero sus tablas quedaron en PostgreSQL.
--
-- TABLAS PROTEGIDAS (NO se tocan):
--   _prisma_migrations, User, UserRole, Role, RolePermission,
--   AuthSession, AuditLog, SecurityEvent (si tuviera modelo),
--   SalesOrder, SalesOrderItem,
--   EntityChangeEvent, EntityWatch,
--   IntegrationEntityState, IntegrationSnapshot, IntegrationSyncRun,
--   IntegrationConfig, IntegrationApiCall,
--   AiConversation, AiMessage, AiApiCall, AiToolCall, AiArtifact, AiAttachment, AiConfig,
--   Notification, TableView, UserTablePreference,
--   internal_chat_* (chat interno nuevo)
--
-- Orden: hijos primero, padres despues (foreign keys)
-- Usa DROP TABLE IF EXISTS para idempotencia
-- Usa CASCADE para eliminar constraints dependientes

-- ============================================================
-- Nivel 1: Tablas hijas (dependen de padres que se eliminaran)
-- ============================================================

-- Agent sub-tasks dependen de goals, goals dependen de cases
DROP TABLE IF EXISTS "AgentSubTask" CASCADE;

-- Chat campaign recipients dependen de campaigns
DROP TABLE IF EXISTS "ChatCampaignRecipient" CASCADE;

-- Chat message attachments/reactions/references dependen de messages
DROP TABLE IF EXISTS "ChatMessageAttachment" CASCADE;
DROP TABLE IF EXISTS "ChatMessageReaction" CASCADE;
DROP TABLE IF EXISTS "ChatMessageReference" CASCADE;

-- Chat poll votes dependen de polls
DROP TABLE IF EXISTS "ChatPollVote" CASCADE;

-- Chat channel members dependen de channels
DROP TABLE IF EXISTS "ChatChannelMember" CASCADE;

-- Chat mentions dependen de messages
DROP TABLE IF EXISTS "ChatMention" CASCADE;

-- Chat pinned messages dependen de messages
DROP TABLE IF EXISTS "ChatPinnedMessage" CASCADE;

-- Chat starred messages dependen de messages
DROP TABLE IF EXISTS "ChatStarredMessage" CASCADE;

-- Chat drafts dependen de messages/channels
DROP TABLE IF EXISTS "ChatDraft" CASCADE;

-- Chat link previews dependen de messages
DROP TABLE IF EXISTS "ChatLinkPreview" CASCADE;

-- Chat commitments reminders dependen de commitments
DROP TABLE IF EXISTS "ChatCommitmentReminder" CASCADE;

-- Chat personal reminders dependen de messages
DROP TABLE IF EXISTS "ChatPersonalReminder" CASCADE;

-- Estimate items dependen de estimates
DROP TABLE IF EXISTS "EstimateItem" CASCADE;

-- ============================================================
-- Nivel 2: Tablas padre
-- ============================================================

-- Agent goals dependen de cases
DROP TABLE IF EXISTS "AgentGoal" CASCADE;

-- Chat campaigns
DROP TABLE IF EXISTS "ChatCampaign" CASCADE;

-- Chat messages (tabla principal del chat WhatsApp legacy)
DROP TABLE IF EXISTS "ChatMessage" CASCADE;

-- Chat polls
DROP TABLE IF EXISTS "ChatPoll" CASCADE;

-- Chat channels (tabla principal del chat WhatsApp legacy)
DROP TABLE IF EXISTS "ChatChannel" CASCADE;

-- Chat commitments
DROP TABLE IF EXISTS "ChatCommitment" CASCADE;

-- Chat external threads
DROP TABLE IF EXISTS "ChatExternalThread" CASCADE;

-- Estimates
DROP TABLE IF EXISTS "Estimate" CASCADE;

-- ============================================================
-- Nivel 3: Tablas independientes o raiz
-- ============================================================

-- Agent cases
DROP TABLE IF EXISTS "AgentCase" CASCADE;

-- Chat AI tables
DROP TABLE IF EXISTS "ChatAiAnalysis" CASCADE;
DROP TABLE IF EXISTS "ChatAiDispatchAuthorization" CASCADE;
DROP TABLE IF EXISTS "ChatAiDispatchLog" CASCADE;
DROP TABLE IF EXISTS "ChatAiSignal" CASCADE;
DROP TABLE IF EXISTS "ChatAiSuggestedReply" CASCADE;

-- Chat configuration tables
DROP TABLE IF EXISTS "ChatAutoAssignRule" CASCADE;
DROP TABLE IF EXISTS "ChatBlockedNumber" CASCADE;
DROP TABLE IF EXISTS "ChatBusinessHours" CASCADE;
DROP TABLE IF EXISTS "ChatRetentionPolicy" CASCADE;
DROP TABLE IF EXISTS "ChatQuickReply" CASCADE;
DROP TABLE IF EXISTS "ChatKeywordAlert" CASCADE;

-- Chat scoring tables
DROP TABLE IF EXISTS "ChatCustomerScore" CASCADE;
DROP TABLE IF EXISTS "ChatSupplierScore" CASCADE;
DROP TABLE IF EXISTS "ChatSaleRisk" CASCADE;

-- Chat tasks
DROP TABLE IF EXISTS "ChatTask" CASCADE;

-- Chat presence (legacy, la nueva es internal_chat_presence)
DROP TABLE IF EXISTS "ChatPresence" CASCADE;

-- SecurityEvent (no tiene modelo en schema actual)
DROP TABLE IF EXISTS "SecurityEvent" CASCADE;

-- Zoho API tracking (no tienen modelo en schema actual)
DROP TABLE IF EXISTS "ZohoApiBudgetDay" CASCADE;
DROP TABLE IF EXISTS "ZohoApiRequestLog" CASCADE;

-- ============================================================
-- Tambien eliminar las tablas Zoho Inventory legacy si aun existen
-- (de la migracion fallida anterior)
-- ============================================================
DROP TABLE IF EXISTS "SalesOrderPackageItem" CASCADE;
DROP TABLE IF EXISTS "SalesOrderPackage" CASCADE;
DROP TABLE IF EXISTS "InvoicePayment" CASCADE;
DROP TABLE IF EXISTS "InvoiceItem" CASCADE;
DROP TABLE IF EXISTS "ProductComponent" CASCADE;
DROP TABLE IF EXISTS "Invoice" CASCADE;
DROP TABLE IF EXISTS "Product" CASCADE;
DROP TABLE IF EXISTS "Vendor" CASCADE;
