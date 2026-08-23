import { regexApi } from '@/api/regex'
import type { RegexScript } from '@/types/regex'
import { KILL_MS } from './worker-client'

// Client-side evidence tiers for display-regex execution (plan F10-amended):
// - quarantined scripts are skipped entirely (flagged toast once per session)
// - high analyzer risk / unknown evidence / oversized script bodies are
//   offloaded to the worker pipeline
// - only scripts with a recent successful run within budget on a small body
//   earn the synchronous fast path
export interface RegexScriptEvidence {
  last_ok_ms?: number
  last_ok_at?: number
  quarantined?: boolean
}

export type RegexExecTier = 'quarantined' | 'worker' | 'sync'

export const SYNC_FAST_PATH_MAX_BODY_CHARS = 8 * 1024
export const SYNC_FAST_PATH_BUDGET_MS = KILL_MS

interface AnalyzerRiskMetadata {
  risk?: string
}

// Session-scoped overlay. Seeded lazily from persisted metadata and consulted
// first thereafter, so tier decisions stay correct even when persistence to
// the backend fails (extension-owned scripts reject bare metadata writes).
const sessionEvidence = new Map<string, RegexScriptEvidence>()

function readStoredEvidence(script: RegexScript): RegexScriptEvidence {
  const raw = script.metadata?.regex_evidence
  if (!raw || typeof raw !== 'object') return {}
  const evidence: RegexScriptEvidence = {}
  if (typeof raw.last_ok_ms === 'number' && raw.last_ok_ms >= 0) evidence.last_ok_ms = raw.last_ok_ms
  if (typeof raw.last_ok_at === 'number' && raw.last_ok_at >= 0) evidence.last_ok_at = raw.last_ok_at
  if (raw.quarantined === true) evidence.quarantined = true
  return evidence
}

export function readRegexScriptEvidence(script: RegexScript): RegexScriptEvidence {
  let entry = sessionEvidence.get(script.id)
  if (!entry) {
    entry = readStoredEvidence(script)
    sessionEvidence.set(script.id, entry)
  }
  return entry
}

export function getRegexExecTier(script: RegexScript): { tier: RegexExecTier; reason: string } {
  const evidence = readRegexScriptEvidence(script)
  if (evidence.quarantined) return { tier: 'quarantined', reason: 'quarantined' }

  const risk = (script.metadata?.analyzer_risk as AnalyzerRiskMetadata | undefined)?.risk
  if (risk === 'high') return { tier: 'worker', reason: 'analyzer risk high' }
  if (risk !== 'low' && risk !== 'medium') return { tier: 'worker', reason: 'analyzer risk unknown' }

  const bodyChars = script.find_regex.length + script.replace_string.length
  if (bodyChars > SYNC_FAST_PATH_MAX_BODY_CHARS) return { tier: 'worker', reason: `body ${bodyChars} chars > ${SYNC_FAST_PATH_MAX_BODY_CHARS}` }
  if (evidence.last_ok_ms === undefined) return { tier: 'worker', reason: 'no last_ok evidence' }
  if (evidence.last_ok_ms > SYNC_FAST_PATH_BUDGET_MS) return { tier: 'worker', reason: `last_ok ${evidence.last_ok_ms}ms over ${SYNC_FAST_PATH_BUDGET_MS}ms budget` }

  return { tier: 'sync', reason: `last_ok ${evidence.last_ok_ms}ms within budget` }
}

export function isRegexScriptQuarantined(script: RegexScript): boolean {
  return readRegexScriptEvidence(script).quarantined === true
}

function persistEvidence(scriptId: string, patch: RegexScriptEvidence): void {
  void regexApi.reportEvidence(scriptId, patch).catch(() => {
    // Best-effort persistence: extension-owned scripts may reject the write.
    // The session overlay keeps tiering correct regardless.
  })
}

// Record a successful application. Persists only on tier-relevant transitions
// (unknown -> known) so steady-state streaming never spams the API.
export function recordRegexScriptSuccess(script: RegexScript, elapsedMs: number): void {
  const before = getRegexExecTier(script)
  const evidence = readRegexScriptEvidence(script)
  evidence.quarantined = false
  evidence.last_ok_ms = Math.max(0, Math.round(elapsedMs))
  evidence.last_ok_at = Date.now()
  sessionEvidence.set(script.id, evidence)

  const after = getRegexExecTier(script)
  if (before.tier !== after.tier && after.tier === 'sync') {
    persistEvidence(script.id, {
      last_ok_ms: evidence.last_ok_ms,
      last_ok_at: evidence.last_ok_at,
      quarantined: false,
    })
  }
}

export function quarantineRegexScript(script: RegexScript): void {
  const evidence = readRegexScriptEvidence(script)
  if (evidence.quarantined) return
  evidence.quarantined = true
  sessionEvidence.set(script.id, evidence)
  persistEvidence(script.id, { quarantined: true })
}

export function resetRegexEvidenceForTests(): void {
  sessionEvidence.clear()
}
