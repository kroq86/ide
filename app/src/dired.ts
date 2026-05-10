import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'

export type DiredEntry = { name: string; fullPath: string; isDir: boolean }

/**
 * List a directory for dired-style browsing: optional .., then dirs, then files (sorted).
 */
export function readDiredEntries(dirPath: string): DiredEntry[] {
  const resolved = resolvePath(dirPath)
  const parent = dirname(resolved)
  const out: DiredEntry[] = []
  if (parent !== resolved) {
    out.push({ name: '..', fullPath: parent, isDir: true })
  }
  let names: string[]
  try {
    names = readdirSync(resolved)
  } catch {
    return out
  }
  const dirs: DiredEntry[] = []
  const files: DiredEntry[] = []
  for (const name of names) {
    if (name === '.' || name === '..') continue
    const fullPath = join(resolved, name)
    try {
      const st = statSync(fullPath)
      const ent: DiredEntry = { name, fullPath, isDir: st.isDirectory() }
      if (st.isDirectory()) dirs.push(ent)
      else if (st.isFile()) files.push(ent)
    } catch {
      /* broken symlink etc. */
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  files.sort((a, b) => a.name.localeCompare(b.name))
  return [...out, ...dirs, ...files]
}
