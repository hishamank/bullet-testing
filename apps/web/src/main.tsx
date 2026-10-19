import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Boot } from './Boot'
import { ErrorBoundary } from './ErrorBoundary'
import { installTheme } from './ui/theme-css'

installTheme()

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <Boot />
    </ErrorBoundary>
  </StrictMode>,
)
