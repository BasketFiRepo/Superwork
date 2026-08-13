import type { Sensitivity } from '@superwork/db'

/**
 * Auto-classification on ingestion (§4.3) and prompt-injection detection (§5.9.6).
 * Deterministic-first: regex detectors run before any model is consulted, so the
 * classification of a credential does not depend on a model being available.
 */

export interface ClassificationResult {
  sensitivity: Sensitivity
  reasons: string[]
  detectors: string[]
}

interface Detector {
  name: string
  level: Sensitivity
  pattern: RegExp
  reason: string
}

const DETECTORS: Detector[] = [
  {
    name: 'credential',
    level: 'restricted',
    pattern: /\b(?:api[_-]?key|secret[_-]?key|password|bearer\s+[a-z0-9._-]{16,}|sk-[a-z0-9]{16,})\b/i,
    reason: 'Contains what looks like a credential or access token.',
  },
  {
    name: 'bank_details',
    level: 'restricted',
    pattern: /\b(?:iban|sort\s?code|account\s?number|swift|bic)\b/i,
    reason: 'Contains bank or payment routing details.',
  },
  {
    name: 'salary',
    level: 'restricted',
    pattern: /\b(?:salary|compensation|remuneration|payroll|bonus\s+scheme)\b/i,
    reason: 'Contains compensation information.',
  },
  {
    name: 'identity_number',
    level: 'restricted',
    pattern: /\b(?:national\s+insurance|ssn|passport\s+(?:no|number)|nhs\s+number)\b/i,
    reason: 'Contains a government identity number.',
  },
  {
    name: 'health',
    level: 'restricted',
    pattern: /\b(?:medical\s+(?:record|history)|diagnosis|sick\s+note|occupational\s+health)\b/i,
    reason: 'Contains health information.',
  },
  {
    name: 'legal_hold',
    level: 'restricted',
    pattern: /\b(?:legal\s+hold|privileged\s+and\s+confidential|litigation\s+hold)\b/i,
    reason: 'Marked as legally privileged or under legal hold.',
  },
  {
    name: 'contract_terms',
    level: 'confidential',
    pattern: /\b(?:master\s+services\s+agreement|non-?disclosure|termination\s+for\s+convenience|liquidated\s+damages)\b/i,
    reason: 'Contains contractual terms.',
  },
  {
    name: 'pricing',
    level: 'confidential',
    pattern: /\b(?:rate\s+card|discount\s+schedule|margin|cost\s+price)\b/i,
    reason: 'Contains commercially sensitive pricing.',
  },
]

export function classifyContent(text: string, fallback: Sensitivity = 'internal'): ClassificationResult {
  const order: Sensitivity[] = ['public', 'internal', 'confidential', 'restricted']
  let level = fallback
  const reasons: string[] = []
  const detectors: string[] = []

  for (const detector of DETECTORS) {
    if (!detector.pattern.test(text)) continue
    detectors.push(detector.name)
    reasons.push(detector.reason)
    if (order.indexOf(detector.level) > order.indexOf(level)) level = detector.level
  }

  return { sensitivity: level, reasons, detectors }
}

// ---------------------------------------------------------------------------
// Prompt-injection detection
// ---------------------------------------------------------------------------

export interface InjectionFinding {
  pattern: string
  excerpt: string
  severity: 'low' | 'medium' | 'high'
}

const INJECTION_PATTERNS: { name: string; re: RegExp; severity: InjectionFinding['severity'] }[] = [
  { name: 'override_instructions', re: /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i, severity: 'high' },
  { name: 'role_reassignment', re: /\byou\s+are\s+now\s+(?:a|an|the)\b|\bnew\s+system\s+prompt\b|\bact\s+as\s+(?:if\s+)?(?:a|an|the)\s+(?:admin|administrator|developer)/i, severity: 'high' },
  { name: 'exfiltration', re: /\b(?:send|forward|email|post|upload|share)\b[^.\n]{0,80}\b(?:to|at)\b\s*[\w.+-]+@[\w.-]+\.\w+/i, severity: 'high' },
  { name: 'credential_request', re: /\b(?:reveal|print|output|show|dump)\b[^.\n]{0,40}\b(?:system\s+prompt|api\s+key|password|credentials?|token)\b/i, severity: 'high' },
  { name: 'permission_escalation', re: /\b(?:grant|give)\s+(?:yourself|me)\b[^.\n]{0,40}\b(?:admin|access|permission)/i, severity: 'high' },
  { name: 'hidden_directive', re: /\b(?:do\s+not\s+tell|without\s+(?:telling|informing|asking))\s+(?:the\s+)?(?:user|human|anyone)/i, severity: 'medium' },
  { name: 'urgency_pressure', re: /\b(?:this\s+is\s+an?\s+(?:urgent|emergency)\s+(?:override|instruction)|bypass\s+(?:the\s+)?approval)/i, severity: 'medium' },
]

/**
 * Scans untrusted content for embedded instructions. Findings quarantine the source
 * document, downgrade the run's capabilities, and surface a banner naming the source —
 * they never cause the content to be silently dropped, because a user who cannot see
 * what was blocked cannot judge whether the block was right.
 */
export function detectInjection(text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = []
  for (const { name, re, severity } of INJECTION_PATTERNS) {
    const match = re.exec(text)
    if (!match) continue
    const start = Math.max(0, match.index - 40)
    findings.push({
      pattern: name,
      excerpt: text.slice(start, Math.min(text.length, match.index + match[0].length + 60)).replace(/\s+/g, ' ').trim(),
      severity,
    })
  }
  return findings
}

export function highestSeverity(findings: InjectionFinding[]): 'none' | 'low' | 'medium' | 'high' {
  if (findings.some((f) => f.severity === 'high')) return 'high'
  if (findings.some((f) => f.severity === 'medium')) return 'medium'
  if (findings.length > 0) return 'low'
  return 'none'
}
