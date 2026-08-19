import { availableParallelism } from "node:os";

export interface WorkerBudget {
  logicalThreads: number;
  reserved: number;
  /** JS-side parse/read/write workers. */
  workerConcurrency: number;
  /** libvips / Sharp thread pool size. */
  sharpConcurrency: number;
  /** Concurrent deferred thumbnail jobs. */
  deferredImageConcurrency: number;
}

let budgetOverride: WorkerBudget | null = null;

export function logicalThreadCount(
  available: () => number = availableParallelism,
): number {
  try {
    const n = available();
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.floor(n);
  } catch {
    return 1;
  }
}

/**
 * Leave a couple logical threads for the OS / UI when possible.
 * Caps keep a 14-core laptop from treating migration as a render farm.
 */
export function deriveWorkerBudget(
  logicalThreads: number = logicalThreadCount(),
  reserved = 2,
): WorkerBudget {
  const threads = Math.max(1, Math.floor(logicalThreads));
  const reserve = Math.max(0, Math.min(Math.floor(reserved), threads - 1));
  const usable = Math.max(1, threads - reserve);
  return {
    logicalThreads: threads,
    reserved: reserve,
    workerConcurrency: Math.max(1, Math.min(6, usable)),
    sharpConcurrency: Math.max(1, Math.min(4, usable)),
    deferredImageConcurrency: Math.max(1, Math.min(2, Math.ceil(usable / 4))),
  };
}

export function currentWorkerBudget(): WorkerBudget {
  return budgetOverride ?? deriveWorkerBudget();
}

export function setWorkerBudgetOverride(budget: WorkerBudget | null): void {
  budgetOverride = budget;
}
