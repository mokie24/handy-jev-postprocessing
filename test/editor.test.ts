import { describe, expect, it } from "vitest";
import {
  applyDecision,
  applyDelete,
  applyFormatBreak,
  applyReplaceFromSource,
  validateDecision,
} from "../src/editor.js";
import { tokenize, toTaggedTranscript } from "../src/tokenizer.js";
import type { JevDecision } from "../src/types.js";

function idOf(text: string, surface: string, occurrence = 0): string {
  const tokens = tokenize(text);
  const hits = tokens.filter(
    (t) => t.text.toLowerCase() === surface.toLowerCase(),
  );
  if (hits.length <= occurrence) {
    throw new Error(`token "${surface}" #${occurrence} not found in: ${text}`);
  }
  return hits[occurrence].id;
}

function decision(over: Partial<JevDecision>): JevDecision {
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

describe("tokenizer", () => {
  it("tokenizes the canonical example without changing text", () => {
    const raw = "The meeting is Thursday, sorry, Friday at three.";
    const tokens = tokenize(raw);
    expect(tokens.map((t) => t.text)).toEqual([
      "The",
      "meeting",
      "is",
      "Thursday",
      "sorry",
      "Friday",
      "at",
      "three",
    ]);
    expect(tokens.map((t) => t.id)).toEqual([
      "W000",
      "W001",
      "W002",
      "W003",
      "W004",
      "W005",
      "W006",
      "W007",
    ]);
    // offsets slice back to the surface form
    for (const t of tokens) {
      expect(raw.slice(t.start, t.end)).toBe(t.text);
    }
    expect(toTaggedTranscript(tokens)).toBe(
      "W000|The W001|meeting W002|is W003|Thursday W004|sorry W005|Friday W006|at W007|three",
    );
  });

  it("handles empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(toTaggedTranscript([])).toBe("");
  });
});

describe("editor: corrections", () => {
  it("Thursday, sorry, Friday -> Friday", () => {
    const raw = "The meeting is Thursday, sorry, Friday.";
    const out = applyReplaceFromSource(
      raw,
      tokenize(raw),
      idOf(raw, "Thursday"),
      idOf(raw, "Thursday"),
      idOf(raw, "Friday"),
      idOf(raw, "Friday"),
      idOf(raw, "sorry"),
    );
    expect(out).toBe("The meeting is Friday.");
  });

  it("Thursday, sorry, Friday at three -> Friday at three", () => {
    const raw = "The meeting is Thursday, sorry, Friday at three.";
    const out = applyReplaceFromSource(
      raw,
      tokenize(raw),
      idOf(raw, "Thursday"),
      idOf(raw, "Thursday"),
      idOf(raw, "Friday"),
      idOf(raw, "Friday"),
      idOf(raw, "sorry"),
    );
    expect(out).toBe("The meeting is Friday at three.");
  });

  it("fifteen, no, fifty -> fifty", () => {
    const raw = "I need fifteen, no, fifty copies.";
    const out = applyReplaceFromSource(
      raw,
      tokenize(raw),
      idOf(raw, "fifteen"),
      idOf(raw, "fifteen"),
      idOf(raw, "fifty"),
      idOf(raw, "fifty"),
      idOf(raw, "no"),
    );
    expect(out).toBe("I need fifty copies.");
  });

  it("Book four tickets. No, three. -> Book three tickets.", () => {
    const raw = "Book four tickets. No, three.";
    const out = applyReplaceFromSource(
      raw,
      tokenize(raw),
      idOf(raw, "four"),
      idOf(raw, "four"),
      idOf(raw, "three"),
      idOf(raw, "three"),
      idOf(raw, "No"),
    );
    expect(out).toBe("Book three tickets.");
  });

  it("deletes repetition: I I think -> I think", () => {
    const raw = "I I think that works.";
    const firstI = idOf(raw, "I", 0);
    const out = applyDelete(raw, tokenize(raw), firstI, firstI);
    expect(out).toBe("I think that works.");
  });

  it("replaces formatting command with paragraph break", () => {
    const raw = "Project update new paragraph migration is complete.";
    const out = applyFormatBreak(
      raw,
      tokenize(raw),
      idOf(raw, "new"),
      idOf(raw, "paragraph"),
      "paragraph_break",
    );
    expect(out).toBe("Project update\n\nmigration is complete.");
  });

  it("replaces formatting command with line and bullet breaks", () => {
    const raw = "First part new line second part.";
    const line = applyFormatBreak(
      raw,
      tokenize(raw),
      idOf(raw, "new"),
      idOf(raw, "line"),
      "line_break",
    );
    expect(line).toBe("First part\nsecond part.");

    const raw2 = "Shopping list new bullet milk.";
    const bullet = applyFormatBreak(
      raw2,
      tokenize(raw2),
      idOf(raw2, "new"),
      idOf(raw2, "bullet"),
      "bullet_break",
    );
    expect(bullet).toBe("Shopping list\n- milk.");
  });
});

describe("editor: validation (invalid => null, preserve original)", () => {
  it("rejects unknown token ids", () => {
    const raw = "Hello world.";
    const d = decision({
      operation: "delete",
      target_start: "W099",
      target_end: "W099",
      confidence: 0.99,
    });
    expect(validateDecision(tokenize(raw), d).ok).toBe(false);
    expect(applyDecision(raw, tokenize(raw), d)).toBeNull();
  });

  it("rejects reversed ranges", () => {
    const raw = "a b c d.";
    const tokens = tokenize(raw);
    const d = decision({
      operation: "delete",
      target_start: tokens[2].id,
      target_end: tokens[1].id,
      confidence: 0.99,
    });
    expect(validateDecision(tokens, d).ok).toBe(false);
  });

  it("rejects source before target", () => {
    const raw = "Friday is after Thursday.";
    const d = decision({
      operation: "replace_from_source",
      // Friday (W000) as target, Thursday (W003) as source would be backwards
      target_start: idOf(raw, "Friday"),
      target_end: idOf(raw, "Friday"),
      source_start: idOf(raw, "Thursday"),
      source_end: idOf(raw, "Thursday"),
      cleanup_start: idOf(raw, "Thursday"),
      confidence: 0.99,
    });
    // Here source IS after target by index, so construct a truly bad one:
    const bad = decision({
      operation: "replace_from_source",
      target_start: idOf(raw, "Thursday"),
      target_end: idOf(raw, "Thursday"),
      source_start: idOf(raw, "Friday"),
      source_end: idOf(raw, "Friday"),
      cleanup_start: idOf(raw, "Friday"),
      confidence: 0.99,
    });
    // Friday (index 0) is before Thursday (index 3) -> invalid
    expect(validateDecision(tokenize(raw), bad).ok).toBe(false);
    expect(d.operation).toBe("replace_from_source");
  });

  it("rejects none spans for edits", () => {
    const raw = "Hello world.";
    const d = decision({ operation: "delete", confidence: 0.99 });
    expect(validateDecision(tokenize(raw), d).ok).toBe(false);
  });

  it("rejects a delete that would erase every copy of a repeated word", () => {
    const raw = "I I think that works.";
    const tokens = tokenize(raw);
    const both = decision({
      operation: "delete",
      target_start: idOf(raw, "I", 0),
      target_end: idOf(raw, "I", 1),
      confidence: 0.99,
    });
    expect(validateDecision(tokens, both).ok).toBe(false);
    expect(applyDecision(raw, tokens, both)).toBeNull();
    // Deleting a single copy is still allowed.
    const one = decision({
      operation: "delete",
      target_start: idOf(raw, "I", 0),
      target_end: idOf(raw, "I", 0),
      confidence: 0.99,
    });
    expect(validateDecision(tokens, one).ok).toBe(true);
  });

  it("keep and unsupported are no-ops", () => {
    const raw = "She said sorry and left.";
    const tokens = tokenize(raw);
    expect(applyDecision(raw, tokens, decision({ operation: "keep" }))).toBeNull();
    expect(
      applyDecision(raw, tokens, decision({ operation: "unsupported" })),
    ).toBeNull();
  });
});
