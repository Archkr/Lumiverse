import { describe, expect, test } from 'bun:test'
import { analyzeRegexRisk } from './risk-analyzer'

const INCIDENT_ORIGINAL = [
  '<Status>\\[DATE:\\s*([^|]*)\\s*\\|\\s*TIME:\\s*([^|]*)\\s*\\|',
  '\\s*MOOD:\\s*([^|]*)\\s*\\|\\s*LOCATION:\\s*([^|]*)\\s*\\|',
  '(?:EXTRA:\\s*([^|]*)\\s*\\|)+',
].join('')

const INCIDENT_FIXED = '<Status>\\[DATE:([^|\\n]*)\\||TIME:([^|\\n]*)\\||MOOD:([^|\\n]*)\\||LOCATION:([^|\\n]*)\\]'

describe('analyzeRegexRisk', () => {
  test('flags the original incident pattern as high risk', () => {
    const result = analyzeRegexRisk(INCIDENT_ORIGINAL)
    expect(result.risk).toBe('high')
    expect(result.reasons.length).toBeGreaterThan(0)
    expect(result.reasons.some((r) => r.includes('capture boundary is ambiguous'))).toBe(true)
  })

  test('passes the fixed incident pattern', () => {
    const result = analyzeRegexRisk(INCIDENT_FIXED)
    expect(result.risk).toBe('low')
    expect(result.reasons).toEqual([])
  })

  test('flags nested quantifiers as high risk', () => {
    expect(analyzeRegexRisk('(a+)+').risk).toBe('high')
    expect(analyzeRegexRisk('(x*)*').risk).toBe('high')
    expect(analyzeRegexRisk('\\w+\\s+(a+)+').risk).toBe('high')
  })

  test('does not flag a single quantifier without nesting', () => {
    expect(analyzeRegexRisk('(a+)').risk).toBe('low')
    expect(analyzeRegexRisk('<status>([^<]+)</status>').risk).toBe('low')
  })

  test('flags quantified whitespace-capable capture adjacent to \\s*', () => {
    expect(analyzeRegexRisk('.*\\s*foo').risk).toBe('high')
    expect(analyzeRegexRisk('[^,]*\\s*,').risk).toBe('high')
  })

  test('does not flag word-character captures adjacent to \\s*', () => {
    expect(analyzeRegexRisk('(\\w+)\\s*:').risk).toBe('low')
  })

  test('flags overlapping alternation branches as medium risk', () => {
    const result = analyzeRegexRisk('(foobar|foo)')
    expect(result.risk).toBe('medium')
    expect(result.reasons.some((r) => r.includes('overlapping branches'))).toBe(true)
  })

  test('flags empty alternation branch as medium risk', () => {
    expect(analyzeRegexRisk('(a|)').risk).toBe('medium')
  })

  test('does not flag disjoint alternation branches', () => {
    expect(analyzeRegexRisk('(foo|bar)').risk).toBe('low')
  })

  test('common benign patterns stay low risk', () => {
    const benign = [
      '\\bfind\\b',
      '\\*([^*]+)\\*',
      '"([^"]+)"',
      '<[^>]+>',
      '<(\\w+)>(.*?)</\\1>',
      '\\(OOC:.*?\\)',
      '^\\s+$',
      '\\d{4}-\\d{2}-\\d{2}',
    ]
    for (const pattern of benign) {
      const result = analyzeRegexRisk(pattern)
      expect(result.risk).toBe('low')
    }
  })
})
