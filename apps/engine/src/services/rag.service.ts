import { IncidentStatus, Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";
import { embeddingService } from "./embedding.service";
import { eventBroadcaster } from "./event-broadcaster.service";
import { logger } from "../config/logger";
import { AppError } from "../middleware/error-handler";
import { sanitizeErrorMessage } from "./execution-payload.service";
import {
  assertAndTransitionIncident,
  transitionIncidentConditional,
} from "./incident-state";

export interface MatchIncidentOptions {
  allowAnalyzingResume?: boolean;
  preserveStatusOnError?: boolean;
}

export interface MatchedRunbook {
  id: string;
  title: string;
  content: string;
  tags: string[];
  similarity: number;
}

export interface RAGMatchResult {
  status: "RAG_MATCHED" | "QUARANTINED";
  matched: boolean;
  runbook: MatchedRunbook | null;
  similarity: number;
  allMatches?: MatchedRunbook[];
}

export class RAGService {
  // Default cosine similarity threshold: 0.60 (60% semantic similarity in 768-dim space)
  public readonly similarityThreshold: number;

  constructor(threshold = 0.60) {
    this.similarityThreshold = threshold;
  }

  /**
   * Retrieves the top most relevant runbooks for a given job failure using pgvector cosine distance.
   */
  async findMatchingRunbooks(
    query: {
      errorMessage: string;
      stackTrace?: string | null;
      jobName?: string;
    },
    limit = 3
  ): Promise<MatchedRunbook[]> {
    const textComponents = [
      query.jobName ? `Job: ${query.jobName}` : "",
      `Error: ${query.errorMessage}`,
      query.stackTrace ? `Stack Trace: ${query.stackTrace.slice(0, 500)}` : "",
    ].filter(Boolean);

    const queryText = textComponents.join("\n");
    if (!queryText.trim()) {
      throw new AppError("Query text cannot be empty for RAG retrieval", 400);
    }

    logger.info(
      { errorMessage: query.errorMessage, jobName: query.jobName },
      "Generating query embedding for RAG retrieval"
    );
    const embedding = await embeddingService.generateEmbedding(queryText);
    const { provider: embeddingProvider, model: embeddingModel } =
      embeddingService.getProvenance();
    const vectorString = `[${embedding.join(",")}]`;

    // Query pgvector using cosine distance <=> strictly matching active vector provenance (B23)
    const rawResults: any[] = await prisma.$queryRawUnsafe(
      `SELECT id, title, content, tags,
              (1 - (embedding <=> $1::vector))::float AS similarity
       FROM "Runbook"
       WHERE embedding IS NOT NULL
         AND "embeddingProvider" = $3
         AND "embeddingModel" = $4
       ORDER BY embedding <=> $1::vector ASC
       LIMIT $2;`,
      vectorString,
      limit,
      embeddingProvider,
      embeddingModel
    );

    return rawResults.map((row) => {
      const rawSim = Number(row.similarity);
      const similarity = isNaN(rawSim) ? 0 : parseFloat(rawSim.toFixed(4));
      return {
        id: row.id,
        title: row.title,
        content: row.content,
        tags: row.tags || [],
        similarity,
      };
    });
  }

  /**
   * Analyzes an ingested incident, computes semantic matches against the vector knowledge base,
   * updates incident status to RAG_MATCHED or QUARANTINED, and logs an audit record.
   */
  async matchIncident(
    incidentId: string,
    options: MatchIncidentOptions = {}
  ): Promise<RAGMatchResult> {
    const incident = await prisma.incident.findUnique({
      where: { id: incidentId },
    });

    if (!incident) {
      throw new AppError(`Incident with id ${incidentId} not found`, 404, "NOT_FOUND");
    }

    const allowedStartStatuses: IncidentStatus[] = options.allowAnalyzingResume
      ? ["INGESTED", "ANALYZING"]
      : ["INGESTED"];

    if (!allowedStartStatuses.includes(incident.status)) {
      throw new AppError(
        `Cannot run RAG matching on incident ${incidentId} in current status "${incident.status}"`,
        409,
        "INVALID_STATE_TRANSITION"
      );
    }

    if (incident.status === "INGESTED") {
      await prisma.$transaction(async (tx) => {
        await assertAndTransitionIncident(tx, {
          incidentId,
          allowedFrom: ["INGESTED"],
          toStatus: "ANALYZING",
          actionName: "RAG match start",
        });

        await tx.auditLog.create({
          data: {
            incidentId,
            action: "STATUS_TRANSITION",
            actor: "system",
            details: { from: incident.status, to: "ANALYZING" },
          },
        });
      });

      eventBroadcaster.broadcast("incident:analyzing", {
        incidentId,
        status: "ANALYZING",
      });
    }

    try {
      const matches = await this.findMatchingRunbooks({
        errorMessage: incident.errorMessage,
        stackTrace: incident.stackTrace,
        jobName: incident.jobName,
      });

      const bestMatch = matches[0] || null;

      if (bestMatch && bestMatch.similarity >= this.similarityThreshold) {
        logger.info(
          {
            incidentId,
            runbookId: bestMatch.id,
            runbookTitle: bestMatch.title,
            similarity: bestMatch.similarity,
          },
          "Found matching Runbook with sufficient confidence"
        );

        // Transition atomically to RAG_MATCHED
        await prisma.$transaction(async (tx) => {
          await assertAndTransitionIncident(tx, {
            incidentId,
            allowedFrom: ["ANALYZING"],
            toStatus: "RAG_MATCHED",
            data: { matchedRunbookId: bestMatch.id },
            actionName: "RAG match success",
          });

          await tx.auditLog.create({
            data: {
              incidentId,
              action: "RAG_MATCHED",
              actor: "system",
              details: {
                runbookId: bestMatch.id,
                runbookTitle: bestMatch.title,
                similarity: bestMatch.similarity,
                threshold: this.similarityThreshold,
              },
            },
          });
        });

        return {
          status: "RAG_MATCHED",
          matched: true,
          runbook: bestMatch,
          similarity: bestMatch.similarity,
          allMatches: matches,
        };
      } else {
        logger.warn(
          {
            incidentId,
            highestSimilarity: bestMatch?.similarity || 0,
            threshold: this.similarityThreshold,
          },
          "No matching Runbook found above threshold; quarantining incident"
        );

        const shouldPurge = incident.encryptedExecutionPayload != null;

        // Transition atomically to QUARANTINED (Safe fallback)
        await prisma.$transaction(async (tx) => {
          await assertAndTransitionIncident(tx, {
            incidentId,
            allowedFrom: ["ANALYZING"],
            toStatus: "QUARANTINED",
            ...(shouldPurge
              ? { data: { encryptedExecutionPayload: Prisma.DbNull } }
              : {}),
            actionName: "RAG quarantine",
          });

          await tx.auditLog.create({
            data: {
              incidentId,
              action: "QUARANTINED",
              actor: "system",
              details: {
                reason: "No runbook matched above confidence threshold",
                highestSimilarity: bestMatch?.similarity || 0,
                threshold: this.similarityThreshold,
                bestCandidate: bestMatch
                  ? { id: bestMatch.id, title: bestMatch.title }
                  : null,
              },
            },
          });
        });

        eventBroadcaster.broadcast("incident:quarantined", {
          incidentId,
          status: "QUARANTINED",
          reason: "No runbook matched above confidence threshold",
          highestSimilarity: bestMatch?.similarity || 0,
        });

        return {
          status: "QUARANTINED",
          matched: false,
          runbook: null,
          similarity: bestMatch?.similarity || 0,
          allMatches: matches,
        };
      }
    } catch (err: any) {
      if (err instanceof AppError && (err.statusCode === 404 || err.statusCode === 409)) {
        throw err;
      }

      if (options.preserveStatusOnError) {
        logger.warn(
          { incidentId, err: sanitizeErrorMessage(err?.message) },
          "RAG matching failed with retryable error; preserving ANALYZING state for redelivery"
        );
        throw err;
      }

      const safeErrMessage = sanitizeErrorMessage(
        err?.message || "RAG matching failed"
      );

      logger.error(
        { incidentId, err: safeErrMessage },
        "RAG matching failed after transitioning to ANALYZING; marking incident ANALYSIS_FAILED"
      );

      try {
        const shouldPurgeOnFail = incident.encryptedExecutionPayload != null;
        let markedFailed = false;
        await prisma.$transaction(async (tx) => {
          const transitioned = await transitionIncidentConditional(tx, {
            incidentId,
            allowedFrom: ["ANALYZING"],
            toStatus: "ANALYSIS_FAILED",
            ...(shouldPurgeOnFail
              ? { data: { encryptedExecutionPayload: Prisma.DbNull } }
              : {}),
            actionName: "RAG failure",
          });

          markedFailed = transitioned;
          if (transitioned) {
            await tx.auditLog.create({
              data: {
                incidentId,
                action: "ANALYSIS_FAILED",
                actor: "system/rag",
                details: { error: safeErrMessage },
              },
            });
          }
        });

        if (markedFailed) {
          eventBroadcaster.broadcast("incident:failed", {
            incidentId,
            status: "ANALYSIS_FAILED",
            error: safeErrMessage,
          });
        }
      } catch (persistErr: any) {
        logger.error(
          { incidentId, err: persistErr?.message },
          "Failed to persist ANALYSIS_FAILED fallback after RAG error"
        );
      }

      throw err;
    }
  }
}

export const ragService = new RAGService();
