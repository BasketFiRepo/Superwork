import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Superwork',
  description: 'An agentic AI operating system for company work',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-density="compact">
      <body>{children}</body>
    </html>
  )
}
