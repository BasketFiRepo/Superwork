import { EventEmitter } from 'node:events'
import type { RunEvent } from './types.js'

/**
 * In-process event bus for live run streaming (§5.8).
 *
 * The bus is a *view* over a durable run, never the run itself: every event it carries
 * has already been persisted to `agent_steps`. A user who closes the tab loses the
 * stream, not the work — reopening replays from the database.
 */

const emitter = new EventEmitter()
emitter.setMaxListeners(0)

const buffers = new Map<string, RunEvent[]>()
const finished = new Set<string>()

export function publish(runId: string, event: RunEvent): void {
  const buffer = buffers.get(runId) ?? []
  buffer.push(event)
  buffers.set(runId, buffer)
  if (event.type === 'run.completed' || event.type === 'run.failed') finished.add(runId)
  emitter.emit(runId, event)
}

export function bufferedEvents(runId: string): RunEvent[] {
  return buffers.get(runId) ?? []
}

export function isFinished(runId: string): boolean {
  return finished.has(runId)
}

export async function* subscribe(runId: string, signal?: AbortSignal): AsyncGenerator<RunEvent> {
  // Replay anything that happened before the client connected.
  for (const event of bufferedEvents(runId)) yield event
  if (isFinished(runId)) return

  const queue: RunEvent[] = []
  let notify: (() => void) | null = null
  const onEvent = (event: RunEvent) => {
    queue.push(event)
    notify?.()
  }
  emitter.on(runId, onEvent)

  try {
    while (!signal?.aborted) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        notify = null
      }
      while (queue.length > 0) {
        const event = queue.shift()!
        yield event
        if (event.type === 'run.completed' || event.type === 'run.failed') return
      }
    }
  } finally {
    emitter.off(runId, onEvent)
  }
}

/** Frees memory for runs nobody is watching. Called by the worker on a timer. */
export function evict(runId: string): void {
  buffers.delete(runId)
  finished.delete(runId)
}
