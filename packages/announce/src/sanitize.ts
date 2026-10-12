/**
 * Neutral pt-BR words spoken in place of anything that could leak a secret or
 * a private detail. They are also how `sanitize` tells redacted text apart.
 */
export const PLACEHOLDERS = {
  credential: "credencial",
  link: "link",
  path: "caminho",
  email: "e-mail",
  code: "código"
} as const

const PLACEHOLDER_WORDS: ReadonlySet<string> = new Set(Object.values(PLACEHOLDERS))

export interface Sanitized {
  /** One line, no `<` or `>`, secrets replaced by placeholders. */
  readonly text: string
  readonly redactions: number
  /** Words left once placeholders and punctuation are ignored. */
  readonly meaningfulWords: number
}

type Rule = readonly [RegExp, string]

// Order matters: specific token shapes go first so the generic ones never
// leave half of a known token behind.
const RULES: ReadonlyArray<Rule> = [
  // Authorization headers, with or without the "Authorization:" prefix.
  [/\b(?:authorization\s*[:=]\s*)?bearer\s+[^\s"'<>]+/gi, PLACEHOLDERS.credential],
  // JWT: three base64url segments, the first one a JSON header ("eyJ").
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, PLACEHOLDERS.credential],
  // Vendor tokens.
  [/\bsk-(?:proj-|ant-)?[\w-]{8,}/g, PLACEHOLDERS.credential],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, PLACEHOLDERS.credential],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, PLACEHOLDERS.credential],
  [/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, PLACEHOLDERS.credential],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, PLACEHOLDERS.credential],
  // Any URL: those with a query string or credentials must never be spoken,
  // and a bare URL read aloud is noise anyway.
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, PLACEHOLDERS.link],
  [/\bwww\.[^\s"'<>]+/gi, PLACEHOLDERS.link],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, PLACEHOLDERS.email],
  // Absolute and home-relative paths.
  [/(?<![\w.])~\/[^\s"'<>]*/g, PLACEHOLDERS.path],
  [/(?<![\w.:/])\/(?:[^\s/"'<>]+\/)+[^\s/"'<>]*/g, PLACEHOLDERS.path],
  // Long hex (hashes, ids) and long base64 blobs.
  [/\b(?:0x)?[0-9a-f]{16,}\b/gi, PLACEHOLDERS.code],
  [/(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{24,}={0,2}/g, PLACEHOLDERS.credential]
]

const entropy = (value: string): number => {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const p = count / value.length
    bits -= p * Math.log2(p)
  }
  return bits
}

// A random-looking word: long, mixes letters and digits, and has high entropy.
const isHighEntropy = (word: string): boolean =>
  word.length >= 16 && /\d/.test(word) && /[A-Za-z]/.test(word) && entropy(word) >= 3.5

const WORD = /\p{L}[\p{L}\p{M}'-]*/gu

const countMeaningfulWords = (text: string): number =>
  (text.match(WORD) ?? []).filter((word) => word.length >= 2 && !PLACEHOLDER_WORDS.has(word.toLowerCase())).length

/**
 * Removes secrets and private details from free text and flattens it to one
 * line without `<` or `>` (Alexa rejects anything that looks like SSML).
 */
export const sanitize = (input: string): Sanitized => {
  let redactions = 0
  let text = input.replace(/[\r\n\t\f\v]+/g, " ")
  for (const [pattern, word] of RULES) {
    text = text.replace(pattern, () => {
      redactions++
      return ` ${word} `
    })
  }
  text = text
    .split(/\s+/)
    .map((token) => {
      const core = token.replace(/^[^\w]+|[^\w]+$/g, "")
      if (!isHighEntropy(core)) return token
      redactions++
      return token.replace(core, PLACEHOLDERS.credential)
    })
    .join(" ")
    .replace(/[<>]/g, " ")
    .replace(/&/g, " e ")
    // Control and zero-width characters.
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
  // "credencial credencial" reads worse than once.
  text = text.replace(/\b(credencial|link|caminho|código)(?:[\s,;]+\1\b)+/gu, "$1")
  return { text, redactions, meaningfulWords: countMeaningfulWords(text) }
}
