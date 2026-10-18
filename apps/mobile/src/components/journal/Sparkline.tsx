/**
 * A 14-day sparkline drawn with plain Views (no SVG dependency): a line through daily values, or
 * bars of daily counts. One accessibility label describes it; the drawing itself is hidden.
 */

import { StyleSheet, View } from 'react-native'
import type { Spark } from '@/features/journal/trackers'
import { useTheme } from '@/theme'

const W = 110
const H = 30
const PAD = 2

export function Sparkline({ spark, label }: { spark: Spark; label: string }) {
  const t = useTheme()
  if (spark.mode === 'none') return null
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={styles.box}>
      <View
        style={StyleSheet.absoluteFill}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {spark.mode === 'bars' ? <Bars counts={spark.counts} color={t.accentText} /> : null}
        {spark.mode === 'line' ? <Line values={spark.values} color={t.accentText} /> : null}
      </View>
    </View>
  )
}

function Bars({ counts, color }: { counts: number[]; color: string }) {
  const max = Math.max(1, ...counts)
  const step = (W - PAD * 2) / counts.length
  const bar = Math.max(3, step - 3)
  return counts.map((c, i) =>
    c > 0 ? (
      <View
        key={i}
        style={{
          position: 'absolute',
          left: PAD + i * step,
          bottom: 0,
          width: bar,
          height: Math.max(4, ((H - PAD) * c) / max),
          borderRadius: 1,
          backgroundColor: color,
        }}
      />
    ) : null,
  )
}

function Line({ values, color }: { values: (number | null)[]; color: string }) {
  const present = values.filter((v): v is number => v !== null)
  const lo = Math.min(...present)
  const hi = Math.max(...present)
  const span = hi - lo || 1
  const step = (W - PAD * 2) / (values.length - 1)
  const pt = (v: number, i: number) => ({
    x: PAD + i * step,
    y: hi === lo ? H / 2 : PAD + (H - PAD * 2) * (1 - (v - lo) / span),
  })
  const marks = []
  let prev: { x: number; y: number } | null = null
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v === null || v === undefined) {
      prev = null
      continue
    }
    const p = pt(v, i)
    marks.push(
      <View
        key={`d${i}`}
        style={{
          position: 'absolute',
          left: p.x - 2,
          top: p.y - 2,
          width: 4,
          height: 4,
          borderRadius: 2,
          backgroundColor: color,
        }}
      />,
    )
    if (prev) {
      const dx = p.x - prev.x
      const dy = p.y - prev.y
      const len = Math.hypot(dx, dy)
      marks.push(
        <View
          key={`s${i}`}
          style={{
            position: 'absolute',
            left: (prev.x + p.x) / 2 - len / 2,
            top: (prev.y + p.y) / 2 - 1,
            width: len,
            height: 2,
            borderRadius: 1,
            backgroundColor: color,
            transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
          }}
        />,
      )
    }
    prev = p
  }
  return marks
}

const styles = StyleSheet.create({ box: { width: W, height: H } })
