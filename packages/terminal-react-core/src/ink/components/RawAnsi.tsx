type Props = {
  lines: string[]
  width: number
}

export function RawAnsi({ lines, width }: Props) {
  if (lines.length === 0) {
    return null
  }

  return (
    <ink-raw-ansi
      rawText={lines.join('\n')}
      rawWidth={width}
      rawHeight={lines.length}
    />
  )
}
