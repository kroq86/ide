export type ChangeHookDecision = {
  revision: number | null
  schedule: boolean
}

export function onChangeDecision(previousRevision: number | undefined, nextRevision: unknown): ChangeHookDecision {
  if (typeof nextRevision !== 'number') return { revision: previousRevision ?? null, schedule: false }
  if (previousRevision === undefined) return { revision: nextRevision, schedule: false }
  if (previousRevision === nextRevision) return { revision: nextRevision, schedule: false }
  return { revision: nextRevision, schedule: true }
}
