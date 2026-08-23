export type RegexRiskLevel = 'high' | 'medium' | 'low'

export interface RegexRiskResult {
  risk: RegexRiskLevel
  reasons: string[]
}

interface QuantifierInfo {
  text: string
  end: number
}

function findClassEnd(pattern: string, start: number): number {
  for (let i = start + 1; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === ']') return i
  }
  return -1
}

function findGroupEnd(pattern: string, start: number): number {
  let depth = 0
  for (let i = start; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '[') {
      const close = findClassEnd(pattern, i)
      if (close < 0) return -1
      i = close
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function readQuantifier(pattern: string, j: number): QuantifierInfo | null {
  const ch = pattern[j]
  if (ch !== '*' && ch !== '+' && ch !== '{' && ch !== '?') return null
  let k = j
  if (ch === '{') {
    const close = pattern.indexOf('}', j)
    if (close < 0 || !/^\{\d+(?:,\d*)?\}$/.test(pattern.slice(j, close + 1))) return null
    k = close + 1
  } else {
    k = j + 1
  }
  if (pattern[k] === '?') k++
  return { text: pattern.slice(j, k), end: k }
}

function isUnboundedQuantifier(q: QuantifierInfo): boolean {
  return q.text.includes('*') || q.text.includes('+') || /^\{\d+,/.test(q.text)
}

function classBodyCanMatchWhitespace(body: string): boolean {
  const stripped = body.startsWith('^') ? body.slice(1) : body
  if (body.startsWith('^')) return true
  if (/\\[sWDP]/.test(stripped)) return true
  if (/[\t\n\v\f\r ]/.test(stripped)) return true
  return false
}

function innerGroupBody(body: string): string {
  if (!body.startsWith('?')) return body
  const named = /^\?<[^<>]*>/.exec(body)
  if (named) return body.slice(named[0].length)
  if (/^\?<[=!]/.test(body)) return body.slice(3)
  if (/^\?[=!]/.test(body)) return body.slice(2)
  if (body[1] === ':' || body[1] === '>') return body.slice(2)
  return body
}

function groupCanMatchWhitespace(inner: string, depth = 0): boolean {
  const body = innerGroupBody(inner)
  const classRe = /\[((?:[^\]\\]|\\.)*)\]/g
  let m: RegExpExecArray | null
  while ((m = classRe.exec(body))) {
    if (classBodyCanMatchWhitespace(m[1])) return true
  }
  const stripped = body.replace(classRe, '[]')
  if (stripped === '[]') return false
  if (/(^|[^\\])\./.test(stripped)) return true
  if (/\\[sWDP]/.test(stripped)) return true
  if (stripped.trim() === '' || stripped.includes('|')) {
    if (depth >= 4) return true
    return splitTopLevelAlternatives(stripped).some(
      (branch) => branch.trim() === '' || groupCanMatchWhitespace(branch, depth + 1),
    )
  }
  return false
}

function splitTopLevelAlternatives(source: string): string[] {
  const branches: string[] = []
  let depth = 0
  let current = ''
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\') {
      current += source.slice(i, i + 2)
      i++
      continue
    }
    if (ch === '[') {
      const close = findClassEnd(source, i)
      if (close > 0) {
        current += source.slice(i, close + 1)
        i = close
        continue
      }
    }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === '|' && depth === 0) {
      branches.push(current)
      current = ''
      continue
    }
    current += ch
  }
  branches.push(current)
  return branches
}

type AtomKind = 'class' | 'group' | 'dot'

interface Atom {
  kind: AtomKind
  body: string
  start: number
}

function atomCanMatchWhitespace(atom: Atom): boolean {
  if (atom.kind === 'dot') return true
  if (atom.kind === 'class') return classBodyCanMatchWhitespace(atom.body)
  return groupCanMatchWhitespace(atom.body)
}

function hasTrailingQuantifier(body: string): boolean {
  const stripped = body.replace(/\?$/, '')
  return /(?:[*+]|\{\d+(?:,\d*)?\})$/.test(stripped)
}

const WS_QUANT_CHARS = new Set(['*', '+', '{'])

function precededByWhitespaceQuantifier(pattern: string, atomStart: number): boolean {
  const tail = pattern.slice(Math.max(0, atomStart - 8), atomStart)
  return /\\s(?:\{\d+(?:,\d*)?\}|[*+])\??$/.test(tail)
}

function followedByWhitespaceQuantifier(pattern: string, j: number): boolean {
  if (!pattern.startsWith('\\s', j)) return false
  const next = pattern[j + 2]
  return next !== undefined && WS_QUANT_CHARS.has(next)
}

function normalizeBranch(branch: string): string {
  return branch.replace(/^\^+/, '').replace(/\$$/, '').replace(/\\[bBAZ]/g, '')
}

function branchesOverlap(a: string, b: string): boolean {
  const na = normalizeBranch(a)
  const nb = normalizeBranch(b)
  if (na === '' || nb === '') return true
  if (na === nb) return true
  return na.startsWith(nb) || nb.startsWith(na)
}

export function analyzeRegexRisk(pattern: string): RegexRiskResult {
  const highReasons: string[] = []
  const mediumReasons: string[] = []

  const groupBodies: Array<{ body: string; inner: string }> = []

  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '[') {
      const close = findClassEnd(pattern, i)
      if (close < 0) break
      const atom: Atom = { kind: 'class', body: pattern.slice(i + 1, close), start: i }
      let j = close + 1
      const q = readQuantifier(pattern, j)
      if (q) {
        if (atomCanMatchWhitespace(atom) && followedByWhitespaceQuantifier(pattern, q.end)) {
          highReasons.push(
            `Quantified character class [${atom.body}] can match whitespace and sits next to \\s* — the capture boundary is ambiguous and can backtrack catastrophically.`,
          )
        }
        if (precededByWhitespaceQuantifier(pattern, atom.start)) {
          highReasons.push(
            `Whitespace quantifier runs into quantified character class [${atom.body}] — the capture boundary is ambiguous and can backtrack catastrophically.`,
          )
        }
        j = q.end
      }
      i = j
      continue
    }
    if (ch === '(') {
      const end = findGroupEnd(pattern, i)
      if (end < 0) break
      const rawBody = pattern.slice(i + 1, end)
      const inner = innerGroupBody(rawBody)
      groupBodies.push({ body: rawBody, inner })
      const atom: Atom = { kind: 'group', body: rawBody, start: i }
      let j = end + 1
      const q = readQuantifier(pattern, j)
      if (q) {
        if (
          atomCanMatchWhitespace(atom)
          && followedByWhitespaceQuantifier(pattern, q.end)
        ) {
          highReasons.push(
            `Quantified capture group (${rawBody}) can match whitespace and sits next to \\s* — the capture boundary is ambiguous and can backtrack catastrophically.`,
          )
        }
        if (precededByWhitespaceQuantifier(pattern, atom.start)) {
          highReasons.push(
            `Whitespace quantifier runs into quantified capture group (${rawBody}) — the capture boundary is ambiguous and can backtrack catastrophically.`,
          )
        }
        if (
          isUnboundedQuantifier(q)
          && hasTrailingQuantifier(innerGroupBody(rawBody))
        ) {
          highReasons.push(
            `Nested quantifiers on (${inner}) — an already-quantified group is quantified again (${q.text}), which can multiply matches exponentially.`,
          )
        }
        j = q.end
      } else {
        const trailing = /(\[(?:[^\]\\]|\\.)*\]|\\.|[^\\].)[*+]\??$/.exec(innerGroupBody(rawBody))
        if (trailing) {
          const token = trailing[1]
          const capable = token.startsWith('[')
            ? classBodyCanMatchWhitespace(token.slice(1, -1))
            : token === '.'
          if (
            capable
            && (followedByWhitespaceQuantifier(pattern, end + 1) || precededByWhitespaceQuantifier(pattern, i))
          ) {
            highReasons.push(
              `Quantified ${token.startsWith('[') ? `character class ${token}` : 'dot'} inside capture group (${rawBody}) can match whitespace and sits next to \\s* — the capture boundary is ambiguous and can backtrack catastrophically.`,
            )
          }
        }
      }
      i = j
      continue
    }
    if (ch === '.') {
      const atom: Atom = { kind: 'dot', body: '.', start: i }
      let j = i + 1
      const q = readQuantifier(pattern, j)
      if (q) {
        if (followedByWhitespaceQuantifier(pattern, q.end)) {
          highReasons.push(
            `Quantified dot (.${q.text}) sits next to \\s* — both can consume whitespace, making the capture boundary ambiguous.`,
          )
        }
        j = q.end
      }
      i = j
      continue
    }
    i++
  }

  const alternationScopes = [pattern, ...groupBodies.map((g) => g.inner)]
  for (const scope of alternationScopes) {
    const branches = splitTopLevelAlternatives(scope)
    if (branches.length < 2) continue
    let overlapped = false
    for (let a = 0; a < branches.length && !overlapped; a++) {
      for (let b = a + 1; b < branches.length; b++) {
        if (branchesOverlap(branches[a], branches[b])) {
          overlapped = true
          break
        }
      }
    }
    if (overlapped) {
      mediumReasons.push(
        'Alternation has overlapping branches (one branch is a prefix of another, or a branch is empty) — later branches may never match.',
      )
      break
    }
  }

  const reasons = [...highReasons, ...mediumReasons]
  const risk: RegexRiskLevel = highReasons.length > 0 ? 'high' : mediumReasons.length > 0 ? 'medium' : 'low'
  return { risk, reasons }
}
