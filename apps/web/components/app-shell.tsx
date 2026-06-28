'use client'

/**
 * The Margin Notebook app shell — quiet, persistent navigation around every screen.
 *
 *  - Desktop (md+): a left rail with the Margin / Notebook brand, the section nav, and a pinned
 *    Review button carrying the live pending-suggestion count.
 *  - Mobile: a slim top bar (section title + Review) and a bottom tab bar.
 *
 * The rail is pure chrome — it reads the pending count via tRPC but holds no domain logic.
 */

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTRPC } from '@/lib/trpc'
import { cn } from '@/lib/utils'

interface NavItem {
  href: string
  label: string
  glyph: string
}

const NAV: NavItem[] = [
  { href: '/', label: 'Stream', glyph: '✎' },
  { href: '/overview', label: 'Overview', glyph: '◆' },
  { href: '/timeline', label: 'Timeline', glyph: '≡' },
  { href: '/tasks', label: 'Tasks', glyph: '•' },
  { href: '/trackers', label: 'Trackers', glyph: '—' },
  { href: '/activities', label: 'Activities', glyph: '○' },
]

/** The three most-used destinations get a mobile tab; Review is the fourth (with its badge). */
const MOBILE_NAV: NavItem[] = NAV.slice(0, 3)

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href)
}

function usePendingCount(): number {
  const trpc = useTRPC()
  const pending = useQuery(trpc.suggestions.listPending.queryOptions())
  return pending.data?.length ?? 0
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const reviewCount = usePendingCount()
  const reviewActive = pathname.startsWith('/review')

  const title = pathname.startsWith('/review')
    ? 'Review'
    : (NAV.find((n) => isActive(pathname, n.href))?.label ?? 'Margin Notebook')

  return (
    <div className="flex h-svh w-full overflow-hidden bg-paper">
      {/* ---------- Desktop left rail ---------- */}
      <aside className="hidden w-[214px] flex-none flex-col gap-1 border-line border-r px-4 pt-6 pb-4 md:flex">
        <Link href="/" className="block px-3 pb-5">
          <div className="font-display text-[23px] text-ink leading-none">Margin</div>
          <div className="mt-1 font-data text-[10px] text-faint-3 uppercase tracking-[0.16em]">
            Notebook
          </div>
        </Link>

        <nav className="flex flex-col gap-1">
          {NAV.map((item) => {
            const active = isActive(pathname, item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'relative flex items-center gap-3 rounded-[9px] px-3 py-2 font-ui text-sm transition-colors',
                  active
                    ? 'bg-indigo-wash font-medium text-indigo-deep'
                    : 'text-muted hover:bg-[#efede6]',
                )}
              >
                {active && (
                  <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-sm bg-indigo" />
                )}
                <span
                  className={cn(
                    'w-4 text-center font-data text-sm',
                    active ? 'text-indigo' : 'text-faint-2',
                  )}
                >
                  {item.glyph}
                </span>
                {item.label}
              </Link>
            )
          })}
        </nav>

        <div className="flex-1" />

        <Link
          href="/review"
          className={cn(
            'flex items-center justify-between rounded-[10px] px-3 py-[11px] transition-colors',
            reviewActive ? 'bg-indigo-deep' : 'bg-indigo hover:bg-indigo-deep',
          )}
        >
          <span className="flex items-center gap-[9px] font-ui text-[13.5px] text-white">
            <span className="font-data text-xs">◷</span>Review
          </span>
          <span className="rounded-[10px] bg-white/20 px-2 py-px font-data text-white text-xs">
            {reviewCount}
          </span>
        </Link>
      </aside>

      {/* ---------- Content ---------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="flex flex-none items-center justify-between border-line border-b px-5 py-3 md:hidden">
          <span className="font-display text-[22px] text-ink">{title}</span>
          <Link
            href="/review"
            className="inline-flex items-center gap-[6px] rounded-2xl bg-indigo px-[11px] py-[5px] font-data text-[11px] text-white"
          >
            ◷ {reviewCount}
          </Link>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>

        {/* Mobile bottom tab bar */}
        <nav className="flex flex-none items-center justify-around border-line border-t bg-panel px-2 pt-[9px] pb-6 md:hidden">
          {MOBILE_NAV.map((item) => {
            const active = isActive(pathname, item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex flex-1 flex-col items-center gap-[3px] px-[6px] py-1"
              >
                <span
                  className={cn('font-data text-base', active ? 'text-indigo' : 'text-faint-3')}
                >
                  {item.glyph}
                </span>
                <span
                  className={cn(
                    'font-ui text-[10px]',
                    active ? 'font-medium text-indigo' : 'text-faint-2',
                  )}
                >
                  {item.label}
                </span>
              </Link>
            )
          })}
          <Link
            href="/review"
            className="flex flex-1 flex-col items-center gap-[3px] px-[6px] py-1"
          >
            <span
              className={cn(
                'relative font-data text-base',
                reviewActive ? 'text-indigo' : 'text-faint-3',
              )}
            >
              ◷
              {reviewCount > 0 && (
                <span className="-top-1 -right-2 absolute flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-indigo px-1 font-data text-[9px] text-white">
                  {reviewCount}
                </span>
              )}
            </span>
            <span
              className={cn(
                'font-ui text-[10px]',
                reviewActive ? 'font-medium text-indigo' : 'text-faint-2',
              )}
            >
              Review
            </span>
          </Link>
        </nav>
      </div>
    </div>
  )
}
