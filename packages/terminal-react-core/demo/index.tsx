import React from 'react'
import { Box, Text, render, useInput } from '../src/index.js'
import {
  actions,
  buildCommandPreview,
  type RunState,
  runVmbenchAction,
  VMBENCH_CLI,
  VMBENCH_ROOT,
} from './runVmbench.js'

function statusColor(state: RunState) {
  switch (state) {
    case 'running':
      return 'ansi:yellow'
    case 'success':
      return 'ansi:green'
    case 'error':
      return 'ansi:red'
    default:
      return 'ansi:white'
  }
}

function formatTime(timestamp: number | null): string {
  if (!timestamp) {
    return 'n/a'
  }

  return new Date(timestamp).toLocaleTimeString()
}

function formatDuration(
  startedAt: number | null,
  finishedAt: number | null,
): string {
  if (!startedAt || !finishedAt) {
    return 'n/a'
  }

  return `${finishedAt - startedAt}ms`
}

function DemoApp() {
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const [runState, setRunState] = React.useState<RunState>('idle')
  const [outputText, setOutputText] = React.useState(
    'Select an action and press Enter to run it.',
  )
  const [lastCommand, setLastCommand] = React.useState(buildCommandPreview(actions[0]!))
  const [lastRunStartedAt, setLastRunStartedAt] = React.useState<number | null>(null)
  const [lastRunFinishedAt, setLastRunFinishedAt] = React.useState<number | null>(null)
  const runTokenRef = React.useRef(0)

  const selectedAction = actions[selectedIndex]!

  const triggerRun = React.useCallback(async () => {
    if (runState === 'running') {
      return
    }

    const startedAt = Date.now()
    const token = runTokenRef.current + 1
    runTokenRef.current = token

    setRunState('running')
    setLastCommand(buildCommandPreview(selectedAction))
    setLastRunStartedAt(startedAt)
    setLastRunFinishedAt(null)
    setOutputText(`Running:\n${buildCommandPreview(selectedAction)}`)

    const result = await runVmbenchAction(selectedAction)

    if (runTokenRef.current !== token) {
      return
    }

    setLastCommand(result.commandPreview)
    setLastRunFinishedAt(Date.now())
    setRunState(result.ok ? 'success' : 'error')
    setOutputText(result.outputText)
  }, [runState, selectedAction])

  useInput((input, key) => {
    if (input === 'q' || key.escape || (key.ctrl && input === 'c')) {
      process.exit(0)
    }

    if (key.upArrow) {
      setSelectedIndex(current => Math.max(0, current - 1))
      return
    }

    if (key.downArrow) {
      setSelectedIndex(current => Math.min(actions.length - 1, current + 1))
      return
    }

    if (key.return || input === 'r') {
      void triggerRun()
      return
    }

    if (input === 'c') {
      if (runState === 'running') {
        return
      }

      setRunState('idle')
      setLastRunStartedAt(null)
      setLastRunFinishedAt(null)
      setLastCommand(buildCommandPreview(selectedAction))
      setOutputText('Result cleared. Press Enter to run the selected action.')
    }
  })

  React.useEffect(() => {
    if (runState !== 'running') {
      setLastCommand(buildCommandPreview(selectedAction))
    }
  }, [runState, selectedAction])

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="ansi:green">
        vmbench toolbox demo
      </Text>
      <Text dim>
        Real local vmbench operator UI backed by the CLI, not a mock screen.
      </Text>

      <Box flexDirection="row" marginTop={1} gap={1}>
        <Box
          width="34%"
          flexDirection="column"
          borderStyle="single"
          paddingX={1}
        >
          <Text bold>Actions</Text>
          <Text dim>Select a vmbench workflow.</Text>
          <Box flexDirection="column" marginTop={1}>
            {actions.map((action, index) => {
              const isSelected = index === selectedIndex
              return (
                <Text
                  key={action.id}
                  color={isSelected ? 'ansi:cyan' : undefined}
                >
                  {`${isSelected ? '>' : ' '} ${action.label.padEnd(8, ' ')} ${action.title}`}
                </Text>
              )
            })}
          </Box>
        </Box>

        <Box
          width="66%"
          flexDirection="column"
          borderStyle="single"
          paddingX={1}
        >
          <Text bold>{selectedAction.title}</Text>
          <Text>{selectedAction.description}</Text>

          <Box flexDirection="column" marginTop={1}>
            <Text bold>Command</Text>
            <Text color="ansi:yellow">{buildCommandPreview(selectedAction)}</Text>
          </Box>

          <Box flexDirection="row" marginTop={1} gap={3}>
            <Text>
              Status:{' '}
              <Text color={statusColor(runState)}>{runState}</Text>
            </Text>
            <Text>Started: {formatTime(lastRunStartedAt)}</Text>
            <Text>Finished: {formatTime(lastRunFinishedAt)}</Text>
            <Text>Duration: {formatDuration(lastRunStartedAt, lastRunFinishedAt)}</Text>
          </Box>

          <Box flexDirection="column" marginTop={1}>
            <Text bold>Last command</Text>
            <Text dim>{lastCommand}</Text>
          </Box>

          <Box flexDirection="column" marginTop={1}>
            <Text bold>Result</Text>
            <Box borderStyle="single" paddingX={1} marginTop={1}>
              <Text color={runState === 'error' ? 'ansi:red' : undefined}>
                {outputText}
              </Text>
            </Box>
          </Box>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dim>
          Up/Down move | Enter run | r rerun | c clear result | q quit
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text dim>{`vmbench root: ${VMBENCH_ROOT}`}</Text>
        <Text dim>{`cli path: ${VMBENCH_CLI}`}</Text>
      </Box>
    </Box>
  )
}

async function main() {
  await render(<DemoApp />)
}

void main()
