import { regexApi } from '@/api/regex'
import type { RegexScript } from '@/types/regex'

// Client-side evidence for isolated display-regex execution. Quarantine state
// is persisted; successful timings remain diagnostic only because one fast
// input cannot prove that a backtracking regex is safe on a different input.
export interface RegexScriptEvidence {
  last_ok_ms?: number
  last_ok_at?: number
  quarantined?: boolean
}

export type RegexExecTier = 'quarantined' | 'worker'

// Session-scoped overlay. Entries include a definition fingerprint so evidence
// from an older pattern cannot survive an edit under the same script id.
const sessionEvidence = new Map<string, { definitionKey: string; evidence: RegexScriptEvidence }>()

function definitionKey(script: RegexScript): string {
  return JSON.stringify([
    script.updated_at,
    script.find_regex,
    script.replace_string,
    script.flags,
    script.trim_strings,
    script.substitute_macros,
    script.actions,
    script.metadata?.match_actions,
  ])
}

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
  const key = definitionKey(script)
  const entry = sessionEvidence.get(script.id)
  if (entry?.definitionKey === key) return entry.evidence
  const evidence = readStoredEvidence(script)
  sessionEvidence.set(script.id, { definitionKey: key, evidence })
  return evidence
}

export function getRegexExecTier(script: RegexScript): { tier: RegexExecTier; reason: string } {
  const evidence = readRegexScriptEvidence(script)
  if (evidence.quarantined) return { tier: 'quarantined', reason: 'quarantined' }
  return { tier: 'worker', reason: 'user-authored regexes require isolated execution' }
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

// Record diagnostic timing without promoting the script to the main thread or
// generating steady-state persistence traffic.
export function recordRegexScriptSuccess(script: RegexScript, elapsedMs: number): void {
  const evidence = readRegexScriptEvidence(script)
  evidence.last_ok_ms = Math.max(0, Math.round(elapsedMs))
  evidence.last_ok_at = Date.now()
  sessionEvidence.set(script.id, { definitionKey: definitionKey(script), evidence })
}

export function quarantineRegexScript(script: RegexScript): void {
  const evidence = readRegexScriptEvidence(script)
  if (evidence.quarantined) return
  evidence.quarantined = true
  sessionEvidence.set(script.id, { definitionKey: definitionKey(script), evidence })
  persistEvidence(script.id, { quarantined: true })
}

export function resetRegexEvidenceForTests(): void {
  sessionEvidence.clear()
}
