import type { BufferInfo } from '../config.js'
import type { EditorBuffer } from './types.js'

export function isDirty(buffer: EditorBuffer): boolean {
  return buffer.snapshot?.dirty ?? false
}

export function toBufferInfo(buffer: EditorBuffer, activeId: string): BufferInfo {
  return {
    id: buffer.id,
    name: buffer.name,
    filename: buffer.snapshot?.filename ?? buffer.filename,
    dirty: isDirty(buffer),
    temporary: buffer.temporary === true,
    active: buffer.id === activeId,
  }
}

export function filterBuffers(buffers: EditorBuffer[], query: string): EditorBuffer[] {
  const q = query.trim().toLowerCase()
  if (!q) return buffers
  return buffers.filter(buffer => {
    const filename = buffer.snapshot?.filename ?? buffer.filename ?? ''
    return buffer.name.toLowerCase().includes(q) || filename.toLowerCase().includes(q)
  })
}
