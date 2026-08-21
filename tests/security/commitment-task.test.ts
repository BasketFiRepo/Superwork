import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  commitmentsForTask,
  createTask,
  createTaskForCommitment,
  getCommitment,
  getTask,
  NotFoundError,
  PermissionError,
  proposeCommitment,
  respondToCommitment,
  updateTask,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * A promise that became work (ADR 0066).
 *
 * `commitments.task_id` was added in migration 0010 and written by nothing, while
 * `SELECT_COMMITMENT` reads it into every view the product builds. So the ledger could record
 * that somebody had accepted an obligation and offer no way to do it — and marking it `kept`
 * was a claim about work that had never existed anywhere in the system.
 *
 * The tests that matter are about the pair: once a commitment has a task, "the task is done"
 * and "the promise was kept" must never be able to disagree.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let member: { organizationId: string; userId: string; timezone: string }

async function seedCommitment(
  direction: 'we_owe' | 'they_owe',
  obligation: string,
  ownerUserId?: string,
): Promise<string> {
  return withTenant(owner, async (ctx) => {
    const actor = await loadActor(ctx)
    const commitment = await proposeCommitment(ctx, actor, {
      obligation,
      direction,
      ownerUserId: ownerUserId ?? org.ownerId,
      companyId: org.companyId,
      dueAt: new Date(Date.now() + 7 * 86_400_000),
      confidence: 0.8,
    })
    return commitment.id
  })
}

async function confirm(id: string): Promise<void> {
  await withTenant(owner, async (ctx) =>
    respondToCommitment(ctx, await loadActor(ctx), { commitmentId: id, response: 'confirm' }),
  )
}

beforeAll(async () => {
  org = await createTenant('commitment-task')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  member = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }
})

afterAll(async () => {
  await destroyTenant('commitment-task')
  await closePools()
})

describe('a promise nobody has planned', () => {
  it('says so, and cannot be planned while it is only a suggestion', async () => {
    const id = await seedCommitment('we_owe', 'Send the revised rate card by Friday.')
    const before = await withTenant(owner, async (ctx) => getCommitment(ctx, await loadActor(ctx), id))
    expect(before.taskId).toBeNull()
    expect(before.taskTitle).toBeNull()
    expect(before.status).toBe('proposed')

    await withTenant(owner, async (ctx) => {
      await expect(
        createTaskForCommitment(ctx, await loadActor(ctx), { commitmentId: id }),
      ).rejects.toThrow(/Nobody has accepted this yet/i)
    })
  })

  it('becomes work once its owner has accepted it, carrying the date and the person', async () => {
    const id = await seedCommitment('we_owe', 'Confirm the Gothenburg inbound window by Wednesday.')
    await confirm(id)

    const after = await withTenant(owner, async (ctx) =>
      createTaskForCommitment(ctx, await loadActor(ctx), { commitmentId: id }),
    )
    expect(after.taskId).not.toBeNull()
    expect(after.taskTitle).toBe('Confirm the Gothenburg inbound window by Wednesday.')
    expect(after.taskStatus).toBe('todo')

    const task = await withTenant(owner, async (ctx) => getTask(ctx, await loadActor(ctx), after.taskId!))
    expect(task.assigneeId).toBe(org.ownerId)
    expect(task.dueAt).not.toBeNull()
    expect(task.description).toMatch(/Discharges a commitment/i)
  })

  it('is readable from the task, so both screens tell one story', async () => {
    const id = await seedCommitment('we_owe', 'Send the pre-cool record in writing this week.')
    await confirm(id)
    const linked = await withTenant(owner, async (ctx) =>
      createTaskForCommitment(ctx, await loadActor(ctx), { commitmentId: id }),
    )
    const promises = await withTenant(owner, async (ctx) =>
      commitmentsForTask(ctx, await loadActor(ctx), linked.taskId!),
    )
    expect(promises.map((row) => row.id)).toEqual([id])
  })

  it('refuses a second piece of work for the same promise', async () => {
    const id = await seedCommitment('we_owe', 'Reissue the amended schedule.')
    await confirm(id)
    await withTenant(owner, async (ctx) => {
      const actor = await loadActor(ctx)
      await createTaskForCommitment(ctx, actor, { commitmentId: id })
      await expect(
        createTaskForCommitment(ctx, actor, { commitmentId: id }),
      ).rejects.toThrow(/already the work for this/i)
    })
  })
})

describe('a promise somebody else made', () => {
  it('is not ours to finish, and the refusal points at what is', async () => {
    const id = await seedCommitment('they_owe', 'Halden will send the QA sign-off form.')
    await confirm(id)
    await withTenant(owner, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        createTaskForCommitment(ctx, actor, { commitmentId: id }),
      ).rejects.toThrow(ValidationError)
      await expect(
        createTaskForCommitment(ctx, actor, { commitmentId: id }),
      ).rejects.toThrow(/follow-up on the thread/i)
    })
  })

  it('is refused the link whatever writes the row', async () => {
    const id = await seedCommitment('they_owe', 'They will confirm the storage windows.')
    const task = await withTenant(owner, async (ctx) =>
      createTask(ctx, await loadActor(ctx), { title: 'Chase them about the windows' }),
    )
    await expect(
      adminSql()`
        UPDATE commitments SET task_id = ${task.id}
        WHERE organization_id = ${org.organizationId} AND id = ${id}`,
    ).rejects.toThrow(/commitments_task_is_ours/)
  })
})

describe('finishing the work', () => {
  it('is what keeps the promise, and the ledger moves by itself', async () => {
    const id = await seedCommitment('we_owe', 'Retrain the Immingham drivers on alarm handling.')
    await confirm(id)
    const linked = await withTenant(owner, async (ctx) =>
      createTaskForCommitment(ctx, await loadActor(ctx), { commitmentId: id }),
    )

    await withTenant(owner, async (ctx) =>
      updateTask(ctx, await loadActor(ctx), { id: linked.taskId!, status: 'completed' }),
    )

    const after = await withTenant(owner, async (ctx) => getCommitment(ctx, await loadActor(ctx), id))
    expect(after.status).toBe('kept')
    expect(after.taskStatus).toBe('completed')
  })

  it('moves nothing that was not outstanding', async () => {
    const id = await seedCommitment('we_owe', 'Something the owner disputes afterwards.')
    await confirm(id)
    const linked = await withTenant(owner, async (ctx) =>
      createTaskForCommitment(ctx, await loadActor(ctx), { commitmentId: id }),
    )
    await withTenant(owner, async (ctx) =>
      respondToCommitment(ctx, await loadActor(ctx), {
        commitmentId: id,
        response: 'dispute',
        reason: 'On reflection this was never agreed on our side.',
      }),
    )

    await withTenant(owner, async (ctx) =>
      updateTask(ctx, await loadActor(ctx), { id: linked.taskId!, status: 'completed' }),
    )
    const after = await withTenant(owner, async (ctx) => getCommitment(ctx, await loadActor(ctx), id))
    // Somebody finishing a task does not make a disputed promise true.
    expect(after.status).toBe('disputed')
  })

  it('leaves the promise standing when the work is cancelled instead', async () => {
    const id = await seedCommitment('we_owe', 'Publish the amended lane schedule.')
    await confirm(id)
    const linked = await withTenant(owner, async (ctx) =>
      createTaskForCommitment(ctx, await loadActor(ctx), { commitmentId: id }),
    )
    await withTenant(owner, async (ctx) =>
      updateTask(ctx, await loadActor(ctx), { id: linked.taskId!, status: 'cancelled' }),
    )
    const after = await withTenant(owner, async (ctx) => getCommitment(ctx, await loadActor(ctx), id))
    // Cancelling our own task does not unmake a promise made to somebody outside the company.
    expect(after.status).toBe('confirmed')
  })
})

describe('the one place that says the work is done', () => {
  it('refuses “Done” on the ledger while the task is the answer, and names it', async () => {
    const id = await seedCommitment('we_owe', 'Send the depot confirmation to Ingrid.')
    await confirm(id)
    await withTenant(owner, async (ctx) => {
      const actor = await loadActor(ctx)
      await createTaskForCommitment(ctx, actor, { commitmentId: id })
      await expect(
        respondToCommitment(ctx, actor, { commitmentId: id, response: 'complete' }),
      ).rejects.toThrow(/is the work for this/i)
    })
  })

  it('still allows it when there is no task, which is every commitment before this', async () => {
    const id = await seedCommitment('we_owe', 'A promise nobody made work for.')
    await confirm(id)
    const after = await withTenant(owner, async (ctx) =>
      respondToCommitment(ctx, await loadActor(ctx), { commitmentId: id, response: 'complete' }),
    )
    expect(after.status).toBe('kept')
  })
})

describe('who may plan it', () => {
  it('is the owner, or a manager above them — not a bystander', async () => {
    const id = await seedCommitment('we_owe', 'Something the owner owns.', org.ownerId)
    await confirm(id)
    await withTenant(member, async (ctx) => {
      await expect(
        createTaskForCommitment(ctx, await loadActor(ctx), { commitmentId: id }),
      ).rejects.toThrow(PermissionError)
    })
  })

  it('is another tenant’s 404, never their rows', async () => {
    const other = await createTenant('commitment-task-other')
    try {
      const theirs = await withTenant(
        { organizationId: other.organizationId, userId: other.ownerId, timezone: TZ },
        async (ctx) =>
          proposeCommitment(ctx, await loadActor(ctx), {
            obligation: 'Somebody else’s promise.',
            direction: 'we_owe',
            ownerUserId: other.ownerId,
          }),
      )
      await withTenant(owner, async (ctx) => {
        await expect(
          createTaskForCommitment(ctx, await loadActor(ctx), { commitmentId: theirs.id }),
        ).rejects.toThrow(NotFoundError)
      })
    } finally {
      await destroyTenant('commitment-task-other')
    }
  })

  it('cannot be discharged by another organization’s task, whatever writes the row', async () => {
    const other = await createTenant('commitment-task-other-2')
    try {
      const theirTask = await withTenant(
        { organizationId: other.organizationId, userId: other.ownerId, timezone: TZ },
        async (ctx) => createTask(ctx, await loadActor(ctx), { title: 'Their own work' }),
      )
      const id = await seedCommitment('we_owe', 'A promise a stranger must not discharge.')
      await expect(
        adminSql()`
          UPDATE commitments SET task_id = ${theirTask.id}
          WHERE organization_id = ${org.organizationId} AND id = ${id}`,
      ).rejects.toThrow(/live task in the same organization/i)
    } finally {
      await destroyTenant('commitment-task-other-2')
    }
  })
})
