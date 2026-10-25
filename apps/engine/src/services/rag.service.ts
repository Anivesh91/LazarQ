import { prisma } from "../db/prisma";
import { embeddingService } from "./embedding.service";
import { logger } from "../config/logger";
import { AppError } from "../middleware/error-handler";

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

    logger.info({ errorMessage: query.errorMessage, jobName: query.jobName }, "Generating query embedding for RAG retrieval");
    const embedding = await embeddingService.generateEmbedding(queryText);
    const vectorString = `[${embedding.join(",")}]`;

    // Query pgvector using cosine distance <=> (1 - distance = cosine similarity)
    const rawResults: any[] = await prisma.$queryRawUnsafe(
      `SELECT id, title, content, tags,
              (1 - (embedding <=> $1::vector))::float AS similarity
       FROM "Runbook"
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector ASC
       LIMIT $2;`,
      vectorString,
      limit
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
  async matchIncident(incidentId: string): Promise<RAGMatchResult> {
    const incident = await prisma.incident.findUnique({
      where: { id: incidentId },
    });

    if (!incident) {
      throw new AppError(`Incident with id ${incidentId} not found`, 404);
    }

    // Set status to ANALYZING
    await prisma.$transaction([
      prisma.incident.update({
        where: { id: incidentId },
        data: { status: "ANALYZING" },
      }),
      prisma.auditLog.create({
        data: {
          incidentId,
          action: "STATUS_TRANSITION",
          actor: "system",
          details: { from: incident.status, to: "ANALYZING" },
        },
      }),
    ]);

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

      // Transition to RAG_MATCHED
      await prisma.$transaction([
        prisma.incident.update({
          where: { id: incidentId },
          data: {
            status: "RAG_MATCHED",
            matchedRunbookId: bestMatch.id,
          },
        }),
        prisma.auditLog.create({
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
        }),
      ]);

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

      // Transition to QUARANTINED (Safe fallback)
      await prisma.$transaction([
        prisma.incident.update({
          where: { id: incidentId },
          data: { status: "QUARANTINED" },
        }),
        prisma.auditLog.create({
          data: {
            incidentId,
            action: "QUARANTINED",
            actor: "system",
            details: {
              reason: "No runbook matched above confidence threshold",
              highestSimilarity: bestMatch?.similarity || 0,
              threshold: this.similarityThreshold,
              bestCandidate: bestMatch ? { id: bestMatch.id, title: bestMatch.title } : null,
            },
          },
        }),
      ]);

      return {
        status: "QUARANTINED",
        matched: false,
        runbook: null,
        similarity: bestMatch?.similarity || 0,
        allMatches: matches,
      };
    }
  }
}

export const ragService = new RAGService();
