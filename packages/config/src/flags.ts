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

/** Phase 1 ships the closed loop. Later phases flip these on per organization. */
export const DEFAULT_FLAGS: Record<FeatureFlag, boolean> = {
  inbox: false,
  meetings: false,
  crm: false,
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
