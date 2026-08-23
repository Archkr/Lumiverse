import { regexApi } from '@/api/regex'
import type { RegexRiskLevel } from './risk-analyzer'

export interface AnalyzerRiskPatch {
  risk?: RegexRiskLevel
  reasons?: string[]
  analyzed_at?: number
}

/** Best-effort persistence of analyzer risk metadata. Ownership rejections
 *  (extension-owned scripts return 403) are expected and swallowed silently;
 *  every other failure only logs a warning. Never throws. */
export async function saveRegexPerformance(scriptId: string, patch: AnalyzerRiskPatch): Promise<boolean> {
  try {
    const script = await regexApi.get(scriptId)
    const metadata: Record<string, any> = { ...(script.metadata ?? {}) }
    metadata.analyzer_risk = { ...(metadata.analyzer_risk ?? {}), ...patch }
    await regexApi.update(scriptId, { metadata })
    return true
  } catch (err: any) {
    if (err?.status === 403) {
      // Extension-owned scripts reject host-side analyzer metadata writes.
      return false
    }
    console.warn('[regex] failed to persist analyzer risk metadata:', err)
    return false
  }
}
