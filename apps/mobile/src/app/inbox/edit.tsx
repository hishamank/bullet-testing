import type { TrackerConfig, TrackerEntryValue } from '@bullet/core'
import DateTimePicker from '@expo/ui/community/datetime-picker'
import { eq } from 'drizzle-orm'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { KeyboardAvoidingView, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { InboxPill, OptionButton } from '@/components/inbox/parts'
import { BackHeader, Label, Placeholder, PrimaryButton, Screen, TextButton } from '@/components/ui'
import { suggestions } from '@/data/schema'
import { accept } from '@/features/inbox/actions'
import { applyEdit, type EditForm, editFormFor, payloadChanged } from '@/features/inbox/edit'
import { summaryContext } from '@/features/inbox/model'
import { summarize } from '@/features/inbox/summary'
import { useLocalQuery } from '@/hooks'
import { deviceDeps } from '@/sync/runtime'
import { radius, size, space, type, useTheme } from '@/theme'

/** Edit a waiting suggestion, then add it with the changes (`suggestion.accept` + payload). */
export default function EditSuggestion() {
  const router = useRouter()
  const { suggestion: id } = useLocalSearchParams<{ suggestion: string }>()
  const loaded = useLocalQuery((db) => {
    const s = db
      .select()
      .from(suggestions)
      .where(eq(suggestions.id, id ?? ''))
      .get()
    if (!s || s.state !== 'active' || s.status !== 'pending') return null
    const ctx = summaryContext(db, [s], Date.now(), deviceDeps.timezone())
    const trackerId =
      typeof s.payload.tracker_id === 'string' ? s.payload.tracker_id : (s.target_id ?? '')
    return { s, summary: summarize(s, ctx), tracker: ctx.trackers.get(trackerId) ?? null }
  }, id)
  const [form, setForm] = useState<EditForm | null>(() => (loaded ? editFormFor(loaded.s) : null))
  const [error, setError] = useState<string | null>(null)
  const close = () => router.back()

  if (!loaded || !form) {
    return (
      <Screen>
        <BackHeader backLabel="Inbox" onBack={close} />
        <View style={{ padding: space.xl }}>
          <Placeholder title="This was already decided, so there's nothing to edit." />
        </View>
      </Screen>
    )
  }
  const { s, summary, tracker } = loaded

  const save = () => {
    const result = applyEdit(s, form, tracker?.config)
    if (!result.ok) {
      setError(result.message)
      return
    }
    accept(
      s.id,
      summary.spoken,
      payloadChanged(s.payload, result.payload) ? result.payload : undefined,
    )
    close()
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <BackHeader title="Edit" backLabel="Inbox" onBack={close} />
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <InboxPill kind={summary.pill.kind} label={summary.pill.label} />
          <Fields form={form} tracker={tracker} onChange={(f) => (setForm(f), setError(null))} />
          {error ? (
            <Label tone="warning" size={type.bodySmall} accessibilityLiveRegion="polite">
              {error}
            </Label>
          ) : null}
          <PrimaryButton title="Add with changes" onPress={save} />
          <View style={{ alignItems: 'center' }}>
            <TextButton title="Cancel" tone="secondary" onPress={close} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

function Fields({
  form,
  tracker,
  onChange,
}: {
  form: EditForm
  tracker: { name: string; config: TrackerConfig } | null
  onChange: (f: EditForm) => void
}) {
  switch (form.kind) {
    case 'task':
      return (
        <>
          <Field
            label="Title"
            value={form.title}
            onChange={(title) => onChange({ ...form, title })}
          />
          <Label tone="secondary" size={type.label}>
            Due
          </Label>
          {form.due_at === null ? (
            <TextButton
              title="Add a due date"
              onPress={() => onChange({ ...form, due_at: Date.now() + 86_400_000 })}
            />
          ) : (
            <View style={styles.inline}>
              <When value={form.due_at} onChange={(due_at) => onChange({ ...form, due_at })} />
              <TextButton
                title="No due date"
                tone="secondary"
                onPress={() => onChange({ ...form, due_at: null })}
              />
            </View>
          )}
        </>
      )
    case 'event':
      return (
        <>
          <Field
            label="Title"
            value={form.title}
            onChange={(title) => onChange({ ...form, title })}
          />
          <Label tone="secondary" size={type.label}>
            Starts
          </Label>
          <When value={form.starts_at} onChange={(starts_at) => onChange({ ...form, starts_at })} />
        </>
      )
    case 'tracker':
      return (
        <Field label="Name" value={form.name} onChange={(name) => onChange({ ...form, name })} />
      )
    case 'activity':
      return (
        <>
          <Field
            label="What you did"
            value={form.name}
            onChange={(name) => onChange({ ...form, name })}
          />
          <Field
            label="Amount (optional)"
            value={form.quantity}
            keyboard="decimal-pad"
            onChange={(quantity) => onChange({ ...form, quantity })}
          />
        </>
      )
    case 'tracker_entry':
      return (
        <ValueField
          name={tracker?.name ?? 'Reading'}
          config={tracker?.config ?? null}
          value={form.value}
          onChange={(value) => onChange({ ...form, value })}
        />
      )
  }
}

function Field({
  label,
  value,
  onChange,
  keyboard = 'default',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  keyboard?: 'default' | 'decimal-pad'
}) {
  const t = useTheme()
  return (
    <View style={{ gap: space.xs }}>
      <Label tone="secondary" size={type.label}>
        {label}
      </Label>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        keyboardType={keyboard}
        placeholderTextColor={t.textMuted}
        style={[styles.input, { backgroundColor: t.card, color: t.text, borderColor: t.hairline }]}
      />
    </View>
  )
}

function When({ value, onChange }: { value: number; onChange: (at: number) => void }) {
  const t = useTheme()
  return (
    <DateTimePicker
      value={new Date(value)}
      mode="datetime"
      display="compact"
      accentColor={t.accent}
      onValueChange={(_, date) => onChange(date.getTime())}
    />
  )
}

/** A reading's value, shaped by its tracker: scale/select/boolean as buttons, else typed. */
function ValueField({
  name,
  config,
  value,
  onChange,
}: {
  name: string
  config: TrackerConfig | null
  value: TrackerEntryValue
  onChange: (v: TrackerEntryValue) => void
}) {
  const t = useTheme()
  const choices = (options: { title: string; value: TrackerEntryValue; selected: boolean }[]) => (
    <View style={styles.choices}>
      {options.map((o) => (
        <View
          key={o.title}
          style={o.selected ? [styles.selected, { borderColor: t.accent }] : styles.unselected}
        >
          <OptionButton
            title={o.title}
            label={`${name} ${o.title}${o.selected ? ', selected' : ''}`}
            onPress={() => onChange(o.value)}
          />
        </View>
      ))}
    </View>
  )
  const header = (
    <Label tone="secondary" size={type.label}>
      {name}
    </Label>
  )
  if (config?.input_type === 'scale' && config.max - config.min <= 10) {
    const steps = Array.from({ length: config.max - config.min + 1 }, (_, i) => config.min + i)
    return (
      <>
        {header}
        {choices(steps.map((n) => ({ title: String(n), value: n, selected: value === n })))}
      </>
    )
  }
  if (config?.input_type === 'boolean' || typeof value === 'boolean') {
    return (
      <>
        {header}
        {choices([
          { title: 'Yes', value: true, selected: value === true },
          { title: 'No', value: false, selected: value === false },
        ])}
      </>
    )
  }
  if (config?.input_type === 'single_select') {
    return (
      <>
        {header}
        {choices(config.options.map((o) => ({ title: o, value: o, selected: value === o })))}
      </>
    )
  }
  if (config?.input_type === 'multi_select') {
    const picked = Array.isArray(value) ? value : []
    return (
      <>
        {header}
        {choices(
          config.options.map((o) => ({
            title: o,
            value: picked.includes(o) ? picked.filter((p) => p !== o) : [...picked, o],
            selected: picked.includes(o),
          })),
        )}
      </>
    )
  }
  if (typeof value === 'number') {
    return <NumberField name={name} value={value} onChange={onChange} />
  }
  return <Field label={name} value={String(value)} onChange={onChange} />
}

/** A typed number; keeps the raw text while it isn't a number yet. */
function NumberField({
  name,
  value,
  onChange,
}: {
  name: string
  value: number
  onChange: (v: TrackerEntryValue) => void
}) {
  const [raw, setRaw] = useState(String(value))
  return (
    <Field
      label={name}
      value={raw}
      keyboard="decimal-pad"
      onChange={(text) => {
        setRaw(text)
        const n = Number(text.replace(',', '.'))
        if (text.trim() !== '' && Number.isFinite(n)) onChange(n)
      }}
    />
  )
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.md },
  input: {
    minHeight: size.touch,
    borderRadius: radius.note,
    borderWidth: 1,
    paddingHorizontal: space.md,
    fontSize: type.body,
  },
  inline: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  selected: { borderWidth: 2, borderRadius: radius.pill },
  unselected: { borderWidth: 2, borderColor: 'transparent', borderRadius: radius.pill },
})
