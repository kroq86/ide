import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseWorkflowSession, type WorkflowSession } from '../workflow.js'

export function workflowSessionPath(cwd: string): string {
  return join(cwd, '.qe', 'session.json')
}

export function loadWorkflowSession(cwd: string): WorkflowSession | null {
  const path = workflowSessionPath(cwd)
  if (!existsSync(path)) return null
  try {
    return parseWorkflowSession(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

export function saveWorkflowSession(cwd: string, session: WorkflowSession): void {
  const path = workflowSessionPath(cwd)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, 'utf8')
  } catch {
    // Session restore is a convenience feature; never block quitting on it.
  }
}
