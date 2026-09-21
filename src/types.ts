/**
 * Shared types. Jev decides; code edits. If uncertain, preserve the transcript.
 */

/** A word token with stable ID + exact character offsets into the original string. */
export interface WordToken {
  /** e.g. "W003" */
  id: string;
  /** surface form as it appears (word characters only, no surrounding punctuation) */
  text: string;
  /** inclusive start offset in the original transcript */
  start: number;
  /** exclusive end offset in the original transcript */
  end: number;
}

export type Operation =
  | "keep"
  | "replace_from_source"
  | "delete"
  | "paragraph_break"
  | "line_break"
  | "bullet_break"
  | "unsupported";

/**
 * One Jev decision (all six questions answered in a single Decisions request).
 * Span fields use token IDs ("W000" …) or "none".
 */
export interface JevDecision {
  operation: Operation;
  target_start: string;
  target_end: string;
  source_start: string;
  source_end: string;
  cleanup_start: string;
  /** Jev's confidence for the chosen `operation` (0..1). Missing => 0. */
  confidence: number;
  probabilities?: Record<string, number>;
  /** Token usage reported by OpenRouter for this decision (if any). */
  usage?: { input_tokens: number; output_tokens: number };
}

export interface ProcessorConfig {
  /** OpenRouter model id, e.g. "typesafe/jev-1.13" */
  model: string;
  /** OpenRouter key, server-side only. Empty = passthrough echo. */
  apiKey: string;
  /** Min operation confidence to apply a non-keep edit. Default 0.8. */
  confidenceThreshold: number;
  /** Hard cap on repair iterations. Default 3. */
  maxIterations: number;
  /** OpenRouter fetch timeout in ms. Default 8000. */
  requestTimeoutMs: number;
  /** HTTP-Referer sent to OpenRouter (shown on its dashboard). Optional. */
  referer?: string;
}

export interface ProcessResult {
  text: string;
  appliedEdits: number;
  iterations: number;
  stoppedReason: string;
  latencyMs: number;
  lastDecision: JevDecision | null;
  /** Summed OpenRouter usage across this transcript's Jev calls. */
  jevInputTokens: number;
  jevOutputTokens: number;
}

/** Dependency-injected Jev call so tests can run without network. */
export type JevDecideFn = (
  rawTranscript: string,
  tokens: WordToken[],
) => Promise<JevDecision>;

export function formatTokenId(index: number): string {
  return `W${String(index).padStart(3, "0")}`;
}
