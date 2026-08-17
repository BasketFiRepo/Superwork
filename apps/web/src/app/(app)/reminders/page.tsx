import { requireSession, withActor } from '@/lib/session'
import {
  listNotifications,
  listReminders,
  notificationPreferences,
  nudgeBudget,
  restDaysAhead,
  workingCalendarFor,
} from '@superwork/core'
import { Reminders } from '@/components/Reminders'
import { NotificationPreferences } from '@/components/NotificationPreferences'
import { NOTIFICATION_TYPES, UNMUTEABLE_TYPES } from '@superwork/core'

export const dynamic = 'force-dynamic'

/**
 * Reminders (§29.2, §29.3).
 *
 * The ladder's last two rungs are declared `in_app` and there was nowhere in the app for
 * them to arrive. Every delivery wrote a `notifications` row that nothing read, and when
 * chat is not connected — the default, because the product runs with no credentials —
 * delivery degrades to `in_app`, so every reminder the product sent landed nowhere and was
 * recorded as delivered.
 *
 * This page is one person's own. The repository refuses any other user id, for anybody,
 * including an admin: a list of what somebody has been chased about is a behavioural record
 * of that person, and §29.5 does not allow one to be assembled.
 */
export default async function RemindersPage() {
  const session = await requireSession()

  const { reminders, notifications, preferences, budget, people, calendar } = await withActor(
    session,
    async (ctx, actor) => ({
      // Which days this person is not chased on, and which department decides that (§29.2).
      calendar: await workingCalendarFor(ctx, actor.userId),
      reminders: await listReminders(ctx, actor),
      notifications: await listNotifications(ctx, actor),
      preferences: await notificationPreferences(ctx, actor),
      budget: await nudgeBudget(ctx, actor.userId),
      people: await ctx.sql<{ id: string; name: string }[]>`
        SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL AND m.status = 'active'
          AND m.user_id <> ${actor.userId}
        ORDER BY u.name`,
    }),
  )

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Yours</span>
        <h1>Reminders</h1>
        <p className="prose secondary">
          What Superwork has asked you, and what it has told you. You can be contacted at most{' '}
          <strong>{budget.perDay}</strong> times a day in total, across every agent — {budget.usedToday} used
          today. That ceiling is set by the strictest jurisdiction this company operates under and
          cannot be raised by configuration.
        </p>
        <p className="prose secondary" data-testid="working-calendar">
          {calendar.calendarId ? (
            <>
              You are not chased on days you do not work — weekends, and the public holidays of{' '}
              <strong>{calendar.label}</strong>
              {calendar.departmentName ? `, which ${calendar.departmentName} is set to` : ''}. A
              reminder that comes due on one of those waits for the next working day.
              {restDaysAhead(calendar).length > 0 ? (
                <> Next: {restDaysAhead(calendar).map((day) => `${day.name} (${day.date})`).join(', ')}.</>
              ) : null}
            </>
          ) : (
            <>
              No working calendar is set for your department, so reminders can reach you on any
              day, weekends included. An administrator can set one on Settings → Teams.
            </>
          )}
        </p>
      </header>

      <Reminders
        reminders={reminders.map((row) => ({
          id: row.id,
          stage: row.stage,
          message: row.message,
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          subjectLabel: row.subjectLabel,
          actions: row.actions,
          deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
          respondedAt: row.respondedAt ? row.respondedAt.toISOString() : null,
          response: row.response,
          responseNote: row.responseNote,
          aboutSomebodyElse: row.aboutSomebodyElse,
        }))}
        notifications={notifications.map((row) => ({
          id: row.id,
          type: row.type,
          title: row.title,
          body: row.body,
          url: row.url,
          readAt: row.readAt ? row.readAt.toISOString() : null,
          createdAt: row.createdAt.toISOString(),
        }))}
        people={people}
      />

      <NotificationPreferences
        briefingHour={preferences.briefingHour}
        endOfDayHour={preferences.endOfDayHour}
        briefingEnabled={preferences.briefingEnabled}
        quietHours={preferences.quietHours}
        timezone={session.timezone}
        perType={preferences.perType}
        types={NOTIFICATION_TYPES}
        unmuteable={[...UNMUTEABLE_TYPES]}
      />
    </div>
  )
}
