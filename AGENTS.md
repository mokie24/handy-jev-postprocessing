# AGENTS.md — handy-jev-postprocessing

Local macOS service: Handy Custom post-processing → Jev (OpenRouter Decisions API) → deterministic edit.

## Key design rule (never violate)

- **Jev decides which existing text means what. Code performs the edit. If uncertain, preserve the transcript.**
- Jev (`typesafe/jev-1.13`) is the ONLY AI model. Never use another LLM to generate candidates or corrected text.
- Never reconstruct transcripts by joining token strings. Edit via exact `start/end` char offsets.
- Never add rules like `if text contains "sorry": delete`. Jev decides from context.
- Never leak `OPENROUTER_API_KEY` (server-side only, never to Handy, never in logs/responses).
- Failure at any point → return the original transcript (Handy stays usable).

## Stack / layout

- Node.js 22+, TypeScript, Fastify, Zod, native `fetch`, `Intl.Segmenter`, Vitest. Keep it small.
- `src/server.ts` — Handy-compatible API (`GET /v1/models`, `POST /v1/chat/completions`), binds `127.0.0.1` only.
- `src/tokenizer.ts` — word tokens `{id, text, start, end}` + `W000|word` tagged form.
- `src/openrouter.ts` — one Decisions request (`operation`, `target_start/end`, `source_start/end`, `cleanup_start`).
- `src/editor.ts` — deterministic `delete` / `replace_from_source` / `paragraph|line|bullet_break` + validation.
- `src/processor.ts` — single-decision loop, confidence gate, ≤ 3 iterations.
- `src/types.ts`, `src/config.ts` — shared types + hardcoded constants.
- `test/fixtures.json` — 18 fixtures (corrections, formats, negatives, unsupported).
- `test/helpers.ts` — shared `idOf` / `d` / `idealMock` (no duplication across test files).
- `test/editor.test.ts` — offset editing. `test/processor.test.ts` — mocked-Jev integration. `test/server.test.ts` — Handy shape. `test/metrics.test.ts` — accuracy / false-changes / missed / latency.

## Commands

```bash
cp .env.example .env   # set OPENROUTER_API_KEY
npm install
npm run typecheck      # tsc --noEmit
npm test               # vitest run (51 tests)
npm run build          # tsc → dist/
npm start              # node dist/src/server.js (127.0.0.1:11434)
npm run dev            # tsx --watch src/server.ts
npm run eval           # fixture metrics (false changes must be 0)
```

Smoke (no key = passthrough echo, i.e. implementation-order step 2):

```bash
curl -s http://127.0.0.1:11434/v1/models
curl -s http://127.0.0.1:11434/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"jev-dictation","messages":[{"role":"user","content":"The meeting is Thursday, sorry, Friday at three."}]}'
```

## Config (hardcoded in `src/config.ts` — no env flags by design)

Port `11434`, model `typesafe/jev-1.13`, confidence threshold `0.8`
(below → keep), max `3` repair iterations, `8000`ms OpenRouter timeout.
The only env var is `OPENROUTER_API_KEY` (empty → passthrough echo),
server-side only. Retune by editing the constants + fixtures, never flags.

## Handy configuration (do not modify Handy itself)

- Base URL: `http://127.0.0.1:11434/v1`, Model: `jev-dictation`, Prompt: any standard template (`${output}`-only also works).
- The service extracts the last user message; if it wraps dictation in `<transcript>...</transcript>` tags, only the inner text is processed — instruction wrappers are ignored, never treated as dictation.
- Response shape: `{choices:[{message:{role:"assistant",content},finish_reason:"stop"}]}`.

## Editing semantics (src/editor.ts)

- `keep`/`unsupported`/invalid/low-confidence → `null` → preserve original.
- `delete`: remove `target_start..target_end` offsets, then minimal normalize (double-space, space-before-punct, `..`→`.`, `,,`→`,`).
- `replace_from_source`: `replacement = text[source_start.start … source_end.end]`; replace target span; delete `cleanup_start … source_end`; drop the `target→cleanup` gap only when it holds no word chars (repair scaffolding like `", "`), keep it when it holds kept words (like `" tickets. "`).
- `paragraph_break`→`"\n\n"`, `line_break`→`"\n"`, `bullet_break`→`"\n- "`; trim spaces around the break; no generated capitalization (spec example capitalizes `Migration`, we preserve source case).
- Validation before any edit: IDs exist, `start ≤ end`, source after target, cleanup after target and at/before source, char offsets monotonic, no `none` where required — plus one conservative veto: a `delete` spanning only repeats of one word (e.g. both `I`s in `I I`) is rejected, since a repetition repair must leave one instance. The veto can only *prevent* edits, never create or reinterpret them.

## Jev request (src/openrouter.ts)

- `POST https://openrouter.ai/api/alpha/decisions`, `{model, state:{raw_transcript, tagged_transcript}, questions}`.
- All six questions are `type: "choice"`. Span criteria enumerate every `Wxxx` + `"none"`. Instructions stress preserving ordinary language (`actually`/`sorry`/`no`/`new paragraph` as content vs. repair/command).
- Parse `answers.*.choice` + `operation.confidence` (missing → `0` → keep). Zod-validated; malformed → throw → processor falls back.

## Cost control (Jev calls are input-token dominated)

Jev 1.13 costs $0.042/M input, $0 output (only 2 Typesafe models exist,
same price — no cheaper swap). Measured live: keep ≈ 1600–1800 in-tokens
(~$0.00007), repair ≈ 3200–3700 over 2 calls (~$0.00015). ~100 dictations/day
≈ $0.25/month. Output tokens are free, so only input size and call count
matter. Question text is ~95% of every request (state is 3%). Span-question
criteria values are bare words only, the token-ID list is not repeated in
instructions (criteria keys + tagged transcript already carry it), and
instructions are one-liners. The load-bearing rules (single-token spans,
never span both copies, middle/after words like 'tickets'/'at three' are
kept sentence, tight source_end) must survive any rewording — cuts that
dropped the kept-words rule and the trailing-words rule each caused a live
false change, caught by the fixture batch and reverted. Verify
same-decisions live on fixtures after touching wording.
- `POST /v1/chat/completions` logs one line per request
  (`[chat] chars=… outcome=… iterations=… jevIn=… jevOut=… ms=…`, plus
  `cache=hit` / `dedup=shared-inflight`) — no transcript content, no key.
  Watch it with `tail -f /tmp/handy-jev-postprocessing.log`.
- Exact-repeat transcripts are served from a bounded in-memory cache (200
  entries, FIFO) and concurrent identical in-flights share one run, both
  with zero extra Jev calls. `__cache` / `processDeduped` in `src/server.ts`
  are the test hooks.
- Every applied edit costs one extra confirm-keep call (`iterations=2`).
  That second call is the price of the required multi-repair behavior
  (single-edit decisions per request, re-run after each edit) — not a flag
  to optimize away.

## What NOT to build (v1 scope)

No database, UI, verifier-model pass, elaborate logging, document-state manager, or Handy fork. Only add stages if observed failures justify them. Optional later: LaunchAgent plist in `macos/` for auto-start.

## Review checklist for changes

1. Does any path generate wording with non-Jev code/LLM? Reject.
2. Does any edit bypass `validateDecision` + confidence gate? Reject.
3. Could a negative fixture (`actually`/`sorry`/`no`/`new paragraph` as content, `very, very`) change? Add/keep a fixture proving it doesn't.
4. Are offsets (not joins) used? Is the fallback "return original" intact?
5. `npm run typecheck && npm test` green? Metrics: `falseChanges === 0`?
