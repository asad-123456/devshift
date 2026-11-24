import { createRoot } from 'react-dom/client'
import type { DevShiftApi } from '../shared/contracts.js'
import { App } from './App.js'
import './styles.css'

declare global {
  interface Window { devshift: DevShiftApi }
}

createRoot(document.getElementById('root')!).render(<App />)
