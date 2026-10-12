import { Schema } from "effect"
import { looksPortuguese } from "./portuguese.ts"
import { sanitize } from "./sanitize.ts"

export const MAX_ANNOUNCEMENT_LENGTH = 300

export const AnnounceEvent = Schema.Literals(["permission", "waiting", "finished", "error"])
export type AnnounceEvent = typeof AnnounceEvent.Type

/**
 * What a hook hands to `jarvis-voice announce`. `event` and `project` are
 * optional hints; without `event` the kind of notification is inferred from
 * the other fields (Claude Code sends them in English).
 */
export const AnnounceInput = Schema.Struct({
  source: Schema.String,
  title: Schema.optionalKey(Schema.String),
  body: Schema.String,
  event: Schema.optionalKey(AnnounceEvent),
  project: Schema.optionalKey(Schema.String)
})
export type AnnounceInput = typeof AnnounceInput.Type

export type ContentSkipReason = "empty" | "secret-only" | "non-portuguese" | "off-persona"

export type Composed =
  | { readonly _tag: "text"; readonly text: string }
  | { readonly _tag: "skip"; readonly reason: ContentSkipReason }

// Checked in order: "permission to continue after an error" is a permission request.
const EVENT_PATTERNS: ReadonlyArray<readonly [AnnounceEvent, RegExp]> = [
  ["permission", /permission|permiss[aã]o|approv|aprova|autoriza|allow|elicitation/i],
  ["error", /\berror|\bfail|\berro\b|falh|exception|crash/i],
  ["waiting", /waiting|wait for|your input|idle|attention|aguardando|esperando|sua resposta/i],
  ["finished", /finish|complet|\bdone\b|\bstop\b|terminou|conclu|pronto|succeed|success/i]
]

export const classifyEvent = (input: AnnounceInput): AnnounceEvent | undefined => {
  if (input.event !== undefined) return input.event
  const haystack = [input.source, input.title ?? "", input.body].join(" ")
  return EVENT_PATTERNS.find(([, pattern]) => pattern.test(haystack))?.[0]
}

// A project name is spoken as a proper noun, so it only needs to be safe and short.
const projectName = (project: string | undefined): string | undefined => {
  if (project === undefined) return undefined
  const { redactions, text } = sanitize(project)
  if (redactions > 0) return undefined
  const name = text.replace(/[_\-.]+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim()
  return name.length > 0 && name.length <= 40 && !OFF_PERSONA.test(name) ? name : undefined
}

// One voice, first person singular, like someone sitting next to you: never
// says who is talking, never names Claude, agents or sessions.
const TEMPLATES: Record<AnnounceEvent, (project: string | undefined) => string> = {
  permission: (project) => `Preciso da sua permissão pra continuar${project === undefined ? "" : ` em ${project}`}.`,
  waiting: (project) => `Tô esperando você responder${project === undefined ? "" : ` em ${project}`}.`,
  finished: (project) => project === undefined ? "Pronto, terminei." : `Pronto, terminei ${project}.`,
  error: (project) => `Deu erro${project === undefined ? "" : ` em ${project}`}, dá uma olhada quando puder.`
}

export const template = (event: AnnounceEvent, project?: string): string => TEMPLATES[event](projectName(project))

// Free text that names a speaker or another entity breaks the single voice.
const OFF_PERSONA = /(?<!\p{L})(claude|grok|jarvis|alexa|agentes?|agents?|sess(?:ão|ao|ões|oes)|sessions?|subagentes?|o outro|a outra|bots?)(?!\p{L})/iu

/** Whether free text names a speaker or another entity, which breaks the single first-person voice. */
export const isOffPersona = (text: string): boolean => OFF_PERSONA.test(text)

/** Cuts at a word boundary and ends with an ellipsis, staying within `max` chars. */
export const truncate = (text: string, max = MAX_ANNOUNCEMENT_LENGTH): string => {
  if (text.length <= max) return text
  const head = text.slice(0, max - 1)
  const boundary = head.lastIndexOf(" ")
  const cut = boundary >= max / 2 ? head.slice(0, boundary) : head
  return `${cut.replace(/[\s,;:.!?-]+$/u, "")}…`
}

const endSentence = (text: string): string => /[.!?…]$/u.test(text) ? text : `${text}.`

/**
 * Builds the pt-BR sentence for a notification, or says why there is nothing
 * worth speaking. Free text is only kept when it is free of secrets and reads
 * as Portuguese in the single first-person voice; otherwise a known event falls
 * back to its fixed template.
 */
export const compose = (input: AnnounceInput): Composed => {
  const event = classifyEvent(input)
  const body = sanitize(input.body)
  const usable = body.meaningfulWords >= 2 || (body.redactions === 0 && body.meaningfulWords >= 1)
  const portuguese = usable && looksPortuguese(body.text)
  const inPersona = !OFF_PERSONA.test(body.text)
  if (event !== undefined) {
    const fixed = template(event, input.project)
    return { _tag: "text", text: truncate(portuguese && inPersona ? `${fixed} ${endSentence(body.text)}` : fixed) }
  }
  if (body.text.length === 0) return { _tag: "skip", reason: "empty" }
  if (!usable) return { _tag: "skip", reason: body.redactions > 0 ? "secret-only" : "empty" }
  if (!portuguese) return { _tag: "skip", reason: "non-portuguese" }
  if (!inPersona) return { _tag: "skip", reason: "off-persona" }
  return { _tag: "text", text: truncate(endSentence(body.text)) }
}
