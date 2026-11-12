// Brand photo servers are sometimes slow or drop requests (WLMouse's hub also forbids caching).
// Retry a failed photo a couple of times, then report it as missing so the page can draw the device instead
// of showing a broken image.
import { useEffect, useState } from 'react'

const RETRIES = 2
const failed = new Set<string>()

export function usePhoto(src: string | undefined): { src: string | undefined; onError: () => void } {
  const [state, setState] = useState<{ for?: string; attempt: number; gaveUp: boolean }>({ attempt: 0, gaveUp: false })
  const cur = state.for === src ? state : { for: src, attempt: 0, gaveUp: !!src && failed.has(src) }
  const [timer, setTimer] = useState<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer), [timer])
  if (!src || cur.gaveUp) return { src: undefined, onError: () => {} }
  const url = cur.attempt ? `${src}${src.includes('?') ? '&' : '?'}retry=${cur.attempt}` : src
  const onError = () => {
    if (cur.attempt >= RETRIES) {
      failed.add(src)
      setState({ for: src, attempt: cur.attempt, gaveUp: true })
      return
    }
    // wait a little longer each time before asking again
    setTimer(setTimeout(() => setState({ for: src, attempt: cur.attempt + 1, gaveUp: false }), 700 * (cur.attempt + 1)))
  }
  return { src: url, onError }
}
