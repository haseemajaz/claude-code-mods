export type DeckStatus = 'done' | 'error' | 'stopped' | 'running' | 'none'

export type DeckPromptRow = {
  key: string
  chat: string
  sid: string
  at: number
  text: string
  status: DeckStatus
  summary: string[]
  files: number
  self: boolean
}

export type DeckNeed = {
  /**
   * Stable 1-based number, shared by the open items and the items ticked in
   * the last 24 h (oldest first), so ticking one never renumbers the rest.
   * 0 for an item ticked longer ago.
   */
  n: number
  ids: string[]
  text: string
  chat: string
  sid: string
  sids: string[]
  at: number
  seen: number
  done: boolean
  doneAt?: number
  self: boolean
  /** a configured project, else the chat's folder (hooks/categorize.ts) */
  project: string
  /** Test / check, Decide, Sign in / keys, Run / do, Read / FYI, Other */
  kind: string
  /** Today, This week, Older than a week (when the board was built) */
  age: string
}

export type DeckWaiting = {
  sid: string
  chat: string
  since: number
  what: string
  self: boolean
}

export type DeckBoard = {
  builtAt: number
  prompts: DeckPromptRow[]
  open: DeckNeed[]
  done: DeckNeed[]
  waiting: DeckWaiting[]
  chats: number
}

export type DeckScope = 'day' | 'here' | 'all'

declare module 'claude-code' {
  interface PluginState {
    'command-deck': { board: DeckBoard | null; scope: DeckScope; selfSid: string }
  }
}
