import { Component, type ReactNode } from 'react'

/** The last resort: something broke while drawing. Say so calmly; Reload starts over. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch(error: unknown) {
    console.error('the app stopped drawing', error)
  }

  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <main className="boot" id="main">
        <h1>Something went wrong</h1>
        <p className="secondary">
          Your journal is safe on your home server, and anything saved in this browser is kept.
          Reloading usually fixes it.
        </p>
        <div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </main>
    )
  }
}
