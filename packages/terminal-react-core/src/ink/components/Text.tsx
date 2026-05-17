import type { ReactNode } from 'react'
import type { Color, Styles, TextStyles } from '../styles.js'

type BaseProps = {
  readonly color?: Color
  readonly backgroundColor?: Color
  readonly italic?: boolean
  readonly underline?: boolean
  readonly strikethrough?: boolean
  readonly inverse?: boolean
  readonly wrap?: Styles['textWrap']
  readonly children?: ReactNode
}

type WeightProps =
  | { bold?: never; dim?: never }
  | { bold: boolean; dim?: never }
  | { dim: boolean; bold?: never }

export type Props = BaseProps & WeightProps

const memoizedStylesForWrap: Record<NonNullable<Styles['textWrap']>, Styles> = {
  wrap: { flexGrow: 0, flexShrink: 1, flexDirection: 'row', textWrap: 'wrap' },
  'wrap-trim': {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'wrap-trim',
  },
  end: { flexGrow: 0, flexShrink: 1, flexDirection: 'row', textWrap: 'end' },
  middle: {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'middle',
  },
  'truncate-end': {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'truncate-end',
  },
  truncate: {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'truncate',
  },
  'truncate-middle': {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'truncate-middle',
  },
  'truncate-start': {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'truncate-start',
  },
}

export default function Text({
  color,
  backgroundColor,
  bold,
  dim,
  italic = false,
  underline = false,
  strikethrough = false,
  inverse = false,
  wrap = 'wrap',
  children,
}: Props): ReactNode {
  if (children === undefined || children === null) {
    return null
  }

  const textStyles: TextStyles = {
    ...(color && { color }),
    ...(backgroundColor && { backgroundColor }),
    ...(dim && { dim }),
    ...(bold && { bold }),
    ...(italic && { italic }),
    ...(underline && { underline }),
    ...(strikethrough && { strikethrough }),
    ...(inverse && { inverse }),
  }

  return (
    <ink-text style={memoizedStylesForWrap[wrap]} textStyles={textStyles}>
      {children}
    </ink-text>
  )
}
