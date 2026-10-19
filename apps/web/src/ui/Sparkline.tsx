/**
 * A 14-day sparkline in plain SVG: a line through daily values, or bars of daily counts. One
 * accessible label describes it; the drawing itself is hidden from screen readers. The geometry is
 * `sparkGeometry`, pure.
 */

import type { Spark } from '@bullet/client'

export const SPARK_W = 110
export const SPARK_H = 30
const PAD = 2

export type SparkShape =
  | { mode: 'none' }
  | { mode: 'bars'; bars: { x: number; y: number; w: number; h: number }[] }
  | { mode: 'line'; points: { x: number; y: number }[]; segments: string[] }

export function sparkGeometry(spark: Spark): SparkShape {
  if (spark.mode === 'none') return { mode: 'none' }
  if (spark.mode === 'bars') {
    const max = Math.max(1, ...spark.counts)
    const step = (SPARK_W - PAD * 2) / spark.counts.length
    const w = Math.max(3, step - 3)
    const bars = spark.counts.flatMap((c, i) =>
      c > 0
        ? [
            {
              x: PAD + i * step,
              y: SPARK_H - Math.max(4, ((SPARK_H - PAD) * c) / max),
              w,
              h: Math.max(4, ((SPARK_H - PAD) * c) / max),
            },
          ]
        : [],
    )
    return { mode: 'bars', bars }
  }
  const present = spark.values.filter((v): v is number => v !== null)
  const lo = Math.min(...present)
  const hi = Math.max(...present)
  const span = hi - lo || 1
  const step = (SPARK_W - PAD * 2) / (spark.values.length - 1)
  const pt = (v: number, i: number) => ({
    x: PAD + i * step,
    y: hi === lo ? SPARK_H / 2 : PAD + (SPARK_H - PAD * 2) * (1 - (v - lo) / span),
  })
  const points: { x: number; y: number }[] = []
  // A run of consecutive days with readings is one polyline; a gap starts another.
  const segments: string[] = []
  let run: string[] = []
  spark.values.forEach((v, i) => {
    if (v === null) {
      if (run.length > 1) segments.push(run.join(' '))
      run = []
      return
    }
    const p = pt(v, i)
    points.push(p)
    run.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`)
  })
  if (run.length > 1) segments.push(run.join(' '))
  return { mode: 'line', points, segments }
}

export function Sparkline({ spark, label }: { spark: Spark; label: string }) {
  const shape = sparkGeometry(spark)
  if (shape.mode === 'none') return null
  return (
    <svg
      className="sparkline"
      width={SPARK_W}
      height={SPARK_H}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      role="img"
      aria-label={label}
    >
      {shape.mode === 'bars'
        ? shape.bars.map((b) => (
            <rect key={b.x} x={b.x} y={b.y} width={b.w} height={b.h} rx={1} fill="currentColor" />
          ))
        : null}
      {shape.mode === 'line' ? (
        <>
          {shape.segments.map((s) => (
            <polyline key={s} points={s} fill="none" stroke="currentColor" strokeWidth={2} />
          ))}
          {shape.points.map((p) => (
            <circle key={`${p.x}`} cx={p.x} cy={p.y} r={2} fill="currentColor" />
          ))}
        </>
      ) : null}
    </svg>
  )
}
