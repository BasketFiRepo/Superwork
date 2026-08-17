import type { Metadata } from 'next'
import { envIssues } from '@superwork/config'
import { NotConfigured } from '@/components/NotConfigured'
import './globals.css'

export const metadata: Metadata = {
  title: 'Superwork',
  description: 'An agentic AI operating system for company work',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Every screen below reads the environment on its first render, so one missing variable
  // is an unhandled throw on every route at once — and a throw during a render reaches the
  // browser as a digest and nothing else. Checking here costs one schema parse per request
  // and turns that into a page that says which variable it is. The children are not
  // rendered at all when it fails, so nothing downstream gets to throw first.
  const issues = envIssues()

  return (
    <html lang="en" data-density="compact">
      <body>{issues.length > 0 ? <NotConfigured issues={issues} /> : children}</body>
    </html>
  )
}
