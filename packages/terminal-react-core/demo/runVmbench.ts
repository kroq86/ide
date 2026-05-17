import { execFile } from 'node:child_process'

const PYTHON_BIN = 'python3'
export const VMBENCH_ROOT = '/Users/ll/honeybadger'
export const VMBENCH_CLI = `${VMBENCH_ROOT}/vmbench_cli.py`

export type VmbenchAction = {
  id: string
  title: string
  label: string
  description: string
  args: string[]
}

export type RunState = 'idle' | 'running' | 'success' | 'error'

export type VmbenchRunResult = {
  ok: boolean
  outputText: string
  commandPreview: string
}

export const actions: VmbenchAction[] = [
  {
    id: 'status',
    title: 'status',
    label: 'Inspect',
    description: 'Inspect manifest, repo map, and the command surface.',
    args: ['status'],
  },
  {
    id: 'repo-map',
    title: 'repo-map',
    label: 'Inspect',
    description: 'Show the key vmbench product and repository map paths.',
    args: ['repo-map'],
  },
  {
    id: 'generate',
    title: 'generate',
    label: 'Generate',
    description: 'Generate a small preset benchmark dataset for demo-sized runs.',
    args: [
      'generate',
      '--single-step-limit',
      '16',
      '--next-2-steps-limit',
      '8',
      '--short-trace-limit',
      '8',
      '--terminal-state-limit',
      '8',
      '--seed',
      '7',
    ],
  },
  {
    id: 'export-sft',
    title: 'export-sft',
    label: 'Export',
    description: 'Export benchmark data into a small SFT-ready demo output folder.',
    args: [
      'export-sft',
      '--dataset-root',
      'datasets/mvp',
      '--output-dir',
      'training_data/sft_demo',
    ],
  },
  {
    id: 'gate',
    title: 'gate',
    label: 'Gate',
    description: 'Evaluate a preset summary path and surface inline file errors if missing.',
    args: ['gate', '--summary', 'reports/baseline/latest/summary.json'],
  },
  {
    id: 'compare',
    title: 'compare',
    label: 'Compare',
    description: 'Compare two preset summary paths and show inline file errors if missing.',
    args: [
      'compare',
      '--base-summary',
      'reports/baseline/base/summary.json',
      '--candidate-summary',
      'reports/baseline/candidate/summary.json',
    ],
  },
]

export function buildCommandPreview(action: VmbenchAction): string {
  return [PYTHON_BIN, VMBENCH_CLI, ...action.args].join(' ')
}

function formatOutput(stdout: string, stderr: string): string {
  const trimmedStdout = stdout.trim()
  const trimmedStderr = stderr.trim()

  if (trimmedStdout) {
    try {
      return JSON.stringify(JSON.parse(trimmedStdout), null, 2)
    } catch {
      // Fall through to raw rendering below.
    }
  }

  if (trimmedStderr && trimmedStdout) {
    return `${trimmedStderr}\n\n${trimmedStdout}`
  }

  if (trimmedStderr) {
    return trimmedStderr
  }

  if (trimmedStdout) {
    return trimmedStdout
  }

  return 'Command completed with no output.'
}

export function runVmbenchAction(
  action: VmbenchAction,
): Promise<VmbenchRunResult> {
  const commandPreview = buildCommandPreview(action)

  return new Promise(resolve => {
    execFile(
      PYTHON_BIN,
      [VMBENCH_CLI, ...action.args],
      {
        cwd: VMBENCH_ROOT,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const outputText = formatOutput(
            stdout,
            stderr || error.message || 'Unknown execution error.',
          )

          resolve({
            ok: false,
            outputText,
            commandPreview,
          })
          return
        }

        resolve({
          ok: true,
          outputText: formatOutput(stdout, stderr),
          commandPreview,
        })
      },
    )
  })
}
