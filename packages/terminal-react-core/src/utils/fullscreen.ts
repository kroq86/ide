import { isEnvTruthy } from './envUtils.js'

export function isMouseClicksDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS)
}
