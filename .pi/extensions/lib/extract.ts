/**
 * Recovering the result envelope from what the model actually wrote.
 *
 * A model asked for "one JSON object and nothing else" will still wrap it in a
 * fence, prefix it with a sentence of prose, or bury it after a paragraph of
 * reasoning. Tolerant extraction keeps a good answer from being thrown away;
 * returning null for anything unusable keeps the caller from guessing.
 */

import { parseResult, validateForPhase, type AgentResult, type Validation } from "./result.ts";
import type { Phase } from "./transitions.ts";

/** Brace matcher that respects strings and escapes, so prose braces cannot fool it. */
function matchObject(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * Pull the last plausible JSON object out of free text.
 * Tries fenced blocks first (last one wins), then the last balanced object.
 */
export function extractJson(text: string): unknown | null {
  if (typeof text !== "string" || text.trim() === "") return null;

  const fences = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)].map((m) => m[1]);
  for (const candidate of fences.reverse()) {
    try {
      return JSON.parse(candidate.trim());
    } catch {
      // not the envelope; keep looking
    }
  }

  // Scan every brace, keep the LONGEST slice that parses.
  //
  // Not right-to-left: for nested JSON the last brace opens the innermost
  // object, so a payload like {"status":"ok","question":{...}} would yield the
  // question instead of the envelope.
  // Not left-to-right either: prose containing "{}" would win over the real
  // object behind it. Longest valid slice wins both ways.
  let best: unknown = null;
  let bestLength = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const end = matchObject(text, i);
    if (end === null) continue;
    const slice = text.slice(i, end + 1);
    if (slice.length <= bestLength) continue;
    try {
      best = JSON.parse(slice);
      bestLength = slice.length;
    } catch {
      // malformed at this offset
    }
  }
  return best;
}

export interface EnvelopeResult {
  valid: boolean;
  result?: AgentResult;
  errors: string[];
  /** The raw text, kept so a repair brief can quote what went wrong. */
  text: string;
}

/** Extract and shape-validate in one step. Meaning is validated later, per phase. */
export function readEnvelope(text: string): EnvelopeResult {
  const raw = extractJson(text);
  if (raw === null) {
    return { valid: false, errors: ["no JSON object found in the reply"], text };
  }
  const parsed = parseResult(raw);
  if (!parsed.valid || !parsed.result) {
    return { valid: false, errors: parsed.errors, text };
  }
  return { valid: true, result: parsed.result, errors: [], text };
}

/**
 * Extract, shape-validate and phase-validate in one step.
 *
 * `errors` is the union of both layers on purpose: the repair brief quotes it
 * verbatim, so the agent sees every problem at once instead of one per turn.
 */
export function readEnvelopeFor(text: string, phase: Phase): EnvelopeResult {
  const envelope = readEnvelope(text);
  if (!envelope.valid || !envelope.result) return envelope;
  const meaning: Validation = validateForPhase(envelope.result, phase);
  if (!meaning.valid) {
    return { valid: false, errors: meaning.errors, text };
  }
  return envelope;
}
