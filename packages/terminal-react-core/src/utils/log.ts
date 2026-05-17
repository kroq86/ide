export function logError(error: unknown): void {
  if (process.env.NODE_ENV === 'test') {
    return
  }

  if (error instanceof Error) {
    console.error(error)
    return
  }

  console.error(error)
}
