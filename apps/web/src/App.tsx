import { useMemo } from 'react'
import { createActions } from './app/actions'
import { ActionsContext, NavContext, useHashRoute, useNavValue } from './app/nav'
import { RuntimeContext, usePairing } from './app/hooks'
import type { Runtime } from './app/runtime'
import { Setup } from './screens/Setup'
import { Shell } from './screens/Shell'

/** The app, over a ready runtime (the boot step opens the local copy first). */
export function App({ runtime }: { runtime: Runtime }) {
  const actions = useMemo(() => createActions(runtime), [runtime])
  return (
    <RuntimeContext.Provider value={runtime}>
      <ActionsContext.Provider value={actions}>
        <Routed />
      </ActionsContext.Provider>
    </RuntimeContext.Provider>
  )
}

function Routed() {
  const route = useHashRoute()
  const nav = useNavValue(route)
  const pairing = usePairing()
  return (
    <NavContext.Provider value={nav}>
      {pairing === 'unpaired' ? <Setup /> : <Shell />}
    </NavContext.Provider>
  )
}
