// Where a mod keeps its files, and how it reads its settings.
// The source is shared/home.ts; scripts/shared.mjs copies it into each mod,
// because a mod may only import its own files.

import type { EngineInterface } from 'claude-code'

/** Forward slashes, no slash at the end. */
export function slashed(path: string): string {
  return String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

// The engine wants the variable's name written out at each call.

/** The person's home folder, or '' when nothing names it. */
export async function homeFolder($: EngineInterface): Promise<string> {
  try {
    return slashed((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '')
  } catch {
    return ''
  }
}

/** A path with the home folder written as ~, for showing. */
export function tilde(path: string, home: string): string {
  return home && path.toLowerCase().startsWith(home.toLowerCase() + '/') ? '~' + path.slice(home.length) : path
}

/** Claude Code's own folder: CLAUDE_CONFIG_DIR when set, else ~/.claude. '' when unknown. */
export async function claudeFolder($: EngineInterface): Promise<string> {
  try {
    const set = slashed((await $.env.get('CLAUDE_CONFIG_DIR')) ?? '')
    if (set) return set
  } catch {
    // not readable here: the usual place
  }
  const home = await homeFolder($)
  return home ? `${home}/.claude` : ''
}

/** This mod's own folder: <claude folder>/zed-mods/<mod>. '' when unknown. */
export async function modFolder($: EngineInterface, mod: string): Promise<string> {
  const base = await claudeFolder($)
  return base ? `${base}/zed-mods/${mod}` : ''
}

/** A JSON file's value, or undefined when it is missing or broken. A byte-order mark is fine. */
export async function readJson($: EngineInterface, path: string): Promise<unknown> {
  try {
    return JSON.parse(String(await $.fs.read(path)).replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
}

/** The settings object in <mod folder>/config.json, or {} when there is none. */
export async function readSettings($: EngineInterface, folder: string): Promise<Record<string, unknown>> {
  if (!folder) return {}
  const value = await readJson($, `${folder}/config.json`)
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** The strings in a settings list; anything else is dropped. */
export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : []
}
