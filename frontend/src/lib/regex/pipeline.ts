import { toast } from '@/lib/toast'
import i18n from '@/i18n'
import type { RegexScript } from '@/types/regex'
import {
  applyDisplayRegexOnBackend,
  applyDisplayRegexViaOwnedResolver,
  compileRegex,
  resolveReplacementMacros,
  resolveRegexStringMacros,
  type ApplyDisplayRegexContext,
  type DisplayRegexBackendResult,
} from './compiler'
import {
  getRegexExecTier,
  quarantineRegexScript,
  resetRegexSkipAnnouncementsForTests,
  shouldAnnounceRegexSkip,
} from './evidence'
import type { ApplyWorkerScript } from './apply.worker'
import {
  isSupported as workerSupported,
  RegexJobDroppedError,
  RegexWorkerCrashedError,
  RegexWorkerError,
  RegexWorkerTimeoutError,
  RegexWorkerUnsupportedError,
  runRegexJobInWorker,
} from './worker-client'

export interface TieredSlowRegexReport {
  script: RegexScript
  elapsedMs: number
  timedOut: boolean
  thresholdMs: number
}

export interface TieredApplyCallbacks {
  onSlowRegex?: (report: TieredSlowRegexReport) => void
  onRecoveredRegex?: (report: TieredSlowRegexReport) => void
}

type ResolveRawTemplates = (templates: Record<string, string>) => Promise<Record<string, string>>

// The once-per-script bookkeeping lives in evidence.ts so that clearing a
// quarantine can reset it without evidence.ts importing this module (which
// would close a cycle, since this module imports evidence.ts). Emitting the
// warning itself stays here — evidence.ts has no business owning toasts.
function announceSkippedOnce(script: RegexScript, reason: string): void {
  if (!shouldAnnounceRegexSkip(script.id)) return
  console.warn(`[display] skipping display regex script (script=${script.id} "${script.name}", reason=${reason})`)
  toast.warning(
    i18n.t('panels:regexPanel.quarantinedDisplay', { name: script.name }),
    { title: i18n.t('panels:regexPanel.slowDisplayTitle'), duration: 7000 },
  )
}

export function resetTieredPipelineForTests(): void {
  resetRegexSkipAnnouncementsForTests()
}

function placementEligible(script: RegexScript, context: ApplyDisplayRegexContext): boolean {
  const placement = context.isUser ? 'user_input' : 'ai_output'
  if (!script.placement.includes(placement)) return false
  if (script.min_depth !== null && context.depth < script.min_depth) return false
  if (script.max_depth !== null && context.depth > script.max_depth) return false
  return true
}

function isWorkerCapable(script: RegexScript): boolean {
  if (script.actions.length > 0) return false
  if (Array.isArray(script.metadata?.match_actions) && script.metadata.match_actions.length > 0) return false
  if (script.substitute_macros === 'raw' || script.substitute_macros === 'after') return false
  return true
}

function resolveWorkerScript(
  script: RegexScript,
  context: ApplyDisplayRegexContext,
): ApplyWorkerScript | null {
  let pattern = script.find_regex
  if (script.substitute_macros !== 'none') {
    const preResolvedFind = context.resolvedFindPatterns?.get(script.id)
    if (preResolvedFind !== undefined) pattern = preResolvedFind
    else if (context.macroCtx) pattern = resolveRegexStringMacros(pattern, context.macroCtx)
  }
  if (!compileRegex(pattern, script.flags)) return null

  let replaceString = script.replace_string
  const mode = script.substitute_macros
  if (mode !== 'none' && mode !== 'find' && mode !== 'raw' && mode !== 'after') {
    const preResolved = context.resolvedReplacements?.get(script.id)
    if (preResolved !== undefined) {
      replaceString = mode === 'escaped' ? preResolved.replace(/\$/g, '$$$$') : preResolved
    } else if (context.macroCtx) {
      replaceString = resolveReplacementMacros(replaceString, mode, context.macroCtx)
    }
  }

  return {
    pattern,
    flags: script.flags,
    replaceString,
    trimStrings: script.trim_strings,
    scriptId: script.id,
    scriptName: script.name,
  }
}

interface WorkerBatchAttempt {
  ok: boolean
  result?: string
}

async function applyBatchInWorker(
  content: string,
  scripts: RegexScript[],
  context: ApplyDisplayRegexContext,
): Promise<WorkerBatchAttempt> {
  let remaining = scripts
  while (remaining.length > 0) {
    const resolved: Array<{ script: RegexScript; worker: ApplyWorkerScript }> = []
    for (const script of remaining) {
      const worker = resolveWorkerScript(script, context)
      if (worker) resolved.push({ script, worker })
    }
    if (resolved.length === 0) return { ok: true, result: content }

    try {
      const outcome = await runRegexJobInWorker({
        op: 'apply',
        body: content,
        scripts: resolved.map((entry) => entry.worker),
      })
      return { ok: true, result: outcome.result }
    } catch (error) {
      if (error instanceof RegexWorkerTimeoutError && error.scriptId) {
        const timedOut = remaining.find((script) => script.id === error.scriptId)
        if (!timedOut) return { ok: false }
        quarantineRegexScript(timedOut)
        announceSkippedOnce(timedOut, 'worker deadline exceeded')
        remaining = remaining.filter((script) => script.id !== timedOut.id)
        continue
      }
      if (
        error instanceof RegexWorkerCrashedError
        || error instanceof RegexJobDroppedError
        || error instanceof RegexWorkerUnsupportedError
        || !(error instanceof RegexWorkerError)
      ) return { ok: false }
      console.warn('[display] worker batch failed; escalating to backend', error)
      return { ok: false }
    }
  }
  return { ok: true, result: content }
}

async function backendThenRaw(
  content: string,
  scripts: RegexScript[],
  context: ApplyDisplayRegexContext,
): Promise<DisplayRegexBackendResult> {
  const backendResult = await applyDisplayRegexOnBackend(content, scripts, context)
  if (backendResult !== null) return backendResult
  for (const script of scripts) announceSkippedOnce(script, 'worker and backend unavailable')
  return { result: content, cacheable: false }
}

function mergeProvenance(
  target: { touchedVars?: ReadonlySet<string>; sawUncacheable: boolean },
  outcome: DisplayRegexBackendResult,
): void {
  if (outcome.touchedVars) {
    target.touchedVars = target.touchedVars
      ? new Set([...target.touchedVars, ...outcome.touchedVars])
      : new Set(outcome.touchedVars)
  }
  if (outcome.cacheable === false) target.sawUncacheable = true
}

/**
 * User-authored display regexes never execute on the host main thread. Plain
 * replacement scripts run in worker batches; feature-rich scripts use the
 * backend sandbox. A failed isolation boundary renders raw text instead of
 * attempting a synchronous fallback.
 */
export async function applyDisplayRegexTiered(
  content: string,
  scripts: RegexScript[],
  context: ApplyDisplayRegexContext,
  _resolveRawTemplates: ResolveRawTemplates,
  _callbacks?: TieredApplyCallbacks,
): Promise<DisplayRegexBackendResult> {
  const owned = await applyDisplayRegexViaOwnedResolver(content, scripts, context)
  if (owned) return owned

  const eligible: RegexScript[] = []
  for (const script of scripts) {
    if (!placementEligible(script, context)) continue
    const decision = getRegexExecTier(script)
    if (decision.tier === 'quarantined') {
      announceSkippedOnce(script, decision.reason)
      continue
    }
    eligible.push(script)
  }

  let result = content
  const provenance: { touchedVars?: ReadonlySet<string>; sawUncacheable: boolean } = { sawUncacheable: false }
  let workerUsable = workerSupported()
  let index = 0

  while (index < eligible.length) {
    if (!isWorkerCapable(eligible[index]!)) {
      let end = index + 1
      while (end < eligible.length && !isWorkerCapable(eligible[end]!)) end += 1
      const applied = await backendThenRaw(result, eligible.slice(index, end), context)
      mergeProvenance(provenance, applied)
      result = applied.result
      index = end
      continue
    }

    let end = index + 1
    while (end < eligible.length && isWorkerCapable(eligible[end]!)) end += 1
    const batch = eligible.slice(index, end)
    if (workerUsable) {
      const attempt = await applyBatchInWorker(result, batch, context)
      if (attempt.ok) {
        result = attempt.result ?? result
        index = end
        continue
      }
      workerUsable = false
    }

    const suffix = eligible.slice(index)
    const applied = await backendThenRaw(result, suffix, context)
    mergeProvenance(provenance, applied)
    return finalize(applied.cacheable, provenance, applied.result)
  }

  return finalize(undefined, provenance, result)
}

function finalize(
  lastCacheable: boolean | undefined,
  provenance: { touchedVars?: ReadonlySet<string>; sawUncacheable: boolean },
  result: string,
): DisplayRegexBackendResult {
  return {
    result,
    ...(provenance.touchedVars ? { touchedVars: provenance.touchedVars } : {}),
    ...(provenance.sawUncacheable || lastCacheable === false ? { cacheable: false } : {}),
  }
}
