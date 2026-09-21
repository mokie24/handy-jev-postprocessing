# Handy + Jev Post-Processing

Small local macOS service that Handy uses for dictation post-processing.

```
Handy → http://127.0.0.1:11434/v1 → OpenRouter Decisions API →
typesafe/jev-1.13 → deterministic text edit → Handy receives final text
```

Input: `The meeting is Thursday, sorry, Friday at three.`
Output: `The meeting is Friday at three.`

**Rule: Jev decides which existing text means what. Code performs the edit. If uncertain, preserve the transcript.**

## Quickstart

```bash
cp .env.example .env   # put your key in OPENROUTER_API_KEY
npm install
npm run typecheck && npm test
npm run dev            # or: npm run build && npm start
```

## Handy configuration

Handy → Custom post-processing provider:

- Base URL: `http://127.0.0.1:11434/v1`
- Model: `jev-dictation`
- Prompt: any standard cleanup template, or `${output}` only. If Handy wraps
  the dictation in `<transcript>...</transcript>`, the service processes only
  the inner text and ignores the instruction wrapper.

Do not modify Handy itself. Do not send the OpenRouter key to Handy (it lives only in this service's env).

## API

`GET /v1/models` → `{data:[{id:"jev-dictation",object:"model"}]}`

`POST /v1/chat/completions` — extracts the raw transcript from the last user
message, runs Jev + deterministic edit, returns:

```json
{ "choices": [{ "message": { "role": "assistant", "content": "FINAL TEXT" }, "finish_reason": "stop" }] }
```

`GET /health` → `{ok:true}`. Binds `127.0.0.1` only.

Implementation order note: with no `OPENROUTER_API_KEY` the server is a
passthrough echo — use that to confirm Handy can send/receive before wiring Jev.

## How it works

1. **Tokenize without changing text** (`src/tokenizer.ts`, `Intl.Segmenter` word granularity). Each word gets `W000…` + exact `start/end` offsets. State sent to Jev: `{raw_transcript, tagged_transcript: "W000|The …"}`.
2. **One Jev Decisions request** (`src/openrouter.ts`, `POST https://openrouter.ai/api/alpha/decisions`, `model=typesafe/jev-1.13`). Six `choice` questions in one call: `operation` (`keep`/`replace_from_source`/`delete`/`paragraph_break`/`line_break`/`bullet_break`/`unsupported`), `target_start/end`, `source_start/end`, `cleanup_start` (over all token IDs + `none`).
3. **Deterministic edit** (`src/editor.ts`) using offsets only:
   - `delete` → remove target span, normalize only directly-affected whitespace/punctuation.
   - `replace_from_source` → copy exact chars `source_start…source_end` over `target_start…target_end`, then remove `cleanup_start…source_end` (handles `Thursday, sorry, Friday → Friday` and `four … No, three → three`, keeping `tickets` in place).
   - `paragraph_break`→`\n\n`, `line_break`→`\n`, `bullet_break`→`\n- ` (fixed strings; Jev generates no text).
4. **Validate + confidence gate** (`src/processor.ts`): IDs exist, ordering valid, source after target, no bad overlap, no `none` where required, plus a veto on deletes that would erase every copy of a repeated word; `operation.confidence >= 0.8` (hardcoded in `src/config.ts`). Anything invalid/unsure → original text.
5. **Iterate** up to 3 passes for multiple corrections (e.g. `… Thursday, sorry Friday, at five, actually six.` takes two passes, each applied edit followed by a confirm-keep call). Stop when Jev says `keep`.

## Failure behavior

Any of: OpenRouter failure/timeout, malformed Jev output, invalid boundaries,
low confidence, or exception → return the original transcript (ordinary Handy transcription).

## Tests & metrics

```bash
npm test        # 51 tests: editor, processor (mocked Jev), server, fixtures
npm run eval    # aggregate over test/fixtures.json
```

Fixtures cover the spec minimum (repairs, `I I` deletion, `new paragraph`) plus
all negative cases (`actually…`, `I don't want Thursday, I want Friday`, `said sorry…`, `Sorry for the delay`, `display the words new paragraph`, `No, I don't…`, `very, very`) and unsupported (`more professional`, `rewrite`, `translate`, `summarize`) — all must remain unchanged. Tracked: exact accuracy, **false changes (most important, must be 0)**, missed corrections, latency.

Note: the `new paragraph` fixture preserves source case (`migration`, not `Migration`) — capitalizing would be generated wording, so code keeps the original.

## Optional: run automatically on macOS

See `macos/com.apple.handy-jev-postprocessing.plist` (LaunchAgent template). Install only once the prototype is reliable with real Handy transcripts.
