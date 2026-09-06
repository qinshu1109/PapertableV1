/**
 * dsh-time-context unit tests: config validation, runtime-context formatting,
 * granularity bucketing, and timezone handling. Pure logic only — no harness.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BAD,
  DEFAULT_CONTEXT_ORDER,
  DEFAULT_REFRESH_SECONDS,
  DEFAULT_SECTION_ORDER,
  CONTEXT_LABEL,
  RELATIVE_TIME_RULE,
  formatCurrentTime,
  systemTimezone,
  validateConfig,
} from '../time-context.js'

/** Fixed instant: 2026-08-14 08:15:30 in Asia/Shanghai (= 00:15:30Z). */
const SHANGHAI_08_15 = new Date('2026-08-14T00:15:30.000Z')

// ---------------------------------------------------------------------------
// 配置校验
// ---------------------------------------------------------------------------

test('配置：默认值（分钟级、系统时区、默认 order）', () => {
  const cfg = validateConfig({})
  assert.equal(cfg.refreshSeconds, DEFAULT_REFRESH_SECONDS)
  assert.equal(cfg.timezone, systemTimezone())
  assert.equal(cfg.sectionOrder, DEFAULT_SECTION_ORDER)
  assert.equal(cfg.contextOrder, DEFAULT_CONTEXT_ORDER)
})

test('配置：未知键 fail loud（拼写保护）', () => {
  assert.throws(() => validateConfig({ refreshSecconds: 60 }), new RegExp(`${BAD} unknown key "refreshSecconds"`))
  assert.throws(() => validateConfig({ timeZone: 'UTC' }), new RegExp(`${BAD} unknown key "timeZone"`))
})

test('配置：refreshSeconds 必须为正整数（0/负数/小数/字符串均拒）', () => {
  for (const bad of [0, -1, 1.5, '60', null, true]) {
    assert.throws(() => validateConfig({ refreshSeconds: bad }), new RegExp('refreshSeconds must be a positive integer'), `bad value: ${String(bad)}`)
  }
})

test('配置：时区非法 fail loud；空串回退系统时区', () => {
  assert.throws(() => validateConfig({ timezone: 'Mars/Olympus' }), new RegExp('not a valid IANA timezone'))
  assert.throws(() => validateConfig({ timezone: 42 }), new RegExp('timezone must be a non-empty IANA timezone name'))
  assert.equal(validateConfig({ timezone: '' }).timezone, systemTimezone())
})

test('配置：sectionOrder/contextOrder 必须为有限数', () => {
  assert.throws(() => validateConfig({ sectionOrder: 'high' }), new RegExp('sectionOrder must be a finite number'))
  assert.throws(() => validateConfig({ contextOrder: Infinity }), new RegExp('contextOrder must be a finite number'))
})

test('配置：非对象 config fail loud', () => {
  assert.throws(() => validateConfig(null), new RegExp(`${BAD} config must be an object`))
  assert.throws(() => validateConfig([]), new RegExp(`${BAD} config must be an object`))
})

// ---------------------------------------------------------------------------
// 注入内容格式
// ---------------------------------------------------------------------------

test('格式：分钟级默认输出与简报样张逐字一致', () => {
  const cfg = validateConfig({ refreshSeconds: 60, timezone: 'Asia/Shanghai' })
  assert.equal(
    formatCurrentTime(SHANGHAI_08_15, cfg),
    '当前时间：2026-08-14 周五 08:15（Asia/Shanghai）',
  )
})

test('格式：周几为中文短星期（周一..周日），跨一周映射正确', () => {
  const cfg = validateConfig({ refreshSeconds: 60, timezone: 'UTC' })
  // 2026-08-10（周一）.. 2026-08-16（周日），均取 UTC 正午避免日界
  const week = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
  for (let index = 0; index < 7; index += 1) {
    const day = new Date(Date.UTC(2026, 7, 10 + index, 12))
    assert.ok(formatCurrentTime(day, cfg).includes(` ${week[index]} `), `day ${index} should be ${week[index]}`)
  }
})

test('格式：粒度决定精度——<60s 秒级、60–3599s 分钟级、≥3600s 小时级', () => {
  const second = validateConfig({ refreshSeconds: 30, timezone: 'Asia/Shanghai' })
  const minute = validateConfig({ refreshSeconds: 60, timezone: 'Asia/Shanghai' })
  const hour = validateConfig({ refreshSeconds: 3600, timezone: 'Asia/Shanghai' })
  assert.equal(formatCurrentTime(SHANGHAI_08_15, second), '当前时间：2026-08-14 周五 08:15:30（Asia/Shanghai）')
  assert.equal(formatCurrentTime(SHANGHAI_08_15, minute), '当前时间：2026-08-14 周五 08:15（Asia/Shanghai）')
  assert.equal(formatCurrentTime(SHANGHAI_08_15, hour), '当前时间：2026-08-14 周五 08 时（Asia/Shanghai）')
})

test('格式：时区配置改变本地时间与日期（同日跨时区、跨日边界）', () => {
  const utc = validateConfig({ refreshSeconds: 60, timezone: 'UTC' })
  const shanghai = validateConfig({ refreshSeconds: 60, timezone: 'Asia/Shanghai' })
  const newYork = validateConfig({ refreshSeconds: 60, timezone: 'America/New_York' })
  assert.equal(formatCurrentTime(SHANGHAI_08_15, utc), '当前时间：2026-08-14 周五 00:15（UTC）')
  assert.equal(formatCurrentTime(SHANGHAI_08_15, shanghai), '当前时间：2026-08-14 周五 08:15（Asia/Shanghai）')
  // 纽约是前一天：时区换算含日期与周几的联动
  assert.equal(formatCurrentTime(SHANGHAI_08_15, newYork), '当前时间：2026-08-13 周四 20:15（America/New_York）')
})

test('格式：标签与规矩文本为中文、零业务词汇', () => {
  assert.equal(CONTEXT_LABEL, '当前时间：')
  assert.match(RELATIVE_TIME_RULE, /涉及“今天\/昨天\/到期\/几天没动”等相对时间时，以注入的当前时间为准现算，禁止凭训练数据猜日期。/)
  // 零业务词汇：不得出现押注/判决/金子/墓碑等镇纸业务词
  for (const word of ['押注', '判决', '金子', '墓碑', '筛子', '捞料']) {
    assert.ok(!RELATIVE_TIME_RULE.includes(word), `规矩文本不得含业务词「${word}」`)
  }
})

// ---------------------------------------------------------------------------
// 刷新粒度（桶内稳定、跨桶变化）
// ---------------------------------------------------------------------------

test('粒度：同一刷新桶内文本逐字稳定，跨桶才变化（KV-cache 友好）', () => {
  // 60s 桶：同一分钟内两个时刻 → 同一文本；跨分钟 → 变化
  const minute = validateConfig({ refreshSeconds: 60, timezone: 'Asia/Shanghai' })
  const a = formatCurrentTime(new Date('2026-08-14T00:15:10.000Z'), minute)
  const b = formatCurrentTime(new Date('2026-08-14T00:15:59.000Z'), minute)
  const c = formatCurrentTime(new Date('2026-08-14T00:16:00.000Z'), minute)
  assert.equal(a, b)
  assert.notEqual(a, c)
  // 1s 桶：相隔 2 秒 → 秒级文本前进（跨轮次时间戳前进的验收依据）
  const oneSecond = validateConfig({ refreshSeconds: 1, timezone: 'Asia/Shanghai' })
  const t1 = formatCurrentTime(new Date('2026-08-14T00:15:30.000Z'), oneSecond)
  const t2 = formatCurrentTime(new Date('2026-08-14T00:15:32.000Z'), oneSecond)
  assert.notEqual(t1, t2)
  assert.ok(t2.includes('08:15:32'), `t2 should carry the later second, got: ${t2}`)
})

test('粒度：显示时间被 floor 到刷新桶（滞后不超过一个桶）', () => {
  // 120s 桶：08:16:30 与 08:17:29 同属 08:16:00–08:17:59 桶 → 文本都是 08:16
  const twoMinutes = validateConfig({ refreshSeconds: 120, timezone: 'Asia/Shanghai' })
  const early = formatCurrentTime(new Date('2026-08-14T00:16:30.000Z'), twoMinutes)
  const late = formatCurrentTime(new Date('2026-08-14T00:17:29.000Z'), twoMinutes)
  const next = formatCurrentTime(new Date('2026-08-14T00:18:00.000Z'), twoMinutes)
  assert.equal(early, late)
  assert.ok(early.includes('08:16'), early)
  assert.ok(next.includes('08:18'), next)
})
