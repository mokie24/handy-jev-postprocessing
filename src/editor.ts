/**
 * Deterministic text edits. Jev decides spans; this module applies them
 * using exact character offsets. Never generates wording.
 */
import { indexById } from "./tokenizer.js";
import type { JevDecision, WordToken } from "./types.js";

export interface Validation {
  ok: boolean;
  reason: string;
}

function getRange(
  byId: Map<string, number>,
  startId: string,
  endId: string,
): { si: number; ei: number } | null {
  const si = byId.get(startId);
  const ei = byId.get(endId);
  if (si === undefined || ei === undefined) return null;
  if (si > ei) return null;
  return { si, ei };
}

/**
 * Shared span validation. Returns ok=false with a reason for any
 * malformed / out-of-order / overlapping selection.
 */
export function validateDecision(
  tokens: WordToken[],
  d: JevDecision,
): Validation {
  const byId = indexById(tokens);
  const op = d.operation;

  if (op === "keep" || op === "unsupported") {
    return { ok: true, reason: `${op}: no edit` };
  }

  const need = (id: string, name: string): Validation | null => {
    if (id === "none") return { ok: false, reason: `${name} is none` };
    if (!byId.has(id)) return { ok: false, reason: `${name} ${id} unknown` };
    return null;
  };

  if (op === "delete") {
    for (const [id, name] of [
      [d.target_start, "target_start"],
      [d.target_end, "target_end"],
    ] as const) {
      const err = need(id, name);
      if (err) return err;
    }
    const r = getRange(byId, d.target_start, d.target_end);
    if (!r) return { ok: false, reason: "delete: bad target ordering" };
    // Conservative veto (bias to keep, never reinterpret): a repetition
    // repair must leave one instance behind. If the whole target span is
    // the same word repeated (e.g. "I I"), deleting it would erase every
    // copy — that never reflects speaker intent, so preserve the original.
    // This veto can only PREVENT edits, never create or alter them.
    if (r.ei > r.si) {
      const words = tokens
        .slice(r.si, r.ei + 1)
        .map((t) => t.text.toLowerCase());
      if (words.every((w) => w === words[0])) {
        return {
          ok: false,
          reason: "delete: would erase all copies of a repeated word",
        };
      }
    }
    return { ok: true, reason: "delete ok" };
  }

  if (
    op === "paragraph_break" ||
    op === "line_break" ||
    op === "bullet_break"
  ) {
    for (const [id, name] of [
      [d.target_start, "target_start"],
      [d.target_end, "target_end"],
    ] as const) {
      const err = need(id, name);
      if (err) return err;
    }
    const r = getRange(byId, d.target_start, d.target_end);
    if (!r) return { ok: false, reason: `${op}: bad target ordering` };
    return { ok: true, reason: `${op} ok` };
  }

  if (op === "replace_from_source") {
    for (const [id, name] of [
      [d.target_start, "target_start"],
      [d.target_end, "target_end"],
      [d.source_start, "source_start"],
      [d.source_end, "source_end"],
      [d.cleanup_start, "cleanup_start"],
    ] as const) {
      const err = need(id, name);
      if (err) return err;
    }
    const t = getRange(byId, d.target_start, d.target_end);
    const s = getRange(byId, d.source_start, d.source_end);
    if (!t) return { ok: false, reason: "replace: bad target ordering" };
    if (!s) return { ok: false, reason: "replace: bad source ordering" };
    const ci = byId.get(d.cleanup_start)!;
    const siS = byId.get(d.source_start)!;
    // cleanup must start at or before source start
    if (ci > siS) return { ok: false, reason: "replace: cleanup after source" };
    // source must occur after target (strictly)
    if (siS <= t.ei) {
      return { ok: false, reason: "replace: source not after target" };
    }
    // cleanup must be after target
    if (ci <= t.ei) {
      return { ok: false, reason: "replace: cleanup not after target" };
    }
    // character offsets must be monotonic (defensive; index order implies it)
    const tS = tokens[t.si].start;
    const tE = tokens[t.ei].end;
    const cS = tokens[ci].start;
    const sE = tokens[s.ei].end;
    if (!(tS <= tE && tE <= cS && cS <= sE)) {
      return { ok: false, reason: "replace: bad char ordering" };
    }
    if (sE > Number.MAX_SAFE_INTEGER) {
      return { ok: false, reason: "replace: bad offsets" };
    }
    return { ok: true, reason: "replace ok" };
  }

  return { ok: false, reason: `unknown operation ${op}` };
}

/** Collapse only directly-affected artefacts: double spaces, space-before-punct, doubled periods/commas. */
export function normalizeEditedText(s: string): string {
  let out = s;
  out = out.replace(/[ \t]{2,}/g, " ");
  out = out.replace(/[ \t]+([,.;:!?])/g, "$1");
  out = out.replace(/\.(\s*\.)+/g, ".");
  out = out.replace(/,(\s*,)+/g, ",");
  // stray comma left as ", at" from a dropped ", " scaffold is already
  // removed via middle-drop; this is a last-resort guard for ",\n"-style
  // leftovers is intentionally NOT applied globally (would risk false
  // changes), so only fix the clear double-space + orphan cases above.
  return out.trim();
}

function middleHasWords(middle: string): boolean {
  return /[A-Za-z0-9]/.test(middle);
}

export function applyDelete(
  text: string,
  tokens: WordToken[],
  targetStartId: string,
  targetEndId: string,
): string | null {
  const byId = indexById(tokens);
  const r = getRange(byId, targetStartId, targetEndId);
  if (!r) return null;
  const tS = tokens[r.si].start;
  const tE = tokens[r.ei].end;
  if (tS > tE) return null;
  const raw = text.slice(0, tS) + text.slice(tE);
  return normalizeEditedText(raw);
}

export function applyReplaceFromSource(
  text: string,
  tokens: WordToken[],
  targetStartId: string,
  targetEndId: string,
  sourceStartId: string,
  sourceEndId: string,
  cleanupStartId: string,
): string | null {
  const byId = indexById(tokens);
  const t = getRange(byId, targetStartId, targetEndId);
  const s = getRange(byId, sourceStartId, sourceEndId);
  const ci = byId.get(cleanupStartId);
  if (!t || !s || ci === undefined) return null;
  if (ci > s.si) return null;
  if (s.si <= t.ei) return null;
  if (ci <= t.ei) return null;

  const tS = tokens[t.si].start;
  const tE = tokens[t.ei].end;
  const cS = tokens[ci].start;
  const sS = tokens[s.si].start;
  const sE = tokens[s.ei].end;
  if (!(tS <= tE && tE <= cS && cS <= sE && sS <= sE)) return null;

  const replacement = text.slice(sS, sE);
  if (!replacement || !replacement.trim()) return null;
  const prefix = text.slice(0, tS);
  let middle = text.slice(tE, cS);
  // Repair scaffolding between target and cleanup (", ", " ") carries no
  // kept words — drop it. If it carries kept words (" tickets. "), keep it.
  if (!middleHasWords(middle)) middle = "";
  const suffix = text.slice(sE);
  const raw = prefix + replacement + middle + suffix;
  return normalizeEditedText(raw);
}

export function applyFormatBreak(
  text: string,
  tokens: WordToken[],
  targetStartId: string,
  targetEndId: string,
  op: "paragraph_break" | "line_break" | "bullet_break",
): string | null {
  const byId = indexById(tokens);
  const r = getRange(byId, targetStartId, targetEndId);
  if (!r) return null;
  const tS = tokens[r.si].start;
  const tE = tokens[r.ei].end;
  const prefix = text.slice(0, tS).replace(/[ \t]+$/g, "");
  const suffix = text.slice(tE).replace(/^[ \t]+/g, "");
  // If the command spans to a sentence boundary, the suffix may start with
  // leftover punctuation (". ", ", "). Only strip leading ",;:" — never a
  // sentence-final period that belongs to the prefix side. Keep it minimal:
  const suffixTrimmed = suffix.replace(/^[,;:]\s*/g, "");

  if (!prefix.trim()) {
    // Command at the very start: no leading break.
    if (op === "bullet_break") return (`- ${suffixTrimmed}`).trimEnd();
    return suffixTrimmed;
  }
  if (!suffixTrimmed.trim()) {
    return prefix.trimEnd();
  }
  if (op === "paragraph_break") return `${prefix.trimEnd()}\n\n${suffixTrimmed}`;
  if (op === "line_break") return `${prefix.trimEnd()}\n${suffixTrimmed}`;
  return `${prefix.trimEnd()}\n- ${suffixTrimmed}`;
}

/**
 * Dispatch a validated JevDecision. Returns the edited text, or null when
 * the decision is keep/unsupported/invalid (caller must preserve original).
 */
export function applyDecision(
  text: string,
  tokens: WordToken[],
  d: JevDecision,
): string | null {
  const v = validateDecision(tokens, d);
  if (!v.ok) return null;
  switch (d.operation) {
    case "keep":
    case "unsupported":
      return null;
    case "delete":
      return applyDelete(text, tokens, d.target_start, d.target_end);
    case "replace_from_source":
      return applyReplaceFromSource(
        text,
        tokens,
        d.target_start,
        d.target_end,
        d.source_start,
        d.source_end,
        d.cleanup_start,
      );
    case "paragraph_break":
    case "line_break":
    case "bullet_break":
      return applyFormatBreak(
        text,
        tokens,
        d.target_start,
        d.target_end,
        d.operation,
      );
    default:
      return null;
  }
}
