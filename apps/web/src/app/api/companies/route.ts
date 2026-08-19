import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  createCompany,
  createContact,
  updateCompany,
  type CompanyView,
  type ContactView,
} from '@superwork/core'
import { errorResponse } from '@/lib/errors'
import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Adding a customer, and keeping the record true (ADR 0056).
 *
 * The repository is the authority on the rules that matter — a domain no other company already
 * receives mail from, a reply promise somebody could keep, a record nobody files above what they
 * could read afterwards. This refuses only the obviously wrong shape.
 */
const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    name: z.string().min(2).max(200),
    type: z.string().max(20).optional(),
    legalName: z.string().max(200).nullish(),
    industry: z.string().max(120).nullish(),
    sizeBand: z.string().max(40).nullish(),
    domains: z.array(z.string().max(120)).max(20).optional(),
    ownerId: z.string().uuid().nullish(),
    sensitivity: z.string().max(20).optional(),
  }),
  z.object({
    action: z.literal('update'),
    id: z.string().uuid(),
    name: z.string().min(2).max(200).optional(),
    type: z.string().max(20).optional(),
    legalName: z.string().max(200).nullish(),
    industry: z.string().max(120).nullish(),
    sizeBand: z.string().max(40).nullish(),
    domains: z.array(z.string().max(120)).max(20).optional(),
    ownerId: z.string().uuid().nullish(),
    healthStatus: z.string().max(20).optional(),
    replySlaDays: z.number().int().optional(),
    checkInDays: z.number().int().optional(),
    contractRenewsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  }),
  z.object({
    action: z.literal('contact'),
    name: z.string().min(2).max(200),
    companyId: z.string().uuid().nullish(),
    emails: z.array(z.string().max(200)).max(10).optional(),
    title: z.string().max(120).nullish(),
    seniority: z.string().max(40).nullish(),
    ownerId: z.string().uuid().nullish(),
    sensitivity: z.string().max(20).optional(),
  }),
])

export async function POST(request: Request) {
  const session = await requireSession()
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'That could not be read.' },
      { status: 400 },
    )
  }
  const body = parsed.data
  try {
    const result = await withActor<CompanyView | ContactView>(session, (ctx, actor) => {
      if (body.action === 'create') {
        return createCompany(ctx, actor, {
          name: body.name,
          ...(body.type === undefined ? {} : { type: body.type }),
          ...(body.legalName === undefined ? {} : { legalName: body.legalName }),
          ...(body.industry === undefined ? {} : { industry: body.industry }),
          ...(body.sizeBand === undefined ? {} : { sizeBand: body.sizeBand }),
          ...(body.domains === undefined ? {} : { domains: body.domains }),
          ...(body.ownerId === undefined ? {} : { ownerId: body.ownerId }),
          ...(body.sensitivity === undefined ? {} : { sensitivity: body.sensitivity }),
        })
      }
      if (body.action === 'contact') {
        return createContact(ctx, actor, {
          name: body.name,
          ...(body.companyId === undefined ? {} : { companyId: body.companyId }),
          ...(body.emails === undefined ? {} : { emails: body.emails }),
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.seniority === undefined ? {} : { seniority: body.seniority }),
          ...(body.ownerId === undefined ? {} : { ownerId: body.ownerId }),
          ...(body.sensitivity === undefined ? {} : { sensitivity: body.sensitivity }),
        })
      }
      return updateCompany(ctx, actor, {
        id: body.id,
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.type === undefined ? {} : { type: body.type }),
        ...(body.legalName === undefined ? {} : { legalName: body.legalName }),
        ...(body.industry === undefined ? {} : { industry: body.industry }),
        ...(body.sizeBand === undefined ? {} : { sizeBand: body.sizeBand }),
        ...(body.domains === undefined ? {} : { domains: body.domains }),
        ...(body.ownerId === undefined ? {} : { ownerId: body.ownerId }),
        ...(body.healthStatus === undefined ? {} : { healthStatus: body.healthStatus }),
        ...(body.replySlaDays === undefined ? {} : { replySlaDays: body.replySlaDays }),
        ...(body.checkInDays === undefined ? {} : { checkInDays: body.checkInDays }),
        ...(body.contractRenewsOn === undefined ? {} : { contractRenewsOn: body.contractRenewsOn }),
      })
    })
    return NextResponse.json({ result })
  } catch (error) {
    return errorResponse(error)
  }
}
