'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Who was actually in the room (ADR 0081).
 *
 * `meeting_participants.attended` has existed since migration 0010 and nothing but the seed
 * had ever written it, while the personal record counted rows in that table and called the
 * number "Meetings you attended". This is the control that makes the sentence true.
 *
 * **Three states, and the empty one is not a gap.** Nothing recorded is nothing claimed; "was
 * not there" is a statement about a person, made by a named someone at a known time. The panel
 * keeps them visibly apart, because a screen that renders "no answer" and "did not come" the
 * same way is the reason the seed could quietly accuse everybody of missing next week's meeting.
 */

export interface AttendanceRow {
  id: string
  displayName: string
  role: string
  isExternal: boolean
  attended: boolean | null
  attendedSetByName: string | null
  attendedSetAt: string | null
}

export function MeetingAttendance({
  meetingId,
  participants,
  canRecord,
  refusal,
  hasStarted,
}: {
  meetingId: string
  participants: AttendanceRow[]
  canRecord: boolean
  refusal: string | null
  /** The database refuses attendance before a meeting begins; the buttons say so first. */
  hasStarted: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [optimistic, setOptimistic] = useState<Record<string, boolean | null>>({})

  async function record(participantId: string, attended: boolean | null) {
    setBusy(participantId)
    setError(null)
    const previous = optimistic[participantId]
    setOptimistic((state) => ({ ...state, [participantId]: attended }))

    const response = await fetch('/api/attendance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meetingId, participantId, attended }),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(null)
    if (!response.ok) {
      // Put it back. An optimistic update that survives its own refusal is a screen telling
      // somebody a thing was recorded when it was not.
      setOptimistic((state) => {
        const next = { ...state }
        if (previous === undefined) delete next[participantId]
        else next[participantId] = previous
        return next
      })
      setError(payload.error)
      return
    }
    router.refresh()
  }

  /** What to show: the optimistic answer while one is in flight, otherwise the stored one. */
  const shown = (row: AttendanceRow): boolean | null =>
    row.id in optimistic ? optimistic[row.id]! : row.attended

  const recorded = participants.filter((row) => shown(row) !== null).length

  return (
    <section className="panel" data-testid="meeting-attendance">
      <div className="panel-header">
        <h2>Who was there</h2>
        <span className="small muted" data-testid="attendance-recorded">
          {recorded === 0
            ? 'Nobody has recorded who came'
            : `${recorded} of ${participants.length} recorded`}
        </span>
      </div>

      <div className="panel-body stack stack-3">
        {error ? (
          <div className="banner banner-critical" role="alert" data-testid="attendance-error">
            {error}
          </div>
        ) : null}

        <p className="small secondary prose" style={{ margin: 0 }} data-testid="attendance-explainer">
          Being on the list is not the same as being in the room. Where nothing is recorded here,
          nothing is being claimed — and marking somebody absent puts your name against that,
          because it is a statement about them.
          {' '}
          <strong>No count of this is kept about anybody.</strong>
        </p>

        {!hasStarted ? (
          <div className="empty small secondary" data-testid="attendance-not-yet">
            This meeting has not started. Attendance can be recorded once it has.
          </div>
        ) : !canRecord && refusal ? (
          <div className="empty small secondary" data-testid="attendance-denied">
            {refusal}
          </div>
        ) : null}
      </div>

      <div className="panel-body-flush table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Who</th>
              <th style={{ width: 110 }}>Role</th>
              <th style={{ width: 210 }}>Was there</th>
              <th style={{ width: 200 }}>Recorded by</th>
            </tr>
          </thead>
          <tbody>
            {participants.map((row) => {
              const value = shown(row)
              const disabled = busy === row.id || !canRecord || !hasStarted
              return (
                <tr key={row.id} data-testid="attendance-row">
                  <td className="small">
                    {row.displayName}
                    {row.isExternal ? <span className="chip" style={{ marginLeft: 6 }}>external</span> : null}
                  </td>
                  <td className="small muted">{row.role}</td>
                  <td>
                    <div className="row-tight">
                      <button
                        type="button"
                        className={value === true ? 'chip chip-positive' : 'chip'}
                        disabled={disabled}
                        aria-pressed={value === true}
                        data-testid="attendance-yes"
                        onClick={() => record(row.id, true)}
                      >
                        There
                      </button>
                      <button
                        type="button"
                        className={value === false ? 'chip chip-attention' : 'chip'}
                        disabled={disabled}
                        aria-pressed={value === false}
                        data-testid="attendance-no"
                        onClick={() => record(row.id, false)}
                      >
                        Not there
                      </button>
                      {value !== null ? (
                        <button
                          type="button"
                          className="chip"
                          disabled={disabled}
                          data-testid="attendance-clear"
                          onClick={() => record(row.id, null)}
                        >
                          Unrecord
                        </button>
                      ) : (
                        <span className="small muted" data-testid="attendance-unrecorded">
                          not recorded
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="small muted">
                    {/*
                      While an answer is optimistic, the stored name belongs to the *previous*
                      answer — and on a panel whose whole point is that a claim carries a name,
                      showing somebody else's against a claim they did not make is the one
                      inconsistency not worth trading for speed. So the cell says it is settling.
                    */}
                    {row.id in optimistic && optimistic[row.id] !== row.attended ? (
                      <span className="muted" data-testid="attendance-settling">
                        saving…
                      </span>
                    ) : row.attendedSetByName && value !== null ? (
                      <>
                        {row.attendedSetByName}
                        {row.attendedSetAt ? (
                          <span className="mono"> · {row.attendedSetAt.slice(0, 10)}</span>
                        ) : null}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
