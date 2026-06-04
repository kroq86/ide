/** Text to insert when the user presses Enter (newline + next-line indent). */
export function newlineInsertText(
  lines: string[],
  cursor: { row: number; col: number },
  tabSize = 2,
): string {
  const line = lines[cursor.row] ?? ''
  const before = line.slice(0, cursor.col)
  const leading = line.match(/^(\s*)/)?.[1] ?? ''
  const unit = ' '.repeat(tabSize)

  let nextIndent = leading
  const head = before.trimEnd()
  const last = head[head.length - 1]
  if (last === '{' || last === '(' || last === '[') {
    nextIndent = leading + unit
  } else if (
    (last === '}' || last === ')' || last === ']')
    && leading.length >= unit.length
  ) {
    nextIndent = leading.slice(0, leading.length - unit.length)
  }

  return `\n${nextIndent}`
}
