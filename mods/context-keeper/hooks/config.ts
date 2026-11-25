// Settings: <claude folder>/zed-mods/context-keeper/config.json, merged over these
// defaults. A missing or broken file means the defaults.

import type { AdviceKind, CoachConfig } from './coach'
import { DEFAULT_COACH } from './coach'

export type Config = CoachConfig & {
  /** refresh the capsule with the model every N prompts */
  capsuleEveryTurns: number
  /** and when context pressure first crosses these % */
  capsuleAtPct: number[]
  /** the capsule's size cap, in characters (~4 per token) */
  capsuleMaxChars: number
  /** the cap on the section a new chat receives */
  injectMaxChars: number
  /** summaries by the model (else the deterministic extract only) */
  useModel: boolean
  /** the model that writes summaries: an alias or a full id */
  summaryModel: string
  /** give a new chat the previous chat's capsule */
  autoLoad: boolean
  /** only capsules updated within this many hours are auto-loaded */
  autoLoadMaxAgeHours: number
  /** a tool output this long counts as a "long output" */
  bigToolOutputChars: number
  /** also copy each capsule into <copyTo>/<date>/; '' = no copy */
  copyTo: string
}

export const DEFAULT_CONFIG: Config = {
  ...DEFAULT_COACH,
  capsuleEveryTurns: 5,
  capsuleAtPct: [60, 80],
  capsuleMaxChars: 9000,
  injectMaxChars: 10_000,
  useModel: false,
  summaryModel: 'haiku',
  autoLoad: true,
  autoLoadMaxAgeHours: 72,
  bigToolOutputChars: 40_000,
  copyTo: '',
}

const KINDS: AdviceKind[] = ['keep', 'compact', 'new-chat', 'clear', 'break', 'loop', 'cold']

function num(v: unknown, d: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}

/** The file's values over the defaults, each checked; unknown keys ignored. */
export function mergeConfig(raw: unknown): Config {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const d = DEFAULT_CONFIG
  const toastOn = Array.isArray(r.toastOn) ? (r.toastOn.filter((k) => KINDS.includes(k as AdviceKind)) as AdviceKind[]) : d.toastOn
  const topics: Record<string, string[]> = { ...d.topics }
  if (r.topics && typeof r.topics === 'object') {
    for (const [k, v] of Object.entries(r.topics as Record<string, unknown>)) {
      if (Array.isArray(v)) topics[k] = v.map((x) => String(x).toLowerCase()).filter(Boolean)
      else if (v === null) delete topics[k]
    }
  }
  const atPct = Array.isArray(r.capsuleAtPct) ? r.capsuleAtPct.map((x) => num(x, 0, 1, 100)).filter((x) => x > 0) : d.capsuleAtPct
  return {
    compactPct: num(r.compactPct, d.compactPct, 10, 100),
    newChatPct: num(r.newChatPct, d.newChatPct, 10, 100),
    driftNewChatPct: num(r.driftNewChatPct, d.driftNewChatPct, 0, 100),
    clearMinPct: num(r.clearMinPct, d.clearMinPct, 0, 100),
    hysteresisPct: num(r.hysteresisPct, d.hysteresisPct, 0, 30),
    growthLookaheadTurns: num(r.growthLookaheadTurns, d.growthLookaheadTurns, 0, 50),
    maxCompactions: num(r.maxCompactions, d.maxCompactions, 1, 50),
    qualityBudgetTokens: num(r.qualityBudgetTokens, d.qualityBudgetTokens, 0, 10_000_000),
    fiveHourBreakPct: num(r.fiveHourBreakPct, d.fiveHourBreakPct, 1, 101),
    fiveHourSqueezePct: num(r.fiveHourSqueezePct, d.fiveHourSqueezePct, 1, 101),
    weekWarnPct: num(r.weekWarnPct, d.weekWarnPct, 1, 101),
    loopRepeats: num(r.loopRepeats, d.loopRepeats, 2, 50),
    cacheTtlMin: num(r.cacheTtlMin, d.cacheTtlMin, 1, 24 * 60),
    coldBigPct: num(r.coldBigPct, d.coldBigPct, 0, 100),
    toastOn,
    toastCooldownMin: num(r.toastCooldownMin, d.toastCooldownMin, 0, 24 * 60),
    topics,
    capsuleEveryTurns: num(r.capsuleEveryTurns, d.capsuleEveryTurns, 1, 100),
    capsuleAtPct: atPct,
    capsuleMaxChars: num(r.capsuleMaxChars, d.capsuleMaxChars, 2000, 40_000),
    injectMaxChars: num(r.injectMaxChars, d.injectMaxChars, 1000, 40_000),
    useModel: typeof r.useModel === 'boolean' ? r.useModel : d.useModel,
    summaryModel: typeof r.summaryModel === 'string' && r.summaryModel.trim() ? r.summaryModel.trim() : d.summaryModel,
    autoLoad: typeof r.autoLoad === 'boolean' ? r.autoLoad : d.autoLoad,
    autoLoadMaxAgeHours: num(r.autoLoadMaxAgeHours, d.autoLoadMaxAgeHours, 1, 24 * 365),
    bigToolOutputChars: num(r.bigToolOutputChars, d.bigToolOutputChars, 1000, 10_000_000),
    copyTo: typeof r.copyTo === 'string' ? r.copyTo.trim() : d.copyTo,
  }
}

/** What /coach config writes when there is no file yet: every threshold, editable. */
export function configFileText(c: Config): string {
  return JSON.stringify(c, null, 2) + '\n'
}
