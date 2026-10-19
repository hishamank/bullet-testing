import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { ConnectionCard, QuoteLink, ThemePill } from '@/components/connections/parts'
import { showThemeMenu, type ThemeSheet, ThemeSheets } from '@/components/connections/ThemeSheets'
import { SectionTitle } from '@/components/journal/parts'
import { BackHeader, IconButton, Placeholder, Screen, TextButton } from '@/components/ui'
import { mergeInto, notATheme, renameThemeTo } from '@/features/connections/actions'
import { COPY, capturesHeading, themeTitle } from '@/features/connections/copy'
import { useThemeView } from '@/hooks'
import { space } from '@/theme'

/**
 * A theme: every capture it came up in, newest first (from a Noticed card's Open, or the
 * Stream's "again" dot). Rename, Merge with… and Not a theme, as on the card.
 */
export default function ThemeScreen() {
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const theme = useThemeView(id)
  const [sheet, setSheet] = useState<ThemeSheet | null>(null)
  const back = () => router.back()
  const open = (bulletId: string) =>
    router.push({ pathname: '/capture/[id]', params: { id: bulletId } })

  if (!theme) {
    return (
      <Screen>
        <BackHeader backLabel={COPY.back} onBack={back} />
        <View style={{ padding: space.xl }}>
          <Placeholder title={COPY.themeGone} />
        </View>
      </Screen>
    )
  }

  const edit = (mode: 'rename' | 'merge') => setSheet({ mode, themeId: theme.id, name: theme.name })
  return (
    <Screen>
      <BackHeader
        title={themeTitle(theme.name)}
        backLabel={COPY.back}
        onBack={back}
        right={
          <IconButton
            icon="more"
            label={COPY.more}
            accessibilityHint={COPY.moreHint}
            iconSize={20}
            onPress={() => showThemeMenu(edit)}
          />
        }
      />
      <ScrollView contentContainerStyle={styles.body}>
        <ThemePill name={theme.name} onPress={() => edit('rename')} />
        <SectionTitle>{capturesHeading(theme.captures.length)}</SectionTitle>
        <ConnectionCard>
          <View>
            {theme.captures.map((q, i) => (
              <QuoteLink key={q.thoughtId} row={q} onOpen={open} first={i === 0} />
            ))}
          </View>
        </ConnectionCard>
        <View style={{ alignItems: 'flex-start' }}>
          <TextButton
            title={COPY.notATheme}
            tone="secondary"
            accessibilityHint={COPY.notAThemeHint}
            onPress={() => {
              notATheme(theme.id)
              back()
            }}
          />
        </View>
      </ScrollView>
      <ThemeSheets
        sheet={sheet}
        onClose={() => setSheet(null)}
        onRename={(themeId, name) => {
          renameThemeTo(themeId, name)
          setSheet(null)
        }}
        onMerge={(themeId, into) => {
          mergeInto(themeId, into)
          setSheet(null)
          router.replace({ pathname: '/theme/[id]', params: { id: into } })
        }}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md },
})
