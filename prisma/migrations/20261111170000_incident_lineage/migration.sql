-- Persist lineage hierarchy for cumulative replay ceiling enforcement across failed replay chains.
ALTER TABLE "Incident"
  ADD COLUMN IF NOT EXISTS "lineageRootId" TEXT,
  ADD COLUMN IF NOT EXISTS "parentIncidentId" TEXT,
  ADD COLUMN IF NOT EXISTS "replayDepth" INTEGER NOT NULL DEFAULT 0;

UPDATE "Incident"
SET "lineageRootId" = "id"
WHERE "lineageRootId" IS NULL;

CREATE INDEX IF NOT EXISTS "Incident_lineageRootId_idx" ON "Incident" ("lineageRootId");
CREATE INDEX IF NOT EXISTS "Incident_parentIncidentId_idx" ON "Incident" ("parentIncidentId");
