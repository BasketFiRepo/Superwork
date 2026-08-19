/** Row shapes mirroring the migrations. Hand-maintained alongside the SQL. */

export type Role = 'owner' | 'admin' | 'manager' | 'member' | 'viewer' | 'guest' | 'service'
export type ActorType = 'user' | 'agent' | 'system' | 'integration'
export type Sensitivity = 'public' | 'internal' | 'confidential' | 'restricted'
export type RiskTier = 'read' | 'low' | 'high'
export type AgentMode = 'ask' | 'assist' | 'execute' | 'autopilot'
export type PlanTier = 'free' | 'team' | 'business' | 'enterprise'

export type TaskStatus =
  | 'backlog' | 'todo' | 'in_progress' | 'waiting' | 'blocked' | 'review' | 'completed' | 'cancelled'
export type Priority = 'urgent' | 'high' | 'medium' | 'low'
export type ProjectStatus = 'planning' | 'active' | 'on_hold' | 'completed' | 'cancelled'

export type RunStatus =
  | 'queued' | 'planning' | 'awaiting_approval' | 'running' | 'succeeded' | 'failed'
  | 'cancelled' | 'aborted_by_admin' | 'budget_exceeded' | 'undone'
export type StepStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'awaiting_approval'
export type ApprovalStatus =
  | 'pending' | 'approved' | 'approved_with_edits' | 'rejected' | 'delegated' | 'expired' | 'cancelled'
export type IndexStatus = 'pending' | 'processing' | 'indexed' | 'failed' | 'quarantined' | 'skipped'
export type InsightStatus =
  | 'new' | 'acknowledged' | 'in_progress' | 'resolved' | 'dismissed' | 'snoozed' | 'expired'
export type LinkRelation =
  | 'mentions' | 'derived_from' | 'blocks' | 'relates_to' | 'attached_to' | 'resolves' | 'supersedes'

export interface UserRow {
  id: string
  email: string
  name: string
  avatar_url: string | null
  timezone: string
  locale: string
}

export interface OrganizationRow {
  id: string
  name: string
  slug: string
  industry: string | null
  timezone: string
  currency: string
  plan_tier: PlanTier
  profile: Record<string, unknown>
  glossary: { term: string; meaning: string }[]
  agent_kill_switch: boolean
  is_demo: boolean
}

export interface MembershipRow {
  id: string
  organization_id: string
  user_id: string
  role: Role
  department_id: string | null
  title: string | null
  /** Exceptions live in `permission_grants` (ADR 0055), not on the membership row. */
}

export interface TaskRow {
  id: string
  organization_id: string
  project_id: string | null
  title: string
  description: string | null
  status: TaskStatus
  priority: Priority
  assignee_id: string | null
  waiting_on: string | null
  blocked_reason: string | null
  due_at: Date | null
  completed_at: Date | null
  sensitivity: Sensitivity
  created_by_actor_type: ActorType
  created_by_agent_run_id: string | null
  created_at: Date
  updated_at: Date
  version: number
}

export interface DocumentRow {
  id: string
  organization_id: string
  title: string
  doc_type: string
  sensitivity: Sensitivity
  index_status: IndexStatus
  quarantine_reason: string | null
  citation_count: number
  current_version_id: string | null
  company_id: string | null
  created_at: Date
}

export interface AgentRunRow {
  id: string
  organization_id: string
  agent_id: string | null
  principal_user_id: string
  mode: AgentMode
  status: RunStatus
  trigger: string
  request: string
  timezone: string
  plan: unknown
  report: unknown
  summary: string | null
  failure_class: string | null
  failure_detail: string | null
  budget: Record<string, number>
  steps_used: number
  tool_calls_used: number
  tokens_in: number
  tokens_out: number
  cost_cents: string
  contains_untrusted_content: boolean
  capability_downgraded: boolean
  injection_flags: unknown[]
  ai_mode: 'mock' | 'sandbox' | 'live'
  trace_id: string
  undone_at: Date | null
  started_at: Date | null
  finished_at: Date | null
  created_at: Date
}
