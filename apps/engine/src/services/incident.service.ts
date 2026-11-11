import { randomUUID } from "crypto";
import { Prisma, Incident } from "@prisma/client";
import { prisma } from "../db/prisma";
import { logger } from "../config/logger";
import { IncidentSnapshot } from "@dlq-healer/sdk";
import { eventBroadcaster } from "./event-broadcaster.service";
import {
  prepareIngestSnapshotData,
  sanitizeIncidentForView,
} from "./execution-payload.service";

export class IncidentService {
  /**
   * Durably ingests a failure snapshot received from the intake queue into PostgreSQL.
   * Ensures idempotency: duplicate deliveries with the same idempotencyKey or source namespace key will not create duplicates.
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
      expectedJsonSchema,
      attemptsMade,
      configuredAttempts,
      occurredAt,
      lineage,
    } = snapshot;

    const normalizedSourceId = source || "sdk-v1";
    const normalizedJobId = String(jobId);

    const {
      sanitizedPayload,
      sanitizedErrorMessage,
      sanitizedStackTrace,
      encryptedExecutionPayload,
    } = prepareIngestSnapshotData(snapshot);

    // ── 1. Idempotency Check (B15: sourceId namespaced) ──
    const existing = await prisma.incident.findFirst({
      where: {
        OR: [
          { idempotencyKey },
          {
            sourceId: normalizedSourceId,
            queueName,
            jobId: normalizedJobId,
            attemptsMade,
          },
        ],
      },
    });

    if (existing) {
      logger.info(
        { idempotencyKey, incidentId: existing.id },
        "Duplicate incident snapshot received; skipping creation."
      );
      return {
        incident: sanitizeIncidentForView(existing),
        isDuplicate: true,
      };
    }

    // ── 2. Atomic Transaction: Create Incident + Initial AuditLog ──
    let incident: Incident;
    try {
      incident = await prisma.$transaction(
        async (tx) => {
          const incidentId = randomUUID();
          let lineageRootId: string = incidentId;
          let parentIncidentId: string | null = null;
          let replayDepth = 0;

          if (lineage?.parentIncidentId) {
            const parent = await tx.incident.findUnique({
              where: { id: lineage.parentIncidentId },
              select: { id: true, lineageRootId: true, replayDepth: true },
            });
            if (parent) {
              lineageRootId = parent.lineageRootId || parent.id;
              parentIncidentId = parent.id;
              replayDepth = (parent.replayDepth ?? 0) + 1;
            } else {
              lineageRootId = lineage.lineageRootId || incidentId;
              parentIncidentId = lineage.parentIncidentId;
              replayDepth = lineage.replayDepth ?? 1;
            }
          } else {
            const recoveryAttemptMatch = normalizedJobId.match(
              /^recovery-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-\d+)?$/i
            );
            if (recoveryAttemptMatch) {
              const attempt = await tx.recoveryAttempt.findUnique({
                where: { id: recoveryAttemptMatch[1] },
                include: {
                  incident: {
                    select: { id: true, lineageRootId: true, replayDepth: true },
                  },
                },
              });
              if (attempt?.incident) {
                lineageRootId =
                  attempt.incident.lineageRootId || attempt.incident.id;
                parentIncidentId = attempt.incident.id;
                replayDepth = (attempt.incident.replayDepth ?? 0) + 1;
              }
            }
          }

          const created = await tx.incident.create({
            data: {
              id: incidentId,
              idempotencyKey,
              sourceId: normalizedSourceId,
              queueName,
              jobId: normalizedJobId,
              jobName: jobName || "unknown",
              lineageRootId,
              parentIncidentId,
              replayDepth,
              payloadSnapshot: sanitizedPayload,
              encryptedExecutionPayload: encryptedExecutionPayload ?? undefined,
              expectedJsonSchema: expectedJsonSchema || undefined,
              errorMessage: sanitizedErrorMessage,
              stackTrace: sanitizedStackTrace,
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
                sourceId: normalizedSourceId,
                queueName,
                jobId: normalizedJobId,
                attemptsMade,
                configuredAttempts,
                errorMessage: sanitizedErrorMessage,
                lineageRootId,
                parentIncidentId,
                replayDepth,
              },
            },
          });

          return created;
        },
        {
          maxWait: 10000,
          timeout: 15000,
        }
      );
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        const concurrentExisting = await prisma.incident.findFirst({
          where: {
            OR: [
              { idempotencyKey },
              {
                sourceId: normalizedSourceId,
                queueName,
                jobId: normalizedJobId,
                attemptsMade,
              },
            ],
          },
        });
        if (concurrentExisting) {
          logger.info(
            { idempotencyKey, incidentId: concurrentExisting.id },
            "Concurrent duplicate incident snapshot detected; returning existing record."
          );
          return {
            incident: sanitizeIncidentForView(concurrentExisting),
            isDuplicate: true,
          };
        }
      }
      throw err;
    }

    const safeIncident = sanitizeIncidentForView(incident);

    logger.info(
      {
        incidentId: safeIncident.id,
        queueName: safeIncident.queueName,
        jobId: safeIncident.jobId,
        status: safeIncident.status,
      },
      "✅ Incident successfully persisted to PostgreSQL"
    );

    // Broadcast live event to connected dashboards (without encryptedExecutionPayload)
    eventBroadcaster.broadcast("incident:new", { incident: safeIncident });

    return { incident: safeIncident, isDuplicate: false };
  }

  /**
   * Fetches an incident by ID including its recovery attempts and audit trail.
   */
  async getIncidentById(id: string) {
    const incident = await prisma.incident.findUnique({
      where: { id },
      include: {
        matchedRunbook: {
          select: {
            id: true,
            title: true,
            content: true,
            tags: true,
          },
        },
        recoveryAttempts: { orderBy: { startedAt: "desc" } },
        auditLogs: { orderBy: { createdAt: "asc" } },
      },
    });
    return incident ? sanitizeIncidentForView(incident) : null;
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
    const trimmedQueue = params.queueName?.trim();
    if (trimmedQueue) {
      where.queueName = { contains: trimmedQueue, mode: "insensitive" };
    }

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
      items: items.map((item) => sanitizeIncidentForView(item)),
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
