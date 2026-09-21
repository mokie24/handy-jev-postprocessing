/**
 * Tokenization without changing the text.
 *
 * Uses Intl.Segmenter (word granularity) and keeps only word-like segments.
 * Each token records its exact start/end offsets; editing uses offsets,
 * never string-joining of token texts.
 */
import { formatTokenId, type WordToken } from "./types.js";

// Node 22 always ships Intl.Segmenter; no fallback by design.
const segmenter = new (Intl as any).Segmenter("en", { granularity: "word" });

export function tokenize(raw: string): WordToken[] {
  if (!raw) return [];
  const tokens: WordToken[] = [];
  // Intl.Segmenter segment() yields { segment, index, isWordLike }.
  const segments = segmenter.segment(raw) as Iterable<{
    segment: string;
    index: number;
    isWordLike?: boolean;
  }>;
  let n = 0;
  for (const seg of segments) {
    if (!seg.isWordLike) continue;
    const start = seg.index;
    const end = seg.index + seg.segment.length;
    tokens.push({ id: formatTokenId(n), text: seg.segment, start, end });
    n++;
  }
  return tokens;
}

/**
 * Tagged form sent to Jev as state, e.g.
 * "W000|The W001|meeting W002|is".
 */
export function toTaggedTranscript(tokens: WordToken[]): string {
  return tokens.map((t) => `${t.id}|${t.text}`).join(" ");
}

export function indexById(tokens: WordToken[]): Map<string, number> {
  const map = new Map<string, number>();
  tokens.forEach((t, i) => map.set(t.id, i));
  return map;
}
