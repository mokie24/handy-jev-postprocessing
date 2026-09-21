/**
 * OpenRouter Decisions client for TypeSafe Jev.
 *
 * POST https://openrouter.ai/api/alpha/decisions
 * Body: { model, state: { raw_transcript, tagged_transcript }, questions }
 * Six `choice` questions are asked in one request; no LLM generates text.
 */
import { z } from "zod";
import { toTaggedTranscript } from "./tokenizer.js";
import type { JevDecision, Operation, WordToken } from "./types.js";

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

const ChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number().optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
});

const DecisionsResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string(),
  provider: z.string().optional(),
  answers: z.record(
    z.string(),
    z.union([
      ChoiceAnswerSchema,
      z.object({ type: z.string() }).passthrough(),
    ]),
  ),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cost: z.number().optional(),
    })
    .optional(),
});

export interface DecideOptions {
  model: string;
  apiKey: string;
  timeoutMs: number;
  referer?: string;
  fetchImpl?: typeof fetch;
}

interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

function tokenCriteria(tokens: WordToken[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const t of tokens) {
    // Values stay minimal on purpose: the tagged transcript in state already
    // maps every ID to its word, so repeating it here would only burn input
    // tokens. Keys (the IDs + "none") are what Jev chooses among.
    criteria[t.id] = `"${t.text}"`;
  }
  criteria["none"] = "No span.";
  return criteria;
}

export function buildQuestions(tokens: WordToken[]): Record<string, ChoiceQuestion> {
  // Note: the full ID list is NOT repeated here — the question criteria keys
  // already enumerate every token ID, and the tagged transcript maps them.
  const spanNote = `Answer a listed token ID or "none".`;
  return {
    operation: {
      type: "choice",
      instructions:
        "What single repair/formatting decision fits this transcript? When unsure, choose keep. " +
        "keep = intentional speech, nothing to change. " +
        "replace_from_source = later words replace earlier words (e.g. 'Thursday, sorry, Friday'; 'four tickets. No, three.'). " +
        "delete = abandoned false start or filler gone entirely, or for a repeated word ONLY the extra copy. " +
        "paragraph_break/line_break/bullet_break = real spoken formatting command (e.g. 'Project update new paragraph migration is complete.' is a paragraph_break on 'new paragraph'; but 'The button should display the words new paragraph.' is keep). " +
        "unsupported = needs generated wording or absent context.",
      criteria: {
        keep: "Intentional speech, nothing to change — even with actually/sorry/no/very.",
        replace_from_source: "Later words replace earlier words.",
        delete:
          "An abandoned false start or clear filler that should disappear entirely, or — for a repeated word — ONLY the extra copy (one instance must remain, e.g. in 'I I think' delete just one 'I').",
        paragraph_break: "Speaker issued an actual 'new paragraph' formatting command.",
        line_break: "Speaker issued an actual 'new line' formatting command.",
        bullet_break: "Speaker issued an actual 'new bullet' / 'bullet point' formatting command.",
        unsupported:
          "Requires generated wording or unavailable document context.",
      },
    },
    target_start: {
      type: "choice",
      instructions: `First token of the earlier material to replace/delete, or of a spoken command. Only mark genuinely abandoned material or a real command. ${spanNote}`,
      criteria: tokenCriteria(tokens),
    },
    target_end: {
      type: "choice",
      instructions: `Last token of ONLY the earlier material/command — usually the SAME token as target_start (repetition: never span both copies). 'none' only when no target exists. Never include other sentence words in the target: neither words after the repair ('at three') nor words between target and repair ('tickets', 'copies') — they belong to the kept sentence. ${spanNote}`,
      criteria: tokenCriteria(tokens),
    },
    source_start: {
      type: "choice",
      instructions: `For replace_from_source only: first token of the later wording that should replace the target. Must occur AFTER the target. Otherwise "none". ${spanNote}`,
      criteria: tokenCriteria(tokens),
    },
    source_end: {
      type: "choice",
      instructions: `For replace_from_source only: last token of ONLY the later replacement wording — usually a SINGLE word; do NOT include trailing words that belong to the rest of the sentence. Otherwise "none". ${spanNote}`,
      criteria: tokenCriteria(tokens),
    },
    cleanup_start: {
      type: "choice",
      instructions:
        `For replace_from_source only: first token of the later repair fragment to remove after copying (e.g. in "Thursday, sorry, Friday" cleanup starts at "sorry"; if no repair marker, equals source_start). Otherwise "none". ${spanNote}`,
      criteria: tokenCriteria(tokens),
    },
  };
}

function asChoice(
  answers: Record<string, unknown>,
  name: string,
): { choice: string; confidence: number; probabilities?: Record<string, number> } | null {
  const a = answers[name] as
    | { type?: string; choice?: unknown; confidence?: unknown; probabilities?: unknown }
    | undefined;
  if (!a || a.type !== "choice" || typeof a.choice !== "string") return null;
  const confidence =
    typeof a.confidence === "number" && Number.isFinite(a.confidence)
      ? a.confidence
      : 0;
  const probabilities =
    a.probabilities && typeof a.probabilities === "object"
      ? (a.probabilities as Record<string, number>)
      : undefined;
  return { choice: a.choice, confidence, probabilities };
}

const VALID_OPS: Operation[] = [
  "keep",
  "replace_from_source",
  "delete",
  "paragraph_break",
  "line_break",
  "bullet_break",
  "unsupported",
];

/**
 * One Jev Decisions request. Throws on network/timeout/malformed output —
 * the processor must catch and fall back to the original transcript.
 */
export async function decideWithJev(
  rawTranscript: string,
  tokens: WordToken[],
  opts: DecideOptions,
): Promise<JevDecision> {
  if (!opts.apiKey) throw new Error("missing OPENROUTER_API_KEY");
  const tagged = toTaggedTranscript(tokens);
  const body = {
    model: opts.model,
    state: { raw_transcript: rawTranscript, tagged_transcript: tagged },
    questions: buildQuestions(tokens),
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(DECISIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": opts.referer ?? "http://127.0.0.1:11434/",
        "X-Title": "handy-jev-postprocessing",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`openrouter fetch failed: ${(e as Error).message}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`openrouter ${res.status}: ${text.slice(0, 300)}`);
  }
  const json: unknown = await res.json();
  const parsed = DecisionsResponseSchema.safeParse(json);
  if (!parsed.success) throw new Error("malformed decisions response");

  const answers = parsed.data.answers as Record<string, unknown>;
  const op = asChoice(answers, "operation");
  if (!op || !VALID_OPS.includes(op.choice as Operation)) {
    throw new Error("malformed operation answer");
  }
  const tS = asChoice(answers, "target_start");
  const tE = asChoice(answers, "target_end");
  const sS = asChoice(answers, "source_start");
  const sE = asChoice(answers, "source_end");
  const cS = asChoice(answers, "cleanup_start");
  if (!tS || !tE || !sS || !sE || !cS) {
    throw new Error("malformed span answers");
  }
  return {
    operation: op.choice as Operation,
    target_start: tS.choice,
    target_end: tE.choice,
    source_start: sS.choice,
    source_end: sE.choice,
    cleanup_start: cS.choice,
    confidence: op.confidence,
    probabilities: op.probabilities,
    usage: parsed.data.usage
      ? {
          input_tokens: parsed.data.usage.input_tokens,
          output_tokens: parsed.data.usage.output_tokens,
        }
      : undefined,
  };
}
