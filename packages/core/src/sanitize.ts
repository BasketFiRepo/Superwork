/**
 * Rendering untrusted message content (§5.9.7, §12.3).
 *
 * Never render untrusted HTML. Remote images are tracking pixels until proven otherwise
 * and are stripped by default; links from unknown senders are neutralised rather than
 * auto-previewed. What was removed is always reported, because a reader who cannot see
 * that something was blocked cannot judge whether the block was right.
 */

export interface SanitizedContent {
  /** Plain text, safe to render as a text node. Never `dangerouslySetInnerHTML`. */
  text: string
  removed: {
    remoteImages: number
    scripts: number
    iframes: number
    trackingPixels: number
  }
  links: { href: string; label: string; external: boolean }[]
  /** True when anything was stripped, so the UI can say so. */
  modified: boolean
}

const BLOCK_TAGS = /<\s*(script|iframe|object|embed|style|link|meta)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi
const SELF_CLOSING_BLOCK = /<\s*(script|iframe|object|embed|style|link|meta)\b[^>]*\/?>/gi
const IMG_TAG = /<\s*img\b[^>]*>/gi
const ANCHOR = /<\s*a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi
const ANY_TAG = /<[^>]+>/g
const BARE_URL = /\bhttps?:\/\/[^\s<>"')]+/gi

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

export function sanitizeMessage(
  raw: string,
  options: { knownDomains?: string[] } = {},
): SanitizedContent {
  const known = new Set((options.knownDomains ?? []).map((d) => d.toLowerCase()))
  const removed = { remoteImages: 0, scripts: 0, iframes: 0, trackingPixels: 0 }
  const links: SanitizedContent['links'] = []

  let working = raw

  working = working.replace(BLOCK_TAGS, (match, tag: string) => {
    if (/script/i.test(tag)) removed.scripts += 1
    else if (/iframe|object|embed/i.test(tag)) removed.iframes += 1
    return ' '
  })
  working = working.replace(SELF_CLOSING_BLOCK, (match, tag: string) => {
    if (/script/i.test(tag)) removed.scripts += 1
    else if (/iframe|object|embed/i.test(tag)) removed.iframes += 1
    return ' '
  })

  working = working.replace(IMG_TAG, (match) => {
    const src = /src\s*=\s*["']([^"']+)["']/i.exec(match)?.[1] ?? ''
    const width = Number(/width\s*=\s*["']?(\d+)/i.exec(match)?.[1] ?? '0')
    const height = Number(/height\s*=\s*["']?(\d+)/i.exec(match)?.[1] ?? '0')
    // A 1×1 remote image has one purpose.
    const isPixel = (width > 0 && width <= 2) || (height > 0 && height <= 2)
    if (/^https?:/i.test(src)) {
      removed.remoteImages += 1
      if (isPixel) removed.trackingPixels += 1
    }
    return ' [image blocked] '
  })

  working = working.replace(ANCHOR, (_match, href: string, label: string) => {
    const external = !isKnown(href, known)
    links.push({ href, label: stripTags(label) || href, external })
    return ` ${stripTags(label) || href} `
  })

  for (const match of raw.match(BARE_URL) ?? []) {
    if (!links.some((l) => l.href === match)) {
      links.push({ href: match, label: match, external: !isKnown(match, known) })
    }
  }

  const text = decodeEntities(stripTags(working)).replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()

  return {
    text,
    removed,
    links,
    modified: removed.remoteImages + removed.scripts + removed.iframes > 0,
  }
}

function stripTags(value: string): string {
  return value.replace(ANY_TAG, ' ')
}

function isKnown(href: string, known: Set<string>): boolean {
  try {
    const host = new URL(href).hostname.toLowerCase()
    for (const domain of known) {
      if (host === domain || host.endsWith(`.${domain}`)) return true
    }
  } catch {
    return false
  }
  return false
}

/** Human-readable note for the banner above a sanitized message. */
export function describeSanitization(content: SanitizedContent): string | null {
  const parts: string[] = []
  if (content.removed.remoteImages) {
    parts.push(
      `${content.removed.remoteImages} remote ${content.removed.remoteImages === 1 ? 'image' : 'images'} blocked` +
        (content.removed.trackingPixels ? ` (${content.removed.trackingPixels} tracking)` : ''),
    )
  }
  if (content.removed.scripts) parts.push(`${content.removed.scripts} scripts removed`)
  if (content.removed.iframes) parts.push(`${content.removed.iframes} embeds removed`)
  return parts.length ? parts.join(' · ') : null
}
