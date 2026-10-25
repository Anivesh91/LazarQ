import { prisma } from "../db/prisma";

export interface OperationalMetrics {
  totalIncidents: number;
  statusCounts: Record<string, number>;
  resolutionRatePercent: number;
  quarantineRatePercent: number;
  runbookMatchRatePercent: number;
  avgResolutionTimeSeconds: number;
  totalRunbooks: number;
}

export class MetricsService {
  /**
   * Computes genuine operational metrics directly from PostgreSQL.
   * Strictly avoids fabricated data or arbitrary percentages.
   */
  public async getOperationalMetrics(): Promise<OperationalMetrics> {
    const [totalIncidents, statusGroups, matchedCount, totalRunbooks, completedAttempts] =
      await Promise.all([
        prisma.incident.count(),
        prisma.incident.groupBy({
          by: ["status"],
          _count: { id: true },
        }),
        prisma.incident.count({
          where: { matchedRunbookId: { not: null } },
        }),
        prisma.runbook.count(),
        prisma.recoveryAttempt.findMany({
          where: {
            status: "COMPLETED",
            completedAt: { not: null },
          },
          select: {
            startedAt: true,
            completedAt: true,
          },
        }),
      ]);

    // Build status lookup map
    const statusCounts: Record<string, number> = {};
    for (const group of statusGroups) {
      statusCounts[group.status] = group._count.id;
    }

    const resolved = statusCounts["RESOLVED"] || 0;
    const quarantined =
      (statusCounts["QUARANTINED"] || 0) + (statusCounts["SANDBOX_FAILED"] || 0);

    const resolutionRatePercent =
      totalIncidents > 0 ? Number(((resolved / totalIncidents) * 100).toFixed(1)) : 0;

    const quarantineRatePercent =
      totalIncidents > 0 ? Number(((quarantined / totalIncidents) * 100).toFixed(1)) : 0;

    const runbookMatchRatePercent =
      totalIncidents > 0 ? Number(((matchedCount / totalIncidents) * 100).toFixed(1)) : 0;

    // Calculate average resolution time in seconds
    let avgResolutionTimeSeconds = 0;
    if (completedAttempts.length > 0) {
      const totalDurationMs = completedAttempts.reduce((acc, attempt) => {
        if (attempt.completedAt && attempt.startedAt) {
          return acc + (attempt.completedAt.getTime() - attempt.startedAt.getTime());
        }
        return acc;
      }, 0);
      avgResolutionTimeSeconds = Number((totalDurationMs / completedAttempts.length / 1000).toFixed(1));
    }

    return {
      totalIncidents,
      statusCounts,
      resolutionRatePercent,
      quarantineRatePercent,
      runbookMatchRatePercent,
      avgResolutionTimeSeconds,
      totalRunbooks,
    };
  }
}

export const metricsService = new MetricsService();
