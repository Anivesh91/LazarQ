import { randomUUID } from "crypto";
import { prisma } from "../db/prisma";
import { embeddingService } from "./embedding.service";
import { AppError } from "../middleware/error-handler";
import { logger } from "../config/logger";

export interface CreateRunbookInput {
  title: string;
  content: string;
  tags?: string[];
}

export interface UpdateRunbookInput {
  title?: string;
  content?: string;
  tags?: string[];
}

export interface RunbookRecord {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export class RunbookService {
  /**
   * Creates a new Runbook, generates its 768-dim vector embedding, and stores it in PostgreSQL.
   */
  async createRunbook(input: CreateRunbookInput): Promise<RunbookRecord> {
    const { title, content, tags = [] } = input;

    if (!title || !title.trim()) {
      throw new AppError("Runbook title is required", 400);
    }
    if (!content || !content.trim()) {
      throw new AppError("Runbook content is required", 400);
    }

    // Embed combined title and markdown content for optimal semantic retrieval
    const textToEmbed = `${title.trim()}\n\n${content.trim()}`;
    const embedding = await embeddingService.generateEmbedding(textToEmbed);

    const id = randomUUID();
    const vectorString = `[${embedding.join(",")}]`;

    logger.info({ title, tags }, "Persisting new Runbook with vector embedding");

    // Persist using raw SQL to cast the 768-dim float array to pgvector
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Runbook" ("id", "title", "content", "tags", "embedding", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::vector, NOW(), NOW())`,
      id,
      title.trim(),
      content.trim(),
      tags,
      vectorString
    );

    const created = await prisma.runbook.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        content: true,
        tags: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!created) {
      throw new AppError("Failed to retrieve newly created Runbook", 500);
    }

    return created;
  }

  /**
   * Retrieves a paginated list of Runbooks.
   */
  async listRunbooks(options?: {
    tag?: string;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ runbooks: RunbookRecord[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, options?.page || 1);
    const limit = Math.min(100, Math.max(1, options?.limit || 20));
    const skip = (page - 1) * limit;

    const where: any = {};
    if (options?.tag) {
      where.tags = { has: options.tag };
    }
    if (options?.search) {
      where.OR = [
        { title: { contains: options.search, mode: "insensitive" } },
        { content: { contains: options.search, mode: "insensitive" } },
      ];
    }

    const [total, runbooks] = await Promise.all([
      prisma.runbook.count({ where }),
      prisma.runbook.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          title: true,
          content: true,
          tags: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);

    return { runbooks, total, page, limit };
  }

  /**
   * Retrieves a single Runbook by ID.
   */
  async getRunbookById(id: string): Promise<RunbookRecord> {
    const runbook = await prisma.runbook.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        content: true,
        tags: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!runbook) {
      throw new AppError(`Runbook with id ${id} not found`, 404);
    }

    return runbook;
  }

  /**
   * Updates an existing Runbook. If title or content is modified, re-generates embedding.
   */
  async updateRunbook(id: string, input: UpdateRunbookInput): Promise<RunbookRecord> {
    const existing = await this.getRunbookById(id);

    const newTitle = input.title !== undefined ? input.title.trim() : existing.title;
    const newContent = input.content !== undefined ? input.content.trim() : existing.content;
    const newTags = input.tags !== undefined ? input.tags : existing.tags;

    if (!newTitle) {
      throw new AppError("Runbook title cannot be empty", 400);
    }
    if (!newContent) {
      throw new AppError("Runbook content cannot be empty", 400);
    }

    const contentChanged = newTitle !== existing.title || newContent !== existing.content;

    if (contentChanged) {
      const textToEmbed = `${newTitle}\n\n${newContent}`;
      const embedding = await embeddingService.generateEmbedding(textToEmbed);
      const vectorString = `[${embedding.join(",")}]`;

      await prisma.$executeRawUnsafe(
        `UPDATE "Runbook"
         SET "title" = $1, "content" = $2, "tags" = $3, "embedding" = $4::vector, "updatedAt" = NOW()
         WHERE "id" = $5`,
        newTitle,
        newContent,
        newTags,
        vectorString,
        id
      );
    } else {
      await prisma.runbook.update({
        where: { id },
        data: {
          tags: newTags,
        },
      });
    }

    return this.getRunbookById(id);
  }

  /**
   * Deletes a Runbook by ID.
   */
  async deleteRunbook(id: string): Promise<{ success: boolean; id: string }> {
    await this.getRunbookById(id);

    await prisma.runbook.delete({
      where: { id },
    });

    logger.info({ id }, "Deleted Runbook");
    return { success: true, id };
  }
}

export const runbookService = new RunbookService();
