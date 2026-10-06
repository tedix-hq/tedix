/**
 * Kernel — autonomous delegation dispatch (the supervised auto-spawn slice).
 *
 * When a `delegate_tedi` route's `decideDelegationDispatch` verdict is `auto`
 * (the fully-authorized, fail-closed path — active target, no required approval,
 * authorized scopes, operator authority, low risk), the kernel actually spawns
 * a supervised child run on the target tedi instead of only recommending it.
 *
 * This module is PURE orchestration over an injected child-enqueue function —
 * no I/O, no DB, no router client of its own — so it is fully unit-testable and
 * carries zero coupling to the hot `kernel-runtime.ts` dispatch internals. The
 * real wiring (the cognitive-runtime enqueue client + deterministic child-run
 * id) is injected by `buildKernelTurnWorkDeps`; the dispatch gate is the typed
 * `shouldAutoDispatch` verdict over the capability card, not an environment
 * switch.
 *
 * Idempotency: the child enqueue is keyed by a deterministic
 * `${homeRunId}:auto:${tediId}` client-request id (the same fire-and-forget,
 * cognitive-runtime-deduplicated pattern the forced `delegateToTediId` path
 * uses) — a re-fired turn never double-spawns.
 */

import type { TediMessageAttachment } from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	type DelegationWorkOrder,
	renderDelegationWorkOrderMessage,
} from "./delegation-dispatch";
import type { HomeDelegationEvidence } from "./index";

export interface AutoDelegationDispatchInput {
	/** Private attachment references from the operator's accepted turn. */
	attachments?: TediMessageAttachment[];
	/** Parent Home run id (the kernel turn that routed delegate_tedi). */
	homeRunId: string;
	/** Parent Home conversation id. */
	homeConversationId: string;
	/** Ledger id of the parent turn's user message. */
	userMessageId: string;
	/**
	 * The operator's verbatim ask. Rich handoffs: this is NO LONGER the child's
	 * turn content directly — the child receives the rendered work order
	 * (objective/contract/tools/boundaries/recent context) instead. This string is
	 * the render's FAIL-SOFT fallback (used verbatim when the work order is
	 * malformed/empty) and the audit-preserved raw ask.
	 */
	content: string;
	/** Target tedi id (from the verdict's resolved, carded target). */
	delegatedTediId: string;
	/** Operator org — threaded to the enqueue so the internal service-binding
	 * call resolves organization context (else "Organization context required"). */
	organizationId: string;
	/** The four-field work order threaded into the child's metadata. */
	workOrder: DelegationWorkOrder;
	/** Work Item prepared before dispatch so the child and its Observer episode
	 * carry the same durable ownership edge from the first runtime event. */
	workItemId?: string;
	/**
	 * Depth propagation: this run's delegation-chain depth (0 for a top-level
	 * Home turn). Threaded verbatim into the child's dispatch metadata so the
	 * injected child runner (`kernelDelegateRunner`) stamps the child at parent+1 —
	 * exactly like the operator-forced path, which spreads the parent turn metadata.
	 * WITHOUT this the auto-dispatch metadata carried no depth and every
	 * self-propagating auto-delegated child was stamped 0+1=1, so
	 * `MAX_DELEGATION_DEPTH` was never reached on the runaway path it exists to
	 * bound. Absent ⇒ treated as 0. See decideDelegationDispatch (depth gate).
	 */
	delegationDepth?: number;
}

export interface AutoDelegationDispatchResult {
	/** The child run id (runtime-assigned when available, else the deterministic prediction). */
	childRunId: string;
	childConversationId?: string;
	status: "queued" | "failed";
	error?: string;
}

export type AutoDelegationDispatcher = (
	input: AutoDelegationDispatchInput,
) => Promise<AutoDelegationDispatchResult>;

/**
 * True when a delegation verdict authorizes autonomous dispatch. Requires BOTH
 * the typed `mode === "auto"` and `canAutoDispatch === true` — belt-and-braces
 * against any future divergence between the two fields. Anything else (blocked,
 * needs_approval, or absent) stays recognition-only.
 */
export function shouldAutoDispatch(
	delegation: HomeDelegationEvidence | null | undefined,
): boolean {
	return (
		delegation?.decision?.mode === "auto" &&
		delegation.decision.canAutoDispatch === true
	);
}

/** Shape of the injected child-enqueue (the cognitive-runtime client call). */
export type ChildEnqueue = (args: {
	attachments?: TediMessageAttachment[];
	tediId: string;
	organizationId: string;
	content: string;
	idempotencyKey: string;
	metadata: Record<string, unknown>;
}) => Promise<{
	runId?: string;
	conversationId?: string;
	error?: string;
	status: string;
}>;

/**
 * Build the auto-delegation dispatcher from an injected child-enqueue + a
 * deterministic child-run-id predictor. The dispatcher mints a stable
 * client-request id, enqueues the child fire-and-forget (idempotency-keyed),
 * threads the work order into the child metadata, and shapes a uniform result.
 * Pure over its injected deps — no router/DB knowledge here.
 */
export function buildAutoDelegationDispatcher(deps: {
	enqueueChild: ChildEnqueue;
	predictChildRunId: (args: {
		clientRequestId: string;
		tediId: string;
	}) => string;
}): AutoDelegationDispatcher {
	return async (input) => {
		const clientRequestId = `${input.homeRunId}:auto:${input.delegatedTediId}`;
		// Deterministic child-run id — also the idempotency key, so a re-fired
		// turn dedups to the same child (matches the forced delegateToTediId path).
		const predicted = deps.predictChildRunId({
			clientRequestId,
			tediId: input.delegatedTediId,
		});
		// Rich handoffs: the child's turn CONTENT is the rendered four-field work
		// order (objective / output contract / tool guidance / boundaries / recent
		// context) — NOT the operator's bare verbatim ask. The handoff is the #1
		// documented multi-agent failure surface; threading the spec only into child
		// metadata (as before) lost it across the hop. Render is pure/synchronous and
		// FAIL-SOFT: a malformed/empty work order falls back to `input.content`, so a
		// regression degrades to exactly today's content (the bare ask). The raw ask
		// is also preserved as the work order's `sourceContent`, so nothing is lost.
		const effectiveWorkOrder = input.workItemId
			? { ...input.workOrder, workItemId: input.workItemId }
			: input.workOrder;
		const childContent = renderDelegationWorkOrderMessage({
			workOrder: effectiveWorkOrder as unknown as Record<string, unknown>,
			fallbackContent: input.content,
			fallbackWorkOrderId: `${input.homeRunId}:auto:${input.delegatedTediId}`,
			label: "DELEGATION",
		});
		const result = await deps.enqueueChild({
			...(input.attachments?.length ? { attachments: input.attachments } : {}),
			tediId: input.delegatedTediId,
			organizationId: input.organizationId,
			content: childContent,
			idempotencyKey: clientRequestId,
			metadata: {
				source: "kernelRuntime.autoDispatch",
				homeRunId: input.homeRunId,
				homeConversationId: input.homeConversationId,
				homeMessageId: input.userMessageId,
				delegationWorkOrder: effectiveWorkOrder,
				executionSurface: input.workOrder.executionRequirement.surface,
				...(input.workOrder.authorityEnvelope
					? { delegationAuthority: input.workOrder.authorityEnvelope }
					: {}),
				delegationAuthorityMode: input.workOrder.authorityMode ?? "shadow",
				...(input.workItemId ? { workItemId: input.workItemId } : {}),
				// Depth propagation: carry this run's chain depth so the injected
				// child runner increments it to parent+1 (it reads metadata.delegationDepth
				// and adds 1). Absent input ⇒ 0, so a top-level dispatch stamps the child
				// at 1. This is what actually lets MAX_DELEGATION_DEPTH bound the
				// self-propagating auto-delegation chain end-to-end.
				delegationDepth: input.delegationDepth ?? 0,
				// Thread the work order's bounded-authority budget caps into the child
				// dispatch metadata so they are durable and visible on the child run.
				// Fail-soft additive: absent budget ⇒ key omitted, child tedi's own
				// profile/policy budgets still apply. `deadlineMs` is also surfaced as a
				// top-level `delegationDeadlineMs` so the child runtime can read it
				// without descending into the nested budget object.
				...(input.workOrder.budget
					? {
							delegationBudget: input.workOrder.budget,
							...(input.workOrder.budget.deadlineMs != null
								? {
										delegationDeadlineMs: input.workOrder.budget.deadlineMs,
									}
								: {}),
						}
					: {}),
			},
		});
		return {
			childRunId: result.runId ?? predicted,
			childConversationId: result.conversationId,
			status: result.status === "failed" ? "failed" : "queued",
			error: result.error,
		};
	};
}
