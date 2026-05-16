import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Loads .env from the repo root into process.env (does not override existing vars).
// Runs once at module-init time so all downstream modules see the values.
// In the esbuild bundle (app/dist/main.js), import.meta.url resolves to the bundle
// path, so ../../.env correctly reaches the repo root .env file.
const envPath = (() => {
  try { return join(dirname(fileURLToPath(import.meta.url)), '../../.env') }
  catch { return '' }
})()

if (envPath && existsSync(envPath)) {
  for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1)
    if (key && !(key in process.env)) process.env[key] = val
  }
}
