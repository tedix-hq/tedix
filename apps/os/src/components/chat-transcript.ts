/** Chat context envelope, run status, draft, hydrate, merge and approval-reconcile helpers for the transcript. */
import type {
	EnqueueHomeMessageOutput,
	HomeMessage,
	HomeRun,
} from "@tedix/api-contract/schemas/kernel-runtime";
import type { QueryClient } from "@tanstack/react-query";
import {
	type ApprovalCardData,
	dedupeDelegations,
} from "@/components/chat-cards";
import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import { provisionalSendMessageId } from "@/lib/provisional-send";
import type { ConversationStreamStatus } from "@/lib/conversation-stream";
import { chatWidgetTargetsFromMetadata } from "@/lib/chat-widget-targets";
import {
	homeMessagesQueryKey,
	homeRunSetQueryKey,
} from "@/lib/os-query-options";
import { asRecord } from "@tedix/api-contract/utils/is-record";
import {
	directReadError,
	directReadResult,
} from "@/components/chat-direct-read";

export type ChatContext = {
	kind: "workspace" | "gadget" | "output";
	id: string;
	label: string;
};

const CONTEXT_PREFIX = "[[tedix-context:";

/** A readable durable envelope rather than browser-only composer state. */
export function encodeChatContext(
	context: ChatContext,
	content: string,
): string {
	return `${CONTEXT_PREFIX}${context.kind}:${context.id}:${encodeURIComponent(context.label)}]]\n\n${content}`;
}

export function decodeChatContext(content: string): {
	context: ChatContext | null;
	content: string;
} {
	if (!content.startsWith(CONTEXT_PREFIX)) return { context: null, content };
	const end = content.indexOf("]]\n\n");
	if (end < 0) return { context: null, content };
	const fields = content.slice(CONTEXT_PREFIX.length, end).split(":");
	if (fields.length !== 3) return { context: null, content };
	const [kind, id, encodedLabel] = fields;
	if (
		(kind !== "workspace" && kind !== "gadget" && kind !== "output") ||
		!id ||
		!encodedLabel
	) {
		return { context: null, content };
	}
	try {
		return {
			context: { kind, id, label: decodeURIComponent(encodedLabel) },
			content: content.slice(end + 4),
		};
	} catch {
		return { context: null, content };
	}
}

/** Run statuses `readRunSet` reports in `activeRunIds` — the running set. */
export const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
	"queued",
	"running",
	"requires_approval",
]);

/** Active work is rendered as live chrome only. Completed delegation history is
 * already represented by its own transcript turn and run detail. */
export function activeDelegations(runs: readonly HomeRun[]) {
	return dedupeDelegations(runs).filter((work) =>
		ACTIVE_RUN_STATUSES.has(work.status),
	);
}

/** The enqueue status union retains a legacy `needs_delegation` sentinel for
 * every fast terminal Kernel turn. Only a typed delegate route is a real
 * request for operator choice; direct Home answers must not show that notice. */
export function needsDelegationChoice(
	output: EnqueueHomeMessageOutput,
): boolean {
	if (output.status !== "needs_delegation") return false;
	const metadata = output.run.metadata;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return false;
	}
	const route = metadata.kernelRoute;
	return Boolean(
		route &&
		typeof route === "object" &&
		!Array.isArray(route) &&
		(route as Record<string, unknown>).routeKind === "delegate_tedi",
	);
}

/** localStorage key for the per-conversation composer draft. A not-yet-created
 * conversation (`conversationId === null`) drafts under the shared "new" key. */
export function chatDraftKey(conversationId: string | null): string {
	return `tedix-os:chat-draft:${conversationId ?? "new"}`;
}

/**
 * The OS creates a conversation with its first persisted turn. An omitted id
 * is deliberately meaningful to the API (it selects the caller's default
 * Home thread), so the synthetic New state must mint an explicit id instead.
 */
export function newHomeConversationId(
	randomUuid: () => string = () => crypto.randomUUID(),
): string {
	return `home:os:${randomUuid()}`;
}

/**
 * Preserve existing and preallocated New-thread ids across retries.
 */
export function conversationIdForSend(
	conversationId: string | null,
	pendingNewConversationId: string | null,
	randomUuid: () => string = () => crypto.randomUUID(),
): string {
	return (
		conversationId ??
		pendingNewConversationId ??
		newHomeConversationId(randomUuid)
	);
}

/** Pure draft restore — storage failures (private mode, quota) read as "". */
export function restoreChatDraft(
	storage: Pick<Storage, "getItem">,
	conversationId: string | null,
): string {
	try {
		return storage.getItem(chatDraftKey(conversationId)) ?? "";
	} catch {
		return "";
	}
}

/**
 * The idempotency key is the run id server-side, so a retry of a failed send
 * must reuse the key verbatim; only a brand-new send mints one. The key is
 * held until the send succeeds — errors keep it for the retry path.
 */
export function nextIdempotencyKey(
	current: string | null,
	generate: () => string = () => crypto.randomUUID(),
): string {
	return current ?? generate();
}

/**
 * Bounded tail for reload-mid-run hydration: `readRunEvents({ tail })` returns
 * at most this many recent events per active run. 200 comfortably covers the
 * delta chunks + tool frames of an in-flight turn without unbounded replay —
 * anything older is durable transcript territory owned by `readMessages`.
 */
export const HYDRATE_RUN_EVENTS_TAIL = 200;

/**
 * Hydrate-once guard: grants hydration for a run id exactly once per guard
 * set (the set is recreated on conversation switch, which re-arms every run).
 * Mutates `hydrated` on a grant so concurrent effect re-runs cannot double
 * fetch the same run.
 */
export function shouldHydrateRun(
	hydrated: Set<string>,
	runId: string,
): boolean {
	if (hydrated.has(runId)) return false;
	hydrated.add(runId);
	return true;
}

/**
 * Id-keyed append of hydrated run events: re-delivery (overlapping tails, an
 * effect racing a conversation refetch) never duplicates an event. Returns
 * `previous` unchanged (same reference) when nothing new arrived so React
 * state updates can bail out.
 */
export function appendHydrateEvents(
	previous: RuntimeStreamEvent[],
	incoming: readonly RuntimeStreamEvent[],
): RuntimeStreamEvent[] {
	const seen = new Set(previous.map((event) => event.id));
	const fresh = incoming.filter((event) => {
		if (seen.has(event.id)) return false;
		seen.add(event.id);
		return true;
	});
	return fresh.length === 0 ? previous : [...previous, ...fresh];
}

export function invalidateHomeTranscript(
	queryClient: Pick<QueryClient, "invalidateQueries">,
	conversationId: string,
): void {
	queryClient.invalidateQueries({
		queryKey: homeMessagesQueryKey(conversationId),
	});
}

/**
 * Focus-convergence handler (pure seam): a returning tab invalidates the run
 * set and the newest transcript slice so multi-tab edits converge — the
 * queries are id-keyed idempotent caches, so re-delivery is a no-op. Chosen
 * over `refetchOnWindowFocus: "always"` because invalidation reuses the exact
 * refresh path the realtime durable-event tap already drives (one convergence
 * mechanism, not two) and stays scoped to this surface instead of changing
 * the query options wherever the hooks are reused.
 */
export function invalidateOnFocus(
	queryClient: Pick<QueryClient, "invalidateQueries">,
	conversationId: string | null,
): void {
	if (conversationId === null) return;
	queryClient.invalidateQueries({
		queryKey: homeRunSetQueryKey(conversationId),
	});
	invalidateHomeTranscript(queryClient, conversationId);
}

/**
 * A pending approval needs one canonical re-read whenever its stream becomes
 * usable. That includes `idle` -> `open` when the shared stream was already
 * established before this conversation mounted: React Query may have retained
 * a run set from an earlier visit, and the approval may have been resolved
 * externally while that cached query was inactive.
 */
export function shouldReconcileApprovalsOnStreamOpen(
	previous: ConversationStreamStatus,
	next: ConversationStreamStatus,
): boolean {
	return next === "open" && previous !== "open";
}

/** A card the operator is still being asked to decide — expiry is terminal. */
export function isUnresolvedApprovalCard(card: ApprovalCardData): boolean {
	return card.expired !== true;
}

/**
 * Reconnect reconciliation. The durable event stream is live-only for state
 * the client did not fold itself: an approval resolved by another tab, the
 * CLI, or an approval rule while this connection was down publishes exactly
 * one `approval.resolved`, and a card that missed it renders "pending"
 * forever between canonical reconciliation ticks. An ordinary reconnect also
 * refreshes immediately instead of waiting for that backstop, querying current
 * state after the subscription reconnects.
 *
 * Bounded on purpose. It refetches the one run set — the batched join that
 * already carries the authoritative state of every card on screen
 * (`approvalsFromRunSet`) — and never the transcript, per-card reads, or run
 * event history. It is skipped entirely when nothing is pending, so a
 * reconnect on a quiet conversation costs no read at all.
 */
export function reconcileApprovalsAfterReconnect(
	queryClient: Pick<QueryClient, "invalidateQueries">,
	conversationId: string | null,
	approvals: readonly ApprovalCardData[],
): boolean {
	if (conversationId === null) return false;
	if (!approvals.some(isUnresolvedApprovalCard)) return false;
	queryClient.invalidateQueries({
		queryKey: homeRunSetQueryKey(conversationId),
	});
	return true;
}

const ROLE_ORDER_RANK: Record<HomeMessage["role"], number> = {
	// Same-instant tie-break: a run's `<runId>:input` row sorts before its
	// `<runId>:assistant` row even when they share a createdAt.
	system: 0,
	user: 1,
	tool: 2,
	runtime: 3,
	assistant: 4,
};

export function compareHomeMessages(a: HomeMessage, b: HomeMessage): number {
	const at = Date.parse(a.createdAt);
	const bt = Date.parse(b.createdAt);
	if (at !== bt) return at - bt;
	const rank = ROLE_ORDER_RANK[a.role] - ROLE_ORDER_RANK[b.role];
	if (rank !== 0) return rank;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Idempotent transcript merge: the cache is keyed by message id, so
 * re-delivery of a message (poll overlap, page overlap, enqueue echo followed
 * by the durable row) is a plain overwrite — never a duplicate bubble.
 * Returns the full cache as an oldest-first ordered array.
 */
export function mergeHomeMessages(
	cache: Map<string, HomeMessage>,
	incoming: readonly HomeMessage[],
): HomeMessage[] {
	for (const message of incoming) cache.set(message.id, message);
	return [...cache.values()].sort(compareHomeMessages);
}

/**
 * A delegated run can settle before its deterministic async-completion message
 * is visible in the transcript. The run projection already carries the exact
 * terminal child preview, so use it to prevent a false "no written response"
 * bubble while the durable message is repaired server-side.
 */
export function applyDelegatedRunPreviews(
	messages: readonly HomeMessage[],
	runs: readonly HomeRun[],
): HomeMessage[] {
	const completedDelegations = new Set(
		messages.flatMap((message) =>
			message.role === "assistant" &&
			message.runId &&
			message.id === `${message.runId}:async-completion:assistant` &&
			message.content.trim()
				? [message.runId]
				: [],
		),
	);
	const runsWithCanonicalAnswer = new Set(
		messages.flatMap((message) =>
			message.role === "assistant" && message.content.trim() && message.runId
				? [message.runId]
				: [],
		),
	);
	const previews = new Map<string, string>();
	const activeRuns = new Set<string>();
	for (const run of runs) {
		if (!run.id) continue;
		if (ACTIVE_RUN_STATUSES.has(run.status)) {
			activeRuns.add(run.id);
			continue;
		}
		const metadata = asRecord(run.metadata);
		const preview = metadata?.childRunPreview;
		if (typeof preview === "string" && preview.trim()) {
			previews.set(run.id, preview);
		}
	}
	return messages.flatMap((message) => {
		const metadata = asRecord(asRecord(message.metadata)?.metadata);
		const workOrder = asRecord(metadata?.delegationWorkOrder);
		// A plain dispatch receipt is superseded by its durable child outcome.
		// Preserve proposals, failures, attachments, and structured results.
		if (
			message.role === "assistant" &&
			message.runId &&
			message.id === `${message.runId}:assistant` &&
			message.childRunId &&
			completedDelegations.has(message.runId) &&
			metadata?.homeSubject === true &&
			!metadata.homePlan &&
			(!workOrder ||
				(workOrder.kind === "tedi.delegate" &&
					workOrder.status !== "requires_approval" &&
					!metadata.approvalRequestId)) &&
			!metadata.delegationError &&
			!message.attachments?.length &&
			chatWidgetTargetsFromMetadata(message.metadata).length === 0 &&
			directReadResult(message) === null &&
			!directReadError(message)
		)
			return [];
		if (
			message.role === "assistant" &&
			!message.content.trim() &&
			message.runId &&
			message.id === `${message.runId}:assistant` &&
			runsWithCanonicalAnswer.has(message.runId)
		) {
			return [];
		}
		if (
			message.role !== "assistant" ||
			message.content.trim() ||
			!message.runId
		)
			return [message];
		// The dispatch acknowledgement can be completed while its child is
		// still running. The canonical run, not that row, owns turn completion.
		if (activeRuns.has(message.runId)) {
			return [{ ...message, status: "streaming" }];
		}
		const preview = previews.get(message.runId);
		return [preview ? { ...message, content: preview } : message];
	});
}

/**
 * The enqueue response does not echo the persisted user message row, but its
 * identity is deterministic (`<runId>:input`), so the transcript renders it
 * straight from the response — when `readMessages` later returns the durable
 * row, the id-keyed cache overwrites this one silently.
 *
 * `status` is derived, not asserted. `normalizeHomeMessage` returns "pending"
 * for a user row whose run is still active and "completed" once it is terminal
 * (`policy-normalization.ts`), so hardcoding "completed" made the bubble flip
 * completed → pending → completed on the first refetch. Mirroring the read's
 * own rule from `run.status` makes the echo converge instead of contradict.
 */
export function userMessageFromEnqueue(
	output: EnqueueHomeMessageOutput,
	content: string,
): HomeMessage {
	return {
		id: provisionalSendMessageId(output.idempotencyKey),
		organizationId: output.run.organizationId,
		conversationId: output.conversationId,
		runId: output.run.id,
		role: "user",
		status: ACTIVE_RUN_STATUSES.has(output.run.status)
			? "pending"
			: "completed",
		content,
		createdAt: output.run.createdAt,
	};
}

/** One execution action per run, on its latest visible message. */
export function executionLinkMessageIds(
	messages: readonly HomeMessage[],
): Set<string> {
	const latest = new Map<string, string>();
	for (const message of messages) {
		if (message.runId) latest.set(message.runId, message.id);
	}
	return new Set(latest.values());
}
export function isBlockingApprovalCard(card: ApprovalCardData): boolean {
	return (
		card.expired !== true &&
		(card.decisionMode ?? "approve_or_reject") === "approve_or_reject"
	);
}

/** Selects one exact-scope approval for the in-memory session allowance. */
export function nextSessionAutoApproval(
	cards: readonly ApprovalCardData[],
	allowedScopes: ReadonlySet<string>,
	attemptedApprovalIds: ReadonlySet<string>,
): ApprovalCardData | null {
	return (
		cards.find(
			(card) =>
				isBlockingApprovalCard(card) &&
				card.sessionScopeKey !== undefined &&
				allowedScopes.has(card.sessionScopeKey) &&
				!attemptedApprovalIds.has(card.approvalId),
		) ?? null
	);
}
