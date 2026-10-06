export const DEFAULT_TEDI_SESSION_KEY = "agent:main:main";
export const RUNTIME_CONTROL_ID_RE = /^[a-zA-Z0-9:._-]+$/;

export type RuntimeRunSurface = "chat" | "mcp" | (string & {});

export function sanitizeRuntimeTurnKey(raw: string): string {
	const cleaned = raw
		.trim()
		.replace(/^<+|>+$/g, "")
		.replace(/:/g, "_")
		.replace(/\s+/g, "_")
		.trim();
	if (!cleaned) {
		throw new Error(
			"sanitizeRuntimeTurnKey: empty turnKey; a stable client-generated id is required",
		);
	}
	return cleaned;
}

function stableRuntimeIdHash(value: string): string {
	let hash = 0xcbf29ce484222325n;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= BigInt(value.charCodeAt(i));
		hash = BigInt.asUintN(64, hash * 0x100000001b3n);
	}
	return hash.toString(16).padStart(16, "0");
}

export function buildRuntimeWorkflowInstanceId(raw: string): string {
	const safe = sanitizeRuntimeTurnKey(raw).replace(/[^a-zA-Z0-9_-]/g, "_");
	if (safe.length <= 64) return safe;
	const suffix = `-${stableRuntimeIdHash(safe)}`;
	return `${safe.slice(0, 64 - suffix.length)}${suffix}`;
}

export function buildRuntimeRunId(input: {
	tediId: string;
	turnKey: string;
	surface?: RuntimeRunSurface;
}): string {
	return `${input.tediId}:${input.surface ?? "chat"}:${sanitizeRuntimeTurnKey(input.turnKey)}`;
}

export function parseRuntimeRunSurface(runId: string): string {
	const parts = runId.split(":");
	return parts.length >= 3 ? (parts[parts.length - 2] ?? "chat") : "chat";
}

export function isEphemeralSessionKey(sessionKey: string | undefined): boolean {
	if (!sessionKey) return false;
	return (
		sessionKey.startsWith("__throwaway:") || sessionKey.startsWith("__test:")
	);
}

/**
 * Session-key prefix minted by the evidence bridge for ONE judge batch:
 * `evidence:judge:{runId}:{claimIds}`.
 *
 * Single source of truth, shared by the producer (`apps/skill-runtime/src/
 * evidence.ts` → `createMcpJudge`) and every consumer that must recognize the
 * turn (`apps/tedi-runtime`). If the two ever drifted apart, the judge would
 * silently regain its memory — see {@link isBlindVerificationSession}.
 */
export const EVIDENCE_JUDGE_SESSION_PREFIX = "evidence:judge:";

/**
 * True for a BLIND VERIFICATION turn: the tedi is being asked a narrow closed
 * question — does THIS passage support THIS claim (`attributable` /
 * `extrapolatory` / `contradictory`) — about a page it cited.
 *
 * The judge is deliberately the same tedi that wrote the interpretation: it owns
 * the domain expertise. That is only sound while the judge is BLIND. It must
 * answer from the passage in front of it and nothing else — **a judge that reads
 * its own memory is not a judge.** Hand it the tedi's accumulated beliefs and it
 * can rubber-stamp a page that never stated the causal story the tedi itself
 * invented last week, and grounding collapses into self-confirmation.
 *
 * So a runtime that sees this key must inject NO accumulated belief into the
 * turn (no compiled directives, no brain digest, no skill guidance) and must not
 * learn from it. Identity, model policy, and the persona/system prompt still
 * apply — that expertise is exactly what the judge is for. Every other session
 * key (Home/chat, mesh, MCP, and the JUDGMENT-writing sessions that consume the
 * verdicts) is unaffected.
 */
export function isBlindVerificationSession(
	sessionKey: string | null | undefined,
): boolean {
	if (!sessionKey) return false;
	return (
		sessionKey.startsWith(EVIDENCE_JUDGE_SESSION_PREFIX) &&
		sessionKey.length > EVIDENCE_JUDGE_SESSION_PREFIX.length
	);
}

/**
 * Session-key prefix for a LEAN WORKFLOW-SYNTHESIS turn: a deterministic
 * skill-workflow asking its tedi for one bounded synthesis (summarize these
 * gathered signals, write this cycle's judgment) with the entire input carried
 * IN the prompt.
 *
 * Distinct from {@link EVIDENCE_JUDGE_SESSION_PREFIX} on purpose: a judge turn
 * is lean for BLINDNESS (a judge that reads its own memory is not a judge); a
 * synthesis turn is lean for cost: a full-context synthesis turn hauls the
 * compiled directives/brain digest into a self-contained summarization task and
 * quickly exhausts a tedi's daily inference budget. A runtime that sees this prefix should
 * skip accumulated-context injection and not learn from the turn; identity,
 * persona, and model policy still apply.
 */
export const WORKFLOW_SYNTH_SESSION_PREFIX = "workflow:synth:";

/** True for a lean workflow-synthesis turn (see the prefix doc above). */
export function isWorkflowSynthesisSession(
	sessionKey: string | null | undefined,
): boolean {
	if (!sessionKey) return false;
	return (
		sessionKey.startsWith(WORKFLOW_SYNTH_SESSION_PREFIX) &&
		sessionKey.length > WORKFLOW_SYNTH_SESSION_PREFIX.length
	);
}

/**
 * True for any turn that must run WITHOUT accumulated-context injection and
 * without writing back to memory — the union of blind verification (judge)
 * and lean workflow synthesis. Use THIS at context-assembly / memory-effects /
 * daily-log gates so the two lean classes cannot drift apart; keep
 * {@link isBlindVerificationSession} for judge-only semantics (facet model
 * pinning, span-checked verdict handling).
 */
export function isLeanContextSession(
	sessionKey: string | null | undefined,
): boolean {
	return (
		isBlindVerificationSession(sessionKey) ||
		isWorkflowSynthesisSession(sessionKey)
	);
}

export function buildTediConversationId(input: {
	tediRef: string;
	sessionKey?: string | null;
	defaultSessionKey?: string;
}): string {
	const tediRef = input.tediRef.trim();
	const sessionKey =
		input.sessionKey || input.defaultSessionKey || DEFAULT_TEDI_SESSION_KEY;
	if (!tediRef) {
		throw new Error("buildTediConversationId: tediRef is required");
	}
	return `${tediRef}:${sessionKey}`;
}

export function sessionKeyFromTediConversationId(input: {
	conversationId: string;
	tediRef?: string | null;
}): string {
	const tediRef = input.tediRef?.trim();
	if (tediRef && input.conversationId.startsWith(`${tediRef}:`)) {
		return input.conversationId.slice(tediRef.length + 1);
	}
	const firstSeparator = input.conversationId.indexOf(":");
	return firstSeparator >= 0
		? input.conversationId.slice(firstSeparator + 1)
		: input.conversationId;
}

export function canonicalizeAgentSessionKey(input: {
	value?: string;
	defaultValue?: string;
	controlIdPattern?: RegExp;
	errorLabel?: string;
}): string {
	const raw = (
		input.value ??
		input.defaultValue ??
		DEFAULT_TEDI_SESSION_KEY
	).trim();
	if (!raw || (input.controlIdPattern && !input.controlIdPattern.test(raw))) {
		throw new Error("Invalid session key");
	}
	if (!raw.toLowerCase().startsWith("agent:")) {
		return raw;
	}

	const parts = raw.toLowerCase().split(":");
	if (parts.some((part) => part.length === 0) || parts.length < 2) {
		const label = input.errorLabel ? `${input.errorLabel} ` : "";
		throw new Error(
			`Invalid ${label}agent session key; expected agent:<agentId>:<session>`,
		);
	}
	if (parts.length === 2) {
		return `${parts[0]}:${parts[1]}:main`;
	}
	return parts.join(":");
}

export function resolveRuntimeSessionKey(input: {
	candidates: unknown[];
	defaultValue?: string;
	errorLabel?: string;
}): string | undefined {
	for (const candidate of input.candidates) {
		if (typeof candidate !== "string") continue;
		const value = candidate.trim();
		if (!value) continue;
		return canonicalizeAgentSessionKey({
			value,
			errorLabel: input.errorLabel,
		});
	}
	if (!input.defaultValue) return undefined;
	return canonicalizeAgentSessionKey({
		value: input.defaultValue,
		errorLabel: input.errorLabel,
	});
}

export function agentSessionKeyWasExpanded(input: {
	raw: string;
	canonical: string;
}): boolean {
	return (
		input.raw.toLowerCase().startsWith("agent:") &&
		input.raw.split(":").filter(Boolean).length === 2 &&
		input.canonical !== input.raw
	);
}
