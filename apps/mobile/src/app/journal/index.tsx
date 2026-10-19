import { useRouter } from 'expo-router'
import { useState } from 'react'
import { RefreshControl, SectionList, StyleSheet } from 'react-native'
import { CaptureCard } from '@/components/journal/CaptureCard'
import { EmptyNote, SectionTitle } from '@/components/journal/parts'
import { retryCaptures } from '@/features/capture/actions'
import { keepAsAudio } from '@/features/journal/actions'
import { groupByDay, listCaptureCards } from '@/features/journal/stream'
import { syncNow } from '@/features/sync/engine'
import { useLocalQuery } from '@/hooks'
import { space, useTheme } from '@/theme'

const PAGE = 40

/** Journal · stream: captures grouped by day, newest first, loaded a page at a time. */
export default function JournalStream() {
  const t = useTheme()
  const router = useRouter()
  const [limit, setLimit] = useState(PAGE)
  const [refreshing, setRefreshing] = useState(false)
  const page = useLocalQuery((db) => listCaptureCards(db, limit), limit)
  // Days and times read in each capture's own zone (where you were), like its card's time.
  const sections = groupByDay(
    page.cards,
    (c) => c.capturedAt,
    Date.now(),
    (c) => c.timezone,
  )

  return (
    <SectionList
      sections={sections}
      keyExtractor={(c) => c.id}
      contentContainerStyle={styles.list}
      stickySectionHeadersEnabled={false}
      initialNumToRender={8}
      windowSize={7}
      onEndReachedThreshold={0.5}
      onEndReached={() => {
        if (page.hasMore) setLimit((l) => l + PAGE)
      }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={t.textSecondary}
          onRefresh={() => {
            setRefreshing(true)
            void syncNow().finally(() => setRefreshing(false))
          }}
        />
      }
      ListEmptyComponent={<EmptyNote>Your captures will show up here, grouped by day.</EmptyNote>}
      renderSectionHeader={({ section }) => <SectionTitle>{section.title}</SectionTitle>}
      renderItem={({ item }) => (
        <CaptureCard
          card={item}
          onOpen={() => router.push({ pathname: '/capture/[id]', params: { id: item.id } })}
          onOpenSource={(id) => router.push({ pathname: '/capture/[id]', params: { id } })}
          onOpenTheme={(id) => router.push({ pathname: '/theme/[id]', params: { id } })}
          onRetry={() => retryCaptures([item.id])}
          onWriteDown={() =>
            router.push({ pathname: '/capture/[id]', params: { id: item.id, write: '1' } })
          }
          onKeepAudio={() => keepAsAudio(item.id)}
        />
      )}
    />
  )
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md },
})
