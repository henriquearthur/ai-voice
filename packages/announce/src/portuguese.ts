// Function words and very common verbs that only exist in Portuguese. Words
// shared with English ("a", "no", "do", "as", "me", "se") are left out.
const PORTUGUESE = new Set([
  "de", "que", "não", "nao", "para", "pra", "com", "uma", "um", "uns", "umas", "os", "da", "das", "dos", "em",
  "na", "nas", "nos", "por", "pelo", "pela", "mais", "mas", "foi", "são", "sao", "está", "esta", "estão", "estou",
  "você", "voce", "sua", "seu", "suas", "seus", "isso", "este", "essa", "esse", "aqui", "agora", "já", "ja", "também",
  "tem", "têm", "ter", "ser", "será", "pode", "precisa", "preciso", "quer", "fazer", "feito", "pronto", "pronta",
  "terminou", "terminei", "concluído", "concluída", "concluiu", "falhou", "falha", "erro", "erros", "tarefa",
  "aguardando", "esperando", "permissão", "resposta", "sim", "ou", "ao", "aos", "às", "como", "quando", "onde",
  "porque", "depois", "antes", "ainda", "nada", "tudo", "todos", "todas", "sem", "sobre", "entre", "até", "lembrete",
  "reunião", "amanhã", "hoje", "ontem", "arquivo", "arquivos", "projeto", "teste", "testes", "passou", "passaram",
  "começou", "acabou", "atenção", "olá", "oi", "bom", "boa", "dia", "noite", "tarde", "minutos", "segundos", "pedido"
])

// Words that only exist in English (plus "terminal": the Echo must never say
// "leia o terminal"). One of them is enough to reject the text.
const ENGLISH = new Set([
  "the", "and", "is", "are", "was", "were", "to", "of", "for", "you", "your", "with", "this", "that", "it", "its",
  "be", "been", "being", "has", "have", "had", "will", "would", "can", "could", "should", "from", "by", "at", "on",
  "in", "not", "an", "or", "if", "then", "when", "what", "which", "who", "please", "need", "needs", "needed",
  "waiting", "wait", "finished", "finish", "done", "failed", "fail", "failure", "input", "permission", "task",
  "tasks", "completed", "complete", "use", "using", "run", "running", "ran", "file", "files", "my", "we", "they",
  "he", "she", "i", "but", "so", "out", "up", "there", "here", "now", "just", "attention", "approve", "allow",
  "claude's", "build", "succeeded", "success", "successfully", "ready", "check", "see", "terminal", "read", "agent",
  "session", "idle", "prompt", "requires", "required", "requested", "request", "response", "reply", "want",
  "does", "did", "how", "why", "where", "all", "some", "any", "new", "error", "errors", "warning", "about", "into",
  "over", "after", "before", "while", "until", "again", "back", "only", "also", "too", "very", "more", "most", "let",
  "let's", "don't", "can't", "won't", "isn't", "it's", "i'm", "you're", "we're", "hello", "hi", "thanks", "yes"
])

const DIACRITIC = /[áàâãéêíóôõúüç]/i

/**
 * Cheap guard for "this free text is Brazilian Portuguese". It is deliberately
 * strict: a single English-only word rejects the text, and the text needs
 * positive Portuguese evidence (two function words, or one plus an accent).
 */
export const looksPortuguese = (text: string): boolean => {
  const words = (text.toLowerCase().match(/\p{L}[\p{L}\p{M}']*/gu) ?? [])
  if (words.length === 0) return false
  if (words.some((word) => ENGLISH.has(word))) return false
  const hits = words.filter((word) => PORTUGUESE.has(word)).length
  return hits >= 2 || (hits >= 1 && (DIACRITIC.test(text) || words.length <= 3))
}
