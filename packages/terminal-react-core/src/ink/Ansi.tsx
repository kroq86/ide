import React, { type ReactNode } from 'react'
import Link from './components/Link.js'
import Text from './components/Text.js'
import type { Color } from './styles.js'
import {
  type Color as TermioColor,
  type NamedColor,
  Parser,
  type TextStyle,
} from './termio.js'

type Props = {
  children: string
  dimColor?: boolean
}

type SpanProps = {
  color?: Color
  backgroundColor?: Color
  dim?: boolean
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  inverse?: boolean
  hyperlink?: string
}

type Span = {
  text: string
  props: SpanProps
}

export const Ansi = React.memo(function Ansi({
  children,
  dimColor,
}: Props): ReactNode {
  if (typeof children !== 'string') {
    return dimColor ? <Text dim>{String(children)}</Text> : <Text>{String(children)}</Text>
  }

  if (children === '') {
    return null
  }

  const spans = parseToSpans(children)

  if (spans.length === 0) {
    return null
  }

  if (spans.length === 1 && !hasAnyProps(spans[0]!.props)) {
    return dimColor ? <Text dim>{spans[0]!.text}</Text> : <Text>{spans[0]!.text}</Text>
  }

  const content = spans.map((rawSpan, index) => {
    const span = {
      text: rawSpan.text,
      props: { ...rawSpan.props, ...(dimColor ? { dim: true } : {}) },
    }
    const hyperlink = span.props.hyperlink
    const hasTextProps = hasAnyTextProps(span.props)

    if (hyperlink) {
      return hasTextProps ? (
        <Link key={index} url={hyperlink}>
          <StyledText {...span.props}>{span.text}</StyledText>
        </Link>
      ) : (
        <Link key={index} url={hyperlink}>
          {span.text}
        </Link>
      )
    }

    return hasTextProps ? (
      <StyledText key={index} {...span.props}>
        {span.text}
      </StyledText>
    ) : (
      span.text
    )
  })

  return dimColor ? <Text dim>{content}</Text> : <Text>{content}</Text>
})

function parseToSpans(input: string): Span[] {
  const parser = new Parser()
  const actions = parser.feed(input)
  const spans: Span[] = []

  let currentHyperlink: string | undefined

  for (const action of actions) {
    if (action.type === 'link') {
      currentHyperlink =
        action.action.type === 'start' ? action.action.url : undefined
      continue
    }

    if (action.type !== 'text') {
      continue
    }

    const text = action.graphemes.map(grapheme => grapheme.value).join('')
    if (!text) {
      continue
    }

    const props = textStyleToSpanProps(action.style)
    if (currentHyperlink) {
      props.hyperlink = currentHyperlink
    }

    const lastSpan = spans[spans.length - 1]
    if (lastSpan && propsEqual(lastSpan.props, props)) {
      lastSpan.text += text
      continue
    }

    spans.push({ text, props })
  }

  return spans
}

function textStyleToSpanProps(style: TextStyle): SpanProps {
  const props: SpanProps = {}

  if (style.bold) props.bold = true
  if (style.dim) props.dim = true
  if (style.italic) props.italic = true
  if (style.underline !== 'none') props.underline = true
  if (style.strikethrough) props.strikethrough = true
  if (style.inverse) props.inverse = true

  const fgColor = colorToString(style.fg)
  if (fgColor) props.color = fgColor

  const bgColor = colorToString(style.bg)
  if (bgColor) props.backgroundColor = bgColor

  return props
}

const NAMED_COLOR_MAP: Record<NamedColor, string> = {
  black: 'ansi:black',
  red: 'ansi:red',
  green: 'ansi:green',
  yellow: 'ansi:yellow',
  blue: 'ansi:blue',
  magenta: 'ansi:magenta',
  cyan: 'ansi:cyan',
  white: 'ansi:white',
  brightBlack: 'ansi:blackBright',
  brightRed: 'ansi:redBright',
  brightGreen: 'ansi:greenBright',
  brightYellow: 'ansi:yellowBright',
  brightBlue: 'ansi:blueBright',
  brightMagenta: 'ansi:magentaBright',
  brightCyan: 'ansi:cyanBright',
  brightWhite: 'ansi:whiteBright',
}

function colorToString(color: TermioColor): Color | undefined {
  switch (color.type) {
    case 'named':
      return NAMED_COLOR_MAP[color.name] as Color
    case 'indexed':
      return `ansi256(${color.index})` as Color
    case 'rgb':
      return `rgb(${color.r},${color.g},${color.b})` as Color
    case 'default':
      return undefined
  }
}

function propsEqual(a: SpanProps, b: SpanProps): boolean {
  return (
    a.color === b.color &&
    a.backgroundColor === b.backgroundColor &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strikethrough === b.strikethrough &&
    a.inverse === b.inverse &&
    a.hyperlink === b.hyperlink
  )
}

function hasAnyProps(props: SpanProps): boolean {
  return (
    props.color !== undefined ||
    props.backgroundColor !== undefined ||
    props.dim === true ||
    props.bold === true ||
    props.italic === true ||
    props.underline === true ||
    props.strikethrough === true ||
    props.inverse === true ||
    props.hyperlink !== undefined
  )
}

function hasAnyTextProps(props: SpanProps): boolean {
  return (
    props.color !== undefined ||
    props.backgroundColor !== undefined ||
    props.dim === true ||
    props.bold === true ||
    props.italic === true ||
    props.underline === true ||
    props.strikethrough === true ||
    props.inverse === true
  )
}

type BaseTextStyleProps = {
  color?: Color
  backgroundColor?: Color
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  inverse?: boolean
}

function StyledText({
  bold,
  dim,
  children,
  ...rest
}: BaseTextStyleProps & {
  bold?: boolean
  dim?: boolean
  children: ReactNode
}) {
  if (dim) {
    return (
      <Text {...rest} dim>
        {children}
      </Text>
    )
  }

  if (bold) {
    return (
      <Text {...rest} bold>
        {children}
      </Text>
    )
  }

  return <Text {...rest}>{children}</Text>
}
