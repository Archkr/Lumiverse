import { compileRegex } from './compile-regex'
import { replaceWithinRegexSearchWindow } from './search-window'

export type ApplyWorkerOp = 'apply' | 'probe'

export interface ApplyWorkerJob {
  jobId: number
  op: ApplyWorkerOp
  body: string
  pattern: string
  flags: string
  replaceString?: string
  trimStrings?: string[]
  scriptId?: string
  scriptName?: string
}

export type ApplyWorkerResponse =
  | { type: 'result'; jobId: number; op: 'apply'; result: string; elapsedMs: number }
  | { type: 'result'; jobId: number; op: 'probe'; passed: boolean; elapsedMs: number }
  | { type: 'error'; jobId: number; error: string; elapsedMs: number }

const PROBE_SAMPLE_CHARS = 500
const TRIM_LOOP_MAX_ITERATIONS = 32

function scriptLabel(job: ApplyWorkerJob): string {
  const id = job.scriptId ?? 'unknown'
  return job.scriptName ? `${id} (${job.scriptName})` : id
}

// Bounded trim loop with the same semantics as compiler.ts's Task 1 amendment:
// max 32 iterations per trim string, empty trim is a no-op, cap hit warns once.
function applyBoundedTrim(result: string, trimStrings: readonly string[], label: string): string {
  for (const trim of trimStrings) {
    if (trim === '') continue
    let iterations = 0
    while (result.includes(trim)) {
      result = result.replaceAll(trim, '')
      iterations += 1
      if (iterations >= TRIM_LOOP_MAX_ITERATIONS) {
        console.warn(`[regex-worker] trim loop capped after ${TRIM_LOOP_MAX_ITERATIONS} iterations for script ${label}`)
        break
      }
    }
  }
  return result
}

function runApplyJob(job: ApplyWorkerJob): { result: string; elapsedMs: number } {
  const startedAt = performance.now()
  const regex = compileRegex(job.pattern, job.flags)
  if (!regex) throw new Error(`invalid pattern for script ${scriptLabel(job)}`)
  // Plain-string replacement path mirrors compiler.ts's non-action branch
  // (:575/:601) — native $-capture substitution keeps semantics identical to
  // the main thread for pre-resolved replacement templates. Scripts with
  // match_actions decoration stay on the main thread (Task 3 tiers them).
  const replaced = replaceWithinRegexSearchWindow(
    job.body,
    regex,
    job.pattern,
    job.flags,
    job.replaceString ?? '',
    job.replaceString ?? '',
  )
  const result = applyBoundedTrim(replaced, job.trimStrings ?? [], scriptLabel(job))
  return { result, elapsedMs: Math.round(performance.now() - startedAt) }
}

function runProbeJob(job: ApplyWorkerJob): { passed: boolean; elapsedMs: number } {
  const startedAt = performance.now()
  let passed = false
  try {
    const regex = compileRegex(job.pattern, job.flags)
    if (regex) {
      // Identity replace never drifts lastIndex on shared cached RegExp
      // instances; a completed pass means the pattern executed safely here.
      const sample = job.body.slice(0, PROBE_SAMPLE_CHARS)
      sample.replace(regex, (match) => match)
      passed = true
    }
  } catch {
    passed = false
  }
  return { passed, elapsedMs: Math.round(performance.now() - startedAt) }
}

const workerSelf = self as unknown as {
  onmessage: ((event: { data: ApplyWorkerJob }) => void) | null
  postMessage(message: ApplyWorkerResponse): void
}

workerSelf.onmessage = (event) => {
  const job = event.data
  const startedAt = performance.now()
  try {
    if (job.op === 'apply') {
      const outcome = runApplyJob(job)
      workerSelf.postMessage({ type: 'result', jobId: job.jobId, op: 'apply', ...outcome })
    } else if (job.op === 'probe') {
      const outcome = runProbeJob(job)
      workerSelf.postMessage({ type: 'result', jobId: job.jobId, op: 'probe', ...outcome })
    } else {
      throw new Error(`unknown op ${(job as ApplyWorkerJob).op}`)
    }
  } catch (error) {
    workerSelf.postMessage({
      type: 'error',
      jobId: job?.jobId ?? -1,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Math.round(performance.now() - startedAt),
    })
  }
}
