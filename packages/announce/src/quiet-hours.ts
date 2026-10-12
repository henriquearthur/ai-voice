import { DateTime, Option } from "effect"

export const ANNOUNCE_TIME_ZONE = "America/Sao_Paulo"

/** Minutes since local midnight; `start` is inclusive and `end` exclusive. */
export interface QuietHours {
  readonly start: number
  readonly end: number
}

const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/

const minutes = (value: string): Option.Option<number> => {
  const match = CLOCK.exec(value.trim())
  return match === null ? Option.none() : Option.some(Number(match[1]) * 60 + Number(match[2]))
}

/**
 * Parses "HH:MM-HH:MM". `Some(None)` means quiet hours are off ("off", "none"
 * or an empty value); `None` means the value is invalid.
 */
export const parseQuietHours = (value: string): Option.Option<Option.Option<QuietHours>> => {
  const trimmed = value.trim().toLowerCase()
  if (trimmed === "" || trimmed === "off" || trimmed === "none") return Option.some(Option.none())
  const [from, to, ...rest] = trimmed.split("-")
  if (from === undefined || to === undefined || rest.length > 0) return Option.none()
  return Option.zipWith(minutes(from), minutes(to), (start, end) => Option.some({ start, end }))
}

/** True inside the window, which may wrap past midnight (23:00-07:00). */
export const isQuietAt = (window: QuietHours, now: DateTime.DateTime, zone: DateTime.TimeZone): boolean => {
  const { hour, minute } = DateTime.toParts(DateTime.setZone(now, zone))
  const current = hour * 60 + minute
  if (window.start === window.end) return false
  return window.start < window.end
    ? current >= window.start && current < window.end
    : current >= window.start || current < window.end
}
