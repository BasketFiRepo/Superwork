/**
 * The events this product raises, and the only names a workflow may subscribe to (ADR 0090).
 *
 * Here rather than in `@superwork/core` for the reason ADR 0088 put `LIVE_IMPLEMENTED` here: the
 * workflow compiler lives in `@superwork/ai`, the activation gate and the emitters live in
 * `@superwork/core`, and `core` already imports `ai`. One of them has to hold the list, and it
 * cannot be either of them without inverting a dependency.
 *
 * That makes this a second place a fact lives — the first being the `events_name_known` CHECK
 * beside the rows — so a test asserts the two against each other, the same shape as the feature
 * flags of ADR 0022 and for the same reason.
 */
export interface EventDefinition {
  name: string
  /** How a person would describe the moment. The compiler reads this back; the screen shows it. */
  label: string
  /** What the row points at, so a subscriber knows what it is being handed. */
  entityType: string
}

export const EVENT_DEFINITIONS: readonly EventDefinition[] = [
  { name: 'message.received', label: 'correspondence arrives in a connected mailbox', entityType: 'message' },
  { name: 'task.created', label: 'a task is opened, by a person or by an automation', entityType: 'task' },
  { name: 'approval.decided', label: 'somebody approves or declines something', entityType: 'approval' },
]

export const EVENT_NAMES: readonly string[] = EVENT_DEFINITIONS.map((definition) => definition.name)

export function eventDefinition(name: string): EventDefinition | null {
  return EVENT_DEFINITIONS.find((definition) => definition.name === name) ?? null
}

/**
 * What to say when a workflow asks to be triggered by something nothing raises.
 *
 * Names the two ways out, like the capability-mode refusal it is modelled on: pick a name that
 * exists, or make the product raise the one you meant.
 */
export function unknownEventMessage(spec: string): string {
  return (
    `Nothing in Superwork raises "${spec}", so a workflow waiting for it would be active and ` +
    `silent forever. Trigger it on one of: ${EVENT_NAMES.join(', ')} — or raise "${spec}" from ` +
    `the code where it happens and add it to EVENT_DEFINITIONS.`
  )
}
