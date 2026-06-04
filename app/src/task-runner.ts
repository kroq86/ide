import type { ParsedLocation, ShellRun, ShellRunOptions, TrackedShellResult } from './shell.js'
import type { QeTask } from './workflow.js'

export type TaskShell = {
  runTracked: (command: string, options?: ShellRunOptions) => Promise<TrackedShellResult>
}

export type TaskRunResult = {
  build: ShellRun
  run?: ShellRun
  final: ShellRun
}

export function taskRunOptions(task: QeTask): ShellRunOptions {
  return {
    cwd: task.cwd,
    errorRegex: task.errorRegex,
    timeoutSeconds: task.timeoutSeconds,
  }
}

export async function runTaskProfile(task: QeTask, shell: TaskShell): Promise<TaskRunResult> {
  const options = taskRunOptions(task)
  const build = await shell.runTracked(task.command, options)
  if (build.exitCode === 0 && task.runCommand) {
    const run = await shell.runTracked(task.runCommand, options)
    return { build, run, final: run }
  }
  return { build, final: build }
}

export function firstTaskLocation(result: TaskRunResult): ParsedLocation | null {
  return result.build.locations[0] ?? result.run?.locations[0] ?? null
}

export function taskSucceeded(result: TaskRunResult): boolean {
  return result.final.exitCode === 0
}
