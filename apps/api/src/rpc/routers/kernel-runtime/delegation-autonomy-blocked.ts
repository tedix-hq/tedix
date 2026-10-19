import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { toJsonRecord } from "@tedix/db/utils/json";
import { homeRuntimeEventId } from "@tedix/api-contract/utils/runtime-events";
import type { BaseContext } from "../../orpc";
import {
	asyncCompletionAssistantMessageId,
	persistKernelTurnSettlement,
} from "../kernel/run-store";
import { nonNullRecord } from "../kernel/runtime-shared";
import { reviewDelegationAutonomy } from "./delegation-autonomy-review";

export async function closePolicyBlockedDelegation(
	context: BaseContext,
	run: KernelRuntimeRun,
): Promise<boolean> {
	const review = await reviewDelegationAutonomy(context, run);
	if (!review.executionBlocked) return false;
	const at = new Date().toISOString();
	const content =
		"The task is allowed by your approval policy. The selected tedi needs the required tools or access before it can retry.";
	const messageId = asyncCompletionAssistantMessageId(run.id);
	const metadata = toJsonRecord({
		...nonNullRecord(run.metadata),
		approvalRequestId: null,
		policyBlocked: {
			version: 1,
			reason: review.reason,
			resolvedBy: { type: "policy", id: "delegation-autonomy.v1" },
		},
	});
	const event = (kind: "message.completed" | "run.failed") => ({
		id: homeRuntimeEventId({
			organizationId: run.organizationId,
			conversationId: run.conversationId,
			runId: run.id,
			kind,
			suffix: "autonomy-execution-blocked",
		}),
		organizationId: run.organizationId,
		conversationId: run.conversationId,
		runId: run.id,
		kind,
		...(kind === "message.completed" ? { messageId } : {}),
		payload:
			kind === "message.completed"
				? { role: "assistant", channel: "home", content }
				: {
						status: "failed",
						reason: "execution_blocked",
						error: review.reason,
					},
		runtimeMetadata: { source: "delegation-autonomy.v1", homeSubject: true },
		createdAt: at,
	});
	const settled = await persistKernelTurnSettlement(context, {
		run: {
			id: run.id,
			organizationId: run.organizationId,
			fromStatus: "requires_approval",
			expectedUpdatedAt: run.updatedAt,
			patch: {
				status: "failed",
				outputMessageId: messageId,
				progressLabel: "Blocked",
				progressValue: 100,
				progressDetail: review.reason,
				preview: content,
				completedAt: at,
				latestEventAt: at,
				latestEventKind: "run.failed",
				updatedAt: at,
				metadata,
			},
		},
		events: [event("message.completed"), event("run.failed")],
	});
	return settled.runTransitioned;
}
