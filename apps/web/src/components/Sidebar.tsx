'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { FlagSet } from '@superwork/config'

/**
 * Grouped navigation, not a flat list of seventeen items (§16.4). Counts render as
 * muted numerals; the only coloured badge is approvals awaiting you.
 */

interface NavItem {
  href: string
  label: string
  count?: number
  attention?: boolean
  flag?: keyof FlagSet
  comingSoon?: string
}

export function Sidebar({ approvals, insights, flags }: { approvals: number; insights: number; flags: FlagSet }) {
  const pathname = usePathname()

  const groups: { title: string; items: NavItem[] }[] = [
    {
      title: 'Work',
      items: [
        { href: '/', label: 'Today' },
        { href: '/tasks', label: 'Tasks' },
        { href: '/projects', label: 'Projects' },
      ],
    },
    {
      title: 'Communicate',
      items: [
        { href: '/inbox', label: 'Inbox', flag: 'inbox', comingSoon: 'Phase 2' },
        { href: '/meetings', label: 'Meetings', flag: 'meetings', comingSoon: 'Phase 2' },
      ],
    },
    {
      title: 'Know',
      items: [
        { href: '/knowledge', label: 'Knowledge' },
        { href: '/agent', label: 'Agent' },
      ],
    },
    {
      title: 'Operate',
      items: [
        { href: '/approvals', label: 'Approvals', count: approvals, attention: approvals > 0 },
        { href: '/insights', label: 'Insights', count: insights },
        { href: '/workflows', label: 'Workflows', flag: 'workflows' },
        { href: '/activity', label: 'Activity' },
      ],
    },
    {
      title: 'Admin',
      items: [{ href: '/settings/ai-governance', label: 'AI governance' }],
    },
  ]

  return (
    <nav className="sidebar" aria-label="Main">
      {groups.map((group) => (
        <div className="nav-group" key={group.title}>
          <div className="micro nav-group-title">{group.title}</div>
          <div className="stack stack-2">
            {group.items.map((item) => {
              const enabled = !item.flag || flags[item.flag]
              const active = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href))

              if (!enabled) {
                return (
                  <span
                    key={item.href}
                    className="nav-item"
                    aria-disabled="true"
                    title={`Not built yet — lands in ${item.comingSoon ?? 'a later phase'}.`}
                    style={{ color: 'var(--ink-disabled)', cursor: 'not-allowed' }}
                  >
                    <span className="nav-label">{item.label}</span>
                    <span className="nav-count">Soon</span>
                  </span>
                )
              }

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="nav-item"
                  aria-current={active ? 'page' : undefined}
                >
                  <span className="nav-label">{item.label}</span>
                  {item.count ? (
                    <span className={`nav-count${item.attention ? ' nav-count-attention' : ''}`}>{item.count}</span>
                  ) : null}
                </Link>
              )
            })}
          </div>
        </div>
      ))}
    </nav>
  )
}
