import type { DatabankRetrievalResult } from "./types";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedResult {
  result: DatabankRetrievalResult;
  cachedAt: number;
  userId: string;
  chatId: string;
  databankIds: string[];
}

const resultCache = new Map<string, CachedResult>();

export function databankCacheKey(
  userId: string,
  chatId: string,
  databankIds: string[],
  queryText: string,
  limit: number,
): string {
  return JSON.stringify([userId, chatId, limit, [...databankIds].sort(), queryText]);
}

export function getCachedDatabankResult(
  userId: string,
  chatId: string,
  databankIds: string[],
  queryText: string,
  limit: number,
): DatabankRetrievalResult | null {
  const key = databankCacheKey(userId, chatId, databankIds, queryText, limit);
  const cached = resultCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > CACHE_TTL_MS) {
    resultCache.delete(key);
    return null;
  }
  return cached.result;
}

export function setCachedDatabankResult(
  userId: string,
  chatId: string,
  databankIds: string[],
  queryText: string,
  limit: number,
  result: DatabankRetrievalResult,
): void {
  resultCache.set(databankCacheKey(userId, chatId, databankIds, queryText, limit), {
    result,
    cachedAt: Date.now(),
    userId,
    chatId,
    databankIds: [...databankIds],
  });
}

export function clearCache(userId: string, chatId: string): void {
  for (const [key, cached] of resultCache.entries()) {
    if (cached.userId === userId && cached.chatId === chatId) resultCache.delete(key);
  }
}

/** Invalidate every cached query that could contain content from this bank. */
export function invalidateDatabankCache(userId: string, databankId: string): void {
  for (const [key, cached] of resultCache.entries()) {
    if (cached.userId === userId && cached.databankIds.includes(databankId)) {
      resultCache.delete(key);
    }
  }
}

/** Drop every reconstructable retrieval result. */
export function clearAllDatabankCache(): void {
  resultCache.clear();
}

/** Test-only alias for keeping module-global cache state isolated. */
export const resetDatabankCacheForTests = clearAllDatabankCache;
