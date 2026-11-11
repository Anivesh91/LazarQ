-- B15: Include sourceId in uniqueness constraint so multi-application incident deduplication never collides.
DROP INDEX IF EXISTS "Incident_queueName_jobId_attemptsMade_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Incident_sourceId_queueName_jobId_attemptsMade_key"
  ON "Incident" ("sourceId", "queueName", "jobId", "attemptsMade");

-- B12: Isolate encrypted execution payload from redacted UI/AI snapshots.
ALTER TABLE "Incident"
  ADD COLUMN IF NOT EXISTS "encryptedExecutionPayload" JSONB;
