/**
 * Shared test helpers: token lookup, decision builder, and the ideal-Jev
 * mock (returns the "correct" decision for known correction inputs, keep
 * for everything else). Lets processor/metrics tests verify the pipeline
 * without network.
 */
import { tokenize } from "../src/tokenizer.js";
import type { JevDecideFn, JevDecision } from "../src/types.js";

export function idOf(text: string, surface: string, occurrence = 0): string {
  const tokens = tokenize(text);
  const hits = tokens.filter(
    (t) => t.text.toLowerCase() === surface.toLowerCase(),
  );
  if (!hits[occurrence]) throw new Error(`missing ${surface} in ${text}`);
  return hits[occurrence].id;
}

export function d(over: Partial<JevDecision>): JevDecision {
  return {
    operation: "keep",
    target_start: "none",
    target_end: "none",
    source_start: "none",
    source_end: "none",
    cleanup_start: "none",
    confidence: 0.95,
    ...over,
  };
}

export function idealMock(): JevDecideFn {
  return async (raw) => {
    if (raw === "The meeting is Thursday, sorry, Friday.") {
      return d({
        operation: "replace_from_source",
        target_start: idOf(raw, "Thursday"),
        target_end: idOf(raw, "Thursday"),
        source_start: idOf(raw, "Friday"),
        source_end: idOf(raw, "Friday"),
        cleanup_start: idOf(raw, "sorry"),
        confidence: 0.95,
      });
    }
    if (raw === "The meeting is Thursday, sorry, Friday at three.") {
      return d({
        operation: "replace_from_source",
        target_start: idOf(raw, "Thursday"),
        target_end: idOf(raw, "Thursday"),
        source_start: idOf(raw, "Friday"),
        source_end: idOf(raw, "Friday"),
        cleanup_start: idOf(raw, "sorry"),
        confidence: 0.95,
      });
    }
    if (raw === "I need fifteen, no, fifty copies.") {
      return d({
        operation: "replace_from_source",
        target_start: idOf(raw, "fifteen"),
        target_end: idOf(raw, "fifteen"),
        source_start: idOf(raw, "fifty"),
        source_end: idOf(raw, "fifty"),
        cleanup_start: idOf(raw, "no"),
        confidence: 0.95,
      });
    }
    if (raw === "Book four tickets. No, three.") {
      return d({
        operation: "replace_from_source",
        target_start: idOf(raw, "four"),
        target_end: idOf(raw, "four"),
        source_start: idOf(raw, "three"),
        source_end: idOf(raw, "three"),
        cleanup_start: idOf(raw, "No"),
        confidence: 0.95,
      });
    }
    if (raw === "I I think that works.") {
      return d({
        operation: "delete",
        target_start: idOf(raw, "I", 0),
        target_end: idOf(raw, "I", 0),
        confidence: 0.95,
      });
    }
    if (raw === "Project update new paragraph migration is complete.") {
      return d({
        operation: "paragraph_break",
        target_start: idOf(raw, "new"),
        target_end: idOf(raw, "paragraph"),
        confidence: 0.95,
      });
    }
    if (raw === "Meet Peter Thursday, sorry Friday, at five, actually six.") {
      return d({
        operation: "replace_from_source",
        target_start: idOf(raw, "Thursday"),
        target_end: idOf(raw, "Thursday"),
        source_start: idOf(raw, "Friday"),
        source_end: idOf(raw, "Friday"),
        cleanup_start: idOf(raw, "sorry"),
        confidence: 0.95,
      });
    }
    if (raw === "Meet Peter Friday, at five, actually six.") {
      return d({
        operation: "replace_from_source",
        target_start: idOf(raw, "five"),
        target_end: idOf(raw, "five"),
        source_start: idOf(raw, "six"),
        source_end: idOf(raw, "six"),
        cleanup_start: idOf(raw, "actually"),
        confidence: 0.95,
      });
    }
    return d({ operation: "keep", confidence: 0.99 });
  };
}
