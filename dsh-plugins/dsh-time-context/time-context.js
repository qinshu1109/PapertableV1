/**
 * dsh-time-context — pure logic: config validation and current-time
 * formatting. No Cordis imports, so the module unit-tests without a harness
 * install; `index.js` owns the plugin wiring.
 *
 * The runtime-context text is a pure function of the instant and the
 * validated config, and only changes at bucket boundaries (see
 * `formatCurrentTime`), which keeps the harness's change-only append cheap.
 *
 * @module dsh-time-context/time-context
 */

/** Fail-loud config error prefix shared by every validation throw. */
export const BAD = 'dsh-time-context: invalid config —'

/** Default refresh granularity: the injected text changes at most once a minute. */
export const DEFAULT_REFRESH_SECONDS = 60

/** Default system-prompt section order (tool-guidance band 100–199). */
export const DEFAULT_SECTION_ORDER = 160

/** Default runtime-context order (joined in ascending order, near the front). */
export const DEFAULT_CONTEXT_ORDER = 10

/** Injected runtime-context text label. */
export const CONTEXT_LABEL = '当前时间：'

/** Short relative-time rule injected as a stable system-prompt section. */
export const RELATIVE_TIME_RULE =
  '涉及“今天/昨天/到期/几天没动”等相对时间时，以注入的当前时间为准现算，禁止凭训练数据猜日期。'

/** Allowed config keys (typo protection: a misspelled key must not silently fall back to a default). */
export const CONFIG_KEYS = ['refreshSeconds', 'timezone', 'sectionOrder', 'contextOrder']

/**
 * Throw unless `value` is a plain object (not null, not an array).
 * @param {unknown} value - candidate config value.
 * @returns {Record<string, unknown>} the value, narrowed.
 */
function requireObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${BAD} config must be an object`)
  }
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * The process-local IANA timezone name (e.g. `Asia/Shanghai`).
 * @returns {string} resolved system timezone.
 */
export function systemTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * Throw when `name` is not a valid IANA timezone; the platform `RangeError`
 * for an unknown name is normalized to the plugin's config error prefix.
 * @param {unknown} name - candidate timezone.
 * @returns {string} the validated timezone.
 */
function requireTimezone(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`${BAD} timezone must be a non-empty IANA timezone name`)
  }
  const timezone = name.trim()
  try {
    // Constructing with an unknown IANA name throws RangeError.
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone })
  } catch {
    throw new Error(`${BAD} timezone "${timezone}" is not a valid IANA timezone`)
  }
  return timezone
}

/**
 * Validate raw plugin config into its normalized form. Unknown keys throw
 * (typo protection); defaults fill missing fields; `refreshSeconds` must be a
 * positive integer; `timezone` defaults to the system timezone.
 * @param {unknown} raw - raw row config from cordis.yml.
 * @returns {{refreshSeconds: number, timezone: string, sectionOrder: number, contextOrder: number}} normalized config.
 */
export function validateConfig(raw) {
  const record = requireObject(raw)
  for (const key of Object.keys(record)) {
    if (!CONFIG_KEYS.includes(key)) {
      throw new Error(`${BAD} unknown key "${key}" (allowed: ${CONFIG_KEYS.join(', ')})`)
    }
  }
  const refreshSeconds = record.refreshSeconds === undefined
    ? DEFAULT_REFRESH_SECONDS
    : record.refreshSeconds
  if (!Number.isInteger(refreshSeconds) || refreshSeconds <= 0) {
    throw new Error(`${BAD} refreshSeconds must be a positive integer`)
  }
  const timezone = record.timezone === undefined || record.timezone === ''
    ? systemTimezone()
    : requireTimezone(record.timezone)
  const sectionOrder = record.sectionOrder === undefined
    ? DEFAULT_SECTION_ORDER
    : record.sectionOrder
  if (typeof sectionOrder !== 'number' || !Number.isFinite(sectionOrder)) {
    throw new Error(`${BAD} sectionOrder must be a finite number`)
  }
  const contextOrder = record.contextOrder === undefined
    ? DEFAULT_CONTEXT_ORDER
    : record.contextOrder
  if (typeof contextOrder !== 'number' || !Number.isFinite(contextOrder)) {
    throw new Error(`${BAD} contextOrder must be a finite number`)
  }
  return { refreshSeconds, timezone, sectionOrder, contextOrder }
}

/** DateTime formatters cached per timezone (formatting runs per assembly). */
const formatterCache = new Map()

/**
 * Formatters for one timezone: `date` = YYYY-MM-DD, `time` = HH:mm:ss,
 * `weekday` = Chinese short weekday (周一..周日).
 * @param {string} timezone - IANA timezone.
 * @returns {{date: Intl.DateTimeFormat, time: Intl.DateTimeFormat, weekday: Intl.DateTimeFormat}} cached formatters.
 */
function formattersFor(timezone) {
  let cached = formatterCache.get(timezone)
  if (cached === undefined) {
    cached = {
      date: new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }),
      time: new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }),
      weekday: new Intl.DateTimeFormat('zh-CN', {
        timeZone: timezone,
        weekday: 'short',
      }),
    }
    formatterCache.set(timezone, cached)
  }
  return cached
}

/**
 * Format one instant as the injected runtime-context line, e.g.
 * `当前时间：2026-08-14 周五 08:15（Asia/Shanghai）`.
 *
 * Granularity contract: the instant is floored to the `refreshSeconds` bucket
 * and rendered at the matching precision, so the returned text is byte-identical
 * for every instant inside one bucket and changes at most once per bucket:
 * - refreshSeconds < 60 → second precision (`08:15:30`);
 * - 60 ≤ refreshSeconds < 3600 → minute precision (`08:15`);
 * - refreshSeconds ≥ 3600 → hour precision (`08 时`).
 * The displayed value is the floored instant, so it may lag real time by up
 * to one bucket (the KV-cache cost of a coarser granularity).
 *
 * @param {Date} date - the instant to render (bucketed internally).
 * @param {{refreshSeconds: number, timezone: string}} config - normalized config fields used by formatting.
 * @returns {string} the runtime-context line.
 */
export function formatCurrentTime(date, config) {
  const bucketMs = config.refreshSeconds * 1000
  const floored = new Date(Math.floor(date.getTime() / bucketMs) * bucketMs)
  const formatters = formattersFor(config.timezone)
  const dateText = formatters.date.format(floored)
  const timeText = formatters.time.format(floored)
  const weekdayText = formatters.weekday.format(floored)
  const time = config.refreshSeconds < 60
    ? timeText
    : config.refreshSeconds < 3600
      ? timeText.slice(0, 5)
      : `${timeText.slice(0, 2)} 时`
  return `${CONTEXT_LABEL}${dateText} ${weekdayText} ${time}（${config.timezone}）`
}
