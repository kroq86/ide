export type WorkspaceTab = 'code' | 'process' | 'ai'

export type QeTask = {
  name: string
  command: string
  tab?: 'process' | 'shell'
}

export type QeProjectProfile = {
  name: string
  root?: string
  files?: string[]
  tasks?: QeTask[]
}

export type BufferTabInput = {
  id: string
  name: string
  filename: string | null
  dirty: boolean
  active: boolean
  lastUsedAt: number
}

export type BufferTabSegment =
  | { kind: 'tab'; id: string; label: string; active: boolean; dirty: boolean }
  | { kind: 'overflow'; count: number; label: string }

export type WorkflowSession = {
  version: 1
  files: string[]
  activeFile: string | null
  workspaceTab: WorkspaceTab
}

export function normalizeWorkspaceTab(value: unknown): WorkspaceTab {
  if (value === 'ai') return 'ai'
  return value === 'process' ? 'process' : 'code'
}

export function normalizeTasks(tasks: readonly QeTask[] | undefined): QeTask[] {
  if (!Array.isArray(tasks)) return []
  return tasks
    .filter(task => task && typeof task.name === 'string' && typeof task.command === 'string')
    .map(task => ({
      name: task.name.trim(),
      command: task.command.trim(),
      tab: task.tab === 'shell' ? 'shell' as const : task.tab === 'process' ? 'process' as const : undefined,
    }))
    .filter(task => task.name.length > 0 && task.command.length > 0)
}

export function sessionFromBuffers(
  buffers: Array<{ filename: string | null; active: boolean }>,
  workspaceTab: WorkspaceTab,
): WorkflowSession {
  const files = uniqueStrings(buffers.map(buffer => buffer.filename).filter((file): file is string => Boolean(file)))
  const activeFile = buffers.find(buffer => buffer.active)?.filename ?? files[0] ?? null
  return {
    version: 1,
    files,
    activeFile,
    workspaceTab,
  }
}

export function parseWorkflowSession(value: unknown): WorkflowSession | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { files?: unknown; activeFile?: unknown; workspaceTab?: unknown }
  const files = Array.isArray(raw.files)
    ? uniqueStrings(raw.files.filter((file): file is string => typeof file === 'string' && file.length > 0))
    : []
  return {
    version: 1,
    files,
    activeFile: typeof raw.activeFile === 'string' && raw.activeFile.length > 0 ? raw.activeFile : null,
    workspaceTab: normalizeWorkspaceTab(raw.workspaceTab),
  }
}

export function buildBufferTabSegments(
  buffers: BufferTabInput[],
  maxWidth: number,
): BufferTabSegment[] {
  if (buffers.length === 0 || maxWidth < 8) return []
  const ordered = orderTabs(buffers)
  const activeSegment = ordered.map((buffer, index) => makeTabSegment(buffer, index)).find(segment => segment.active)
  const result: BufferTabSegment[] = []
  let used = 0
  let hidden = 0

  for (let i = 0; i < ordered.length; i++) {
    const buffer = ordered[i]!
    const segment = makeTabSegment(buffer, i)
    const remainingAfter = ordered.length - i - 1
    const reserve = remainingAfter > 0 ? overflowLabel(remainingAfter).length : 0
    let label = segment.label
    let width = label.length

    if (result.length === 0 && width + reserve > maxWidth) {
      label = truncateMiddle(label, Math.max(1, maxWidth - reserve))
      width = label.length
    }

    if (used + width + reserve > maxWidth) {
      hidden++
      continue
    }
    result.push({ ...segment, label })
    used += width
  }

  if (hidden > 0) {
    let label = overflowLabel(hidden)
    while (result.length > 1 && used + label.length > maxWidth) {
      const removed = result.pop()
      if (removed?.kind === 'tab') hidden++
      used = result.reduce((sum, segment) => sum + segment.label.length, 0)
      label = overflowLabel(hidden)
    }
    if (result.length === 1 && used + label.length > maxWidth && result[0]?.kind === 'tab') {
      result[0] = { ...result[0], label: truncateMiddle(result[0].label, Math.max(1, maxWidth - label.length)) }
      used = result[0].label.length
    }
    if (used + label.length <= maxWidth) {
      result.push({ kind: 'overflow', count: hidden, label })
    }
  }

  return ensureActiveTabVisible(result, activeSegment, ordered.length, maxWidth)
}

function orderTabs(buffers: BufferTabInput[]): BufferTabInput[] {
  return buffers
}

function makeTabSegment(buffer: BufferTabInput, index: number): Extract<BufferTabSegment, { kind: 'tab' }> {
  const marker = buffer.dirty ? '*' : ' '
  const active = buffer.active ? '>' : ' '
  const name = buffer.name || buffer.filename || '*scratch*'
  return {
    kind: 'tab',
    id: buffer.id,
    label: ` ⌥${index + 1} ${active}${marker} ${name} `,
    active: buffer.active,
    dirty: buffer.dirty,
  }
}

function overflowLabel(count: number): string {
  return ` +${count} `
}

function ensureActiveTabVisible(
  segments: BufferTabSegment[],
  activeSegment: Extract<BufferTabSegment, { kind: 'tab' }> | undefined,
  totalTabs: number,
  maxWidth: number,
): BufferTabSegment[] {
  if (!activeSegment || segments.some(segment => segment.kind === 'tab' && segment.id === activeSegment.id)) {
    return segments
  }

  const visibleTabs = segments.filter((segment): segment is Extract<BufferTabSegment, { kind: 'tab' }> => segment.kind === 'tab')
  let hidden = Math.max(0, totalTabs - visibleTabs.length - 1)
  let activeLabel = activeSegment.label
  let overflow = overflowLabel(hidden)

  while (visibleTabs.length > 0 && sumLabels(visibleTabs) + activeLabel.length + overflow.length > maxWidth) {
    visibleTabs.pop()
    hidden++
    overflow = overflowLabel(hidden)
  }

  const visibleWidth = sumLabels(visibleTabs)
  if (visibleWidth + activeLabel.length + overflow.length > maxWidth) {
    activeLabel = truncateMiddle(activeLabel, Math.max(1, maxWidth - visibleWidth - overflow.length))
  }

  const next: BufferTabSegment[] = [...visibleTabs, { ...activeSegment, label: activeLabel }]
  const nextWidth = sumLabels(next)
  if (hidden > 0 && nextWidth + overflow.length <= maxWidth) {
    return [...next, { kind: 'overflow', count: hidden, label: overflow }]
  }
  return next
}

function sumLabels(segments: BufferTabSegment[]): number {
  return segments.reduce((sum, segment) => sum + segment.label.length, 0)
}

function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value
  if (max <= 1) return value.slice(0, max)
  const left = Math.max(1, Math.floor((max - 1) / 2))
  const right = Math.max(0, max - left - 1)
  return `${value.slice(0, left)}…${right > 0 ? value.slice(-right) : ''}`
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}
