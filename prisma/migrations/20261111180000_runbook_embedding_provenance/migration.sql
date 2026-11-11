-- Phase 5 (B23): Track embedding provider & model provenance on Runbook vectors
ALTER TABLE "Runbook"
  ADD COLUMN IF NOT EXISTS "embeddingProvider" TEXT NOT NULL DEFAULT 'gemini',
  ADD COLUMN IF NOT EXISTS "embeddingModel" TEXT NOT NULL DEFAULT 'gemini-embedding-001';

CREATE INDEX IF NOT EXISTS "Runbook_embeddingProvider_embeddingModel_idx"
  ON "Runbook"("embeddingProvider", "embeddingModel");
