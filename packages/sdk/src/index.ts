export interface DLQHealerConfig {
  redisUrl?: string;
  intakeQueueName?: string;
  redactFields?: string[];
}

export function attachDLQHealer(worker: any, config?: DLQHealerConfig) {
  // Skeleton implementation for Day 1
  return {
    attached: true,
    workerName: worker?.name || "unknown",
  };
}
