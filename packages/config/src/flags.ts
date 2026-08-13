/**
 * Feature flags (§2.3): per-organization and per-user, stored in the database,
 * evaluated server-side, exposed to the client only as booleans.
 */

export const FEATURE_FLAGS = [
  'inbox',
  'meetings',
  'crm',
  'workflows',
  'insights',
  'reports',
  'autopilot',
  'chat_presence',
  'public_api',
  'compact_density',
] as const

export type FeatureFlag = (typeof FEATURE_FLAGS)[number]

/** Phase 2 ships the nervous system. Later phases flip the remainder on per organization. */
export const DEFAULT_FLAGS: Record<FeatureFlag, boolean> = {
  inbox: true,
  meetings: true,
  crm: true,
  workflows: true,
  insights: true,
  reports: false,
  autopilot: false,
  chat_presence: false,
  public_api: false,
  compact_density: true,
}

export type FlagSet = Record<FeatureFlag, boolean>

export function resolveFlags(
  orgOverrides: Partial<FlagSet> = {},
  userOverrides: Partial<FlagSet> = {},
): FlagSet {
  return { ...DEFAULT_FLAGS, ...orgOverrides, ...userOverrides }
}
