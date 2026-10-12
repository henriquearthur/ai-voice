import { Schema, SchemaTransformation } from "effect"
import type { EchoDevice } from "./alexa-api.ts"
import type { AlexaRemoteClient, SequenceNode } from "./alexa-remote.ts"

export const MAX_TEXT_LENGTH = 4000
const CHUNK_LENGTH = 250

export const SpeechText = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(MAX_TEXT_LENGTH), Schema.isPattern(/^[^<>]*$/u)),
  Schema.decodeTo(Schema.Trimmed.check(Schema.isNonEmpty()), SchemaTransformation.trim())
)

export const Echo = Schema.Struct({
  name: Schema.String,
  serial: Schema.String,
  online: Schema.Boolean,
  isDefault: Schema.Boolean
})
export type Echo = typeof Echo.Type

export const SpeechAccepted = Schema.Struct({
  status: Schema.Literal("accepted"),
  device: Schema.String,
  chunks: Schema.Number,
  playbackConfirmed: Schema.Literal(false)
})
export type SpeechAccepted = typeof SpeechAccepted.Type

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff

// Alexa.Speak accepts at most 250 UTF-16 code units per node.
export const splitSpeech = (text: string): ReadonlyArray<string> => {
  const chunks: Array<string> = []
  let rest = text.trim()
  while (rest.length > CHUNK_LENGTH) {
    const prefix = rest.slice(0, CHUNK_LENGTH + 1)
    // Prefer whole sentences and words; never split a UTF-16 surrogate pair.
    const sentence = [...prefix.matchAll(/[.!?](?:\s|$)/gu)].filter((match) => match.index < CHUNK_LENGTH).at(-1)
    let end = sentence === undefined ? 0 : sentence.index + 1
    if (end < CHUNK_LENGTH / 2) {
      end = prefix.slice(0, CHUNK_LENGTH).search(/\s+\S*$/u)
      if (end < CHUNK_LENGTH / 2) end = CHUNK_LENGTH
    }
    if (isHighSurrogate(rest.charCodeAt(end - 1))) end--
    chunks.push(rest.slice(0, end).trim())
    rest = rest.slice(end).trim()
  }
  if (rest) chunks.push(rest)
  return chunks
}

export interface SpeechSequence {
  readonly "@type": "com.amazon.alexa.behaviors.model.Sequence"
  readonly startNode: SequenceNode | {
    readonly "@type": "com.amazon.alexa.behaviors.model.SerialNode"
    readonly name: null
    readonly nodesToExecute: ReadonlyArray<SequenceNode>
  }
}

// The library's own speak path forces de-DE and rewrites decimals outside .com marketplaces,
// so the locale and the original text are written back into each node.
export const speechSequence = (
  remote: AlexaRemoteClient,
  device: EchoDevice,
  chunks: ReadonlyArray<string>,
  locale: string
): SpeechSequence => {
  remote.serialNumbers[device.serialNumber] = device
  const nodes = chunks.map((text): SequenceNode => {
    const node = remote.createSequenceNode("speak", text, device.serialNumber)
    return { ...node, operationPayload: { ...node.operationPayload, locale, textToSpeak: text } }
  })
  return {
    "@type": "com.amazon.alexa.behaviors.model.Sequence",
    startNode: nodes.length === 1 ? nodes[0] : {
      "@type": "com.amazon.alexa.behaviors.model.SerialNode",
      name: null,
      nodesToExecute: nodes
    }
  }
}
