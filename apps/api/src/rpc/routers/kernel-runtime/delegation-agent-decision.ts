/**
 * Kernel runtime — carry out an approval tedi's decision on a held Home
 * delegation (see `./delegation-agent-review` for the request side). An
 * approval reuses and admits the held Work Item (its receipt satisfies
 * admission) and dispatches through the Home approval core; a rejection, or an
 * approval that cannot be carried out, cancels the item and leaves the run
 * parked with the operator card showing the approver's rationale.
 */

import {
	getKernelRuntimeRun,
	transitionKernelRuntimeRunStatus,
} from "@tedix/db/queries/kernel-runtime-runs";
import { cancelWorkItem } from "@tedix/db/queries/work-items/crud";
import { toJsonRecord } from "@tedix/db/utils/json";
import type { BaseContext } from "../../orpc";
import {
	type HomeDelegationAgentReview,
	readHomeDelegationAgentReview,
} from "../kernel/delegation-approver";
import {
	errorMessage,
	nowIso,
	stringFromPayload,
} from "../kernel/runtime-shared";
import { internalDelegationContext } from "./delegation-context";
import { kernelDelegationRecommendationFromRun } from "./turn-delegation";

/**
 * Carry out an approver's decision on a held Home delegation. Called after
 * `decideWorkApproval` recorded the decision; it never re-decides. A run the
 * operator already resolved, or whose review names another proposal, is left
 * alone: the Work decision then stands as an audit record only.
 */
export async function settleHomeDelegationAgentDecision(
	context: BaseContext,
	input: {
		organizationId: string;
		proposalId: string;
		workItemId: string;
		homeRunId: string;
		decision: "approved" | "rejected";
		deciderTediId: string;
		rationale: string;
		decidedAt: string;
	},
): Promise<void> {
	const run = await getKernelRuntimeRun(context.db, {
		id: input.homeRunId,
		organizationId: input.organizationId,
	});
	if (!run || run.status !== "requires_approval") return;
	const pending = kernelDelegationRecommendationFromRun(run);
	if (!pending || stringFromPayload(pending.delegation.resolutionStatus))
		return;
	const review = readHomeDelegationAgentReview(pending.delegation);
	if (
		!review ||
		review.proposalId !== input.proposalId ||
		review.approverTediId !== input.deciderTediId
	)
		return;
	const decided: HomeDelegationAgentReview = {
		...review,
		decidedAt: input.decidedAt,
		rationale: input.rationale.slice(0, 2_000),
	};
	let declineReason: string | null = null;
	if (input.decision === "approved") {
		const approvedRun = {
			...run,
			metadata: toJsonRecord({
				...pending.metadata,
				homeDelegation: {
					...pending.delegation,
					agentReview: { ...decided, status: "approved" },
				},
			}),
		};
		try {
			const { respondKernelDelegationRecommendationApprovalCore } =
				await import("./approval-control");
			await respondKernelDelegationRecommendationApprovalCore(
				internalDelegationContext(context, input.organizationId),
				{
					decision: "approve",
					note: `Approved by ${review.approverTediLabel ?? review.approverTediId}: ${input.rationale}`.slice(
						0,
						2_000,
					),
					organizationId: input.organizationId,
					run: approvedRun,
					approvedWorkItemId: input.workItemId,
					resolvedBy: { type: "tedi", id: input.deciderTediId },
				},
			);
			return;
		} catch (error) {
			declineReason = `approval could not be carried out: ${errorMessage(error)}`;
			console.warn(
				"[kernelRuntime] agent-approved Home delegation failed; operator decides",
				declineReason,
			);
		}
	}
	await cancelWorkItem(context.db, {
		orgId: input.organizationId,
		workItemId: input.workItemId,
		actor: { type: "tedi", id: input.deciderTediId },
		reason:
			declineReason ??
			`Approver declined the Home delegation: ${input.rationale}`.slice(0, 500),
		cancelledAt: input.decidedAt,
	}).catch((error) =>
		console.warn(
			"[kernelRuntime] held Home delegation Work Item cancel failed",
			errorMessage(error),
		),
	);
	// Re-read: an approval that failed may have advanced the row.
	const current =
		(await getKernelRuntimeRun(context.db, {
			id: input.homeRunId,
			organizationId: input.organizationId,
		})) ?? run;
	const currentPending = kernelDelegationRecommendationFromRun(current);
	if (
		current.status !== "requires_approval" ||
		!currentPending ||
		stringFromPayload(currentPending.delegation.resolutionStatus)
	)
		return;
	const updatedAt = nowIso();
	await transitionKernelRuntimeRunStatus(context.db, {
		id: current.id,
		organizationId: input.organizationId,
		fromStatus: "requires_approval",
		patch: {
			updatedAt,
			progressDetail: `${review.approverTediLabel ?? "The approver"} declined; awaiting your decision`,
			metadata: toJsonRecord({
				...currentPending.metadata,
				homeDelegation: {
					...currentPending.delegation,
					agentReview: {
						...decided,
						status: "rejected",
						...(declineReason ? { reason: declineReason.slice(0, 300) } : {}),
					},
				},
			}),
		},
	});
}
