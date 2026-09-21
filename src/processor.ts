/**
 * Single Jev decision per iteration, deterministic edit, repeat up to
 * maxIterations. Any failure => original transcript unchanged.
 */
import { decideWithJev } from "./openrouter.js";
import { applyDecision, validateDecision } from "./editor.js";
import { tokenize } from "./tokenizer.js";
import type {
  JevDecideFn,
  JevDecision,
  ProcessResult,
  ProcessorConfig,
} from "./types.js";

function liveDecideFn(opts: ProcessorConfig): JevDecideFn {
  return (raw, tokens) =>
    decideWithJev(raw, tokens, {
      model: opts.model,
      apiKey: opts.apiKey,
      timeoutMs: opts.requestTimeoutMs,
      referer: opts.referer,
    });
}

/** Apply at most one Jev decision to `current`. Never throws. */
export async function processOnce(
  current: string,
  decide: JevDecideFn,
  confidenceThreshold: number,
): Promise<{ text: string; applied: boolean; decision: JevDecision | null; reason: string }> {
  try {
    if (!current || !current.trim()) {
      return { text: current, applied: false, decision: null, reason: "empty" };
    }
    const tokens = tokenize(current);
    if (tokens.length === 0) {
      return { text: current, applied: false, decision: null, reason: "no tokens" };
    }
    const decision = await decide(current, tokens);
    if (decision.operation === "keep" || decision.operation === "unsupported") {
      return {
        text: current,
        applied: false,
        decision,
        reason: decision.operation,
      };
    }
    if (
      !Number.isFinite(decision.confidence) ||
      decision.confidence < confidenceThreshold
    ) {
      return {
        text: current,
        applied: false,
        decision,
        reason: `low confidence ${decision.confidence}`,
      };
    }
    const v = validateDecision(tokens, decision);
    if (!v.ok) {
      return { text: current, applied: false, decision, reason: `invalid: ${v.reason}` };
    }
    const edited = applyDecision(current, tokens, decision);
    if (edited === null || edited === current) {
      return {
        text: current,
        applied: false,
        decision,
        reason: "edit no-op",
      };
    }
    return { text: edited, applied: true, decision, reason: "applied" };
  } catch (e) {
    return {
      text: current,
      applied: false,
      decision: null,
      reason: `error: ${(e as Error).message}`,
    };
  }
}

/**
 * Full pipeline: iterate processOnce until keep / invalid / low-confidence,
 * maxIterations, or error. Never throws; falls back to the original input.
 */
export async function processTranscript(
  raw: string,
  opts: ProcessorConfig,
  decide?: JevDecideFn,
): Promise<ProcessResult> {
  const start = Date.now();
  const decideFn = decide ?? liveDecideFn(opts);
  let current = raw;
  let appliedEdits = 0;
  let lastDecision: JevDecision | null = null;
  let stoppedReason = "keep";
  let iterations = 0;
  let jevInputTokens = 0;
  let jevOutputTokens = 0;

  try {
    const cap = Math.max(1, Math.min(10, opts.maxIterations));
    for (let i = 0; i < cap; i++) {
      iterations++;
      const r = await processOnce(current, decideFn, opts.confidenceThreshold);
      lastDecision = r.decision ?? lastDecision;
      jevInputTokens += r.decision?.usage?.input_tokens ?? 0;
      jevOutputTokens += r.decision?.usage?.output_tokens ?? 0;
      if (!r.applied) {
        stoppedReason = r.reason;
        break;
      }
      current = r.text;
      appliedEdits++;
      stoppedReason = "applied";
      // loop again on the new text so a second correction can apply
    }
  } catch {
    current = raw;
    stoppedReason = "exception";
  }

  return {
    text: current,
    appliedEdits,
    iterations,
    stoppedReason,
    latencyMs: Date.now() - start,
    lastDecision,
    jevInputTokens,
    jevOutputTokens,
  };
}
