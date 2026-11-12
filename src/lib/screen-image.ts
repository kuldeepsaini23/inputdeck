// Turns a picture the user picks into what a device screen stores.
// Stills: drawn to cover the screen, then packed as RGB565, big-endian (hi byte first), row-major.
import type { ScreenImage } from '#/drivers/types'

export interface Draft {
  id: string
  name: string
  /** small JPEG for showing in the app */
  preview: string
  image: ScreenImage
}

export function rgb565(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array((rgba.length / 4) * 2)
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 2) {
    const v = ((rgba[i] >> 3) << 11) | ((rgba[i + 1] >> 2) << 5) | (rgba[i + 2] >> 3)
    out[o] = v >> 8
    out[o + 1] = v & 0xff
  }
  return out
}

async function loadBitmap(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file)
  } catch {
    throw new Error("That file isn't a picture this browser can open (use PNG, JPG or WebP).")
  }
}

/** Cover-fit `file` into width×height; round screens get black outside the circle. */
export async function encodeStill(file: File, width: number, height: number, round: boolean): Promise<Draft> {
  const bmp = await loadBitmap(file)
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.fillStyle = '#000'
  g.fillRect(0, 0, width, height)
  const s = Math.max(width / bmp.width, height / bmp.height)
  const w = bmp.width * s, h = bmp.height * s
  if (round) {
    g.save()
    g.beginPath()
    g.arc(width / 2, height / 2, Math.min(width, height) / 2, 0, Math.PI * 2)
    g.clip()
  }
  g.drawImage(bmp, (width - w) / 2, (height - h) / 2, w, h)
  if (round) g.restore()
  bmp.close()
  const data = rgb565(g.getImageData(0, 0, width, height).data)
  return {
    id: crypto.randomUUID(),
    name: file.name,
    preview: c.toDataURL('image/jpeg', 0.82),
    image: { data, width, height, kind: 'still' },
  }
}

/** GIFs are stored as the file itself; the size must already match the screen's GIF size. */
export async function readGif(file: File, size: number): Promise<Draft> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const sig = String.fromCharCode(...bytes.subarray(0, 6))
  if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new Error(`${file.name} isn't a GIF.`)
  const w = bytes[6] | (bytes[7] << 8)
  const h = bytes[8] | (bytes[9] << 8)
  if (w !== size || h !== size) throw new Error(`GIFs must be exactly ${size}×${size} pixels (${file.name} is ${w}×${h}).`)
  const bmp = await loadBitmap(file)
  const c = document.createElement('canvas')
  c.width = c.height = 180
  c.getContext('2d')!.drawImage(bmp, 0, 0, 180, 180)
  bmp.close()
  return { id: crypto.randomUUID(), name: file.name, preview: c.toDataURL('image/jpeg', 0.82), image: { data: bytes, width: w, height: h, kind: 'gif' } }
}

// previews of what InputDeck last sent, so the app can show them again (the receiver can't be read back quickly)
const KEY = 'inputdeck.screen.'
export function savePreviews(deviceId: string, previews: string[]) {
  try {
    localStorage.setItem(KEY + deviceId, JSON.stringify(previews))
  } catch {
    /* storage full or blocked: previews are only a convenience */
  }
}
export function loadPreviews(deviceId: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY + deviceId) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}
