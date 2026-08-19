import { describe, expect, test } from "bun:test";
import {
  currentWorkerBudget,
  deriveWorkerBudget,
  logicalThreadCount,
  setWorkerBudgetOverride,
} from "./cpu-budget";

describe("cpu-budget", () => {
  test("logicalThreadCount floors and floors invalid values to 1", () => {
    expect(logicalThreadCount(() => 14)).toBe(14);
    expect(logicalThreadCount(() => 1.9)).toBe(1);
    expect(logicalThreadCount(() => 0)).toBe(1);
    expect(logicalThreadCount(() => Number.NaN)).toBe(1);
    expect(logicalThreadCount(() => { throw new Error("unavailable"); })).toBe(1);
  });

  test("reserves threads and caps worker / Sharp / deferred jobs", () => {
    expect(deriveWorkerBudget(14)).toEqual({
      logicalThreads: 14,
      reserved: 2,
      workerConcurrency: 6,
      sharpConcurrency: 4,
      deferredImageConcurrency: 2,
    });
    expect(deriveWorkerBudget(8)).toEqual({
      logicalThreads: 8,
      reserved: 2,
      workerConcurrency: 6,
      sharpConcurrency: 4,
      deferredImageConcurrency: 2,
    });
    expect(deriveWorkerBudget(4)).toEqual({
      logicalThreads: 4,
      reserved: 2,
      workerConcurrency: 2,
      sharpConcurrency: 2,
      deferredImageConcurrency: 1,
    });
    expect(deriveWorkerBudget(2)).toEqual({
      logicalThreads: 2,
      reserved: 1,
      workerConcurrency: 1,
      sharpConcurrency: 1,
      deferredImageConcurrency: 1,
    });
    expect(deriveWorkerBudget(1)).toEqual({
      logicalThreads: 1,
      reserved: 0,
      workerConcurrency: 1,
      sharpConcurrency: 1,
      deferredImageConcurrency: 1,
    });
  });

  test("override replaces the live budget until cleared", () => {
    const override = deriveWorkerBudget(4);
    setWorkerBudgetOverride(override);
    expect(currentWorkerBudget()).toEqual(override);
    setWorkerBudgetOverride(null);
    expect(currentWorkerBudget().logicalThreads).toBeGreaterThanOrEqual(1);
  });
});
