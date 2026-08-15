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

export function Sidebar({
  approvals,
  insights,
  inbox,
  pastSla,
  commitments,
  flags,
}: {
  approvals: number
  insights: number
  inbox: number
  pastSla: number
  commitments: number
  flags: FlagSet
}) {
  const pathname = usePathname()

  const groups: { title: string; items: NavItem[] }[] = [
    {
      title: 'Work',
      items: [
        { href: '/', label: 'Today' },
        { href: '/briefing', label: 'Briefing' },
        { href: '/tasks', label: 'Tasks' },
        { href: '/projects', label: 'Projects' },
      ],
    },
    {
      title: 'Communicate',
      items: [
        { href: '/inbox', label: 'Inbox', count: inbox, attention: pastSla > 0, flag: 'inbox' },
        { href: '/meetings', label: 'Meetings', flag: 'meetings' },
        { href: '/commitments', label: 'Commitments', count: commitments, flag: 'inbox' },
        { href: '/companies', label: 'Companies', flag: 'crm' },
      ],
    },
    {
      title: 'Know',
      items: [
        { href: '/knowledge', label: 'Knowledge' },
        { href: '/knowledge/memory', label: 'What it remembers' },
        { href: '/agent', label: 'Agent' },
      ],
    },
    {
      title: 'Operate',
      items: [
        { href: '/approvals', label: 'Approvals', count: approvals, attention: approvals > 0 },
        { href: '/insights', label: 'Insights', count: insights, flag: 'insights' },
        { href: '/workflows', label: 'Workflows', flag: 'workflows' },
        { href: '/analytics', label: 'AI ledger' },
        { href: '/activity', label: 'Activity' },
      ],
    },
    {
      title: 'You',
      items: [{ href: '/me', label: 'What is known about you' }],
    },
    {
      title: 'Admin',
      items: [
        { href: '/settings/agents', label: 'Agents' },
        { href: '/settings/integrations', label: 'Integrations' },
        { href: '/settings/tools', label: 'Custom tools' },
        { href: '/settings/api', label: 'API and MCP' },
        { href: '/settings/identity', label: 'Identity' },
        { href: '/settings/compliance', label: 'Jurisdiction' },
        { href: '/settings/retention', label: 'Retention and erasure' },
        { href: '/settings/holds', label: 'Legal holds' },
        { href: '/settings/teams', label: 'Teams' },
        { href: '/settings/features', label: 'Features' },
        { href: '/settings/queue', label: 'Agent queue' },
        { href: '/settings/billing', label: 'Usage and cost' },
        { href: '/settings/ai-governance', label: 'AI governance' },
      ],
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
