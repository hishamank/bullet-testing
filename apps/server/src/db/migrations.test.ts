import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, test } from 'vite-plus/test'
import { migrationsFolder } from './client'

/** Run the SQL migration files whose names sort before / from `tag` against `db`. */
function apply(db: Database.Database, filter: (name: string) => boolean) {
  const files = readdirSync(migrationsFolder)
    .filter((f) => f.endsWith('.sql') && filter(f))
    .sort()
  for (const f of files) {
    for (const stmt of readFileSync(join(migrationsFolder, f), 'utf8').split(
      '--> statement-breakpoint',
    )) {
      if (stmt.trim()) db.exec(stmt)
    }
  }
}

test('0005 keeps every question and thought, reading them as clarifying and not sensitive', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  apply(db, (f) => f < '0005')
  db.exec(`
    INSERT INTO users (id, name, created_at, updated_at) VALUES ('u', 'me', 1, 1);
    INSERT INTO bullets (id, owner_id, created_at, updated_at, text, captured_at, timezone, source,
      text_updated_at, proc_status, proc_updated_at)
      VALUES ('b', 'u', 1, 1, 'dentist thursday', 1, 'Europe/Paris', 'text', 1, 'processed', 1);
    INSERT INTO thoughts (id, owner_id, created_at, updated_at, source_bullet_id, position, text,
      kind, kind_source) VALUES ('t', 'u', 1, 1, 'b', 0, 'dentist thursday', 'event', 'engine');
    INSERT INTO questions (id, owner_id, created_at, updated_at, source_bullet_id, source_thought_id,
      suggestion_id, kind, topic, text, options, status, answer_bullet_id, answer_option, resolved_at)
      VALUES ('q', 'u', 1, 2, 'b', 't', NULL, 'clarifying', 'date', 'Which Thursday?',
        '["Today","Next Thursday"]', 'answered', NULL, 'Today', 3);
  `)
  apply(db, (f) => f >= '0005')
  expect(db.prepare('SELECT * FROM questions').all()).toEqual([
    {
      id: 'q',
      owner_id: 'u',
      created_at: 1,
      updated_at: 2,
      state: 'active',
      source_bullet_id: 'b',
      source_thought_id: 't',
      suggestion_id: null,
      kind: 'clarifying',
      origin: 'capture',
      topic: 'date',
      text: 'Which Thursday?',
      options: '["Today","Next Thursday"]',
      status: 'answered',
      answer_bullet_id: null,
      answer_option: 'Today',
      resolved_at: 3,
      snoozed_until: null,
      snooze_count: 0,
      template_id: null,
    },
  ])
  expect(db.prepare('SELECT sensitive, never_ask FROM thoughts').get()).toEqual({
    sensitive: 0,
    never_ask: 0,
  })
  // An evergreen question has no capture.
  db.exec(`INSERT INTO questions (id, owner_id, created_at, updated_at, kind, origin, topic, text,
    options, status, template_id) VALUES ('e', 'u', 5, 5, 'reflective', 'evergreen', 'other',
    'What surprised you this week?', '[]', 'open', 'surprised')`)
  expect(db.prepare("SELECT source_bullet_id FROM questions WHERE id = 'e'").get()).toEqual({
    source_bullet_id: null,
  })
})
