/**
 * Harness-version component hashing + trace-bundle id derivation (pure, shared).
 *
 * Both runtime bodies ensure an `active` HarnessVersion whose `components` is a
 * content-hash map of the live harness inputs (system prompt, model, directive
 * provenance set, MCP app slug, runtime kind). The API bumps the version only
 * when this map changes. Keeping the hash/derivation logic pure + isolated
 * makes it unit-testable and side-effect-free.
 *
 * BODY-NEUTRAL: this module is the single source of truth for the component-hash
 * + id scheme used by the Agent runtime and any future certified body adapter.
 *
 * See `@tedix/api-contract/schemas/harness-version` for the canonical shapes.
 */

const HASH_PREFIX_LEN = 16;

/**
 * Truncated SHA-256 hex of a string. Web Crypto first (Workers / Node ≥20 /
 * browser); a stable weak fallback only if `crypto.subtle` is unavailable so
 * the function never throws in a degraded runtime. Mirrors `computeProvenanceHash`
 * (`./compiler`) so hashes are comparable.
 */
export async function shortHash(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto
		?.subtle;
	if (!subtle) {
		let h = 0;
		for (let i = 0; i < input.length; i++) {
			h = (h * 31 + input.charCodeAt(i)) | 0;
		}
		return (h >>> 0).toString(16).padStart(16, "0").slice(0, HASH_PREFIX_LEN);
	}
	const buf = await subtle.digest("SHA-256", data);
	const bytes = new Uint8Array(buf);
	let hex = "";
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i]!.toString(16).padStart(2, "0");
	}
	return hex.slice(0, HASH_PREFIX_LEN);
}

/**
 * The agent-loop control policy in force for a turn — the runaway-guard ceiling
 * plus the final-step stop rule. Stamped into the `HarnessVersion.components`
 * map as the `loop_policy` component so loop behaviour is versioned/auditable
 * instead of a buried runtime constant: change either field and the next ensure
 * bumps the version. See `apps/tedi-runtime/src/do.ts` (`MAX_CHAT_STEPS` + the
 * forced `toolChoice: "none"` final-step stop).
 */
export interface HarnessLoopPolicy {
	/** Safety ceiling on tool rounds per turn (NOT a turn budget). */
	maxSteps: number;
	/**
	 * Stop rule applied to the final permitted step so a turn always ends with
	 * synthesized text rather than an empty tool-only stop. Stable token, e.g.
	 * `"toolChoice:none"`.
	 */
	finalStepStop: string;
}

/**
 * Compact, human-readable, order-stable descriptor of a {@link HarnessLoopPolicy}.
 * Stored as the `loop_policy` component VALUE — a descriptor (not an opaque hash)
 * keeps the stamped loop behaviour directly auditable in the version row while
 * still bumping the version whenever either field changes.
 */
export function loopPolicyComponent(policy: HarnessLoopPolicy): string {
	return `maxSteps=${policy.maxSteps};finalStep=${policy.finalStepStop}`;
}

/**
 * Inverse of {@link loopPolicyComponent}: parse the `loop_policy` component VALUE
 * back into a {@link HarnessLoopPolicy} so the runtime can READ the policy from
 * the active `HarnessVersion` instead of a hardcoded constant — the read half
 * that makes a stamped policy a *promotable* variant. Pure + fail-soft: returns
 * `null` on any missing/malformed descriptor (and on a non-positive `maxSteps`),
 * so callers fall back to their built-in default and a turn can never break on a
 * bad/absent/old-row policy string. Byte-symmetric with the serializer above
 * (`finalStep` may itself contain a colon, e.g. `toolChoice:none`).
 */
export function parseLoopPolicyComponent(
	value: string | null | undefined,
): HarnessLoopPolicy | null {
	if (!value) return null;
	const match = /^maxSteps=(\d+);finalStep=(.+)$/.exec(value.trim());
	if (!match) return null;
	const maxSteps = Number.parseInt(match[1]!, 10);
	const finalStepStop = match[2]!.trim();
	if (
		!Number.isInteger(maxSteps) ||
		maxSteps < 1 ||
		finalStepStop.length === 0
	) {
		return null;
	}
	return { maxSteps, finalStepStop };
}

export interface HarnessComponentInputs {
	/** The full composed system prompt for the tedi this turn. */
	systemPrompt: string;
	/** Model id / deployment the chat turn runs on. */
	model: string;
	/** Provenance hashes of the active compiled directives (order-independent). */
	directiveProvenanceHashes: string[];
	/** MCP app slug routed to this tedi, if any. */
	mcpAppSlug?: string;
	/** Runtime body class (isolate / container). */
	runtimeKind?: string;
	/**
	 * Agent-loop control policy (max steps + final-step stop rule). Stamped as
	 * the `loop_policy` component when present so loop behaviour is versioned.
	 */
	loopPolicy?: HarnessLoopPolicy;
}

/**
 * Build the `components` content-hash map for a `HarnessVersion`. Keys are drawn
 * from `HarnessComponentSchema`'s well-known vocabulary. The directive set is
 * hashed as a SORTED join so two turns with the same directives (in any order)
 * produce the same `directive_set` hash and therefore do NOT bump the version.
 */
export async function buildHarnessComponents(
	inputs: HarnessComponentInputs,
): Promise<Record<string, string>> {
	const directiveKey = [...inputs.directiveProvenanceHashes].sort().join(",");
	const [promptHash, directiveHash] = await Promise.all([
		shortHash(inputs.systemPrompt),
		shortHash(directiveKey),
	]);
	const components: Record<string, string> = {
		model: inputs.model,
		prompt_template: `sha256:${promptHash}`,
		directive_set: `sha256:${directiveHash}`,
	};
	if (inputs.mcpAppSlug) components.mcp_routing = inputs.mcpAppSlug;
	if (inputs.runtimeKind) components.context_policy = inputs.runtimeKind;
	if (inputs.loopPolicy)
		components.loop_policy = loopPolicyComponent(inputs.loopPolicy);
	return components;
}

/**
 * Order-independent equality of two component maps. Used both server-side (the
 * router) and to short-circuit an ensure call when the cached components already
 * match. Sorting the keys makes the comparison insertion-order-safe.
 */
export function componentsEqual(
	a: Record<string, string>,
	b: Record<string, string>,
): boolean {
	const ak = Object.keys(a).sort();
	const bk = Object.keys(b).sort();
	if (ak.length !== bk.length) return false;
	for (let i = 0; i < ak.length; i++) {
		const key = ak[i]!;
		if (key !== bk[i]) return false;
		if (a[key] !== b[key]) return false;
	}
	return true;
}

export interface HarnessVersionCacheEntry {
	versionId: string;
	components: Record<string, string>;
}

export function matchingHarnessVersionId(
	cache: HarnessVersionCacheEntry | null | undefined,
	components: Record<string, string>,
): string | null {
	if (!cache) return null;
	return componentsEqual(cache.components, components) ? cache.versionId : null;
}

export function harnessVersionCacheEntry(
	versionId: string,
	components: Record<string, string>,
): HarnessVersionCacheEntry {
	return { versionId, components };
}

/** Deterministic trace-bundle id for one run — idempotent on queue retries. */
export function traceBundleId(runId: string): string {
	return `${runId}:bundle`;
}

type TraceReferenceEventId =
	| string
	| null
	| undefined
	| readonly (string | null | undefined)[];

/**
 * Shared trace-reference event-id builder. TraceBundle rows should point at
 * ledger rows the runtime actually wrote; this helper centralizes the small but
 * important filtering/deduping step while preserving first-seen order.
 */
export function traceReferenceEventIds(
	...eventIds: TraceReferenceEventId[]
): string[] {
	const seen = new Set<string>();
	const references: string[] = [];
	for (const value of eventIds) {
		const ids = Array.isArray(value) ? value : [value];
		for (const id of ids) {
			if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
			seen.add(id);
			references.push(id);
		}
	}
	return references;
}

/**
 * Deterministic ledger event ids for one run's `${runId}:${seq}` ledger-mirror
 * scheme. The default terminal sequence is 3, matching the isolate success
 * chain. Failure/recovery callers can pass the last sequence they actually
 * mirrored so TraceBundle rows never reference synthetic events.
 *
 * The optional `conversation.created` event (`${runId}:conv-created`) is
 * included only when `emitConversationCreated` is set, since the mirror writes
 * it only on the conversation's first turn.
 *
 * Runtime callers write the canonical `${runId}:${seq}` event mirror.
 */
export function runEventIds(
	runId: string,
	opts?: { emitConversationCreated?: boolean; terminalSequence?: number },
): string[] {
	const terminalSequence = Math.max(0, opts?.terminalSequence ?? 3);
	const ids = Array.from(
		{ length: terminalSequence + 1 },
		(_, seq) => `${runId}:${seq}`,
	);
	return traceReferenceEventIds(
		opts?.emitConversationCreated ? `${runId}:conv-created` : null,
		ids,
	);
}

// ============================================================================
// Live-turn scoring (Slice B): grade a just-closed production turn into a
// HarnessEvalResult-shaped score/gates/passed WITHOUT calling a model.
// ============================================================================

/**
 * The lane every live-turn score lands on. `validation` is the first promotion
 * gate (`PROMOTION_STAGE_LANE.proposed`), so accumulating live-turn evidence on
 * this lane lets a non-active candidate's `meanScore` be compared to the active
 * version's — the candidate-marking signal Slice B produces. NOTE: this is a
 * MARK-ONLY signal; nothing here flips `promotion_status` to `active`.
 */
export const LIVE_TURN_EVAL_LANE = "validation";

/** Stable task-set id for live, in-production turn scoring. Bump on rubric change. */
export const LIVE_TURN_TASK_SET_ID = "live-turn-v1";

/**
 * The deterministic signals a closed turn exposes at run close. Every field is
 * pre-extracted by the caller (the DO has the outcome, the assistant text, and
 * the per-step tool telemetry in hand) so this grader stays pure + body-neutral.
 */
export interface TurnScoringInput {
	/** Episode outcome label (`success` is the only passing terminal state). */
	outcome:
		| "success"
		| "partial"
		| "failure"
		| "escalated"
		| "aborted"
		| "unknown";
	/** The assistant's produced answer text for the turn (may be empty). */
	assistantText: string;
	/**
	 * Count of tool RESULTS the turn received across all steps. A grounded turn
	 * either returned a non-empty answer OR consumed at least one tool result.
	 */
	toolResultCount: number;
	/**
	 * True when the turn terminated via chat-recovery exhaustion / a hard runtime
	 * error that was NOT recovered. An unrecovered error always fails the turn.
	 */
	unrecoveredError?: boolean;
}

/**
 * Stable, deterministic ids for one live-turn score. The result/run ids are
 * derived from the harness version + lane + runId so a queue retry of the
 * scoring step re-emits the SAME ids and the conflict-do-nothing writes stay
 * idempotent (no duplicate rows, no double-counted meanScore). The trace bundle
 * for the SAME run links to `resultId` so `trace_bundles.evalResultId` is
 * populated.
 */
export function liveTurnEvalIds(
	harnessVersionId: string,
	runId: string,
): { resultId: string; runId: string } {
	return {
		resultId: `her_${harnessVersionId}_${LIVE_TURN_EVAL_LANE}_${runId}`,
		runId: `hrun_${harnessVersionId}_${LIVE_TURN_EVAL_LANE}_${runId}`,
	};
}

/**
 * Pure, deterministic grade of one closed turn — no model, no I/O. Mirrors the
 * substring/threshold gate shape of `scripts/harness/eval-tasks.ts` (gates are
 * the protected metrics the promotion gate AND-reduces) rather than an LLM
 * judge, so the score is reviewable and unit-testable.
 *
 * Gates:
 * - `task_success`: the episode reached `success` AND no unrecovered error.
 * - `grounding`: the turn produced a non-empty assistant answer OR consumed >=1
 *   tool result (it did real work, not an empty/echo reply).
 *
 * `passed` is the AND over the gates. `score` is a deterministic [0,1] blend so
 * a partially-credit turn (e.g. success but no grounding) is distinguishable
 * from a clean pass and a hard fail — the meanScore the candidate accumulates is
 * a real signal, not a binary.
 */
export function gradeTurn(input: TurnScoringInput): {
	score: number;
	gates: Record<string, boolean>;
	passed: boolean;
} {
	const unrecoveredError = input.unrecoveredError === true;
	const taskSuccess = input.outcome === "success" && !unrecoveredError;
	const hasAnswer = input.assistantText.trim().length > 0;
	const hasToolResult = input.toolResultCount > 0;
	const grounding = hasAnswer || hasToolResult;

	const gates: Record<string, boolean> = {
		task_success: taskSuccess,
		grounding,
	};
	const passed = Object.values(gates).every(Boolean);

	// Deterministic [0,1] blend: success carries the bulk of the credit, grounding
	// the rest, so "success but ungrounded" (0.6) and "grounded but not success"
	// (0.4) are both distinguishable from a clean pass (1) and a hard fail (0).
	const score = (taskSuccess ? 0.6 : 0) + (grounding ? 0.4 : 0);

	return { score, gates, passed };
}
