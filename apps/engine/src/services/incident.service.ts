import { prisma } from "../db/prisma";
import { logger } from "../config/logger";
import { IncidentSnapshot } from "@dlq-healer/sdk";
import { Incident } from "@prisma/client";

export class IncidentService {
  /**
   * Durably ingests a failure snapshot received from the intake queue into PostgreSQL.
   * Ensures idempotency: duplicate deliveries with the same idempotencyKey will not create duplicates.
   */
  async ingestSnapshot(snapshot: IncidentSnapshot): Promise<{
    incident: Incident;
    isDuplicate: boolean;
  }> {
    const {
      idempotencyKey,
      source,
      queueName,
      jobId,
      jobName,
      payloadSnapshot,
      expectedJsonSchema,
      errorMessage,
      stackTrace,
      attemptsMade,
      configuredAttempts,
      occurredAt,
    } = snapshot;

    // ── 1. Idempotency Check ──
    const existing = await prisma.incident.findUnique({
      where: { idempotencyKey },
    });

    if (existing) {
      logger.info(
        { idempotencyKey, incidentId: existing.id },
        "Duplicate incident snapshot received; skipping creation."
      );
      return { incident: existing, isDuplicate: true };
    }

    // ── 2. Atomic Transaction: Create Incident + Initial AuditLog ──
    const incident = await prisma.$transaction(async (tx) => {
      const created = await tx.incident.create({
        data: {
          idempotencyKey,
          sourceId: source || "sdk-v1",
          queueName,
          jobId: String(jobId),
          jobName: jobName || "unknown",
          payloadSnapshot: payloadSnapshot || {},
          expectedJsonSchema: expectedJsonSchema || undefined,
          errorMessage,
          stackTrace: stackTrace || null,
          attemptsMade,
          configuredAttempts,
          status: "INGESTED",
          occurredAt: occurredAt ? new Date(occurredAt) : new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          incidentId: created.id,
          action: "FAILURE_CAPTURED",
          actor: "system/intake",
          details: {
            queueName,
            jobId: String(jobId),
            attemptsMade,
            configuredAttempts,
            errorMessage,
          },
        },
      });

      return created;
    });

    logger.info(
      {
        incidentId: incident.id,
        queueName: incident.queueName,
        jobId: incident.jobId,
        status: incident.status,
      },
      "✅ Incident successfully persisted to PostgreSQL"
    );

    return { incident, isDuplicate: false };
  }

  /**
   * Fetches an incident by ID including its recovery attempts and audit trail.
   */
  async getIncidentById(id: string) {
    return prisma.incident.findUnique({
      where: { id },
      include: {
        recoveryAttempts: { orderBy: { startedAt: "desc" } },
        auditLogs: { orderBy: { createdAt: "asc" } },
      },
    });
  }

  /**
   * Lists incidents with pagination and optional status filter.
   */
  async listIncidents(params: {
    page?: number;
    limit?: number;
    status?: any;
    queueName?: string;
  }) {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 20));
    const skip = (page - 1) * limit;

    const where: any = {};
    if (params.status) where.status = params.status;
    if (params.queueName) where.queueName = params.queueName;

    const [items, total] = await Promise.all([
      prisma.incident.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.incident.count({ where }),
    ]);

    return {
      items,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}

export const incidentService = new IncidentService();
