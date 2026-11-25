// One short label in the footer, beside the permission mode. Where no footer is
// drawn (VS Code, a phone) the label goes to the status line, and only when it
// is news: the engine marks a status line as a warning.
// The source is shared/footer.ts; scripts/shared.mjs copies it into each mod.

import type { EngineInterface, On } from 'claude-code'

let label: string | undefined
let isNews = false
let noFooter = false

/** Asks where this session draws. Each mod calls it when its session starts. */
export async function lookForFooter($: EngineInterface): Promise<void> {
  try {
    const surfaces = await $.session.surfaces()
    noFooter = surfaces.length > 0 && !surfaces.some((s) => s === 'terminal' || s === 'desktop')
  } catch {
    noFooter = false
  }
}

function draw($: EngineInterface): void {
  $.ui.status(noFooter && isNews ? label : undefined)
  $.ui.invalidate('ui.render')
}

/** Sets the label; `news` is whether it deserves the status line where no footer is drawn. */
export function setFooter($: EngineInterface, text: string | undefined, news: boolean): void {
  if (text === label && news === isNews) return
  label = text
  isNews = news
  draw($)
}

/** Draws the label, and looks again at where the session draws when that changes. */
export function watchFooter(on: On): void {
  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    await lookForFooter($)
    draw($)
    return r
  })
  on('session.detach', async ($, e, next) => {
    const r = await next(e)
    await lookForFooter($)
    draw($)
    return r
  })
  on('ui.render', { component: 'SessionMode' }, (_$, e, next) => {
    if (!label) return next(e)
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } })
  })
}
