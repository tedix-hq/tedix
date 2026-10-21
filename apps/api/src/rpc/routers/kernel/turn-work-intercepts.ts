import {
	KERNEL_RUNTIME_BACKEND,
	emitProgress,
	type KernelTurnWorkDeps,
	type KernelTurnWorkInput,
} from "./turn-work-context";
import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import type { HomeRun } from "@tedix/api-contract/schemas/kernel-runtime";
import { transitionKernelRuntimeRunStatus } from "@tedix/db/queries/kernel-runtime-runs";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	classifyAffirmative,
	readPendingWorkflowHint,
	type WorkflowDispatchResult,
} from "./workflow-confirm";

export function recordOrNull(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

/**
 * Settle a turn that an intercept answered without the route planner: one
 * guarded run patch, the assistant message, and the terminal event.
 */
async function settleInterceptedTurn(
	deps: KernelTurnWorkDeps,
	input: KernelTurnWorkInput,
	outcome: {
		content: string;
		status: "completed" | "failed";
		returnStatus: "completed" | "needs_delegation" | "failed";
		metadata: Record<string, unknown>;
		error: string | null;
	},
) {
	const {
		organizationId,
		conversationId,
		runId,
		userMessageId,
		assistantMessageId,
		createdAt,
		assistantAt,
		completedAt,
		homePlan,
		runtimeMetadata,
	} = input;
	const progress = deps.homeRunProgress({
		eventCount: 0,
		status: outcome.status,
	});
	emitProgress(deps, "Finalizing");
	await transitionKernelRuntimeRunStatus(deps.db, {
		id: runId,
		organizationId,
		fromStatus: "running",
		patch: {
			status: outcome.status,
			progressValue: progress.current,
			progressLabel: progress.label,
			progressDetail: progress.detail,
			completedAt,
			updatedAt: completedAt,
			metadata: toJsonRecord(outcome.metadata),
		},
	});
	const assistantEvent = await deps.insertKernelRuntimeEvent({
		organizationId,
		kind: "message.completed",
		conversationId,
		runId,
		messageId: assistantMessageId,
		payload: {
			role: "assistant",
			content: outcome.content,
			channel: "home",
			metadata: {
				homeSubject: true,
				approvalRequestId: null,
				delegatedTediId: null,
				childConversationId: null,
				childRunId: null,
				delegationError: null,
				delegationWorkOrder: null,
				homePlan,
			},
		},
		runtimeMetadata: { ...runtimeMetadata },
		createdAt: assistantAt,
	});
	await deps.insertKernelRuntimeEvent({
		organizationId,
		kind: "run.completed",
		conversationId,
		runId,
		messageId: assistantMessageId,
		payload: {
			status: outcome.status,
			approvalRequestId: null,
			inputMessageId: userMessageId,
			outputMessageId: assistantMessageId,
			childConversationId: null,
			childRunId: null,
			error: outcome.error,
			delegationError: null,
			delegationWorkOrder: null,
			homePlan,
			// Deterministic intercept: no route planner ran this turn.
			route: null,
		},
		runtimeMetadata: { ...runtimeMetadata },
		createdAt: completedAt,
	});
	const run: import("@tedix/api-contract/schemas/kernel-runtime").HomeRun = {
		id: runId,
		organizationId,
		conversationId,
		status: outcome.status,
		inputMessageId: userMessageId,
		outputMessageId: assistantMessageId,
		delegatedTediId: null,
		childRunId: null,
		runtime: {
			backend: KERNEL_RUNTIME_BACKEND,
			externalId: runId,
			metadata: { ...runtimeMetadata },
		},
		startedAt: createdAt,
		completedAt,
		createdAt,
		updatedAt: completedAt,
		metadata: outcome.metadata,
		progress,
	};
	return {
		idempotencyKey: runId,
		conversationId,
		status: outcome.returnStatus,
		run,
		homePlan: undefined,
		assistantMessage: {
			id: assistantMessageId,
			organizationId,
			conversationId,
			runId,
			role: "assistant" as const,
			status: "completed" as const,
			content: outcome.content,
			runtime: assistantEvent.runtime,
			createdAt: assistantEvent.createdAt,
			startedAt: assistantEvent.createdAt,
			completedAt,
			metadata: assistantEvent.payload,
		},
		error: undefined,
	};
}

/**
 * The ingress outcome of a bare "approve"/"reject" chat reply to a parked
 * write card (see `resolveApprovalByChatReply`). Recorded on the turn's
 * runtime metadata so the turn settles with the outcome instead of planning a
 * second, duplicate write.
 */
export interface ChatApprovalReply {
	runId: string;
	decision: "approve" | "reject";
	tool: string;
	targetKind?: "delegation";
	runStatus: string | null;
	error: string | null;
	/** The settled write's human receipt (e.g. "Updated “Plan”. [Open document](…)"). */
	receipt?: string | null;
}

export function readChatApprovalReply(
	runtimeMetadata: Record<string, unknown>,
): ChatApprovalReply | null {
	const reply = recordOrNull(runtimeMetadata.chatApprovalReply);
	if (
		!reply ||
		typeof reply.runId !== "string" ||
		(reply.decision !== "approve" && reply.decision !== "reject") ||
		typeof reply.tool !== "string"
	) {
		return null;
	}
	return {
		runId: reply.runId,
		decision: reply.decision,
		tool: reply.tool,
		...(reply.targetKind === "delegation"
			? { targetKind: "delegation" as const }
			: {}),
		runStatus: typeof reply.runStatus === "string" ? reply.runStatus : null,
		error: typeof reply.error === "string" ? reply.error : null,
		receipt: typeof reply.receipt === "string" ? reply.receipt : null,
	};
}

export function chatApprovalReplyContent(reply: ChatApprovalReply): string {
	const tool = `\`${reply.tool}\``;
	if (reply.error) {
		return `Couldn't ${reply.decision} ${tool}: ${reply.error}`;
	}
	if (reply.targetKind === "delegation") {
		if (reply.decision === "reject")
			return `Rejected delegation to ${tool}. Nothing was dispatched.`;
		return reply.runStatus === "failed"
			? `Approved delegation to ${tool}, but dispatch failed. Open the run details for the error.`
			: `Approved delegation to ${tool}. Follow its status in the delegation card.`;
	}
	if (reply.decision === "reject") return `Rejected ${tool}. Nothing ran.`;
	return reply.runStatus === "failed"
		? `Approved ${tool}, but the write failed. Open the run details for the error.`
		: reply.receipt
			? `Approved and ran ${tool}. ${reply.receipt}`
			: `Approved and ran ${tool}.`;
}

export async function runChatApprovalReplyIntercept(
	deps: KernelTurnWorkDeps,
	input: KernelTurnWorkInput,
) {
	const reply = readChatApprovalReply(input.runtimeMetadata);
	if (!reply) return null;
	return settleInterceptedTurn(deps, input, {
		content: chatApprovalReplyContent(reply),
		status: reply.error ? "failed" : "completed",
		returnStatus: reply.error ? "failed" : "completed",
		metadata: { ...input.runRowMetadata, chatApprovalReply: reply },
		error: reply.error,
	});
}

/**
 * Workflow confirm→dispatch intercept — extracted verbatim from the former
 * inline block in {@link runKernelTurnWork}. When the operator's turn is a
 * clear affirmative to a prior `run_workflow` route proposal, dispatches the
 * named skill workflow and settles this run. Returns `null` when the
 * intercept does not apply, so the caller falls through to normal kernel
 * planning.
 */
export async function runWorkflowConfirmIntercept(
	deps: KernelTurnWorkDeps,
	input: KernelTurnWorkInput,
) {
	const { organizationId, conversationId, runId, content, runRowMetadata } =
		input;

	// ── Workflow confirm→dispatch intercept ────────────────────────────────────
	// When the operator replied with a clear affirmative ("yes", "go ahead", …)
	// and the most recent completed prior run in this conversation proposed a
	// `run_workflow` route, dispatch the named skill workflow now — skip the LLM
	// planning pass entirely (saves tokens, gives deterministic dispatch).
	//
	// Fail-soft at every gate: missing dep → fall through; read fails → fall
	// through; dispatch fails → normal error reply (never a crash).
	//
	// No double-dispatch: this turn's run row carries `kernelWorkflowConfirm`
	// metadata but no `kernelRoute.run_workflow`, so it shadows the original
	// pending route as the most-recent run — a second affirmative on the next
	// turn reads this run first and finds no pending hint. A re-enqueue of the
	// same runId also can't re-fire: the patch below moves the run off `running`,
	// and the read excludes the current run by id.
	if (
		input.allowWorkflowConfirmation !== false &&
		deps.dispatchWorkflowConfirm &&
		classifyAffirmative(content)
	) {
		const pendingHint = await readPendingWorkflowHint(deps.db, {
			organizationId,
			conversationId,
			excludeRunId: runId,
		});
		if (pendingHint) {
			emitProgress(deps, `Starting ${pendingHint} workflow`);
			let dispatchResult: WorkflowDispatchResult | null = null;
			try {
				dispatchResult = await deps.dispatchWorkflowConfirm({
					organizationId,
					conversationId,
					homeRunId: runId,
					workflowSlug: pendingHint,
				});
			} catch (error) {
				console.warn({
					component: "kernel.turn_work",
					event: "workflow_confirm_dispatch_failed",
					error: safeExceptionTopology(error),
				});
				dispatchResult = {
					workflowRunId: "",
					status: "failed",
					error: deps.errorMessage(error).slice(0, 200),
				};
			}
			if (dispatchResult) {
				const workflowOk = dispatchResult.status === "dispatched";
				const workflowContent = workflowOk
					? `Started — workflow \`${pendingHint}\` is running (run id: ${dispatchResult.workflowRunId}).`
					: `Couldn't start the \`${pendingHint}\` workflow${dispatchResult.error ? `: ${dispatchResult.error}` : "."}`;
				const workflowStatus: "completed" | "failed" = workflowOk
					? "completed"
					: "failed";
				const workflowMeta = {
					...runRowMetadata,
					kernelWorkflowConfirm: {
						workflowSlug: pendingHint,
						workflowRunId: dispatchResult.workflowRunId || null,
						workflowTediId: dispatchResult.workflowTediId ?? null,
						status: dispatchResult.status,
						...(dispatchResult.error
							? { error: dispatchResult.error.slice(0, 200) }
							: {}),
					},
				};
				return settleInterceptedTurn(deps, input, {
					content: workflowContent,
					status: workflowStatus,
					returnStatus: workflowOk ? "needs_delegation" : "failed",
					metadata: workflowMeta,
					error: workflowOk
						? null
						: (dispatchResult.error ?? "workflow dispatch failed"),
				});
			}
		}
	}
	return null;
}
