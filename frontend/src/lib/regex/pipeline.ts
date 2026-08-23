import { toast } from '@/lib/toast'
import i18n from '@/i18n'
import type { RegexScript } from '@/types/regex'
import {
  applyDisplayRegex,
  applyDisplayRegexLocalLoop,
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
  recordRegexScriptSuccess,
} from './evidence'
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

// Quarantine/skip announcements fire at most once per session per script so a
// permanently broken script cannot spam toasts on every streaming chunk.
const announcedSkipKeys = new Set<string>()

function announceSkippedOnce(script: RegexScript, reason: string): void {
  if (announcedSkipKeys.has(script.id)) return
  announcedSkipKeys.add(script.id)
  console.warn(`[display] skipping display regex script (script=${script.id} "${script.name}", reason=${reason})`)
  toast.warning(
    i18n.t('panels:regexPanel.quarantinedDisplay', { name: script.name }),
    { title: i18n.t('panels:regexPanel.slowDisplayTitle'), duration: 7000 },
  )
}

export function resetTieredPipelineForTests(): void {
  announcedSkipKeys.clear()
}

function placementEligible(script: RegexScript, context: ApplyDisplayRegexContext): boolean {
  const placement = context.isUser ? 'user_input' : 'ai_output'
  if (!script.placement.includes(placement)) return false
  if (script.min_depth !== null && context.depth < script.min_depth) return false
  if (script.max_depth !== null && context.depth > script.max_depth) return false
  return true
}

// The worker executes only the plain replacement branch (search-window-bounded
// replace + bounded trim). Scripts needing collect->substitute->decorate are
// NOT worker-capable yet:
// - action decoration (script.actions)
// - match_actions runtime behaviors (move_top/move_bottom/repeat_back)
// - raw/after capture-then-resolve substitution
// Those stay main-thread/backend pending full helper sharing in the worker.
function isWorkerCapable(script: RegexScript): boolean {
  if (script.actions.length > 0) return false
  if (Array.isArray(script.metadata?.match_actions) && script.metadata.match_actions.length > 0) return false
  if (script.substitute_macros === 'raw' || script.substitute_macros === 'after') return false
  return true
}

// Mirror applyDisplayRegex's pattern/replacement resolution so worker jobs run
// against bit-identical inputs (macros are always resolved on the main thread).
function resolveScriptPatterns(
  script: RegexScript,
  context: ApplyDisplayRegexContext,
): { findRegex: string; replaceString: string } | null {
  let findRegex = script.find_regex
  if (script.substitute_macros !== 'none') {
    const preResolvedFind = context.resolvedFindPatterns?.get(script.id)
    if (preResolvedFind !== undefined) {
      findRegex = preResolvedFind
    } else if (context.macroCtx) {
      findRegex = resolveRegexStringMacros(findRegex, context.macroCtx)
    }
  }
  if (!compileRegex(findRegex, script.flags)) return null

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
  return { findRegex, replaceString }
}

interface WorkerAttempt {
  ok: boolean
  quarantined: boolean
  result?: string
}

async function applyScriptInWorker(
  body: string,
  script: RegexScript,
  context: ApplyDisplayRegexContext,
): Promise<WorkerAttempt> {
  const patterns = resolveScriptPatterns(script, context)
  if (!patterns) return { ok: true, quarantined: false, result: body }
  try {
    const outcome = await runRegexJobInWorker({
      op: 'apply',
      body,
      pattern: patterns.findRegex,
      flags: script.flags,
      replaceString: patterns.replaceString,
      trimStrings: script.trim_strings,
      scriptId: script.id,
      scriptName: script.name,
    })
    if (outcome.op !== 'apply') return { ok: true, quarantined: false, result: body }
    recordRegexScriptSuccess(script, outcome.elapsedMs)
    return { ok: true, quarantined: false, result: outcome.result }
  } catch (err) {
    if (err instanceof RegexWorkerTimeoutError) {
      // A deadline kill means this script hung the executor: quarantine it so
      // every later pass skips it entirely (flagged toast once per session).
      quarantineRegexScript(script)
      return { ok: true, quarantined: true }
    }
    if (
      err instanceof RegexWorkerCrashedError
      || err instanceof RegexJobDroppedError
      || err instanceof RegexWorkerUnsupportedError
      // Non-typed throws are worker-construction/environment failures — an
      // infrastructure problem, not the script's fault.
      || !(err instanceof RegexWorkerError)
    ) {
      // Infrastructure failure: escalate to the backend fallback for the
      // remaining suffix instead of blaming the script.
      return { ok: false, quarantined: false }
    }
    console.warn(`[display] worker application failed, skipping script (script=${script.id} "${script.name}")`, err)
    return { ok: true, quarantined: false, result: body }
  }
}

async function probeScriptInWorker(
  body: string,
  script: RegexScript,
  context: ApplyDisplayRegexContext,
): Promise<boolean> {
  const patterns = resolveScriptPatterns(script, context)
  if (!patterns) return false
  try {
    const outcome = await runRegexJobInWorker({
      op: 'probe',
      body,
      pattern: patterns.findRegex,
      flags: script.flags,
      scriptId: script.id,
      scriptName: script.name,
    })
    return outcome.op === 'probe' ? outcome.passed : false
  } catch {
    return false
  }
}

function readAnalyzerRiskHigh(script: RegexScript): boolean {
  const risk = (script.metadata?.analyzer_risk as { risk?: string } | undefined)?.risk
  return risk === 'high'
}

// Fallback matrix tail: backend first (preserving touched_vars/cacheable
// provenance); when the backend is unreachable, sync execution ONLY for
// scripts whose micro-probe passed AND whose analyzer risk is not high;
// everything else renders raw text with a flagged toast.
async function backendThenGuardedSync(
  content: string,
  scripts: RegexScript[],
  context: ApplyDisplayRegexContext,
  resolveRawTemplates: ResolveRawTemplates,
): Promise<DisplayRegexBackendResult> {
  const backendResult = await applyDisplayRegexOnBackend(content, scripts, context)
  if (backendResult !== null) return backendResult

  let result = content
  for (const script of scripts) {
    const passed = await probeScriptInWorker(result, script, context)
    if (!passed || readAnalyzerRiskHigh(script)) {
      announceSkippedOnce(script, passed ? 'analyzer risk high' : 'micro-probe failed')
      continue
    }
    const startedAt = performance.now()
    const applied = await applyDisplayRegexLocalLoop(result, [script], context, resolveRawTemplates)
    recordRegexScriptSuccess(script, Math.round(performance.now() - startedAt))
    result = applied.result
  }
  return { result, cacheable: false }
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
 * Evidence-tiered display regex application (production path).
 *
 * Order of preference per plan 3c: owned-chat resolver bypass (main thread) >
 * sync fast path (proven-safe scripts) > local worker > backend >
 * probe-gated guarded sync > raw text + flagged toast.
 */
export async function applyDisplayRegexTiered(
  content: string,
  scripts: RegexScript[],
  context: ApplyDisplayRegexContext,
  resolveRawTemplates: ResolveRawTemplates,
  callbacks?: TieredApplyCallbacks,
): Promise<DisplayRegexBackendResult> {
  // Spindle-owned chats never enter the worker/backend tiers (Task 3d): the
  // owning extension's resolver is the sole executor for that surface.
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
    const script = eligible[index]!
    const decision = getRegexExecTier(script)

    if (!isWorkerCapable(script)) {
      // Batch consecutive complex scripts into one backend attempt so ordered
      // multi-script pipelines don't degenerate into per-script round trips.
      let end = index
      while (end < eligible.length && !isWorkerCapable(eligible[end]!)) end += 1
      const batch = eligible.slice(index, end)
      index = end
      const applied = await backendThenGuardedSync(result, batch, context, resolveRawTemplates)
      mergeProvenance(provenance, applied)
      result = applied.result
      continue
    }

    if (decision.tier === 'sync') {
      const startedAt = performance.now()
      const next = applyDisplayRegex(
        result,
        [script],
        context,
        callbacks?.onSlowRegex,
        callbacks?.onRecoveredRegex,
      )
      recordRegexScriptSuccess(script, Math.round(performance.now() - startedAt))
      result = next
      index += 1
      continue
    }

    if (workerUsable) {
      const attempt = await applyScriptInWorker(result, script, context)
      if (attempt.quarantined) {
        announceSkippedOnce(script, 'worker deadline exceeded')
        index += 1
        continue
      }
      if (attempt.ok) {
        result = attempt.result ?? result
        index += 1
        continue
      }
      workerUsable = false
    }

    // Worker construction/infrastructure failure: backend handles the whole
    // remaining suffix (order-preserving), preserving provenance.
    const suffix = eligible.slice(index)
    const applied = await backendThenGuardedSync(result, suffix, context, resolveRawTemplates)
    mergeProvenance(provenance, applied)
    result = applied.result
    return finalize(applied.cacheable, provenance, result)
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
