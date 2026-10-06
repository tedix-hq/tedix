/**
 * TanStack Query cache patches driven by the durable event stream.
 *
 * The rule this module enforces: a durable event that CARRIES the mutated
 * fields patches the cache in place; an event that only ANNOUNCES a change the
 * client cannot reconstruct invalidates the narrowest key that owns it. Before
 * this, every kind in `DURABLE_TRANSCRIPT_EVENT_KINDS` invalidated the whole
 * transcript AND the whole run set on a 1s debounce — the debounce existed
 * precisely because the invalidation was broad.
 *
 * What can be patched, and why:
 *
 * - `run.*` carries `runId` and the terminal state, and `activeRunIds` is a
 *   pure derivation of `runs[].status`. Exact patch.
 * - `message.completed` carries `messageId` and the FULL answer in
 *   `payload.content`, and the transcript merge is already id-keyed. Exact
 *   append — with the organization/conversation identity read off the cached
 *   page, never invented.
 * - `approval.resolved` carries `approvalRequestId`, and removing a row from a
 *   list needs nothing else. Exact removal.
 *
 * What must stay a refetch, stated rather than guessed:
 *
 * - `approval.requested` is an INSERT and `RuntimeStreamEvent.payload` is an
 *   untyped record, not the `ApprovalRequest` contract row. There is nothing to
 *   insert.
 * - Retry candidates are engine-verified and carry an epoch-bound `restartId`;
 *   a client may never synthesize one. Both keys that hold them are refetched
 *   together, because they are the same procedure under two names and a surface
 *   that disagreed with its sibling about restartability is worse than a
 *   refetch.
 * - `artifact.created` names an artifact whose summary projection is not on the
 *   wire. NOTE: it is also not reachable on THIS stream today — the lane reads
 *   `kernel_runtime_events` and that kind is only ever written to
 *   `tedi_runtime_events`. The branch is kept because it is correct if the kind
 *   ever lands here, but nothing currently drives it, so no surface may claim
 *   artifact liveness from this lane.
 *
 * Cost note: skill-workflow runs are deliberately NOT touched here — neither
 * `osQueryKeys.skillRuns()` nor `workflowRunInspectQueryOptions(runId)` (they
 * were the hand-written `["os-skill-runs"]` and `["os-run", runId, …]` when
 * this note was first written). Those carry skill-workflow run ids, a different
 * id space from the kernel Home run ids this conversation lane delivers;
 * patching one from the other would look right in a test and be wrong in
 * production.
 *
 * ---------------------------------------------------------------------------
 * Key namespaces: which half of the cache each domain lives in
 * ---------------------------------------------------------------------------
 *
 * apps/os keys server reads two ways: generated oRPC keys built from
 * `osQuery`/`osQueryKeys` (`lib/os-query-options.ts`), and hand-written string
 * literals. React Query matching is PREFIX-based, so the two namespaces are
 * disjoint — a generated prefix can never reach a literal, and a literal can
 * never reach a generated key. A domain whose READER moved to generated keys
 * while this file still writes the literal (or the reverse) goes silently and
 * permanently stale: no error, no retry, no refetch (this has hit both the
 * canvas outputs list and the canvas output detail). The invariant is therefore per-domain CONSISTENCY, not "generated
 * everywhere":
 *
 * - Canvas outputs — GENERATED. `artifact.created` fires
 *   `osQueryKeys.outputs()`, and every reader of that domain (Canvas list,
 *   Outputs library, the palette's bounded slice, and each open document) is a
 *   generated key underneath that prefix.
 * - Home run set and Home transcript — GENERATED. The readers, exact-key
 *   realtime patches, focus convergence, and mutation invalidations all derive
 *   their keys from the same contract query options.
 * - Pending approvals — GENERATED. The Activity reader, approval-rule
 *   invalidations, and realtime patches share `pendingApprovalsQueryOptions`.
 *
 * `realtime-projections.test.ts` enforces both halves — reachability against a
 * real QueryClient, and a source scan that fails the moment one domain is split
 * across the two namespaces.
 */

import type { ApprovalRequest } from "@tedix/api-contract/contracts/tedi-approvals";
import type {
	HomeMessage,
	HomeRunSet,
} from "@tedix/api-contract/schemas/kernel-runtime";
import type { TediRunStatus } from "@tedix/api-contract/schemas/cognitive-runtime";
import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import type { QueryClient } from "@tanstack/react-query";
// The approval-id derivation is SHARED with the projection envelope: it lives
// in `payload`, not at the top level, and the one time it was re-derived beside
// a consumer the patch shipped dead while a fixture that invented the field
// kept the tests green.
import { approvalRequestIdOf } from "@/lib/projection-envelope";
import {
	homeMessagesQueryKey,
	homeRunSetQueryKey,
	osQueryKeys,
	pendingApprovalsQueryOptions,
} from "@/lib/os-query-options";
const RUN_STATUS_BY_KIND: Record<string, TediRunStatus> = {
	"run.started": "running",
	"run.completed": "completed",
	"run.failed": "failed",
	"run.canceled": "canceled",
};

// ---------------------------------------------------------------------------
// Cache patching
// ---------------------------------------------------------------------------

export type CachePatchOutcome = {
	/** Query keys written in place with `setQueryData`. */
	patched: string[];
	/** Query keys that had to be refetched, and could not be reconstructed. */
	invalidated: string[];
};

type ReadRunSetOutput = { runSet: HomeRunSet };
type ReadMessagesOutput = {
	messages: HomeMessage[];
	nextCursor?: string | null;
};
type ApprovalListOutput = { data: ApprovalRequest[] };

/**
 * Mirror of the server's `isActiveHomeRunStatus`
 * (`apps/api/src/rpc/routers/kernel/runtime-shared.ts`). A POSITIVE whitelist,
 * not the complement: a status added later is inactive on both sides, whereas
 * "everything not terminal is active" would silently disagree with the server
 * the day a new status lands.
 */
const ACTIVE_RUN_STATUSES: ReadonlySet<TediRunStatus> = new Set([
	"queued",
	"running",
	"requires_approval",
]);

// The realtime lane PATCHES this entry with setQueryData by exact key, so it must be
// the very key the Activity surface reads. Contract-derived on both sides is what
// makes that true by construction rather than by two literals agreeing.
const pendingApprovalsKey = () => pendingApprovalsQueryOptions().queryKey;

function patchRunSet(
	queryClient: QueryClient,
	conversationId: string,
	runId: string,
	status: TediRunStatus,
	at: string,
	outcome: CachePatchOutcome,
): void {
	const key = homeRunSetQueryKey(conversationId);
	const label = "os-home-run-set";
	const current = queryClient.getQueryData<ReadRunSetOutput>(key);
	const existing = current?.runSet.runs.find((run) => run.id === runId);
	if (current === undefined || existing === undefined) {
		// A run this cache has never seen (the very first turn, or a run started
		// in another tab) cannot be synthesized — the row carries an input
		// message id, runtime ref and timestamps the event does not.
		void queryClient.invalidateQueries({ queryKey: key });
		outcome.invalidated.push(label);
		return;
	}
	if (existing.status === status) return;
	// A terminal run whose cached row still carries an in-flight `progress`
	// label would render "Completed" beside stale progress text, because the
	// event carries no replacement and the timer that used to refetch is gone.
	// The read owns that field; defer to it.
	const terminal =
		status === "completed" || status === "failed" || status === "canceled";
	if (terminal && existing.progress != null) {
		void queryClient.invalidateQueries({ queryKey: key });
		outcome.invalidated.push(label);
		return;
	}
	const runs = current.runSet.runs.map((run) =>
		run.id === runId
			? {
					...run,
					status,
					...(ACTIVE_RUN_STATUSES.has(status) ? {} : { completedAt: at }),
				}
			: run,
	);
	// `activeRunIds` is a pure derivation of the run statuses, so deriving it
	// here cannot drift from the server's own projection.
	const activeRunIds = runs
		.filter((run) => ACTIVE_RUN_STATUSES.has(run.status))
		.map((run) => run.id);
	queryClient.setQueryData<ReadRunSetOutput>(key, {
		...current,
		runSet: { ...current.runSet, runs, activeRunIds, updatedAt: at },
	});
	outcome.patched.push(label);
}

function patchTranscript(
	queryClient: QueryClient,
	conversationId: string,
	event: RuntimeStreamEvent,
	outcome: CachePatchOutcome,
): void {
	const key = homeMessagesQueryKey(conversationId);
	const label = "os-home-messages";
	const current = queryClient.getQueryData<ReadMessagesOutput>(key);
	const messageId =
		typeof event.messageId === "string" ? event.messageId : null;
	const content =
		typeof event.payload?.content === "string" ? event.payload.content : null;
	const role =
		typeof event.payload?.role === "string" ? event.payload.role : null;
	if (role !== null && role !== "assistant") return;
	// The canonical read is not a passthrough: conversations-reads.ts filters
	// out plan-assignment-completion rows (isHomeMessageEvent) and then runs
	// collapseHomeDelegationNarration, which DROPS or BLANKS rows stamped
	// homeNarration — measured at ~40% of a live thread. Appending those
	// verbatim renders bubbles the read would never return, and with the live
	// lane on there is no longer a poll to correct them. Rather than mirror two
	// server-side dispositions here (where they would silently drift), defer to
	// the read whenever either marker is present.
	const metadata = event.payload?.metadata;
	if (metadata && typeof metadata === "object") {
		const marked = metadata as {
			homeNarration?: unknown;
			source?: unknown;
		};
		if (
			marked.homeNarration !== undefined ||
			marked.source === "kernelRuntime.planAssignmentCompletion"
		) {
			void queryClient.invalidateQueries({ queryKey: key });
			outcome.invalidated.push(label);
			return;
		}
	}
	if (current === undefined || messageId === null || content === null) {
		// Nothing to merge into, or the event did not carry the answer: the read
		// is the only source of the durable row.
		void queryClient.invalidateQueries({ queryKey: key });
		outcome.invalidated.push(label);
		return;
	}
	const index = current.messages.findIndex(
		(message) => message.id === messageId,
	);
	if (index >= 0 && current.messages[index]?.content === content) return;
	// Identity is READ off the cached page, never invented: an id-keyed merge
	// with the wrong organizationId would render, then flip on the next fetch.
	const anchor = current.messages[0];
	if (anchor === undefined) {
		void queryClient.invalidateQueries({ queryKey: key });
		outcome.invalidated.push(label);
		return;
	}
	const merged: HomeMessage = {
		...(index >= 0 ? current.messages[index] : undefined),
		id: messageId,
		organizationId: anchor.organizationId,
		conversationId: anchor.conversationId,
		...(typeof event.runId === "string" ? { runId: event.runId } : {}),
		role: "assistant",
		status: "completed",
		content,
		createdAt: event.createdAt,
		completedAt: event.createdAt,
	};
	const messages =
		index >= 0
			? current.messages.map((message, at) => (at === index ? merged : message))
			: [...current.messages, merged];
	queryClient.setQueryData<ReadMessagesOutput>(key, { ...current, messages });
	outcome.patched.push(label);
}

function patchPendingApprovals(
	queryClient: QueryClient,
	approvalRequestId: string,
	outcome: CachePatchOutcome,
): void {
	const key = pendingApprovalsKey();
	const label = "os-approvals/pending";
	const current = queryClient.getQueryData<ApprovalListOutput>(key);
	if (current === undefined) return;
	const data = current.data.filter((row) => row.id !== approvalRequestId);
	if (data.length === current.data.length) return;
	queryClient.setQueryData<ApprovalListOutput>(key, { ...current, data });
	outcome.patched.push(label);
}

/**
 * Applies one durable event to the query caches.
 *
 * Idempotent by construction: every patch is a keyed replace or a filter, so a
 * replayed frame is a no-op. Returns what it did so tests assert on real
 * behavior rather than on a proxy.
 */
export function patchQueryCachesFromEvent(
	queryClient: QueryClient,
	event: RuntimeStreamEvent,
	conversationId: string | null,
): CachePatchOutcome {
	const outcome: CachePatchOutcome = { patched: [], invalidated: [] };
	const runId = typeof event.runId === "string" ? event.runId : null;
	const eventConversationId =
		typeof event.conversationId === "string"
			? event.conversationId
			: conversationId;

	const runStatus = RUN_STATUS_BY_KIND[event.kind];
	if (
		runStatus !== undefined &&
		runId !== null &&
		eventConversationId !== null
	) {
		patchRunSet(
			queryClient,
			eventConversationId,
			runId,
			runStatus,
			event.createdAt,
			outcome,
		);
		return outcome;
	}

	switch (event.kind) {
		case "message.completed": {
			if (eventConversationId === null) break;
			patchTranscript(queryClient, eventConversationId, event, outcome);
			break;
		}
		case "message.received": {
			if (eventConversationId === null) break;
			// A user turn the client did not originate (another tab, the CLI): the
			// row is not on the wire, so the transcript read owns it.
			void queryClient.invalidateQueries({
				queryKey: homeMessagesQueryKey(eventConversationId),
			});
			outcome.invalidated.push("os-home-messages");
			break;
		}
		case "approval.requested": {
			void queryClient.invalidateQueries({
				queryKey: pendingApprovalsKey(),
			});
			outcome.invalidated.push("os-approvals/pending");
			if (eventConversationId !== null) {
				// Deliberately an invalidate, not a status patch. The approval
				// CARDS render from runSet.approvalMirrors, which this event
				// cannot reconstruct — patching the status to requires_approval
				// alone would show "requires approval" with no approve/reject
				// affordance anywhere on the page.
				void queryClient.invalidateQueries({
					queryKey: homeRunSetQueryKey(eventConversationId),
				});
				outcome.invalidated.push("os-home-run-set");
			}
			break;
		}
		case "approval.resolved": {
			const resolvedApprovalId = approvalRequestIdOf(event);
			if (resolvedApprovalId !== null) {
				patchPendingApprovals(queryClient, resolvedApprovalId, outcome);
			} else {
				void queryClient.invalidateQueries({
					queryKey: pendingApprovalsKey(),
				});
				outcome.invalidated.push("os-approvals/pending");
			}
			if (eventConversationId !== null) {
				void queryClient.invalidateQueries({
					queryKey: homeRunSetQueryKey(eventConversationId),
				});
				outcome.invalidated.push("os-home-run-set");
			}
			break;
		}
		case "artifact.created": {
			// Workspace state: the artifact summary projection is not on the wire,
			// so the narrowest owning keys refetch. Both are hit because the canvas
			// list is a separate entry under the same prefix.
			void queryClient.invalidateQueries({ queryKey: osQueryKeys.outputs() });
			outcome.invalidated.push("os-outputs");
			break;
		}
		default:
			break;
	}
	return outcome;
}

/** Every kind `patchQueryCachesFromEvent` reacts to. Nothing else reaches it. */
export const REALTIME_PATCHED_EVENT_KINDS: ReadonlySet<string> = new Set([
	"message.received",
	"message.completed",
	"run.started",
	"run.completed",
	"run.failed",
	"run.canceled",
	"approval.requested",
	"approval.resolved",
	"artifact.created",
]);
