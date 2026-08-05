import enUS from './en-US'

type LocaleObject = Record<string, unknown>

function merge(base: LocaleObject, override: LocaleObject): LocaleObject {
  const result: LocaleObject = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const baseValue = base[key]
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      && baseValue && typeof baseValue === 'object' && !Array.isArray(baseValue)
      ? merge(baseValue as LocaleObject, value as LocaleObject)
      : value
  }
  return result
}

/** Build a complete locale while keeping English as the fallback for newly added keys. */
export function createLocale(override: LocaleObject): typeof enUS {
  return merge(enUS as LocaleObject, override) as typeof enUS
}
