/**
 * Structure-aware chunking (§7.2).
 *
 * Fixed-width splitting is what produces confidently wrong answers about pricing: a
 * table cut in half reads as a complete table. This splitter tracks the heading path,
 * keeps table blocks and fenced code intact, and emits an anchor for every chunk so a
 * citation can deep-link to the exact section.
 */

export interface Chunk {
  ordinal: number
  headingPath: string
  anchor: string
  content: string
  tokenCount: number
}

const TARGET_TOKENS = 650
const MAX_TOKENS = 900
const OVERLAP_RATIO = 0.12

/** Cheap deterministic estimate; good enough for budgeting and chunk sizing. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

interface Block {
  text: string
  headingPath: string
  anchor: string
  /** Table rows and fenced code are atomic — never split. */
  atomic: boolean
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.split('\n')
  const blocks: Block[] = []
  const headings: string[] = []
  let buffer: string[] = []
  let inFence = false
  let inTable = false
  let sectionIndex = 0

  const anchorFor = () => {
    const slug =
      headings[headings.length - 1]
        ?.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-') ?? 'body'
    return `#${slug}--${sectionIndex}`
  }

  const flush = (atomic = false) => {
    const text = buffer.join('\n').trim()
    if (text) blocks.push({ text, headingPath: headings.join(' › '), anchor: anchorFor(), atomic })
    buffer = []
  }

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inFence) {
        buffer.push(line)
        flush(true)
        inFence = false
        continue
      }
      flush()
      inFence = true
      buffer.push(line)
      continue
    }
    if (inFence) {
      buffer.push(line)
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      if (inTable) {
        flush(true)
        inTable = false
      } else {
        flush()
      }
      const depth = heading[1]!.length
      headings.length = Math.max(0, depth - 1)
      headings[depth - 1] = heading[2]!.trim()
      sectionIndex += 1
      continue
    }

    const looksLikeTableRow = line.trim().startsWith('|') && line.includes('|', 1)
    if (looksLikeTableRow && !inTable) {
      flush()
      inTable = true
    } else if (!looksLikeTableRow && inTable && line.trim() === '') {
      flush(true)
      inTable = false
      continue
    }

    buffer.push(line)
  }
  flush(inTable)
  return blocks
}

export function chunkDocument(markdown: string): Chunk[] {
  const blocks = parseBlocks(markdown)
  const chunks: Chunk[] = []
  type Pending = { lines: string[]; tokens: number; headingPath: string; anchor: string }
  let current: Pending | null = null

  const commit = () => {
    if (!current || current.lines.length === 0) return
    const content = current.lines.join('\n\n').trim()
    if (!content) return
    chunks.push({
      ordinal: chunks.length,
      headingPath: current.headingPath,
      anchor: current.anchor,
      content,
      tokenCount: estimateTokens(content),
    })
    current = null
  }

  for (const block of blocks) {
    const tokens = estimateTokens(block.text)

    if (block.atomic && tokens > MAX_TOKENS) {
      // An oversized table still ships whole; a truncated one is worse than a long one.
      commit()
      chunks.push({
        ordinal: chunks.length,
        headingPath: block.headingPath,
        anchor: block.anchor,
        content: block.text,
        tokenCount: tokens,
      })
      continue
    }

    if (!current) {
      current = { lines: [block.text], tokens, headingPath: block.headingPath, anchor: block.anchor }
      continue
    }

    const open: Pending = current
    const headingChanged = open.headingPath !== block.headingPath
    // Merging across a heading boundary is only safe when the new block sits *inside*
    // the current section; otherwise the chunk would be labelled with a heading it no
    // longer belongs to, and its citation would deep-link to the wrong place.
    const sameSection = !headingChanged || block.headingPath.startsWith(open.headingPath)
    if (open.tokens + tokens > TARGET_TOKENS || !sameSection) {
      const tail = open.lines[open.lines.length - 1] ?? ''
      const overlap = headingChanged ? '' : tail.slice(-Math.floor(tail.length * OVERLAP_RATIO))
      commit()
      current = {
        lines: overlap ? [overlap.trim(), block.text] : [block.text],
        tokens: tokens + estimateTokens(overlap),
        headingPath: block.headingPath,
        anchor: block.anchor,
      }
      continue
    }

    open.lines.push(block.text)
    open.tokens += tokens
    if (headingChanged) {
      // The chunk is labelled and anchored by the deepest section it actually covers.
      open.headingPath = block.headingPath
      open.anchor = block.anchor
    }
  }
  commit()

  return chunks.map((c, i) => ({ ...c, ordinal: i }))
}
