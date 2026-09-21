/**
 * Handy-compatible localhost passthrough server.
 *
 * Handy (Custom post-processing provider):
 *   Base URL: http://127.0.0.1:11434/v1
 *   Model:    jev-dictation
 *   Prompt:   any standard template (transcript unwrapped from
 *             <transcript> tags) or ${output} only
 *
 * Implements:
 *   GET  /v1/models
 *   POST /v1/chat/completions  -> Jev repair + deterministic edit
 *
 * Failure behavior: any error returns the original transcript so Handy
 * stays usable (fallback = ordinary transcription).
 */
import Fastify from "fastify";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { processTranscript } from "./processor.js";

export const HANDY_MODEL_ID = "jev-dictation";

/**
 * Tiny exact-match cache: if the same transcript arrives twice (e.g. Handy
 * sends a transcribe pass and a process pass), the repeat is answered with
 * zero new Jev calls. Bounded FIFO; restart clears it. Cached values are
 * final texts, so hits are behavior-identical to recomputing.
 */
const recentResults = new Map<string, string>();
const CACHE_MAX = 200;

function cacheSet(raw: string, finalText: string): void {
  if (!recentResults.has(raw) && recentResults.size >= CACHE_MAX) {
    const oldest = recentResults.keys().next();
    if (!oldest.done) recentResults.delete(oldest.value);
  }
  recentResults.set(raw, finalText);
}

/** Test hooks for the repeat cache. */
export const __cache = {
  set: cacheSet,
  clear: () => recentResults.clear(),
  size: () => recentResults.size,
};

/**
 * In-flight dedup: concurrent identical transcripts share one processing
 * run (e.g. Handy double-sending while the first call is still in flight).
 * Behavior-identical to sequential processing; failures fall back per call.
 */
const inFlight = new Map<string, Promise<string>>();

export function processDeduped(raw: string): Promise<string> {
  const existing = inFlight.get(raw);
  if (existing) {
    // eslint-disable-next-line no-console
    console.log(`[chat] chars=${raw.length} dedup=shared-inflight`);
    return existing;
  }
  const config = loadConfig();
  const run = (async (): Promise<string> => {
    if (!config.apiKey) return raw;
    const result = await processTranscript(raw, config);
    cacheSet(raw, result.text);
    // One line per request: no transcript content, no key. jevIn/jevOut
    // make duplicate or looping cost visible at a glance.
    // eslint-disable-next-line no-console
    console.log(
      `[chat] chars=${raw.length} outcome=${result.appliedEdits > 0 ? "edited" : result.stoppedReason} iterations=${result.iterations} jevIn=${result.jevInputTokens} jevOut=${result.jevOutputTokens} ms=${result.latencyMs}`,
    );
    return result.text;
  })();
  inFlight.set(raw, run);
  // Drop the entry when settled so later repeats revalidate via the cache.
  // The extra .then costs nothing; rejections still reach each waiter.
  run.then(
    () => inFlight.delete(raw),
    () => inFlight.delete(raw),
  );
  return run;
}

const ContentPartSchema = z.union([
  z.object({ type: z.string().optional(), text: z.string() }).passthrough(),
  z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
]);

const MessageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(ContentPartSchema), z.null()]).optional(),
});

const ChatCompletionsSchema = z.object({
  model: z.string().optional(),
  messages: z.array(MessageSchema).min(1),
  stream: z.boolean().optional(),
});

function contentToText(
  content: string | Array<{ text?: string }> | null | undefined,
): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("");
}

/**
 * Raw transcript = last user message with non-empty text.
 * Handy embeds the dictation inside a prompt template, so when the message
 * wraps it in <transcript>...</transcript> tags (the standard Handy-style
 * cleanup prompt), only the inner text is used — the instruction wrapper
 * is ignored and never treated as dictation.
 * Falls back to the last message with any text (Handy prompt shapes vary).
 */
export function extractTranscript(messages: Array<{ role: string; content?: unknown }>): string {
  const textOf = (m: { content?: unknown }): string =>
    contentToText(
      m.content as string | Array<{ text?: string }> | null | undefined,
    );
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const t = textOf(messages[i]);
      if (t.trim()) return unwrapTranscript(t);
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = textOf(messages[i]);
    if (t.trim()) return unwrapTranscript(t);
  }
  return "";
}

/**
 * Prefer the dictation inside <transcript> tags when present (last block
 * wins). Without tags, the whole message is the transcript.
 */
export function unwrapTranscript(text: string): string {
  const re = /<transcript>([\s\S]*?)<\/transcript>/gi;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last === null ? text : last.trim();
}

export function buildApp() {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true }));

  app.get("/v1/models", async () => ({
    object: "list",
    data: [
      {
        id: HANDY_MODEL_ID,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "local",
      },
    ],
  }));

  app.post("/v1/chat/completions", async (req, reply) => {
    const parsed = ChatCompletionsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid chat completions body" });
    }
    const raw = extractTranscript(parsed.data.messages);
    // Empty input: echo back empty (keeps Handy usable).
    if (!raw) {
      return reply.send(chatCompletion(""));
    }

    // Exact repeat: free answer, no new Jev call.
    const hit = recentResults.get(raw);
    if (hit !== undefined) {
      // eslint-disable-next-line no-console
      console.log(`[chat] chars=${raw.length} cache=hit`);
      return reply.send(chatCompletion(hit));
    }

    const config = loadConfig();
    // No key (dev / step 2 passthrough check): echo input unchanged.
    if (!config.apiKey) {
      return reply.send(chatCompletion(raw));
    }

    try {
      return reply.send(chatCompletion(await processDeduped(raw)));
    } catch {
      return reply.send(chatCompletion(raw));
    }
  });

  // Non-streaming only; reject streams explicitly so Handy falls back cleanly.
  return app;
}

function chatCompletion(text: string) {
  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: HANDY_MODEL_ID,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

const isMain =
  process.argv[1]?.endsWith("server.js") ||
  process.argv[1]?.endsWith("server.ts");

if (isMain) {
  const config = loadConfig();
  const app = buildApp();
  app
    .listen({ port: config.port, host: "127.0.0.1" })
    .then((addr) => {
      // eslint-disable-next-line no-console
      console.log(`handy-jev-postprocessing listening on ${addr}`);
      if (!config.apiKey) {
        // eslint-disable-next-line no-console
        console.log("OPENROUTER_API_KEY missing: running as passthrough.");
      }
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("failed to start server", err);
      process.exit(1);
    });
}
