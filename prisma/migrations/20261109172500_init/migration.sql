-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('INGESTED', 'ANALYZING', 'RAG_MATCHED', 'PROPOSAL_READY', 'AWAITING_APPROVAL', 'REPLAY_QUEUED', 'REPLAYING', 'RESOLVED', 'QUARANTINED', 'SANDBOX_FAILED', 'REPLAY_FAILED', 'ANALYSIS_FAILED');

-- CreateEnum
CREATE TYPE "RecoveryStatus" AS ENUM ('PENDING', 'QUEUED', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL DEFAULT 'sdk-v1',
    "queueName" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "payloadSnapshot" JSONB NOT NULL,
    "expectedJsonSchema" JSONB,
    "errorMessage" TEXT NOT NULL,
    "stackTrace" TEXT,
    "attemptsMade" INTEGER NOT NULL,
    "configuredAttempts" INTEGER NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'INGESTED',
    "idempotencyKey" TEXT NOT NULL,
    "fingerprint" TEXT,
    "matchedRunbookId" TEXT,
    "aiDiagnosis" JSONB,
    "proposedPayload" JSONB,
    "validationResult" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Runbook" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(768),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Runbook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryAttempt" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "proposedPayload" JSONB NOT NULL,
    "validationResult" JSONB,
    "replayJobId" TEXT,
    "status" "RecoveryStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RecoveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Incident_idempotencyKey_key" ON "Incident"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Incident_status_idx" ON "Incident"("status");

-- CreateIndex
CREATE INDEX "Incident_queueName_idx" ON "Incident"("queueName");

-- CreateIndex
CREATE INDEX "Incident_fingerprint_idx" ON "Incident"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_queueName_jobId_attemptsMade_key" ON "Incident"("queueName", "jobId", "attemptsMade");

-- CreateIndex
CREATE INDEX "RecoveryAttempt_incidentId_idx" ON "RecoveryAttempt"("incidentId");

-- CreateIndex
CREATE INDEX "RecoveryAttempt_status_idx" ON "RecoveryAttempt"("status");

-- CreateIndex
CREATE INDEX "AuditLog_incidentId_idx" ON "AuditLog"("incidentId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_matchedRunbookId_fkey" FOREIGN KEY ("matchedRunbookId") REFERENCES "Runbook"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;
