/**
 * Text chunking for the approved knowledge library (pure).
 * Splits by sections/paragraphs into ~`targetChars` chunks with a small
 * overlap so a fact split across a boundary is still found.
 */

export interface TextChunk {
  ordinal: number;
  section: string | null;
  content: string;
  tokens: number;
}

export interface ChunkOptions {
  targetChars?: number;
  maxChars?: number;
  overlapChars?: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const targetChars = options.targetChars ?? 1800;
  const maxChars = options.maxChars ?? 2400;
  const overlapChars = options.overlapChars ?? 200;
  const normalized = normalizeText(text);
  if (normalized.length === 0) return [];

  const chunks: TextChunk[] = [];
  let currentSection: string | null = null;
  let buffer = '';
  let bufferSection: string | null = null;

  const flush = () => {
    const content = buffer.trim();
    if (content.length === 0) return;
    chunks.push({
      ordinal: chunks.length,
      section: bufferSection,
      content,
      tokens: estimateTokens(content),
    });
    // Keep an overlap tail so boundary facts survive.
    buffer = overlapChars > 0 ? content.slice(-overlapChars) : '';
    bufferSection = currentSection;
  };

  const paragraphs = normalized.split(/\n\s*\n/);
  for (const raw of paragraphs) {
    const paragraph = raw.trim();
    if (paragraph.length === 0) continue;
    const heading = /^(#{1,6}\s+.+|[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9 .:-]{3,80})$/.exec(paragraph);
    if (heading && paragraph.length <= 100) {
      currentSection = paragraph.replace(/^#+\s*/, '').trim();
      if (buffer.trim().length > 0) flush();
      buffer = '';
      bufferSection = currentSection;
      continue;
    }
    if (paragraph.length > maxChars) {
      // Split very long paragraphs by sentences.
      const sentences = paragraph.split(/(?<=[.!?;])\s+/);
      for (const sentence of sentences) {
        if (buffer.length + sentence.length + 1 > targetChars && buffer.trim().length > 0) flush();
        buffer += (buffer.length > 0 ? ' ' : '') + sentence;
        if (bufferSection === null) bufferSection = currentSection;
      }
      continue;
    }
    if (buffer.length + paragraph.length + 2 > targetChars && buffer.trim().length > 0) flush();
    buffer += (buffer.length > 0 ? '\n\n' : '') + paragraph;
    if (bufferSection === null) bufferSection = currentSection;
  }
  if (buffer.trim().length > 0) {
    const content = buffer.trim();
    chunks.push({
      ordinal: chunks.length,
      section: bufferSection,
      content,
      tokens: estimateTokens(content),
    });
  }
  return chunks;
}

/** Turns a user query into a safe tsquery string (AND of alphanumeric terms). Pure. */
export function buildTsQuery(query: string): string {
  const terms = query
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9ñ]+/)
    .filter((t) => t.length >= 2)
    .slice(0, 12);
  if (terms.length === 0) return '';
  return terms.map((t) => `${t}:*`).join(' & ');
}
