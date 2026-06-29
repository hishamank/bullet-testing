/**
 * The "coming next" placeholder for sections that are designed but out of v1 scope (Tasks,
 * Trackers, Activities as standalone managers). v1 ships exactly Bullet / Task / Tracker /
 * Activity as data; these dedicated views arrive later (CLAUDE.md §1). Mirrors the design's
 * calm soon-state rather than a broken link.
 */

export function Soon({ glyph, title, body }: { glyph: string; title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-12 text-center">
      <div className="font-data text-[22px] text-indigo-soft tracking-[0.34em]">{glyph}</div>
      <div className="mt-[18px] mb-[10px] font-display text-[32px] text-ink max-md:text-[26px]">
        {title}
      </div>
      <p className="m-0 max-w-[440px] font-reader text-[17px] text-muted leading-relaxed">{body}</p>
    </div>
  )
}
