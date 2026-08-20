import type { Metadata } from 'next'
import { envIssues } from '@superwork/config'
import { schemaState } from '@superwork/db'
import { NotConfigured } from '@/components/NotConfigured'
import { SchemaBehind } from '@/components/SchemaBehind'
import './globals.css'

export const metadata: Metadata = {
  title: 'Superwork',
  description: 'An agentic AI operating system for company work',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Every screen below reads the environment on its first render, so one missing variable
  // is an unhandled throw on every route at once — and a throw during a render reaches the
  // browser as a digest and nothing else. Checking here costs one schema parse per request
  // and turns that into a page that says which variable it is. The children are not
  // rendered at all when it fails, so nothing downstream gets to throw first.
  const issues = envIssues()
  if (issues.length > 0) {
    return (
      <html lang="en" data-density="compact">
        <body>
          <NotConfigured issues={issues} />
        </body>
      </html>
    )
  }

  // The same argument, one layer down. A database that is behind this build throws on the
  // first table it is missing, which reached the browser as the same digest and nothing else
  // — for five hours, on a deployment whose code was correct the whole time (ADR 0062). This
  // costs one query per process and nothing after it succeeds; while it is failing it is
  // asked every request, so applying the migrations fixes the site without a redeploy.
  //
  // Second, not first: with no environment there is no database to ask.
  const schema = await schemaState()

  return (
    <html lang="en" data-density="compact">
      <body>{schema.ok ? children : <SchemaBehind pending={schema.pending} empty={schema.empty} opaque={schema.opaque} />}</body>
    </html>
  )
}
