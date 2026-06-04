export type TempBufferLike = {
  id: string
  filename: string | null
  temporary?: boolean
  snapshot?: { dirty?: boolean; filename?: string | null } | null
}

export function shouldReplaceTemporaryBuffer(buffer: TempBufferLike | undefined): boolean {
  return Boolean(buffer?.temporary && !isPermanentByState(buffer))
}

export function markBufferPermanent<T extends TempBufferLike>(buffer: T): T {
  buffer.temporary = false
  return buffer
}

function isPermanentByState(buffer: TempBufferLike): boolean {
  return Boolean(buffer.snapshot?.dirty || !buffer.filename)
}
