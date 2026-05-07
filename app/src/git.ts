import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type GitHunk = { header: string; lines: string[] }

export type GitFileEntry = {
  path: string
  xy: string
  section: 'untracked' | 'unstaged' | 'staged'
  expanded: boolean
  hunks: GitHunk[]
}

export type GitStatusData = {
  branch: string
  ahead: number
  behind: number
  untracked: GitFileEntry[]
  unstaged: GitFileEntry[]
  staged: GitFileEntry[]
}

export type GitLogEntry = { hash: string; msg: string; date: string }

export type GitDisplayLine =
  | { type: 'header';     text: string; selectable: false }
  | { type: 'section';    text: string; selectable: false }
  | { type: 'file';       text: string; entry: GitFileEntry; selectable: true }
  | { type: 'hunk';       text: string; entry: GitFileEntry; hunk: GitHunk; selectable: true }
  | { type: 'diff';       text: string; selectable: false }
  | { type: 'log-header'; text: string; selectable: false }
  | { type: 'log-entry';  text: string; logEntry: GitLogEntry; selectable: false }
  | { type: 'blank';      selectable: false }

function runGit(args: string[], cwd: string, input?: string): { stdout: string; ok: boolean } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 4000, input })
  return { stdout: r.stdout ?? '', ok: (r.status ?? 1) === 0 }
}

export function loadGitStatus(cwd: string): GitStatusData {
  const data: GitStatusData = {
    branch: 'HEAD',
    ahead: 0, behind: 0,
    untracked: [], unstaged: [], staged: [],
  }

  data.branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).stdout.trim() || 'HEAD'

  const ab = runGit(['rev-list', '--left-right', '--count', '@{u}...HEAD'], cwd).stdout.trim()
  const abParts = ab.split('\t')
  if (abParts.length === 2) {
    data.behind = parseInt(abParts[0]!, 10) || 0
    data.ahead  = parseInt(abParts[1]!, 10) || 0
  }

  const statusOut = runGit(['status', '--porcelain=v1', '-u'], cwd).stdout
  for (const line of statusOut.split('\n')) {
    if (!line.trim() || line.length < 4) continue
    const xy = line.slice(0, 2)

    let path = line.slice(3).trim()
    if (path.includes(' -> ')) path = path.split(' -> ')[1]!.trim()

    if (xy === '??' || xy === '!!') {
      data.untracked.push({ path, xy, section: 'untracked', expanded: false, hunks: [] })
      continue
    }

    const ix = xy[0]!
    const wt = xy[1]!

    if (ix !== ' ' && ix !== '?' && ix !== '!') {
      data.staged.push({ path, xy, section: 'staged', expanded: false, hunks: [] })
    }
    if (wt !== ' ' && wt !== '?' && wt !== '!') {
      data.unstaged.push({ path, xy, section: 'unstaged', expanded: false, hunks: [] })
    }
  }

  return data
}

function parseHunks(diffOut: string): GitHunk[] {
  const hunks: GitHunk[] = []
  let current: GitHunk | null = null
  for (const line of diffOut.split('\n')) {
    if (line.startsWith('@@')) {
      if (current) hunks.push(current)
      current = { header: line, lines: [] }
    } else if (current && /^[+\- \\]/.test(line)) {
      current.lines.push(line)
    }
  }
  if (current) hunks.push(current)
  return hunks
}

export function loadFileHunks(cwd: string, path: string, section: 'untracked' | 'unstaged' | 'staged'): GitHunk[] {
  if (section === 'untracked') {
    try {
      const content = readFileSync(join(cwd, path), 'utf8')
      const fileLines = content.split('\n')
      if (fileLines[fileLines.length - 1] === '') fileLines.pop()
      return [{ header: `@@ -0,0 +1,${fileLines.length} @@`, lines: fileLines.map(l => `+${l}`) }]
    } catch { return [] }
  }
  const args = section === 'staged'
    ? ['diff', '--cached', '--unified=3', '--', path]
    : ['diff', '--unified=3', '--', path]
  return parseHunks(runGit(args, cwd).stdout)
}

function buildPatch(entry: GitFileEntry, hunk: GitHunk): string {
  return `--- a/${entry.path}\n+++ b/${entry.path}\n${hunk.header}\n${hunk.lines.join('\n')}\n`
}

export function stageEntry(cwd: string, entry: GitFileEntry, hunk?: GitHunk): void {
  if (!hunk || entry.section === 'untracked') {
    spawnSync('git', ['add', '--', entry.path], { cwd, timeout: 3000 })
  } else {
    spawnSync('git', ['apply', '--cached', '--whitespace=nowarn', '--'], {
      cwd, input: buildPatch(entry, hunk), encoding: 'utf8', timeout: 3000,
    })
  }
}

export function unstageEntry(cwd: string, entry: GitFileEntry, hunk?: GitHunk): void {
  if (entry.section === 'untracked') return
  if (!hunk) {
    spawnSync('git', ['restore', '--staged', '--', entry.path], { cwd, timeout: 3000 })
  } else {
    spawnSync('git', ['apply', '--cached', '--reverse', '--whitespace=nowarn', '--'], {
      cwd, input: buildPatch(entry, hunk), encoding: 'utf8', timeout: 3000,
    })
  }
}

export function commitGit(cwd: string, message: string): void {
  spawnSync('git', ['commit', '-m', message], { cwd, encoding: 'utf8', timeout: 10000 })
}

export function pullGit(cwd: string): void {
  spawnSync('git', ['pull'], { cwd, encoding: 'utf8', timeout: 30000 })
}

export function pushGit(cwd: string): void {
  spawnSync('git', ['push'], { cwd, encoding: 'utf8', timeout: 30000 })
}

export function getGitLog(cwd: string, n = 20): GitLogEntry[] {
  const out = runGit(['log', `--max-count=${n}`, '--format=%h\t%s\t%ar'], cwd).stdout
  return out.split('\n').filter(l => l.trim()).map(line => {
    const parts = line.split('\t')
    return { hash: parts[0] ?? '', msg: parts[1] ?? '', date: parts[2] ?? '' }
  })
}

export function buildGitDisplayLines(data: GitStatusData, logEntries?: GitLogEntry[] | null): GitDisplayLine[] {
  const lines: GitDisplayLine[] = []

  const ab = data.ahead > 0 || data.behind > 0 ? ` ↑${data.ahead} ↓${data.behind}` : ''
  lines.push({ type: 'header', text: `Branch: ${data.branch}${ab}`, selectable: false })
  lines.push({ type: 'blank', selectable: false })

  function addSection(title: string, entries: GitFileEntry[]) {
    if (entries.length === 0) return
    lines.push({ type: 'section', text: `${title} (${entries.length})`, selectable: false })
    for (const entry of entries) {
      lines.push({ type: 'file', text: `  ${entry.path}`, entry, selectable: true })
      if (entry.expanded) {
        if (entry.hunks.length === 0) {
          lines.push({ type: 'diff', text: '    (no diff)', selectable: false })
        } else {
          for (const hunk of entry.hunks) {
            lines.push({ type: 'hunk', text: `    ${hunk.header}`, entry, hunk, selectable: true })
            for (const dl of hunk.lines) {
              lines.push({ type: 'diff', text: `      ${dl}`, selectable: false })
            }
          }
        }
      }
    }
  }

  addSection('Untracked files', data.untracked)
  addSection('Unstaged changes', data.unstaged)
  addSection('Staged changes', data.staged)

  if (!data.untracked.length && !data.unstaged.length && !data.staged.length) {
    lines.push({ type: 'section', text: 'Working tree clean', selectable: false })
  }

  if (logEntries?.length) {
    lines.push({ type: 'blank', selectable: false })
    lines.push({ type: 'log-header', text: 'Recent commits', selectable: false })
    for (const e of logEntries) {
      lines.push({ type: 'log-entry', text: `  ${e.hash}  ${e.msg}  (${e.date})`, logEntry: e, selectable: false })
    }
  }

  return lines
}
