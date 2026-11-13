// Undo / redo for one device. Every step holds the value each setting had before and after it,
// so undoing writes the old value back through the normal edit path (and on to the device).
import type { Value } from '#/drivers/types'

export interface Change {
  key: string
  before: Value
  after: Value
}

export interface Step {
  changes: Change[]
  /** when the step was last extended (ms) */
  at: number
}

/** Edits of the same setting closer together than this become one step (slider drags, typing). */
export const COALESCE_MS = 800

/** Most steps kept per device. */
export const MAX_STEPS = 100

const same = (a: Value, b: Value) => JSON.stringify(a) === JSON.stringify(b)

export class History {
  private undos: Step[] = []
  private redos: Step[] = []
  /** set by undo/redo: the next edit always starts a new step */
  private sealed = false

  get canUndo() {
    return this.undos.length > 0
  }
  get canRedo() {
    return this.redos.length > 0
  }
  get size() {
    return { undo: this.undos.length, redo: this.redos.length }
  }

  /**
   * Remember an edit. A single-setting edit of the same key as the last step, within COALESCE_MS,
   * extends that step instead of adding one. Any new edit clears the redo stack.
   */
  record(changes: Change[], now = Date.now()): void {
    const real = changes.filter((c) => !same(c.before, c.after))
    if (!real.length) return
    this.redos = []
    const top = this.undos.at(-1)
    const sealed = this.sealed
    this.sealed = false
    if (!sealed && real.length === 1 && top && top.changes.length === 1 && top.changes[0].key === real[0].key && now - top.at < COALESCE_MS) {
      top.changes[0] = { ...top.changes[0], after: real[0].after }
      top.at = now
      // dragged back to where it started: nothing left to undo in this step
      if (same(top.changes[0].before, top.changes[0].after)) this.undos.pop()
      return
    }
    this.undos.push({ changes: real, at: now })
    if (this.undos.length > MAX_STEPS) this.undos.shift()
  }

  /** Take the last step; apply each change's `before`. */
  undo(): Step | undefined {
    const s = this.undos.pop()
    if (s) this.redos.push(s)
    this.sealed = true
    return s
  }

  /** Take the last undone step; apply each change's `after`. */
  redo(): Step | undefined {
    const s = this.redos.pop()
    if (s) this.undos.push(s)
    this.sealed = true
    return s
  }

  clear(): void {
    this.undos = []
    this.redos = []
    this.sealed = false
  }
}
