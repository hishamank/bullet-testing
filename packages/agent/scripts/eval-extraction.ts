/**
 * Extraction eval harness (dev tool, not part of the build/test graph).
 *
 * Runs a fixed set of varied, realistic bullets through the LIVE model (real HttpOllamaClient) and
 * the full extract → resolve pipeline, printing what each bullet produced: per candidate the
 * extracted `kind`/`orientation`, the resolved `target_kind`/`operation`/`tier`, the model
 * confidence, and the key payload fields. Some cases seed prior state (an open task, a tracker) so
 * the append/mark-done/log paths are exercised.
 *
 * Usage (Ollama must be running with the live model pulled):
 *   pnpm build && node --import tsx packages/agent/scripts/eval-extraction.ts
 *   (or from packages/agent: npx tsx scripts/eval-extraction.ts)
 *
 * Env: OLLAMA_BASE_URL, OLLAMA_LIVE_MODEL (defaults: http://localhost:11434, gemma3:4b).
 */

import { createBullet, createTask, createTestDb, createTracker, createUser } from '@bullet/db'
import { loadAgentConfig } from '../src/config'
import { extractCandidates } from '../src/extraction/extract'
import { buildSnapshot } from '../src/extraction/snapshot'
import { HttpOllamaClient } from '../src/ollama/http'
import { resolveCandidates } from '../src/resolution/resolve'

interface EvalCase {
  label: string
  bullet: string
  /** Optional prior state so append/mark-done/log paths can fire. */
  seed?: (db: ReturnType<typeof createTestDb>['db'], ownerId: string) => void
}

const CASES: EvalCase[] = [
  { label: 'task + date', bullet: 'finish the Q3 report by Friday' },
  {
    label: 'mood (tracker seeded)',
    bullet: 'feeling pretty low today, mood is like a 3',
    seed: (db, ownerId) =>
      void createTracker(db, {
        owner_id: ownerId,
        name: 'mood',
        input_type: 'scale',
        config: { input_type: 'scale', min: 1, max: 10 },
        source_bullet_id: null,
      }),
  },
  { label: 'plain activity', bullet: 'went for a long walk in the park this afternoon' },
  { label: 'ambiguous', bullet: 'ugh, the thing with the stuff again' },
  {
    label: 'append / mark-done (task seeded)',
    bullet: 'called the dentist',
    seed: (db, ownerId) =>
      void createTask(db, {
        owner_id: ownerId,
        title: 'call the dentist',
        status: 'todo',
        notes: null,
        due_at: null,
        priority: null,
        source_bullet_id: null,
      }),
  },
  {
    label: 'multi-item (activity + recurring)',
    bullet: 'feeling overwhelmed, need to start planning my week every Sunday',
  },
  { label: 'quantified activity', bullet: 'drank 3 coffees today' },
  { label: 'future one-off', bullet: 'need to book flights for the trip next month' },
  { label: 'activity w/ duration', bullet: 'meditated for 20 minutes this morning' },
  { label: 'durable fact', bullet: "mom's birthday is june 14" },
]

async function main() {
  const config = loadAgentConfig()
  const ollama = new HttpOllamaClient({ baseUrl: config.baseUrl })
  console.log(`# Extraction eval — model=${config.liveModel} base=${config.baseUrl}\n`)

  for (const c of CASES) {
    const { db } = createTestDb()
    const user = createUser(db, { name: 'eval' })
    c.seed?.(db, user.id)
    const snapshot = buildSnapshot({ db }, user.id)
    createBullet(db, { owner_id: user.id, text: c.bullet })

    const t0 = Date.now()
    let candidates: Awaited<ReturnType<typeof extractCandidates>>
    try {
      candidates = await extractCandidates({ ollama, config }, c.bullet, snapshot)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`## [${c.label}] "${c.bullet}"\n  ERROR: ${msg}\n`)
      continue
    }
    const { suggestions, skipped } = resolveCandidates(candidates, snapshot, config)
    const ms = Date.now() - t0

    // Note: resolveCandidates SKIPS durable_fact, so suggestions are NOT index-aligned with
    // candidates — print them as two groups.
    console.log(`## [${c.label}] "${c.bullet}"  (${ms}ms, skipped=${skipped})`)
    if (candidates.length === 0) console.log('  candidates: (none)')
    candidates.forEach((cand) => {
      const ref = cand.referenceName ? ` ref="${cand.referenceName}"` : ''
      console.log(
        `  - cand: kind=${cand.kind} orient=${cand.orientation} conf=${cand.confidence}${ref} fields=${JSON.stringify(cand.fields)}`,
      )
    })
    if (suggestions.length === 0) console.log('  resolved: (none — all skipped/out-of-scope)')
    suggestions.forEach((s) => {
      console.log(
        `  => ${s.target_kind} ${s.operation} tier=${s.tier} conf=${s.confidence.toFixed(2)} payload=${JSON.stringify(s.payload)}`,
      )
    })
    console.log()
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
