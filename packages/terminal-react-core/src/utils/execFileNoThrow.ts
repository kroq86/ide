import { spawn } from 'child_process'

type ExecFileOptions = {
  input?: string
  timeout?: number
  useCwd?: boolean
}

export function execFileNoThrow(
  file: string,
  args: string[],
  options: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  return new Promise(resolve => {
    const child = spawn(file, args, {
      cwd: options.useCwd === false ? undefined : process.cwd(),
      stdio: 'pipe',
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (result: {
      stdout: string
      stderr: string
      code: number
      error?: string
    }) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let timer: NodeJS.Timeout | undefined
    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        child.kill('SIGTERM')
        finish({ stdout, stderr, code: 1, error: 'timeout' })
      }, options.timeout)
    }

    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', error => {
      if (timer) clearTimeout(timer)
      finish({ stdout, stderr, code: 1, error: error.message })
    })
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      finish({
        stdout,
        stderr,
        code: code ?? 1,
        error: code && code !== 0 ? `exit ${code}` : undefined,
      })
    })

    if (options.input !== undefined) {
      child.stdin.write(options.input)
    }
    child.stdin.end()
  })
}
