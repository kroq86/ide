import type { CommandSource } from './config-runtime.js'
import type { ShellRun, ShellMode } from './shell.js'

export type TroubleshootingSnapshotInput = {
  configPath: string | null
  projectRoot: string
  workspaceRoots: string[]
  aiModelLabel: string
  shellMode: ShellMode
  shellSpawnError: string | null
  lastRun: ShellRun | null
  lastFailedRun: ShellRun | null
  indexedFileCount: number
  commandCounts: Record<CommandSource, number>
  openBufferCount: number
  temporaryBufferCount: number
  activeFile: string | null
  mode: string
  sidecarBinaryPath: string
  sidecarStatus: string
}

export type TroubleshootingRow = {
  label: string
  value: string
}

function runSummary(run: ShellRun | null): string {
  if (!run) return 'none'
  const exit = typeof run.exitCode === 'number' ? `exit ${run.exitCode}` : 'running'
  const locs = run.locations.length === 1 ? '1 location' : `${run.locations.length} locations`
  return `${run.command} (${exit}, ${locs})`
}

export function troubleshootingRows(input: TroubleshootingSnapshotInput): TroubleshootingRow[] {
  const commandCounts = Object.entries(input.commandCounts)
    .map(([source, count]) => `${source}:${count}`)
    .join(' ')
  return [
    { label: 'config', value: input.configPath ?? 'none' },
    { label: 'project root', value: input.projectRoot },
    { label: 'workspace roots', value: input.workspaceRoots.length ? input.workspaceRoots.join(', ') : input.projectRoot },
    { label: 'ai model', value: input.aiModelLabel },
    { label: 'shell', value: input.shellSpawnError ? `${input.shellMode} (${input.shellSpawnError})` : input.shellMode },
    { label: 'last run', value: runSummary(input.lastRun) },
    { label: 'last failed run', value: runSummary(input.lastFailedRun) },
    { label: 'workspace index', value: `${input.indexedFileCount} files` },
    { label: 'commands', value: commandCounts },
    { label: 'buffers', value: `${input.openBufferCount} open, ${input.temporaryBufferCount} temporary` },
    { label: 'active', value: `${input.activeFile ?? '*scratch*'} (${input.mode})` },
    { label: 'sidecar', value: `${input.sidecarStatus}: ${input.sidecarBinaryPath}` },
  ]
}
