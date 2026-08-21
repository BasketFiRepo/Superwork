/**
 * Every migration this build of the application was compiled against.
 *
 * The application needs to know whether the database underneath it matches, and it cannot
 * read the migrations directory to find out: a serverless bundle contains the code the
 * tracer found and not a directory of SQL files nobody imports. So the list is here, and
 * `tests/unit/schema-manifest.test.ts` refuses it the moment it stops matching the
 * directory — a migration added without a line here is a red build, not a surprise in
 * production.
 *
 * Sorted, because the order files are read in is not a guarantee and the difference is what
 * gets shown to somebody trying to work out what to run.
 */
export const MIGRATIONS: readonly string[] = [
  '0001_foundation',
  '0002_work',
  '0003_relationships_comms',
  '0004_knowledge',
  '0005_links_governance',
  '0006_agent',
  '0007_workflows',
  '0008_rls',
  '0009_audit_erasure',
  '0010_nervous_system',
  '0011_scale_and_trust',
  '0012_enterprise_scale',
  '0013_custom_tools',
  '0014_workflow_schedules',
  '0015_watcher_schedules',
  '0016_step_up',
  '0017_retention_and_erasure',
  '0018_legal_holds',
  '0019_memory_constraints',
  '0020_document_audience',
  '0021_task_dependencies',
  '0022_teams',
  '0023_feature_flags',
  '0024_reporting_lines',
  '0025_jurisdiction_history',
  '0026_invitations',
  '0027_subscriptions',
  '0028_insight_feedback',
  '0029_project_roster',
  '0030_reminders',
  '0031_comments_and_follow_ups',
  '0032_governance_controls',
  '0033_structure',
  '0034_views_and_watchers',
  '0035_ingestion_queue',
  '0036_working_days',
  '0037_agent_messages',
  '0038_recurring_tasks',
  '0039_effective_to',
  '0040_second_factor',
  '0041_who_classified_it',
  '0042_a_throttle_somebody_set',
  '0043_when_you_are_written_to',
  '0044_work_a_milestone_is_made_of',
  '0045_a_project_somebody_started',
  '0046_a_budget_that_stops_something',
  '0047_days_this_office_is_closed',
  '0048_an_organization_that_describes_itself',
  '0049_why_a_step_stopped',
  '0050_a_send_that_can_be_stopped',
  '0051_an_exception_somebody_granted',
  '0052_a_customer_somebody_added',
  '0053_what_was_said_and_when',
  '0054_correspondence_that_can_be_classified',
  '0055_a_database_that_says_where_it_is',
  '0056_a_thread_somebody_is_answering',
  '0057_work_a_team_can_hold',
  '0058_a_decision_somebody_stood_behind',
  '0059_a_promise_that_became_work',
  '0060_an_agent_somebody_still_stands_behind',
  '0061_a_report_somebody_actually_read',
  '0062_a_next_step_that_is_already_true',
]

/** The id half of a migration's name: `0054_correspondence…` → `0054`. */
export function migrationId(name: string): string {
  return name.split('_')[0] ?? name
}
