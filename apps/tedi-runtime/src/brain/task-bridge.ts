/**
 * Task-intent → Work Item promotion — HTTP/runtime side.
 *
 * Parity with the retired container task policy/provider shape. The Observer already extracts provider-
 * agnostic `taskIntents` (parsed by `@tedix/context-core/observer`); this
 * module classifies them with the same policy the container uses and promotes
 * the confirmed candidates to proposed canonical Work Items via
 * `platform.createWorkItem`
 * (`workItems.create` RPC → apps/api).
 *
 * Why here: the Agent runtime needs
 * only the pure classification + the platform write. The pure policy is
 * re-implemented here (no Node deps): same thresholds, same actions, a
 * crypto-free FNV-1a idempotency key.
 *
 * State persistence is callback-injected (mirrors the crystallizer's
 * `CrystallizationStateStore`) so the isolate backs idempotency with DO SQLite
 * and a turn never re-promotes a Work Item it already created. Provider sync
 * (Todoist etc.) is intentionally NOT done here — that is supervised, lives in
 * provider adapters and is gated on canonical Work Items.
 */

import type { TaskIntent } from "@tedix/context-core/types";
import type { PlatformClient } from "./platform-client.js";

export type TaskPolicyAction =
	| "ignore"
	| "working_memory"
	| "needs_context"
	| "external_candidate";

export interface TaskPolicyDecision {
	intent: TaskIntent;
	action: TaskPolicyAction;
	reason: string;
}

export interface WorkItemPromotionRef {
	id: string;
	title: string;
	sourceIntentId?: string | null;
}

/**
 * Idempotency-key store. The runtime injects a DO-SQLite-backed implementation;
 * `has`/`add` gate re-promotion of the same intent across turns and restarts.
 *
 * `countForSession` (optional) backs the per-session rolling promotion cap — the
 * only layer that bounds promotions across MANY turns. It is optional so a store
 * that cannot count degrades gracefully to the per-turn budget only.
 */
export interface WorkItemPromotionStore {
	has(idempotencyKey: string): Promise<boolean>;
	add(
		idempotencyKey: string,
		ref: WorkItemPromotionRef,
		sessionKey?: string,
	): Promise<void>;
	countForSession?(sessionKey: string): Promise<number>;
}

interface Logger {
	log(msg: string): void;
	warn(msg: string, err?: unknown): void;
}

const defaultLogger: Logger = {
	log: (msg) => console.log(msg),
	warn: (msg, err) => console.warn(msg, err),
};

/**
 * Normalize a task title for dedup keying: lowercase, collapse internal
 * whitespace, strip trailing punctuation. MUST stay byte-identical to
 * the retired task policy's `normalizeTitleForKey`.
 */
function normalizeTitleForKey(title: string): string {
	return title
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.,;:!?]+$/, "");
}

/**
 * `dueHint`/`deadlineHint` are whatever the Observer's model wrote — an instant
 * when the source stated one, otherwise prose ("today", "immediately",
 * "within 90 seconds of the echo send"). `workItems.dueDate`/`deadline` are
 * scheduler instants (`Date.parse` → urgency), so only a resolvable timestamp
 * may cross that boundary; the raw hint is never discarded, it is carried in
 * `metadata.dueHint`/`metadata.deadlineHint` where it stays readable without
 * ranking anything.
 *
 * Returns the canonical ISO-8601 form the create contract requires, or
 * `undefined` when the hint is not a timestamp at all.
 */
export function resolveIntentInstant(
	hint: string | undefined,
): string | undefined {
	if (!hint) return undefined;
	const trimmed = hint.trim();
	if (!trimmed) return undefined;
	const parsed = Date.parse(trimmed);
	if (!Number.isFinite(parsed)) return undefined;
	return new Date(parsed).toISOString();
}

/**
 * Crypto-free stable key over the identity-bearing intent fields. Matches the
 * retired `stableTaskKey` input shape exactly (same normalized fields, same
 * order; `kind` intentionally dropped so a restated task collapses to one key)
 * but uses FNV-1a so it carries no Node `crypto` dependency.
 */
export function stableIntentKey(
	intent: TaskIntent,
	sessionKey: string,
): string {
	const raw = [
		sessionKey,
		normalizeTitleForKey(intent.title),
		intent.ownerHint?.toLowerCase() ?? "",
		intent.projectHint?.toLowerCase() ?? "",
		intent.dueHint ?? "",
		intent.deadlineHint ?? "",
	].join("|");
	// FNV-1a 32-bit, hex. Stable, dependency-free, collision-resistant enough
	// for per-session dedup of human-readable task titles.
	let hash = 0x811c9dc5;
	for (let i = 0; i < raw.length; i++) {
		hash ^= raw.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Pure policy. Mirrors the retired `classifyTaskIntent` policy exactly:
 *   - done → working_memory (never close a task implicitly)
 *   - confidence < 0.35 → ignore
 *   - blocked/waiting → needs_context
 *   - requiresConfirmation or confidence < 0.65 → working_memory
 *   - confident, but NOT actionable (no owner, no date, and kind is a
 *     speculative candidate/follow_up/delegation) → working_memory. Commitment,
 *     not confidence, is the axis that separates a tracked task from agent
 *     musing — this is what stops a chatty self-talk turn from minting dozens of
 *     accepted Work Items that never receive an execution attempt.
 *   - else (confident AND actionable) → external_candidate (the only action
 *     that promotes a Work Item)
 */
export function classifyTaskIntent(intent: TaskIntent): TaskPolicyDecision {
	if (intent.statusHint === "done") {
		return {
			intent,
			action: "working_memory",
			reason:
				"completion evidence is kept as memory; no task is closed implicitly",
		};
	}
	if (intent.confidence < 0.35) {
		return {
			intent,
			action: "ignore",
			reason: "confidence below tracking threshold",
		};
	}
	if (intent.statusHint === "blocked" || intent.statusHint === "waiting") {
		return {
			intent,
			action: "needs_context",
			reason:
				"blocked or waiting tasks need explicit owner/context before external sync",
		};
	}
	if (intent.requiresConfirmation || intent.confidence < 0.65) {
		return {
			intent,
			action: "working_memory",
			reason:
				"candidate is useful, but not confirmed enough for durable tracking",
		};
	}
	// Commitment gate (parity with task-policy.ts): require an owner, a date, or
	// an inherently-actionable kind. A speculative candidate/follow_up/delegation
	// with no owner and no date is kept as memory, not promoted to a Work Item.
	const isActionable =
		Boolean(intent.ownerHint) ||
		Boolean(intent.deadlineHint) ||
		Boolean(intent.dueHint) ||
		intent.kind === "deadline" ||
		intent.kind === "blocker" ||
		intent.kind === "issue";
	if (!isActionable) {
		return {
			intent,
			action: "working_memory",
			reason:
				"speculative candidate without explicit owner/deadline — kept as memory, not promoted",
		};
	}
	return {
		intent,
		action: "external_candidate",
		reason:
			"confirmed provider-agnostic task candidate; external adapters may sync it later",
	};
}

export function classifyTaskIntents(
	intents: TaskIntent[] | undefined,
): TaskPolicyDecision[] {
	return (intents ?? []).map(classifyTaskIntent);
}

export interface PromoteWorkItemsResult {
	detected: number;
	externalCandidates: number;
	promoted: number;
	/** Confirmed candidates left un-promoted by the per-turn or per-session budget. */
	deferred: number;
	refs: Record<string, WorkItemPromotionRef>;
}

/** Per-turn promotion budget — at most N Work Items minted per single turn. */
export const DEFAULT_MAX_PROMOTIONS_PER_TURN = 3;
/** Per-session rolling promotion budget — bounds the blast radius across turns. */
export const DEFAULT_SESSION_PROMOTION_CAP = 20;

/**
 * Classify the turn's task intents and promote confirmed candidates
 * (`external_candidate`) to canonical Work Items. Idempotent: the injected
 * store gates re-promotion by stable key. Fail-soft per intent — one failed
 * create never aborts the others.
 *
 * Mirrors `TedixContextEngine#promoteWorkItems`: only `external_candidate`
 * decisions promote, provenance + metadata carry the same shape, and the
 * `sourceIntentId` is the stable idempotency key.
 *
 * Promotion budget (defense-in-depth backstop, independent of the commitment
 * gate above): at most `maxPromotionsPerTurn` Work Items per turn (the
 * highest-confidence candidates win), and — when the store can count — at most
 * `sessionCap` per session over a rolling window. A future prompt/model drift
 * that re-floods 5 confident candidates/turn can never again dump dozens of
 * accepted Work Items. Budget skips are reported as `deferred`; idempotent
 * re-promotion skips (`store.has`) are not.
 */
export async function promoteWorkItems(params: {
	taskIntents: TaskIntent[] | undefined;
	platform: PlatformClient;
	store: WorkItemPromotionStore;
	sessionKey: string;
	maxPromotionsPerTurn?: number;
	sessionCap?: number;
	logger?: Logger;
}): Promise<PromoteWorkItemsResult> {
	const { taskIntents, platform, store, sessionKey } = params;
	const maxPromotionsPerTurn =
		params.maxPromotionsPerTurn ?? DEFAULT_MAX_PROMOTIONS_PER_TURN;
	const sessionCap = params.sessionCap ?? DEFAULT_SESSION_PROMOTION_CAP;
	const logger = params.logger ?? defaultLogger;

	const decisions = classifyTaskIntents(taskIntents);
	const allCandidates = decisions.filter(
		(decision) => decision.action === "external_candidate",
	);
	const result: PromoteWorkItemsResult = {
		detected: decisions.length,
		externalCandidates: allCandidates.length,
		promoted: 0,
		deferred: 0,
		refs: {},
	};
	if (allCandidates.length === 0) return result;

	// Per-turn budget: only the top-N by confidence are eligible this turn.
	const candidates = [...allCandidates]
		.sort((a, b) => b.intent.confidence - a.intent.confidence)
		.slice(0, maxPromotionsPerTurn);
	result.deferred += allCandidates.length - candidates.length;

	// Per-session rolling budget (the only cross-turn bound). Fail-soft: if the
	// store cannot count, fall back to the per-turn cap alone.
	let sessionCapActive = typeof store.countForSession === "function";
	let sessionPromoted = 0;
	if (sessionCapActive && store.countForSession) {
		try {
			sessionPromoted = await store.countForSession(sessionKey);
		} catch (err) {
			sessionCapActive = false;
			logger.warn(
				"[brain-bridge.task] session-cap count failed; per-turn cap only",
				err,
			);
		}
	}

	for (const decision of candidates) {
		const { intent } = decision;
		if (sessionCapActive && sessionPromoted >= sessionCap) {
			result.deferred += 1;
			continue;
		}
		const idempotencyKey =
			intent.idempotencyKey ?? stableIntentKey(intent, sessionKey);
		try {
			if (await store.has(idempotencyKey)) continue;
			const workItem = await platform.createWorkItem({
				title: intent.title,
				description: intent.evidence.join("\n") || undefined,
				workKind:
					intent.kind === "issue" || intent.kind === "blocker"
						? "incident"
						: "operations",
				sourceSessionKey: sessionKey,
				sourceIntentId: idempotencyKey,
				dueDate: resolveIntentInstant(intent.dueHint),
				deadline: resolveIntentInstant(intent.deadlineHint),
				provenance: {
					sessionKey,
					source: intent.source,
					evidence: intent.evidence,
				},
				metadata: {
					kind: intent.kind,
					projectHint: intent.projectHint,
					confidence: intent.confidence,
					ownerHint: intent.ownerHint,
					externalProviderHint: intent.externalProviderHint,
					labels: intent.labels ?? [],
					policyReason: decision.reason,
					// The raw model hints, kept verbatim. Only a resolvable instant
					// reaches `dueDate`/`deadline`; this is where the rest survives.
					dueHint: intent.dueHint,
					deadlineHint: intent.deadlineHint,
				},
			});
			const ref: WorkItemPromotionRef = {
				id: workItem.id,
				title: workItem.title,
				sourceIntentId: workItem.sourceIntentId ?? idempotencyKey,
			};
			await store.add(idempotencyKey, ref, sessionKey);
			result.refs[idempotencyKey] = ref;
			result.promoted += 1;
			sessionPromoted += 1;
		} catch (err) {
			logger.warn(
				`[brain-bridge.task] Work Item promotion skipped for "${intent.title}"`,
				err,
			);
		}
	}

	if (result.promoted > 0) {
		logger.log(`[brain-bridge.task] promoted ${result.promoted} Work Item(s)`);
	}
	if (result.deferred > 0) {
		logger.log(
			`[brain-bridge.task] deferred ${result.deferred} candidate(s) over promotion budget`,
		);
	}
	return result;
}
