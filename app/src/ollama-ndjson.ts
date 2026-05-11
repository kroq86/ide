/**
 * Read Ollama streaming bodies as newline-delimited chunks (NDJSON over HTTP).
 * Same buffering contract as a readline loop on child stdout — one logical line per yield,
 * with a final yield for any trailing bytes after the stream closes (may be incomplete JSON).
 */
export async function* readOllamaNdjsonLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) yield line
    }
    buf += decoder.decode()
    if (buf.length > 0) yield buf
  } finally {
    reader.releaseLock()
  }
}
