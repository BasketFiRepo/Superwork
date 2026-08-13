import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { logout, SESSION_COOKIE } from '@superwork/auth'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  if (token) await logout(token)
  store.delete(SESSION_COOKIE)
  return NextResponse.redirect(new URL('/login', request.url), { status: 303 })
}
