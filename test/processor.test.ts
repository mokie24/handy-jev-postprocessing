import { describe, expect, it } from "vitest";
import fixtures from "./fixtures.json" with { type: "json" };
import { processTranscript, processOnce } from "../src/processor.js";
import { tokenize } from "../src/tokenizer.js";
import { d, idOf, idealMock } from "./helpers.js";
import type { JevDecideFn } from "../src/types.js";

const keepMock: JevDecideFn = async () => d({ operation: "keep", confidence: 0.99 });

const baseOpts = {
  model: "typesafe/jev-1.13",
  apiKey: "test",
  confidenceThreshold: 0.8,
  maxIterations: 3,
  requestTimeoutMs: 1000,
};

describe("processor: single pass guards", () => {
  it("keeps on keep", async () => {
    const raw = "It was actually a very useful meeting.";
    const r = await processOnce(raw, keepMock, 0.8);
    expect(r.text).toBe(raw);
    expect(r.applied).toBe(false);
  });

  it("keeps on low confidence", async () => {
    const raw = "I I think that works.";
    const low: JevDecideFn = async () =>
      d({
        operation: "delete",
        target_start: idOf(raw, "I", 0),
        target_end: idOf(raw, "I", 0),
        confidence: 0.5,
      });
    const r = await processOnce(raw, low, 0.8);
    expect(r.text).toBe(raw);
    expect(r.applied).toBe(false);
    expect(r.reason).toMatch(/confidence/);
  });

  it("keeps on invalid spans", async () => {
    const raw = "Hello world.";
    const bad: JevDecideFn = async () =>
      d({
        operation: "delete",
        target_start: "W099",
        target_end: "W099",
        confidence: 0.99,
      });
    const r = await processOnce(raw, bad, 0.8);
    expect(r.text).toBe(raw);
    expect(r.applied).toBe(false);
  });

  it("keeps on unsupported", async () => {
    const raw = "Make that more professional.";
    const un: JevDecideFn = async () =>
      d({ operation: "unsupported", confidence: 0.99 });
    const r = await processOnce(raw, un, 0.8);
    expect(r.text).toBe(raw);
  });

  it("falls back to original when decide throws", async () => {
    const raw = "The meeting is Friday.";
    const boom: JevDecideFn = async () => {
      throw new Error("network down");
    };
    const r = await processTranscript(raw, baseOpts, boom);
    expect(r.text).toBe(raw);
    expect(r.appliedEdits).toBe(0);
  });
});

describe("processor: corrections with ideal Jev", () => {
  const corrections = (fixtures as Array<{ name: string; kind: string; input: string; expected: string }>).filter(
    (f) => f.kind === "correction" || f.kind === "format",
  );
  for (const f of corrections) {
    it(`${f.name}`, async () => {
      const r = await processTranscript(f.input, baseOpts, idealMock());
      expect(r.text).toBe(f.expected);
      expect(r.appliedEdits).toBeGreaterThanOrEqual(1);
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    });
  }

  it("runs two iterations for double repair", async () => {
    const r = await processTranscript(
      "Meet Peter Thursday, sorry Friday, at five, actually six.",
      baseOpts,
      idealMock(),
    );
    expect(r.text).toBe("Meet Peter Friday, at six.");
    expect(r.appliedEdits).toBe(2);
  });

  it("respects maxIterations", async () => {
    let calls = 0;
    const always: JevDecideFn = async (raw) => {
      calls++;
      // always propose deleting the first token (keeps changing text)
      const t = tokenize(raw)[0];
      return d({
        operation: "delete",
        target_start: t.id,
        target_end: t.id,
        confidence: 0.99,
      });
    };
    const r = await processTranscript("a b c d e f g.", { ...baseOpts, maxIterations: 2 }, always);
    expect(r.appliedEdits).toBeLessThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(2);
  });
});

describe("processor: negatives stay unchanged (false changes = worst error)", () => {
  const negatives = (fixtures as Array<{ name: string; kind: string; input: string; expected: string }>).filter(
    (f) => f.kind === "unchanged",
  );
  for (const f of negatives) {
    it(`${f.name}`, async () => {
      const r = await processTranscript(f.input, baseOpts, idealMock());
      expect(r.text).toBe(f.expected);
      expect(r.appliedEdits).toBe(0);
    });
  }
});
