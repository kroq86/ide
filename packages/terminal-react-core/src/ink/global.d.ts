declare global {
  namespace JSX {
    interface IntrinsicElements {
      'ink-root': Record<string, unknown>
      'ink-box': Record<string, unknown>
      'ink-text': Record<string, unknown>
      'ink-virtual-text': Record<string, unknown>
      'ink-link': Record<string, unknown>
      'ink-progress': Record<string, unknown>
      'ink-raw-ansi': Record<string, unknown>
    }
  }

  namespace React {
    namespace JSX {
      interface IntrinsicElements {
        'ink-root': Record<string, unknown>
        'ink-box': Record<string, unknown>
        'ink-text': Record<string, unknown>
        'ink-virtual-text': Record<string, unknown>
        'ink-link': Record<string, unknown>
        'ink-progress': Record<string, unknown>
        'ink-raw-ansi': Record<string, unknown>
      }
    }
  }

  const Bun:
    | {
        stringWidth?: (value: string, options?: unknown) => number
        wrapAnsi?: (
          input: string,
          columns: number,
          options?: unknown,
        ) => string
        semver: {
          order: (a: string, b: string) => -1 | 0 | 1
          satisfies: (version: string, range: string) => boolean
        }
      }
    | undefined
}

export {}
