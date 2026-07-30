import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ChunkCitation, RunContext } from "./notes.ts";
import { getChunkCitation } from "./notes.ts";

export const ANSWER_SENTINEL = "[[PAPERTABLE_ANSWER_START]]";

export type TerminalResult = "completed" | "partial" | "refused" | "failed" | "aborted";
export type TerminalReason =
  | "none"
  | "insufficient_evidence"
  | "protocol_error"
  | "citation_error"
  | "provider_error"
  | "startup_error"
  | "process_interrupted"
  | "user_abort";

export type Terminal = {
  result: TerminalResult;
  reason: TerminalReason;
  error?: string;
  answer?: string;
  citations: PublicCitation[];
};

export type PublicCitation = Omit<ChunkCitation, "actualPath">;

export class AnswerSentenceGate {
  #context: RunContext;
  #onSentence: (sentence: string, answer: string) => void;
  #onCitation: (citation: PublicCitation) => void;
  #raw = "";
  #answer = "";
  #started = false;
  #emittedKeys = new Set<string>();
  #citations = new Map<string, PublicCitation>();
  #protocolViolation = false;
  #citationViolation = false;
  #hasSubstantiveEvidence = false;

  constructor(
    context: RunContext,
    callbacks: {
      onSentence: (sentence: string, answer: string) => void;
      onCitation: (citation: PublicCitation) => void;
    },
  ) {
    this.#context = context;
    this.#onSentence = callbacks.onSentence;
    this.#onCitation = callbacks.onCitation;
  }

  feed(delta: string): void {
    if (!delta) return;
    this.#raw += delta;
    this.#sync(false);
  }

  finish(): void {
    this.#sync(true);
  }

  get answer(): string {
    return this.#hasSubstantiveEvidence ? this.#answer.trim() : "";
  }

  get citations(): PublicCitation[] {
    return [...this.#citations.values()];
  }

  get started(): boolean {
    return this.#started;
  }

  get emitted(): boolean {
    return this.#answer.trim().length > 0;
  }

  get protocolViolation(): boolean {
    return this.#protocolViolation;
  }

  get citationViolation(): boolean {
    return this.#citationViolation;
  }

  #sync(flush: boolean): void {
    const parsed = safePieces(this.#raw, this.#context, flush);
    this.#started ||= parsed.started;
    this.#protocolViolation ||= parsed.protocolViolation;
    this.#citationViolation ||= parsed.citationViolation;
    for (const piece of parsed.pieces) {
      const pieceKey = piece.substantive
        ? `claim:${normalizedClaim(piece.text)}`
        : `structure:${piece.text}`;
      if (this.#emittedKeys.has(pieceKey)) continue;
      this.#emittedKeys.add(pieceKey);
      for (const citation of piece.citations) {
        if (this.#citations.has(citation.chunkId)) continue;
        this.#citations.set(citation.chunkId, citation);
        this.#onCitation(citation);
      }
      this.#hasSubstantiveEvidence ||= piece.substantive;
      this.#answer += piece.text;
      this.#onSentence(piece.text, this.#answer.trim());
    }
  }
}

export function gateAnswer(rawAnswer: string, context: RunContext): Terminal {
  if (context.readIds.size === 0) {
    return { result: "refused", reason: "insufficient_evidence", citations: [] };
  }
  const afterSentinel = textAfterSentinel(rawAnswer);
  if (afterSentinel === undefined) {
    return { result: "failed", reason: "protocol_error", citations: [] };
  }
  const parsed = safePieces(rawAnswer, context, true);
  const answer = parsed.pieces.map((piece) => piece.text).join("");
  const citations = new Map<string, PublicCitation>();
  for (const piece of parsed.pieces) {
    for (const citation of piece.citations) citations.set(citation.chunkId, citation);
  }
  if (
    citations.size === 0
    || !answer.trim()
    || !parsed.pieces.some((piece) => piece.substantive)
  ) {
    return { result: "failed", reason: "citation_error", citations: [] };
  }
  return {
    result: "completed",
    reason: "none",
    answer: answer.trim(),
    citations: [...citations.values()],
  };
}

type SafePiece = {
  text: string;
  citations: PublicCitation[];
  substantive: boolean;
};

function safePieces(
  rawAnswer: string,
  context: RunContext,
  flush: boolean,
): {
  started: boolean;
  pieces: SafePiece[];
  protocolViolation: boolean;
  citationViolation: boolean;
} {
  const afterSentinel = textAfterSentinel(rawAnswer);
  if (afterSentinel === undefined) {
    return {
      started: false,
      pieces: [],
      protocolViolation: false,
      citationViolation: false,
    };
  }
  const protocol = new ProtocolSanitizer();
  let remaining = protocol.feed(afterSentinel);
  if (flush) remaining += protocol.finish();
  const pieces: SafePiece[] = [];
  const seenClaims = new Set<string>();
  let citationViolation = false;
  while (remaining) {
    const boundary = nextSentenceBoundary(remaining, flush);
    if (boundary < 0 && !flush) break;
    const end = boundary < 0 ? remaining.length : boundary;
    const candidate = remaining.slice(0, end);
    remaining = remaining.slice(end);
    if (!candidate) break;
    const cleaned = validateCitations(candidate, context);
    if (cleaned.hadInvalidCitation && cleaned.citations.length === 0) {
      citationViolation = true;
      continue;
    }
    if (!cleaned.text.trim()) continue;
    if (cleaned.citations.length === 0 && !isStructuralText(cleaned.text)) {
      citationViolation = true;
      continue;
    }
    const substantive = cleaned.citations.length > 0 && isSubstantiveText(cleaned.text);
    if (cleaned.citations.length > 0 && !substantive && !isStructuralText(cleaned.text)) {
      citationViolation = true;
      continue;
    }
    const claimIdentity = substantive ? normalizedClaim(cleaned.text) : "";
    if (claimIdentity && seenClaims.has(claimIdentity)) continue;
    if (claimIdentity) seenClaims.add(claimIdentity);
    pieces.push({ text: cleaned.text, citations: cleaned.citations, substantive });
    if (boundary < 0) break;
  }
  return {
    started: true,
    pieces,
    protocolViolation: protocol.violation,
    citationViolation,
  };
}

export function sanitizeAssistantMessage(
  message: AssistantMessage,
  context: RunContext,
): AssistantMessage {
  const hasToolCall = message.content.some((block) => block.type === "toolCall");
  if (hasToolCall) {
    return {
      ...message,
      content: message.content.filter((block) => block.type === "toolCall"),
    };
  }
  const rawText = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const terminal = gateAnswer(rawText, context);
  return {
    ...message,
    content: terminal.answer ? [{ type: "text", text: terminal.answer }] : [],
  };
}

export function abortedTerminal(answer = "", citations: PublicCitation[] = []): Terminal {
  return {
    result: "aborted",
    reason: "user_abort",
    ...(answer.trim() ? { answer: answer.trim(), citations } : { citations: [] }),
  };
}

export function providerErrorTerminal(
  error: string | undefined,
  answer = "",
  citations: PublicCitation[] = [],
): Terminal {
  return answer.trim()
    ? { result: "partial", reason: "provider_error", answer: answer.trim(), citations, ...(error ? { error } : {}) }
    : { result: "failed", reason: "provider_error", citations: [], ...(error ? { error } : {}) };
}

export function protocolErrorTerminal(
  answer = "",
  citations: PublicCitation[] = [],
): Terminal {
  return answer.trim()
    ? { result: "partial", reason: "protocol_error", answer: answer.trim(), citations }
    : { result: "failed", reason: "protocol_error", citations: [] };
}

export function startupErrorTerminal(error?: string): Terminal {
  return { result: "failed", reason: "startup_error", ...(error ? { error } : {}), citations: [] };
}

export function interruptedTerminal(
  answer = "",
  citations: PublicCitation[] = [],
): Terminal {
  return answer.trim()
    ? { result: "partial", reason: "process_interrupted", answer: answer.trim(), citations }
    : { result: "failed", reason: "provider_error", error: "process_interrupted", citations: [] };
}

function textAfterSentinel(text: string): string | undefined {
  const index = text.indexOf(ANSWER_SENTINEL);
  return index < 0 ? undefined : text.slice(index + ANSWER_SENTINEL.length);
}

function validateCitations(text: string, context: RunContext): {
  text: string;
  citations: PublicCitation[];
  hadInvalidCitation: boolean;
} {
  const citations = new Map<string, PublicCitation>();
  let hadInvalidCitation = false;
  const cleaned = text
    .replace(/\[\[source:([^\]]*)\]\]/g, (token, rawChunkId: string) => {
      const chunkId = rawChunkId.trim();
      if (!chunkId || /\s/u.test(chunkId)) {
        hadInvalidCitation = true;
        return "";
      }
      const full = getChunkCitation(context, chunkId);
      if (!full) {
        hadInvalidCitation = true;
        return "";
      }
      const { actualPath: _actualPath, ...citation } = full;
      citations.set(chunkId, citation);
      return token;
    });
  return { text: cleaned, citations: [...citations.values()], hadInvalidCitation };
}

function nextSentenceBoundary(text: string, flush = false): number {
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\n") return index + 1;
    const isPunctuation = "。！？!?；;".includes(character)
      || (character === "." && (index + 1 === text.length || /\s/u.test(text[index + 1])));
    if (!isPunctuation) continue;
    const after = text.slice(index + 1);
    if (!after && !flush) return -1;
    const citationSuffix = after.match(/^(\s*\[\[source:[^\]]+\]\])+/u)?.[0];
    if (citationSuffix) {
      const suffixEnd = index + 1 + citationSuffix.length;
      if (suffixEnd === text.length && !flush) return -1;
      if (
        !flush
        && /^\s*\[\[(?:source(?::[^\]]*)?)?$/u.test(text.slice(suffixEnd))
      ) {
        return -1;
      }
      return text[suffixEnd] === "\n" ? suffixEnd + 1 : suffixEnd;
    }
    if (!flush && /^\s*(?:\[\[source:[^\]]*)?$/u.test(after)) return -1;
    return index + 1;
  }
  return -1;
}

function isStructuralText(text: string): boolean {
  const value = text
    .replace(/\[\[source:[^\]]+\]\]/g, "")
    .trim();
  return !value
    || /^#{1,6}\s/u.test(value)
    || /^-{3,}$/u.test(value)
    || /[:：]$/u.test(value);
}

function isSubstantiveText(text: string): boolean {
  if (isStructuralText(text)) return false;
  const value = text
    .replace(/\[\[source:[^\]]+\]\]/g, "")
    .replace(/[\s#>*_`"'“”‘’()[\]{}.,，。:：;；!?！？\-—–/\\|]+/gu, "");
  return /[\p{L}\p{N}]/u.test(value);
}

function normalizedClaim(text: string): string {
  return text
    .replace(/\[\[source:[^\]]+\]\]/g, "")
    .replace(/^\s*(?:[-+*]|\d+[.)、])\s*/u, "")
    .replace(/[\s#>*_`"'“”‘’()[\]{}.,，。:：;；!?！？\-—–/\\|]+/gu, "")
    .toLocaleLowerCase();
}

export function stripProtocol(text: string): string {
  return text
    .replace(/<(?:analysis|thinking|system|assistant|tool)[^>]*>[\s\S]*?<\/(?:analysis|thinking|system|assistant|tool)>/gi, "")
    .replace(/<\/?(?:analysis|thinking|system|assistant|tool|final|answer)[^>]*>/gi, "")
    .replaceAll(ANSWER_SENTINEL, "");
}

class ProtocolSanitizer {
  #buffer = "";
  #hidden: "analysis" | "thinking" | "system" | "assistant" | "tool" | null = null;
  violation = false;

  feed(value: string): string {
    this.#buffer += value;
    let visible = "";
    for (;;) {
      const open = this.#buffer.indexOf("<");
      if (open < 0) {
        if (this.#hidden) {
          this.#buffer = this.#buffer.slice(-32);
        } else {
          visible += this.#buffer;
          this.#buffer = "";
        }
        return visible;
      }
      if (!this.#hidden) visible += this.#buffer.slice(0, open);
      this.#buffer = this.#buffer.slice(open);
      const close = this.#buffer.indexOf(">");
      if (close < 0) return visible;
      const tag = this.#buffer.slice(0, close + 1);
      this.#buffer = this.#buffer.slice(close + 1);
      const match = tag.match(/^<\s*(\/?)\s*(analysis|thinking|system|assistant|tool|final|answer)\b/i);
      if (!match) {
        if (!this.#hidden) visible += tag;
        continue;
      }
      this.violation = true;
      const closing = Boolean(match[1]);
      const name = match[2].toLowerCase();
      if (["analysis", "thinking", "system", "assistant", "tool"].includes(name)) {
        if (closing && this.#hidden === name) this.#hidden = null;
        else if (!closing) {
          this.#hidden = name as "analysis" | "thinking" | "system" | "assistant" | "tool";
        }
      }
    }
  }

  finish(): string {
    const visible = this.#hidden ? "" : this.#buffer.replace(/<[^>]*$/u, "");
    if (this.#buffer !== visible) this.violation = true;
    this.#buffer = "";
    return visible;
  }
}
