import {
  isConfigAction,
  type ConfigAction,
  type ConfigActionResult,
  type ConfigCommand,
  type ConfigDirective,
  type EditorContext,
  type QeConfig,
} from './config.js'

export type CommandHandler = (ctx: EditorContext, args?: Record<string, unknown>) => ConfigActionResult

export type RegisteredCommand = {
  id: string
  label: string
  run: CommandHandler
}

export class CommandRegistry {
  #commands = new Map<string, RegisteredCommand>()

  register(id: string, label: string, run: CommandHandler): void {
    // User config intentionally uses the same registry as built-ins: last registration wins.
    this.#commands.set(id, { id, label, run })
  }

  has(id: string): boolean {
    return this.#commands.has(id)
  }

  list(): RegisteredCommand[] {
    return [...this.#commands.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  async run(id: string, ctx: EditorContext, args?: Record<string, unknown>): Promise<void> {
    const command = this.#commands.get(id)
    if (!command) {
      ctx.ui.notify(`unknown command: ${id}`, 'error')
      return
    }
    await executeActionResult(command.run(ctx, args), ctx, this)
  }
}

export function registerCommandActions(
  commands: Record<string, ConfigAction>,
  registry: CommandRegistry,
): string[] {
  const ids: string[] = []
  for (const [id, action] of Object.entries(commands)) {
    if (!isConfigAction(action)) continue
    const label = commandLabel(action) ?? id
    registry.register(id, label, async (ctx) => {
      await runConfigAction(action, ctx, registry)
    })
    ids.push(id)
  }
  return ids
}

export function registerConfigCommands(config: QeConfig, registry: CommandRegistry): void {
  registerCommandActions(config.commands ?? {}, registry)
}

export async function runConfigAction(
  action: ConfigAction,
  ctx: EditorContext,
  registry: CommandRegistry,
): Promise<void> {
  if (typeof action === 'function') {
    await executeActionResult(action(ctx), ctx, registry)
    return
  }
  if (typeof action === 'string') {
    await registry.run(action, ctx)
    return
  }
  if (Array.isArray(action)) {
    await executeDirectives(action, ctx, registry)
    return
  }
  if (isCommandInvocation(action)) {
    await registry.run(action.command, ctx, action.args)
    return
  }
  await executeDirective(action, ctx, registry)
}

export async function executeActionResult(
  result: ConfigActionResult,
  ctx: EditorContext,
  registry: CommandRegistry,
): Promise<void> {
  const resolved = await result
  if (!resolved || typeof resolved !== 'object') return
  if (Array.isArray(resolved)) {
    await executeDirectives(resolved, ctx, registry)
  } else {
    await executeDirective(resolved, ctx, registry)
  }
}

export async function executeDirectives(
  directives: ConfigDirective[],
  ctx: EditorContext,
  registry: CommandRegistry,
): Promise<void> {
  for (const directive of directives) {
    await executeDirective(directive, ctx, registry)
  }
}

export async function executeDirective(
  directive: ConfigDirective,
  ctx: EditorContext,
  registry: CommandRegistry,
): Promise<void> {
  switch (directive.type) {
    case 'shell.run':
      ctx.shell.run(directive.command)
      break
    case 'panel.open':
      ctx.ui.panel(directive.panel, directive.options)
      break
    case 'openFile':
      ctx.openFile(
        directive.path,
        typeof directive.row === 'number'
          ? { row: directive.row, col: typeof directive.col === 'number' ? directive.col : 0 }
          : undefined,
      )
      break
    case 'editor.insert':
      ctx.insert(directive.text)
      break
    case 'editor.move':
      ctx.move(directive.direction)
      break
    case 'command.run':
      await registry.run(directive.command, ctx, directive.args)
      break
    case 'ui.notify':
      ctx.ui.notify(directive.message, directive.level)
      break
    case 'ui.splash':
      ctx.ui.splash({
        title: directive.title,
        message: directive.message,
        hint: directive.hint,
      })
      break
    default: {
      const unknownType = String((directive as { type?: unknown }).type)
      ctx.ui.notify(`unknown directive: ${unknownType}`, 'error')
      break
    }
  }
}

function isCommandInvocation(value: ConfigAction): value is ConfigCommand {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && !('type' in value)
    && 'command' in value
    && typeof (value as ConfigCommand).command === 'string',
  )
}

function commandLabel(value: ConfigAction): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return 'label' in value && typeof value.label === 'string' ? value.label : null
}
