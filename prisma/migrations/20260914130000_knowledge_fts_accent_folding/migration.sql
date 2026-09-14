-- Accent-insensitive full-text search for the approved library. Query terms are folded
-- ("instalacion", "anos"), so the indexed text is folded the same way. The expression must match
-- FOLDED_TSVECTOR in src/modules/copilot/knowledge-service.ts for the index to be used.
-- Additive: the previous KnowledgeChunk_content_fts_idx is kept.
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_content_fts_folded_idx"
  ON "KnowledgeChunk"
  USING GIN (to_tsvector('spanish', translate(lower("content"), 'áéíóúüñ', 'aeiouun')));
