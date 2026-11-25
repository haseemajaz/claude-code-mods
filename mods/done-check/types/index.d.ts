/** How the last finished turn stands on verification. */
export type DoneCheckVerdict = {
  /**
   * unverified: changed code and ran no check after the last edit.
   * failed: the latest run of some check failed.
   * verified: checks ran after the last edit and the latest run of each passed.
   * none: nothing to say (no changes and no checks, or docs-only changes).
   */
  kind: 'unverified' | 'failed' | 'verified' | 'none'
  /** Files the turn changed (docs included). */
  changed: number
  /** The failed check's command, for kind 'failed'. */
  cmd?: string
  /** The session turn number the verdict belongs to. */
  turn: number
}

/** One finished turn, as /done lists it. */
export type DoneCheckTurn = {
  turn: number
  /** Local time the turn ended, HH:MM. */
  at: string
  prompt: string
  changed: number
  verified: 'yes' | 'no' | 'failed' | 'stale' | 'n/a'
  logged: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'done-check': {
      verdict: DoneCheckVerdict | null
      dismissed: boolean
      turns: DoneCheckTurn[]
    }
  }
}
