import { taskStatusSchema } from '@bullet/core'

/**
 * Placeholder web client. It will become the review and dashboard surface; the phone is the
 * primary capture client.
 */
export function App() {
  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '0 auto', padding: 16 }}>
      <h1>Bullet</h1>
      <p>Web client placeholder. Task statuses: {taskStatusSchema.options.join(', ')}</p>
    </main>
  )
}
