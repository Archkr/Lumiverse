/** Durable Illarin delivery collection and acknowledgement workers. */

import * as svc from "../services/illarin-instance.service";
import type { IllarinInstance } from "../services/illarin-instance.service";
import {
  collectDeliveries,
  IllarinApiError,
  IllarinRateLimitError,
  IllarinUnauthorizedError,
  IllarinUnavailableError,
} from "./api";
import type { DeliveryWorkList, IllarinDelivery, TakedownNotice } from "./types";
import { installIllarinDelivery } from "./delivery-installer";
import { recordWithheld, reportLibrary } from "./extensions";
import { getValidAccessToken, handleTerminalUnauthorized, refreshAccessToken } from "./tokens";
import { clearPermissionError, setPermissionError } from "./permission-state";

const MAX_BACKOFF_MS = 60_000;
const LIBRARY_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60_000;
let librarySnapshotTimer: ReturnType<typeof setInterval> | null = null;

export interface DeliveryCycleDependencies {
  getInstance(userId: string): Promise<IllarinInstance | null>;
  getAccessToken(userId: string): Promise<string | null>;
  refreshAccessToken(userId: string): Promise<string | null>;
  collect(baseUrl: string, token: string, acknowledge: readonly string[]): Promise<DeliveryWorkList>;
  recordWithheld(userId: string, notices: readonly TakedownNotice[]): Promise<void>;
  pendingAcknowledgements(userId: string, instanceId: string): string[];
  markAcknowledged(userId: string, instanceId: string, deliveryIds: readonly string[]): void;
  hasReceipt(userId: string, instanceId: string, deliveryId: string): boolean;
  queueAcknowledgement(userId: string, instanceId: string, deliveryId: string): void;
  install(userId: string, delivery: IllarinDelivery): Promise<void>;
  recordInstalled(
    userId: string,
    instanceId: string,
    deliveryId: string,
    workId: string,
    versionNumber: number,
  ): void;
  terminalUnauthorized(userId: string): Promise<void>;
}

const productionDependencies: DeliveryCycleDependencies = {
  getInstance: svc.getIllarinInstance,
  getAccessToken: getValidAccessToken,
  refreshAccessToken,
  collect: collectDeliveries,
  recordWithheld,
  pendingAcknowledgements: svc.pendingDeliveryAcknowledgements,
  markAcknowledged: svc.markDeliveriesAcknowledged,
  hasReceipt: svc.hasDeliveryReceipt,
  queueAcknowledgement: svc.queueDeliveryAcknowledgement,
  install: installIllarinDelivery,
  recordInstalled: svc.recordDeliveryInstalled,
  terminalUnauthorized: (userId) => handleTerminalUnauthorized(userId, "unauthorized"),
};

export interface DeliveryCycleResult {
  status: "continue" | "stop";
  installed: number;
  failed: number;
}

async function collectWithOneRefresh(
  userId: string,
  instance: IllarinInstance,
  acknowledge: readonly string[],
  dependencies: DeliveryCycleDependencies,
): Promise<DeliveryWorkList | null> {
  const accessToken = await dependencies.getAccessToken(userId);
  if (!accessToken) return null;
  try {
    return await dependencies.collect(instance.illarinUrl, accessToken, acknowledge);
  } catch (err) {
    if (!(err instanceof IllarinUnauthorizedError)) throw err;
  }

  const refreshed = await dependencies.refreshAccessToken(userId);
  if (!refreshed) return null;
  try {
    return await dependencies.collect(instance.illarinUrl, refreshed, acknowledge);
  } catch (err) {
    if (!(err instanceof IllarinUnauthorizedError)) throw err;
    await dependencies.terminalUnauthorized(userId);
    return null;
  }
}

/**
 * Complete one queue transaction: acknowledge prior durable installs, collect
 * released work, deduplicate it, install it, then record receipts for the next
 * request. Newly installed ids are intentionally not acknowledged until a
 * later successful collect call.
 */
export async function runDeliveryCycle(
  userId: string,
  dependencies: DeliveryCycleDependencies = productionDependencies,
  signal?: AbortSignal,
): Promise<DeliveryCycleResult> {
  const instance = await dependencies.getInstance(userId);
  if (!instance || !instance.scopes.includes("work:receive")) {
    return { status: "stop", installed: 0, failed: 0 };
  }
  const acknowledge = dependencies.pendingAcknowledgements(userId, instance.instanceId);
  const work = await collectWithOneRefresh(userId, instance, acknowledge, dependencies);
  if (!work || signal?.aborted) return { status: "stop", installed: 0, failed: 0 };

  // A successful response means Illarin committed every acknowledgement in
  // the request, whether it returned work (200) or an empty wait (204).
  dependencies.markAcknowledged(userId, instance.instanceId, acknowledge);
  await dependencies.recordWithheld(userId, work.takedowns);

  let installed = 0;
  let failed = 0;
  for (const delivery of work.sends) {
    if (signal?.aborted) return { status: "stop", installed, failed };
    if (dependencies.hasReceipt(userId, instance.instanceId, delivery.id)) {
      dependencies.queueAcknowledgement(userId, instance.instanceId, delivery.id);
      continue;
    }
    try {
      await dependencies.install(userId, delivery);
      dependencies.recordInstalled(
        userId,
        instance.instanceId,
        delivery.id,
        delivery.workId,
        delivery.versionNumber,
      );
      installed++;
      if (signal?.aborted) return { status: "stop", installed, failed };
    } catch (err) {
      failed++;
      console.warn(
        `[Illarin] Send ${delivery.id} (${delivery.type}) was not installed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { status: "continue", installed, failed };
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

const workers = new Map<string, AbortController>();
const workerTasks = new Map<string, Promise<void>>();

async function runWorker(userId: string, controller: AbortController): Promise<void> {
  let failures = 0;
  while (!controller.signal.aborted && workers.get(userId) === controller) {
    try {
      const result = await runDeliveryCycle(userId, productionDependencies, controller.signal);
      if (result.status === "stop") break;
      failures = 0;
    } catch (err) {
      if (controller.signal.aborted || workers.get(userId) !== controller) break;
      if (err instanceof IllarinApiError && err.status === 403) {
        setPermissionError(userId, "work:receive");
        console.warn("[Illarin] Send collection disabled by missing work:receive permission. Enable it in Illarin account settings.");
        break;
      }
      failures++;
      const retryAfterMs = (err instanceof IllarinRateLimitError || err instanceof IllarinUnavailableError)
        && err.retryAfterSeconds !== null
        ? err.retryAfterSeconds * 1000
        : 0;
      const exponentialMs = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(failures, 6));
      const delayMs = Math.max(retryAfterMs, exponentialMs) + Math.floor(Math.random() * 1_000);
      console.warn("[Illarin] Delivery pickup failed; retrying:", err instanceof Error ? err.message : err);
      await abortableDelay(delayMs, controller.signal);
    }
  }
  if (workers.get(userId) === controller) workers.delete(userId);
}

export function startDeliveryWorker(userId: string): void {
  stopDeliveryWorker(userId);
  clearPermissionError(userId);
  const controller = new AbortController();
  const previous = workerTasks.get(userId);
  workers.set(userId, controller);
  const task = (async () => {
    if (previous) await previous;
    if (!controller.signal.aborted) await runWorker(userId, controller);
  })().finally(() => { if (workerTasks.get(userId) === task) workerTasks.delete(userId); });
  workerTasks.set(userId, task);
  void reportLibrary(userId);
}

export function stopDeliveryWorker(userId: string): void {
  workers.get(userId)?.abort();
  workers.delete(userId);
}

export async function startAllDeliveryWorkers(): Promise<void> {
  const instances = await svc.listIllarinInstances();
  for (const instance of instances) {
    if (instance.scopes.includes("work:receive")) startDeliveryWorker(instance.userId);
    else if (instance.scopes.includes("library:sync")) void reportLibrary(instance.userId);
  }
  if (!librarySnapshotTimer) {
    librarySnapshotTimer = setInterval(() => {
      void svc.listIllarinInstances().then(async (current) => {
        for (const instance of current) await reportLibrary(instance.userId);
      }).catch((err) => console.warn("[Illarin] Library snapshot skipped:", err instanceof Error ? err.message : err));
    }, LIBRARY_SNAPSHOT_INTERVAL_MS);
  }
}

export function stopAllDeliveryWorkers(): void {
  for (const controller of workers.values()) controller.abort();
  workers.clear();
  if (librarySnapshotTimer) clearInterval(librarySnapshotTimer);
  librarySnapshotTimer = null;
}
