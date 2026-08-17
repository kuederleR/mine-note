export type WorldSnapshot = {
  now: string
  date: string
  time: string
  weekday: string
  timeZone: string
  utcOffset: string
  locale: string
  languages: string[]
  today: string
  tomorrow: string
  yesterday: string
  weekStart: string
  weekEnd: string
  month: string
  year: string
  timeOfDay: 'night' | 'morning' | 'afternoon' | 'evening'
  hour: number
}

export type ChatSlashTrigger = {
  from: number
  to: number
  query: string
}

export type ChatSlashCommand = {
  id: string
  token: string
  title: string
  hint: string
  keywords: string[]
}

export const CHAT_SLASH_COMMANDS: ChatSlashCommand[] = [
  {
    id: 'world',
    token: '/world',
    title: 'World',
    hint: 'Local date, time, timezone',
    keywords: ['world', 'date', 'time', 'today', 'timezone', 'now'],
  },
]

const WORLD_TOKEN = /(?:^|\s)\/world(?=\s|$)/gi

const TEMPORAL_RE =
  /\b(today|tonight|tomorrow|yesterday|this (week|weekend|morning|afternoon|evening|month|year)|right now|current (date|time)|what time|what day|what date|overdue|due (today|this|tomorrow)|as of now|\bnow\b)\b/i

export function findChatSlashTrigger(text: string, caret: number): ChatSlashTrigger | null {
  const left = text.slice(0, Math.max(0, caret))
  const slashAt = left.lastIndexOf('/')
  if (slashAt < 0) return null
  if (slashAt > 0 && left[slashAt - 1] === ':') return null
  if (slashAt > 0 && !/\s/.test(left[slashAt - 1] || '')) return null
  const token = left.slice(slashAt + 1)
  if (!/^[a-z]*$/i.test(token)) return null
  return { from: slashAt, to: caret, query: token }
}

export function filterChatSlashCommands(query: string): ChatSlashCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return CHAT_SLASH_COMMANDS
  return CHAT_SLASH_COMMANDS.filter((cmd) => {
    if (cmd.token.slice(1).startsWith(q) || cmd.title.toLowerCase().startsWith(q)) return true
    return cmd.keywords.some((word) => word.startsWith(q) || word.includes(q))
  })
}

export function insertChatSlashCommand(text: string, trigger: ChatSlashTrigger, token: string): string {
  const before = text.slice(0, trigger.from)
  const after = text.slice(trigger.to).replace(/^\s*/, '')
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  return `${before}${lead}${token}${after ? ` ${after}` : ' '}`
}

export function parseWorldCommand(raw: string): { query: string; requested: boolean } {
  const text = raw.replace(/\r\n/g, '\n')
  const requested = WORLD_TOKEN.test(text)
  WORLD_TOKEN.lastIndex = 0
  const query = text.replace(WORLD_TOKEN, ' ').replace(/\s+/g, ' ').trim()
  return { query, requested }
}

export function looksTemporal(query: string): boolean {
  return TEMPORAL_RE.test(query)
}

export function shouldIncludeWorld(raw: string): boolean {
  const parsed = parseWorldCommand(raw)
  return parsed.requested || looksTemporal(parsed.query)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function civilDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return civilDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
}

function weekdayUtc(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

function startOfWeek(iso: string, firstDay: number): string {
  const dow = weekdayUtc(iso)
  const isoDow = dow === 0 ? 7 : dow
  const first = firstDay === 7 ? 7 : firstDay || 1
  return addDays(iso, -((isoDow - first + 7) % 7))
}

function timeOfDay(hour: number): WorldSnapshot['timeOfDay'] {
  if (hour < 5 || hour >= 21) return 'night'
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  return 'evening'
}

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-'
  const abs = Math.abs(minutes)
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

function localeDateParts(now: Date, timeZone: string, locale: string) {
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || ''
  const year = Number(get('year'))
  const month = Number(get('month'))
  const day = Number(get('day'))
  const hour = Number(get('hour'))
  const minute = Number(get('minute'))
  return { year, month, day, hour, minute, weekday: get('weekday') }
}

export function collectWorldSnapshot(now = new Date()): WorldSnapshot {
  const locale =
    (typeof navigator !== 'undefined' && (navigator.language || navigator.languages?.[0])) || 'en-US'
  const languages =
    typeof navigator !== 'undefined' && navigator.languages?.length
      ? [...navigator.languages]
      : [locale]
  const timeZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const parts = localeDateParts(now, timeZone, locale)
  const date = civilDate(parts.year, parts.month, parts.day)
  let firstDay = 1
  try {
    const info = (new Intl.Locale(locale) as Intl.Locale & { weekInfo?: { firstDay?: number } }).weekInfo
    if (info?.firstDay) firstDay = info.firstDay
  } catch {
    /* keep Monday */
  }
  const weekStart = startOfWeek(date, firstDay)
  const offsetMinutes = -now.getTimezoneOffset()
  const display = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(now)
  return {
    now: display,
    date,
    time: `${pad(parts.hour)}:${pad(parts.minute)}`,
    weekday: parts.weekday,
    timeZone,
    utcOffset: formatOffset(offsetMinutes),
    locale,
    languages: languages.slice(0, 5),
    today: date,
    tomorrow: addDays(date, 1),
    yesterday: addDays(date, -1),
    weekStart,
    weekEnd: addDays(weekStart, 6),
    month: `${parts.year}-${pad(parts.month)}`,
    year: String(parts.year),
    timeOfDay: timeOfDay(parts.hour),
    hour: parts.hour,
  }
}

export function formatWorldHint(world: WorldSnapshot): string {
  return `${world.now} · ${world.timeZone} (${world.utcOffset})`
}
