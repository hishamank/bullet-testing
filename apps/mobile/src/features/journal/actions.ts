/**
 * Device edge: what the Journal and Capture detail buttons do. Each write lives in `src/data`
 * (change + outbox op in one transaction); here we run it, refresh live queries and sync.
 */

import type {
  BulletDeleteMode,
  EventManualPatch,
  TaskManualPatch,
  ThoughtKind,
  TrackerEntryValue,
} from '@bullet/core'
import * as Haptics from 'expo-haptics'
import {
  captureBullet,
  deleteBullet,
  deleteEvent,
  deleteTask,
  deleteTrackerEntry,
  editBullet,
  reclassifyThought,
  resolveThought,
  unresolveThought,
  updateEvent,
  updateTask,
  updateTrackerEntry,
} from '../../data/local'
import { getDb } from '../../data/open'
import { deviceDeps } from '../../sync/runtime'
import { notifyLocalChange, syncNow } from '../sync/engine'

function run(write: () => void): void {
  write()
  notifyLocalChange()
  void syncNow()
}

const tap = () =>
  Haptics.selectionAsync().catch(() => {
    // No haptics engine (simulator): the change is what matters.
  })

export const resolveLoop = (thoughtId: string) => {
  run(() => resolveThought(getDb(), thoughtId, deviceDeps))
  void tap()
}

export const reopenLoop = (thoughtId: string) =>
  run(() => unresolveThought(getDb(), thoughtId, deviceDeps))

/** "Close with a note": the note is an ordinary capture that resolves the thought. */
export function sendLoopNote(text: string, thoughtId: string): string {
  let id = ''
  run(() => {
    id = captureBullet(getDb(), { text, resolvesThoughtId: thoughtId }, deviceDeps)
  })
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
  return id
}

export const changeKind = (thoughtId: string, kind: ThoughtKind) =>
  run(() => reclassifyThought(getDb(), thoughtId, kind, deviceDeps))

export const editCapture = (bulletId: string, text: string) =>
  run(() => editBullet(getDb(), bulletId, text, deviceDeps))

export const deleteCapture = (bulletId: string, mode: BulletDeleteMode) =>
  run(() => deleteBullet(getDb(), bulletId, mode, deviceDeps))

export function setTaskDone(taskId: string, done: boolean): void {
  run(() => updateTask(getDb(), taskId, { status: done ? 'done' : 'todo' }, deviceDeps))
  void tap()
}

export const editTask = (taskId: string, patch: TaskManualPatch) =>
  run(() => updateTask(getDb(), taskId, patch, deviceDeps))

export const removeTask = (taskId: string) => run(() => deleteTask(getDb(), taskId, deviceDeps))

export const editEvent = (eventId: string, patch: EventManualPatch) =>
  run(() => updateEvent(getDb(), eventId, patch, deviceDeps))

export const removeEvent = (eventId: string) => run(() => deleteEvent(getDb(), eventId, deviceDeps))

export const fixReading = (entryId: string, value: TrackerEntryValue) =>
  run(() => updateTrackerEntry(getDb(), entryId, value, deviceDeps))

export const removeReading = (entryId: string) =>
  run(() => deleteTrackerEntry(getDb(), entryId, deviceDeps))
