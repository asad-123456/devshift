import { useEffect } from 'react'

export function useStartupSplash(ready: boolean) {
  useEffect(() => {
    const splash = document.getElementById('startup-splash')
    const root = document.getElementById('root')
    if (!splash || !root || splash.classList.contains('splash-exit')) return
    const dismiss = () => {
      root.inert = false
      splash.setAttribute('aria-hidden', 'true')
      splash.classList.add('splash-exit')
      const fade = splash.getAnimations()[0]
      const remove = () => splash.remove()
      if (fade) void fade.finished.then(remove, remove)
      else remove()
    }
    if (ready) { dismiss(); return }
    const maximumWait = window.setTimeout(dismiss, 900)
    return () => window.clearTimeout(maximumWait)
  }, [ready])
}
