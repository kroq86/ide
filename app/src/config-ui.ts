export type ConfigPromptType = 'configPick' | 'configInput' | 'configConfirm'

export function isConfigPromptType(type: string): type is ConfigPromptType {
  return type === 'configPick' || type === 'configInput' || type === 'configConfirm'
}

export function configPromptCancelValue(type: ConfigPromptType): null | false {
  return type === 'configConfirm' ? false : null
}
