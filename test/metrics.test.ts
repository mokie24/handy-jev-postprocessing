/**
 * Fixture metrics: exact accuracy, false changes, missed corrections, latency.
 * False changes are the most important error — they must stay at zero.
 *
 * Uses the ideal-Jev mock (processor.test.ts logic lives there); this file
 * reports aggregate numbers over fixtures.json so regressions are visible.
 */
import { describe, expect, it } from "vitest";
import fixtures from "./fixtures.json" with { type: "json" };
import { processTranscript } from "../src/processor.js";
import { idealMock } from "./helpers.js";

describe("fixture metrics", () => {
  it("reports accuracy with zero false changes", async () => {
    const opts = {
      model: "typesafe/jev-1.13",
      apiKey: "test",
      confidenceThreshold: 0.8,
      maxIterations: 3,
      requestTimeoutMs: 1000,
    };
    let exact = 0;
    let falseChanges = 0;
    let missed = 0;
    let totalLatency = 0;
    const failures: string[] = [];

    for (const f of fixtures as Array<{
      name: string;
      kind: string;
      input: string;
      expected: string;
    }>) {
      const r = await processTranscript(f.input, opts, idealMock());
      totalLatency += r.latencyMs;
      if (r.text === f.expected) {
        exact++;
      } else {
        failures.push(`${f.name}: got ${JSON.stringify(r.text)}`);
      }
      if (f.kind === "unchanged" && r.text !== f.input) falseChanges++;
      if (f.kind !== "unchanged" && r.text === f.input) missed++;
    }

    const total = (fixtures as unknown[]).length;
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          total,
          exact,
          accuracy: exact / total,
          falseChanges,
          missed,
          avgLatencyMs: totalLatency / total,
          failures,
        },
        null,
        2,
      ),
    );

    expect(falseChanges).toBe(0);
    expect(exact).toBe(total);
  });
});
