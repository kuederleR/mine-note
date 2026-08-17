import { weekendBounds } from './reminders.js'

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

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^\d{2}:\d{2}$/
const OFFSET = /^UTC[+-]\d{2}:\d{2}$/
const TIMES = new Set(['night', 'morning', 'afternoon', 'evening'])

function str(value: unknown, max = 80): string {
  const text = String(value ?? '').trim()
  return text.slice(0, max)
}

export function sanitizeWorld(raw: unknown): WorldSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  const date = str(src.date, 10)
  const today = str(src.today, 10) || date
  if (!DATE.test(date) || !DATE.test(today)) return null
  const time = TIME.test(str(src.time, 5)) ? str(src.time, 5) : '00:00'
  const hour = Number(src.hour)
  const timeOfDay = TIMES.has(String(src.timeOfDay))
    ? (src.timeOfDay as WorldSnapshot['timeOfDay'])
    : 'morning'
  const languages = Array.isArray(src.languages)
    ? src.languages.map((item) => str(item, 16)).filter(Boolean).slice(0, 5)
    : []
  return {
    now: str(src.now, 80) || `${today} ${time}`,
    date,
    time,
    weekday: str(src.weekday, 16),
    timeZone: str(src.timeZone, 64) || 'UTC',
    utcOffset: OFFSET.test(str(src.utcOffset, 12)) ? str(src.utcOffset, 12) : 'UTC+00:00',
    locale: str(src.locale, 16) || 'en-US',
    languages,
    today,
    tomorrow: DATE.test(str(src.tomorrow, 10)) ? str(src.tomorrow, 10) : today,
    yesterday: DATE.test(str(src.yesterday, 10)) ? str(src.yesterday, 10) : today,
    weekStart: DATE.test(str(src.weekStart, 10)) ? str(src.weekStart, 10) : today,
    weekEnd: DATE.test(str(src.weekEnd, 10)) ? str(src.weekEnd, 10) : today,
    month: str(src.month, 7) || today.slice(0, 7),
    year: str(src.year, 4) || today.slice(0, 4),
    timeOfDay,
    hour: Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.round(hour))) : 0,
  }
}

export function formatWorldPrompt(world: WorldSnapshot): string {
  return [
    'World context from the user\'s browser (use for now/today/timezone/locale; do not invent other world facts):',
    `Local now: ${world.now}`,
    `Timezone: ${world.timeZone} (${world.utcOffset})`,
    `Today: ${world.today} (${world.weekday})`,
    `Time: ${world.time} (${world.timeOfDay})`,
    `Yesterday: ${world.yesterday}`,
    `Tomorrow: ${world.tomorrow}`,
    `This week: ${world.weekStart} to ${world.weekEnd}`,
    `This month: ${world.month}`,
    `Locale: ${world.locale}${world.languages.length ? ` (${world.languages.join(', ')})` : ''}`,
  ].join('\n')
}

export function worldOnlyAnswer(world: WorldSnapshot): {
  text: string
  bullets: string[]
} {
  return {
    text: `It's ${world.now} in ${world.timeZone} (${world.utcOffset}).`,
    bullets: [
      `Today is ${world.today}, ${world.weekday}.`,
      `This week is ${world.weekStart} to ${world.weekEnd}.`,
      `Locale ${world.locale}.`,
    ],
  }
}

const WORLD_QUESTION =
  /^(what(?:'s| is) (?:the )?(?:date|time|day|today)|what time is it|what day is it|what date is it|current (?:date|time)|world context)?$/i

export function isWorldQuestion(query: string): boolean {
  const q = query.trim()
  if (!q) return true
  return WORLD_QUESTION.test(q)
}

export function expandQueryWithWorld(query: string, world: WorldSnapshot): string {
  const extras = [world.today, world.weekday]
  if (/\btomorrow\b/i.test(query)) extras.push(world.tomorrow)
  if (/\byesterday\b/i.test(query)) extras.push(world.yesterday)
  if (/\bthis week\b/i.test(query)) extras.push(world.weekStart, world.weekEnd)
  if (/\bthis weekend\b/i.test(query) || /\b(saturday|sunday)\b/i.test(query)) {
    const weekend = weekendBounds(world.today)
    extras.push(weekend.weekendStart, weekend.weekendEnd)
  }
  if (/\bthis month\b/i.test(query)) extras.push(world.month)
  const seen = new Set(query.toLowerCase().split(/\s+/))
  const add = extras.filter((item) => item && !seen.has(item.toLowerCase()))
  return add.length ? `${query} ${add.join(' ')}` : query
}
