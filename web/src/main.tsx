import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './pilot-global.css'
import App from './BrowserPilot.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
