-- AddColumn: internal_chat_config.value
--
-- The InternalChatConfig model declares `value String` (required) but the
-- original migration that created the table (20260910120000_expand_chat_internal)
-- only created `id` and `key` columns. This additive migration adds the
-- missing `value` column with a default empty string so existing rows
-- remain valid and the chat admin service (suspended users, global config)
-- can read/write values.

ALTER TABLE "internal_chat_config" ADD COLUMN "value" TEXT NOT NULL DEFAULT '';
