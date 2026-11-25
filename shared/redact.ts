// Hides secret-looking text before it is written to disk or shown.
// The source is shared/redact.ts; scripts/shared.mjs copies it into each mod.
// It knows the published shapes of common keys, NAME=value pairs whose name
// says "secret", and long random runs. It is a filter, not a guarantee.

export const HIDDEN = '[hidden]'

export type KeyShape = { name: string; pattern: RegExp }

const shape = (name: string, source: string): KeyShape => ({ name, pattern: new RegExp(source) })

/** Well-known key formats. Each needs its own prefix, so ordinary words never match. */
export const KEY_SHAPES: readonly KeyShape[] = [
  shape('private key', '-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----'),
  shape('AWS access key', '\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b'),
  shape('GitHub token', '\\b(?:gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,})'),
  shape('GitLab token', '\\bglpat-[A-Za-z0-9_-]{20,}'),
  shape('Anthropic or OpenAI key', '\\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}'),
  shape('Stripe key', '\\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|\\bwhsec_[A-Za-z0-9]{20,}'),
  shape('Google API key', '\\bAIza[A-Za-z0-9_-]{35}'),
  shape('Google client secret', '\\bGOCSPX-[A-Za-z0-9_-]{20,}'),
  shape('Slack token', '\\bxox[a-z]-[A-Za-z0-9-]{12,}'),
  shape('npm token', '\\bnpm_[A-Za-z0-9]{36}'),
  shape('Supabase token', '\\bsbp_[a-f0-9]{32,}|\\bsb_secret_[A-Za-z0-9_-]{16,}'),
  shape('Resend key', '\\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{18,}'),
  shape('Vercel token', '\\bvc[apr]_[A-Za-z0-9]{24,}'),
  shape('SendGrid key', '\\bSG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}'),
  shape('Hugging Face token', '\\bhf_[A-Za-z0-9]{30,}'),
  shape('Groq key', '\\bgsk_[A-Za-z0-9]{30,}'),
  shape('JSON web token', '\\beyJ[A-Za-z0-9_-]{12,}\\.eyJ[A-Za-z0-9_-]{12,}\\.[A-Za-z0-9_-]{8,}'),
]

const BEARER = /\bBearer\s+[\w.~+/-]{16,}=*/gi

// The name may be a compound (DB_PASSWORD, app_db_pass), so there is no \b in front.
const NAMED =
  /([\w-]*(?:pass(?:word|wd)?|pwd|secret|token|api[_ -]?key|access[_ -]?key|private[_ -]?key|service[_-]role[_-]?key|(?:signing|encryption)[_-]?key)(?:[_-][\w-]*)?)(["']?\s*[:=]\s*["'`]?)([^\s"'`,;]{6,})/gi

function varied(run: string): boolean {
  return /\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run)
}

/** A value after `token:` that is plainly not a key: a number, a count, a lower-case word. */
function plainValue(value: string): boolean {
  return /^[\d,.]+[%kKmM]?$/.test(value) || /^[a-z]+$/.test(value)
}

/** The text with secret-looking parts replaced by [hidden]. */
export function redact(text: string): string {
  let out = String(text ?? '')
  if (!out) return ''
  for (const s of KEY_SHAPES) out = out.replace(new RegExp(s.pattern.source, 'g'), HIDDEN)
  out = out.replace(BEARER, HIDDEN)
  out = out.replace(NAMED, (all, name: string, sep: string, value: string) =>
    value.startsWith(HIDDEN) || plainValue(value) ? all : `${name}${sep}${HIDDEN}`,
  )
  out = out.replace(/\b[0-9a-fA-F]{40,}\b|\b[0-9a-fA-F]{32}\b/g, HIDDEN)
  // a run with slashes is a path, not a key
  return out.replace(/[A-Za-z0-9+_=-]{36,}/g, (run) => (varied(run) ? HIDDEN : run))
}

/** The name of the first key shape in the text, or null. Never returns the value. */
export function keyIn(text: string): string | null {
  for (const s of KEY_SHAPES) if (s.pattern.test(text)) return s.name
  return null
}
