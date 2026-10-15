import { transitionKernelRuntimeRunStatus } from "@tedix/db/queries/kernel-runtime-runs";
import { settleKernelSubmission } from "../../../kernel/runtime-submission-bridge";
import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import type { BaseContext } from "../../orpc";
import { insertKernelRuntimeEvent } from "./run-store";
import type { KernelTurnWorkInput } from "./turn-work";

const INTERRUPTION_MESSAGE =
	"This request was interrupted after it was accepted. Your message is saved. Check the run details and any changes before retrying.";

/** A late RPC failure cannot safely replay a turn that may have made changes. */
export async function recordDetachedKernelFailure(
	context: BaseContext,
	input: KernelTurnWorkInput,
): Promise<void> {
	try {
		const now = new Date().toISOString();
		const transitioned = await transitionKernelRuntimeRunStatus(context.db, {
			id: input.runId,
			organizationId: input.organizationId,
			fromStatus: "running",
			patch: {
				status: "failed",
				progressLabel: "Interrupted",
				progressDetail: INTERRUPTION_MESSAGE,
				completedAt: now,
				updatedAt: now,
			},
		});
		if (!transitioned) return;
		await insertKernelRuntimeEvent(context, {
			organizationId: input.organizationId,
			conversationId: input.conversationId,
			runId: input.runId,
			messageId: input.assistantMessageId,
			kind: "message.completed",
			payload: {
				role: "assistant",
				content: INTERRUPTION_MESSAGE,
				channel: "home",
			},
			createdAt: now,
		});
		await insertKernelRuntimeEvent(context, {
			organizationId: input.organizationId,
			conversationId: input.conversationId,
			runId: input.runId,
			messageId: input.assistantMessageId,
			kind: "run.failed",
			payload: { status: "failed", error: INTERRUPTION_MESSAGE },
			createdAt: now,
		});
		await settleKernelSubmission(context.db, {
			runId: input.runId,
			organizationId: input.organizationId,
			conversationId: input.conversationId,
			outcome: "failed",
			error: INTERRUPTION_MESSAGE,
		});
	} catch (error) {
		console.warn("[kernel] interrupted turn settlement failed", {
			runId: input.runId,
			exception: safeExceptionTopology(error),
		});
	}
}
