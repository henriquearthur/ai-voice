export const MAX_TEXT_LENGTH = 4000;
const CHUNK_LENGTH = 250;

export function splitSpeech(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH || /[<>]/u.test(text)) {
    throw new Error(`Use plain text between 1 and ${MAX_TEXT_LENGTH} characters, without SSML.`);
  }
  const chunks = [];
  let rest = text.trim();
  while (rest.length > CHUNK_LENGTH) {
    const prefix = rest.slice(0, CHUNK_LENGTH + 1);
    // Prefer whole sentences and words; never split a UTF-16 surrogate pair.
    const sentences = [...prefix.matchAll(/[.!?](?:\s|$)/gu)].filter((match) => match.index < CHUNK_LENGTH);
    let end = sentences.at(-1)?.index + 1;
    if (!end || end < CHUNK_LENGTH / 2) {
      end = prefix.slice(0, CHUNK_LENGTH).search(/\s+\S*$/u);
      if (end < CHUNK_LENGTH / 2) end = CHUNK_LENGTH;
    }
    if (/[\uD800-\uDBFF]/u.test(rest[end - 1])) end--;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function speechSequence(remote, device, chunks, locale) {
  remote.serialNumbers[device.serialNumber] = device;
  const nodes = chunks.map((text) => {
    const node = remote.createSequenceNode('speak', text, device.serialNumber);
    node.operationPayload.locale = locale;
    node.operationPayload.textToSpeak = text;
    return node;
  });
  return {
    '@type': 'com.amazon.alexa.behaviors.model.Sequence',
    startNode: nodes.length === 1 ? nodes[0] : {
      '@type': 'com.amazon.alexa.behaviors.model.SerialNode',
      name: null,
      nodesToExecute: nodes,
    },
  };
}
