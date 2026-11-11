-- Ensure at most one active (PENDING, QUEUED, IN_PROGRESS) recovery attempt exists per incident.
CREATE UNIQUE INDEX IF NOT EXISTS "RecoveryAttempt_one_active_per_incident_idx"
ON "RecoveryAttempt" ("incidentId")
WHERE "status" IN ('PENDING', 'QUEUED', 'IN_PROGRESS');
