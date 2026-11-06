import {
	type DelegationResolutionClaim,
	delegationResolutionStaleBefore,
	isStaleDelegationResolutionClaim,
	readResolvingDelegationClaim,
} from "@tedix/api-contract/utils/delegation-resolution-claim";
import { getKernelRuntimeEventById } from "@tedix/db/queries/kernel-runtime-events";
import type {
	KernelRuntimeRun,
	StaleDelegationResolutionTakeover,
} from "@tedix/db/queries/kernel-runtime-runs";
import { createError, ErrorCodes, type BaseContext } from "../../orpc";
import { errorMessage, nonNullRecord } from "../kernel/runtime-shared";

/** The decision a cut-off resolver recorded before it stopped. */
export interface RecordedDelegationResolution {
	decision: "approve" | "reject";
	approvalEventId: string;
	approvalResolvedAt: string;
	status: "approved" | "rejected";
	workOrder: Record<string, unknown>;
	resolution: string | null;
	resolvedBy: Record<string, unknown> | null;
}

/**
 * The receipt the claim names, or null when the resolver recorded none.
 * A receipt that exists but cannot be read is refused rather than ignored:
 * deciding again could resolve the delegation twice.
 */
export async function readRecordedDelegationResolution(
	context: BaseContext,
	run: KernelRuntimeRun,
	claim: DelegationResolutionClaim,
): Promise<RecordedDelegationResolution | null> {
	if (!claim.approvalEventId) return null;
	const event = await getKernelRuntimeEventById(
		context.db,
		{ organizationId: run.organizationId },
		claim.approvalEventId,
	);
	if (!event) return null;
	const payload = nonNullRecord(event.payload);
	const status = payload?.status;
	const workOrder = nonNullRecord(payload?.delegationWorkOrder);
	if (
		event.kind !== "approval.resolved" ||
		event.runId !== run.id ||
		event.conversationId !== run.conversationId ||
		event.createdAt !== claim.approvalResolvedAt ||
		(status !== "approved" && status !== "rejected") ||
		!workOrder
	)
		throw createError(
			ErrorCodes.CONFLICT,
			"An earlier decision on this delegation was recorded but cannot be read; ask an admin to check the run before deciding again",
		);
	return {
		decision: status === "approved" ? "approve" : "reject",
		approvalEventId: event.id,
		approvalResolvedAt: event.createdAt,
		status,
		workOrder,
		resolution:
			typeof payload?.resolution === "string" ? payload.resolution : null,
		resolvedBy: nonNullRecord(payload?.resolvedBy) ?? null,
	};
}

/**
 * Permission to take over a `resolving` claim. A claim younger than the
 * stale window still belongs to a live resolver and is refused. A stale one
 * whose resolver recorded nothing may be taken over by any decision; one whose
 * resolver recorded a decision may only be finished with that same decision.
 * The returned fence is checked again, atomically, by the claim write.
 */
export async function staleDelegationResolutionTakeover(
	context: BaseContext,
	input: {
		run: KernelRuntimeRun;
		decision: "approve" | "reject";
		nowMs?: number;
	},
): Promise<
	StaleDelegationResolutionTakeover & {
		recorded?: RecordedDelegationResolution;
	}
> {
	const nowMs = input.nowMs ?? Date.now();
	const claim = readResolvingDelegationClaim(input.run.metadata);
	if (
		!claim ||
		input.run.status !== "requires_approval" ||
		!isStaleDelegationResolutionClaim(claim, nowMs)
	)
		throw createError(
			ErrorCodes.CONFLICT,
			"Another approval resolution is still in progress",
		);
	const staleBefore = delegationResolutionStaleBefore(nowMs);
	const recorded = await readRecordedDelegationResolution(
		context,
		input.run,
		claim,
	);
	if (!recorded) return { claimId: claim.claimId, staleBefore };
	if (recorded.decision !== input.decision)
		throw createError(
			ErrorCodes.CONFLICT,
			`This delegation was already ${recorded.status} at ${recorded.approvalResolvedAt}, but recording did not finish. ${recorded.decision === "approve" ? "Approve" : "Reject"} again to finish it.`,
		);
	return { claimId: claim.claimId, staleBefore, recorded };
}

/**
 * Read-side annotation for the approvals UI: next to a stale claim, say which
 * decision its resolver recorded (`homeDelegationResolutionRecovery`), so the
 * card offers exactly the action the server accepts. Fail-soft: without the
 * annotation the card asks the person to check again.
 */
export async function withDelegationResolutionRecovery(
	context: BaseContext,
	rows: KernelRuntimeRun[],
	nowMs: number = Date.now(),
): Promise<KernelRuntimeRun[]> {
	return Promise.all(
		rows.map(async (row) => {
			if (row.status !== "requires_approval") return row;
			const claim = readResolvingDelegationClaim(row.metadata);
			if (!claim || !isStaleDelegationResolutionClaim(claim, nowMs)) return row;
			try {
				const recorded = await readRecordedDelegationResolution(
					context,
					row,
					claim,
				);
				return {
					...row,
					metadata: {
						...nonNullRecord(row.metadata),
						homeDelegationResolutionRecovery: {
							recordedDecision: recorded?.decision ?? null,
						},
					},
				};
			} catch (error) {
				console.warn("[kernelRuntime] resolution receipt read failed", {
					runId: row.id,
					error: errorMessage(error),
				});
				return row;
			}
		}),
	);
}
