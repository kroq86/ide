import type { ParsedLocation, ShellRun } from './shell.js'
import type { TaskRunResult } from './task-runner.js'
import type { QeTask } from './workflow.js'

export type LastTaskRunState = {
  task: QeTask
  result: TaskRunResult
}

export type BuildErrorItem = ParsedLocation & {
  cwd: string
  command: string
  runId: string
}

export type BuildPanelState = {
  taskName: string
  command: string
  cwd: string
  elapsedMs: number | null
  exitCode?: number
  succeeded: boolean
  errors: BuildErrorItem[]
}

function elapsedMs(run: ShellRun): number | null {
  if (!run.endedAt) return null
  const started = Date.parse(run.startedAt)
  const ended = Date.parse(run.endedAt)
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return null
  return Math.max(0, ended - started)
}

function collectRunLocations(run: ShellRun): BuildErrorItem[] {
  return run.locations.map(location => ({
    ...location,
    cwd: run.cwd,
    command: run.command,
    runId: run.id,
  }))
}

export function buildPanelState(lastRun: LastTaskRunState | null): BuildPanelState | null {
  if (!lastRun) return null
  const runs = [lastRun.result.build, lastRun.result.run].filter((run): run is ShellRun => Boolean(run))
  return {
    taskName: lastRun.task.name,
    command: lastRun.task.runCommand
      ? `${lastRun.task.command} && ${lastRun.task.runCommand}`
      : lastRun.task.command,
    cwd: lastRun.result.final.cwd,
    elapsedMs: elapsedMs(lastRun.result.final),
    exitCode: lastRun.result.final.exitCode,
    succeeded: lastRun.result.final.exitCode === 0,
    errors: runs.flatMap(collectRunLocations),
  }
}

export function buildErrorAt(state: BuildPanelState | null, cursor: number): BuildErrorItem | null {
  if (!state || state.errors.length === 0) return null
  return state.errors[((cursor % state.errors.length) + state.errors.length) % state.errors.length] ?? null
}

export function moveBuildErrorCursor(state: BuildPanelState | null, cursor: number, delta: number): number {
  const count = state?.errors.length ?? 0
  if (count === 0) return 0
  return ((cursor + delta) % count + count) % count
}
