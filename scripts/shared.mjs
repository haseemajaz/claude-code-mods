// Copies shared/*.ts into the mods that use them (a mod can only import its
// own files). `node scripts/shared.mjs` writes; `--check` fails on a difference.
import { readFileSync, writeFileSync } from 'node:fs'

const USES = {
  'home.ts': ['billing-meter', 'done-check', 'context-keeper', 'command-deck'],
  'footer.ts': ['context-keeper', 'billing-meter'],
  'redact.ts': ['done-check', 'context-keeper', 'command-deck'],
}
const root = new URL('..', import.meta.url)
const check = process.argv.includes('--check')
const lf = (s) => s.replaceAll('\r\n', '\n')
let different = 0
for (const [file, mods] of Object.entries(USES)) {
  const want = lf(readFileSync(new URL(`shared/${file}`, root), 'utf8'))
  for (const mod of mods) {
    const to = new URL(`mods/${mod}/hooks/${file}`, root)
    let have = ''
    try {
      have = lf(readFileSync(to, 'utf8'))
    } catch {}
    if (have === want) continue
    different++
    if (check) console.error(`mods/${mod}/hooks/${file} differs from shared/${file}`)
    else writeFileSync(to, want)
  }
}
console.log(different ? `${different} ${check ? 'copies differ' : 'copies written'}` : 'all copies match')
if (check && different) process.exit(1)
