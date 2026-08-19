import { requireSession, withActor } from '@/lib/session'
import { listApprovals, listOutgoing, trustLedger } from '@superwork/core'
import { ApprovalCard } from '@/components/ApprovalCard'
import { OutgoingMail } from '@/components/OutgoingMail'

export const dynamic = 'force-dynamic'

/** Approvals (§17). Primary action: decide. */
export default async function ApprovalsPage() {
  const session = await requireSession()
  const { pending, decided, ledger, outgoing } = await withActor(session, async (ctx, actor) => ({
    pending: await listApprovals(ctx, actor, { status: 'pending' }),
    decided: (await listApprovals(ctx, actor, { limit: 20 })).filter((a) => a.status !== 'pending'),
    ledger: await trustLedger(ctx),
    // What a decision made here has already put in motion, and can still be stopped
    // (ADR 0054). It belongs on this screen rather than the inbox: somebody who has just
    // changed their mind about sending is still standing where they approved it.
    outgoing: await listOutgoing(ctx, actor),
  }))

  const serialize = (list: typeof pending) =>
    list.map((a) => ({
      ...a,
      createdAt: a.createdAt.toISOString(),
      preview: a.preview as never,
      evidence: a.evidence as never,
    }))

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Operate</span>
        <h1>Approvals</h1>
        <p className="prose secondary">
          Nothing leaves this organization, and nothing irreversible happens, without a decision
          here. Each card shows the exact change before it is made.
        </p>
      </header>

      <OutgoingMail
        outgoing={outgoing.map((row) => ({
          id: row.id,
          subject: row.subject,
          toAddresses: row.toAddresses,
          secondsLeft: row.secondsLeft,
          dispatching: row.dispatching,
          sentByName: row.sentByName,
          mine: row.mine,
        }))}
      />

      {ledger.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <h2>Trust ledger</h2>
            <span className="small muted">What the team does with what the agent proposes</span>
          </div>
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Action type</th>
                  <th style={{ width: 100 }}>Proposed</th>
                  <th style={{ width: 100 }}>Approved</th>
                  <th style={{ width: 100 }}>Edited</th>
                  <th style={{ width: 100 }}>Rejected</th>
                  <th style={{ width: 140 }}>Approval rate</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((row) => (
                  <tr key={row.actionType}>
                    <td>{row.actionType.replace(/_/g, ' ')}</td>
                    <td className="num">{row.proposed}</td>
                    <td className="num">{row.approved}</td>
                    <td className="num">{row.edited}</td>
                    <td className="num">{row.rejected}</td>
                    <td className="num">{(row.approvalRate * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="stack stack-5">
        <h2>Waiting for you</h2>
        {pending.length === 0 ? (
          <div className="panel">
            <div className="empty stack stack-3">
              <p className="secondary">Nothing is waiting for a decision.</p>
              <p className="small muted">
                Ask the agent to do something in Execute mode and its plan will appear here before
                anything changes.
              </p>
            </div>
          </div>
        ) : (
          serialize(pending).map((approval) => <ApprovalCard key={approval.id} approval={approval} />)
        )}
      </section>

      {decided.length > 0 ? (
        <section className="stack stack-5">
          <h2>Decided</h2>
          {serialize(decided).map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} />
          ))}
        </section>
      ) : null}
    </div>
  )
}
