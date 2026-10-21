import { createRouterClient } from "@orpc/server";
import type {
	TediRunStatus,
	TediRuntimeEventKind,
} from "@tedix/api-contract/schemas/cognitive-runtime";
import { TediRuntimeEventKindSchema } from "@tedix/api-contract/schemas/cognitive-runtime";
import type { HomePlan } from "@tedix/api-contract/schemas/kernel-runtime";
import { homeRuntimeEventId } from "@tedix/api-contract/utils/runtime-events";
import {
	type KernelRuntimeRun,
	updateKernelRuntimeRunForOrg,
} from "@tedix/db/queries/kernel-runtime-runs";
import { addWorkItemCommentIfAbsent } from "@tedix/db/queries/work-items/comments";
import {
	listWorkItemAttempts,
	settleWorkItemAttempt,
} from "@tedix/db/queries/work-items/attempts";
import { toJsonRecord } from "@tedix/db/utils/json";
import { type BaseContext } from "../../orpc";
import { cognitiveRuntimeContractRouter } from "../cognitive-runtime";
import {
	type KernelChildEnqueue,
	surfaceUnblockedDependents,
} from "./delegation-work-item";
import {
	approvedHomePlanStatus,
	homeRunStatusFromPlanStatus,
	planAssignmentStatusFromChildStatus,
} from "./home-plan";
import {
	childRunStatusFromSummary,
	childRunStatusKey,
	delegationSessionKey,
	errorMessage,
	homeRunProgress,
	isTerminalHomeRunStatus,
	latestIso,
	nonNullRecord,
	nowIso,
	shouldFailSoftHomeRunSetRead,
} from "./runtime-shared";
import { insertKernelRuntimeEvent } from "./run-store";

/**
 * The unblock watcher's injected child-enqueue: the same cognitive-runtime
 * `enqueueMessage` seam the kernel's delegate runner uses (async dispatch,
 * idempotency-keyed, per-delegation session scoping) — built here because
 * delegation-work-item.ts must stay import-cycle-free of cognitive-runtime.ts.
 */
export function kernelUnblockEnqueue(context: BaseContext): KernelChildEnqueue {
	return async (input) => {
		const client = createRouterClient(cognitiveRuntimeContractRouter, {
			context,
		});
		const result = await client.enqueueMessage({
			tediId: input.delegateToTediId,
			content: input.content,
			conversationId: delegationSessionKey(input.childClientRequestId),
			idempotencyKey: input.childClientRequestId,
			metadata: { ...input.metadata, dispatchMode: "async" },
		});
		return {
			childRunId: result.runId ?? null,
			childConversationId: result.conversationId ?? null,
			error: result.error ?? null,
			status: result.status ?? null,
		};
	};
}

function childRunStatusKeyForAssignment(
	assignment: HomePlan["assignments"][number],
): string | null {
	if (!assignment.ownerTediId || !assignment.childRunId) return null;
	return childRunStatusKey(assignment.ownerTediId, assignment.childRunId);
}

export type ReconciledHomePlanAssignment = {
	assignment: HomePlan["assignments"][number];
	latestEventAt: string | null;
	latestEventKind: TediRuntimeEventKind | undefined;
	preview: string | null;
	previousStatus: HomePlan["assignments"][number]["status"];
	status: HomePlan["assignments"][number]["status"];
	terminalAt: string | null;
};

export function reconcileHomePlanWithChildStatuses(
	plan: HomePlan,
	childRunStatuses: Map<string, Record<string, unknown>>,
): {
	changed: boolean;
	eventCount: number;
	latestEventAt: string | null;
	latestEventKind: TediRuntimeEventKind | undefined;
	plan: HomePlan;
	preview: string | null;
	terminalAssignments: ReconciledHomePlanAssignment[];
	terminalAt: string | null;
} {
	let changed = false;
	let eventCount = 0;
	const terminalAssignments: ReconciledHomePlanAssignment[] = [];
	const latestEventAts: string[] = [];
	const terminalAts: string[] = [];
	let latestEventKind: TediRuntimeEventKind | undefined;
	let preview: string | null = null;
	const assignments = plan.assignments.map((assignment) => {
		const key = childRunStatusKeyForAssignment(assignment);
		const childRunStatus = key ? childRunStatuses.get(key) : undefined;
		if (!childRunStatus) return assignment;
		const childStatus = childRunStatusFromSummary(childRunStatus);
		const nextStatus = planAssignmentStatusFromChildStatus(childStatus);
		const childEventCount =
			typeof childRunStatus.childRunEventCount === "number"
				? childRunStatus.childRunEventCount
				: 1;
		eventCount += childEventCount;
		const childLatestEventAt =
			typeof childRunStatus.childRunLatestEventAt === "string"
				? childRunStatus.childRunLatestEventAt
				: null;
		const childTerminalAt =
			typeof childRunStatus.childRunTerminalAt === "string"
				? childRunStatus.childRunTerminalAt
				: null;
		const childPreview =
			typeof childRunStatus.childRunPreview === "string"
				? childRunStatus.childRunPreview
				: null;
		const parsedEventKind =
			typeof childRunStatus.childRunLatestEventKind === "string"
				? TediRuntimeEventKindSchema.safeParse(
						childRunStatus.childRunLatestEventKind,
					)
				: null;
		if (childLatestEventAt) latestEventAts.push(childLatestEventAt);
		if (childTerminalAt) terminalAts.push(childTerminalAt);
		if (!preview && childPreview) preview = childPreview;
		if (!latestEventKind && parsedEventKind?.success) {
			latestEventKind = parsedEventKind.data;
		}
		const nextAssignment = {
			...assignment,
			error:
				nextStatus === "failed"
					? (childPreview ?? assignment.error ?? null)
					: (assignment.error ?? null),
			status: nextStatus,
		};
		const changedAssignment =
			assignment.status !== nextStatus ||
			(nextStatus === "failed" && nextAssignment.error !== assignment.error);
		if (changedAssignment) changed = true;
		if (
			["completed", "failed", "canceled"].includes(nextStatus) &&
			assignment.status !== nextStatus
		) {
			terminalAssignments.push({
				assignment: nextAssignment,
				latestEventAt: childLatestEventAt,
				latestEventKind: parsedEventKind?.success
					? parsedEventKind.data
					: undefined,
				preview: childPreview,
				previousStatus: assignment.status,
				status: nextStatus,
				terminalAt: childTerminalAt,
			});
		}
		return nextAssignment;
	});
	const nextPlan: HomePlan = {
		...plan,
		assignments,
		attentionRoutes: plan.attentionRoutes.map((route) => {
			const matching = assignments.find(
				(assignment) => assignment.ownerTediId === route.ownerTediId,
			);
			if (!matching) return route;
			const outcome =
				matching.status === "completed"
					? "completed"
					: matching.status === "canceled"
						? "rejected"
						: ["running", "queued"].includes(matching.status)
							? "dispatched"
							: route.outcome;
			return outcome === route.outcome ? route : { ...route, outcome };
		}),
	};
	nextPlan.status = approvedHomePlanStatus(nextPlan);
	if (nextPlan.status !== plan.status) changed = true;
	return {
		changed,
		eventCount,
		latestEventAt: latestIso(latestEventAts),
		latestEventKind,
		plan: nextPlan,
		preview,
		terminalAssignments,
		terminalAt: latestIso(terminalAts),
	};
}

function oneLinePreview(value: unknown, max = 240): string {
	if (typeof value !== "string") return "No result summary was published.";
	const uuidSource =
		"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
	const uuid = new RegExp(uuidSource, "gi");
	const compact = value
		// Child completions often include the internal Work Item UUID as proof.
		// Keep that correlation in traces/audit, not in the calm operator summary.
		.replace(
			new RegExp(`(?:Home )?Work Item \`${uuidSource}\``, "gi"),
			"the delegated work item",
		)
		.replace(new RegExp(`\`${uuidSource}\``, "gi"), "the delegated work item")
		.replace(uuid, "the delegated work item")
		.replace(/\s+/g, " ")
		.trim()
		.replaceAll("|", "\\|");
	if (!compact) return "No result summary was published.";
	return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

/** Deterministic, exactly-once operator synthesis for a settled Home plan. */
export function homePlanFinalSynthesisContent(
	plan: HomePlan,
	childRunStatuses: Map<string, Record<string, unknown>>,
): string {
	const failed = plan.assignments.filter((assignment) =>
		["failed", "canceled"].includes(assignment.status),
	).length;
	const heading =
		failed > 0
			? `Coordinated work finished with ${failed} issue${failed === 1 ? "" : "s"}.`
			: `Coordinated work completed across ${plan.assignments.length} tedis.`;
	const rows = plan.assignments.map((assignment) => {
		const key = childRunStatusKeyForAssignment(assignment);
		const child = key ? childRunStatuses.get(key) : undefined;
		const preview =
			child?.childRunPreview ??
			assignment.error ??
			"No result summary was published.";
		return `| ${assignment.ownerLabel.replaceAll("|", "\\|")} | ${assignment.status} | ${oneLinePreview(preview)} |`;
	});
	return [
		heading,
		"",
		"| Tedi | Outcome | Result |",
		"| --- | --- | --- |",
		...rows,
	].join("\n");
}

export async function reconcileHomePlanRunRowFromChildStatus(
	context: BaseContext,
	input: {
		childRunStatuses: Map<string, Record<string, unknown>>;
		plan: HomePlan;
		row: KernelRuntimeRun;
	},
): Promise<KernelRuntimeRun> {
	const reconciliation = reconcileHomePlanWithChildStatuses(
		input.plan,
		input.childRunStatuses,
	);
	if (!reconciliation.changed) return input.row;
	const reconciledRunStatus = homeRunStatusFromPlanStatus(
		reconciliation.plan.status,
	);
	// A terminal child set is not yet the operator answer. Keep the parent live
	// until the inbox-wake convergence turn has assembled every full child
	// transcript and persisted the single canonical plan-convergence message.
	// This prevents the deterministic evidence table from winning a race against
	// the richer synthesis and then suppressing that better answer in the TUI.
	const awaitingConvergence = isTerminalHomeRunStatus(reconciledRunStatus);
	const runStatus: TediRunStatus = awaitingConvergence
		? "running"
		: reconciledRunStatus;
	const progress = homeRunProgress({
		eventCount: reconciliation.eventCount,
		status: reconciledRunStatus,
	});
	const completedAt = awaitingConvergence ? null : reconciliation.terminalAt;
	const fallbackPreview = awaitingConvergence
		? homePlanFinalSynthesisContent(reconciliation.plan, input.childRunStatuses)
		: null;
	const finalMessageId = input.row.outputMessageId;
	const updatedAt =
		reconciliation.latestEventAt ?? input.row.updatedAt ?? input.row.createdAt;
	const metadata = {
		...nonNullRecord(input.row.metadata),
		homePlan: reconciliation.plan,
		homePlanReconciledAt: updatedAt,
		...(awaitingConvergence ? { homePlanConvergencePending: true } : {}),
		progress,
		source: "kernelRuntime.reconcileHomePlanAssignments",
	};
	const nextRow = {
		...input.row,
		status: runStatus,
		progressValue: progress.current,
		progressLabel: progress.label,
		progressDetail: progress.detail,
		latestEventKind:
			reconciliation.latestEventKind ?? input.row.latestEventKind,
		latestEventAt: reconciliation.latestEventAt ?? input.row.latestEventAt,
		outputMessageId: finalMessageId,
		preview: fallbackPreview ?? reconciliation.preview ?? input.row.preview,
		completedAt,
		updatedAt,
		metadata,
	};
	try {
		await updateKernelRuntimeRunForOrg(context.db, {
			id: input.row.id,
			organizationId: input.row.organizationId,
			patch: {
				status: runStatus,
				progressValue: progress.current,
				progressLabel: progress.label,
				progressDetail: progress.detail,
				latestEventKind:
					reconciliation.latestEventKind ?? input.row.latestEventKind,
				latestEventAt: reconciliation.latestEventAt ?? input.row.latestEventAt,
				outputMessageId: finalMessageId,
				preview: fallbackPreview ?? reconciliation.preview ?? input.row.preview,
				completedAt,
				updatedAt,
				metadata,
			},
		});
		await Promise.all(
			reconciliation.terminalAssignments.map((assignment) =>
				recordHomePlanAssignmentCompletion(context, {
					assignment,
					conversationId: input.row.conversationId,
					homeRunId: input.row.id,
					organizationId: input.row.organizationId,
				}),
			),
		);
		return nextRow;
	} catch (error) {
		if (shouldFailSoftHomeRunSetRead(error)) {
			console.warn("[kernelRuntime] plan assignment reconciliation failed", {
				error: errorMessage(error),
				runId: input.row.id,
			});
			return input.row;
		}
		throw error;
	}
}

function homePlanAssignmentCompletionContent(input: {
	assignment: HomePlan["assignments"][number];
	preview: string | null;
	status: HomePlan["assignments"][number]["status"];
}): string {
	const evidence = input.preview ? ` Latest evidence: ${input.preview}` : "";
	switch (input.status) {
		case "completed":
			return `${input.assignment.ownerLabel} finished the approved Home assignment.${evidence}`;
		case "failed":
			return `${input.assignment.ownerLabel} reported that the approved Home assignment failed.${evidence}`;
		case "canceled":
			return `${input.assignment.ownerLabel}'s approved Home assignment was canceled.${evidence}`;
		default:
			return `${input.assignment.ownerLabel} published an update for the approved Home assignment.${evidence}`;
	}
}

async function insertWorkItemCommentIfAbsent(
	context: BaseContext,
	input: {
		authorId: string;
		body: string;
		createdAt: string;
		id: string;
		metadata: Record<string, unknown>;
		orgId: string;
		workItemId: string;
	},
): Promise<void> {
	await addWorkItemCommentIfAbsent(context.db, {
		id: input.id,
		workItemId: input.workItemId,
		orgId: input.orgId,
		authorType: "system",
		authorId: input.authorId,
		body: input.body,
		metadata: toJsonRecord(input.metadata),
		createdAt: input.createdAt,
	});
}

async function recordHomePlanAssignmentCompletion(
	context: BaseContext,
	input: {
		assignment: ReconciledHomePlanAssignment;
		conversationId: string;
		homeRunId: string;
		organizationId: string;
	},
): Promise<void> {
	const assignment = input.assignment.assignment;
	if (!assignment.childRunId) return;
	const createdAt =
		input.assignment.terminalAt ?? input.assignment.latestEventAt ?? nowIso();
	const content = homePlanAssignmentCompletionContent({
		assignment,
		preview: input.assignment.preview,
		status: input.assignment.status,
	});
	if (assignment.workItemId) {
		const completionMetadata = {
			childRunId: assignment.childRunId,
			childRunLatestEventAt: input.assignment.latestEventAt,
			childRunLatestEventKind: input.assignment.latestEventKind ?? null,
			childRunPreview: input.assignment.preview,
			childRunStatus: input.assignment.status,
			homePlanAssignmentId: assignment.id,
			homeRunId: input.homeRunId,
			source: "kernelRuntime.planAssignmentCompletion",
		};
		const attempt = (
			await listWorkItemAttempts(context.db, {
				orgId: input.organizationId,
				workItemId: assignment.workItemId,
			})
		).data.find(
			(candidate) =>
				candidate.runId === assignment.childRunId &&
				["running", "waiting", "retrying"].includes(candidate.runtimeState),
		);
		if (attempt) {
			await settleWorkItemAttempt(context.db, {
				orgId: input.organizationId,
				workItemId: assignment.workItemId,
				attemptId: attempt.id,
				executor: { type: "tedi", id: assignment.ownerTediId },
				outcome:
					input.assignment.status === "completed"
						? "succeeded"
						: input.assignment.status === "canceled"
							? "cancelled"
							: "failed",
				summary: content,
				metadata: toJsonRecord(completionMetadata),
				settledAt: createdAt,
			});
		}
		await insertWorkItemCommentIfAbsent(context, {
			id: `${assignment.workItemId}:home-plan-terminal:${input.assignment.status}`,
			workItemId: assignment.workItemId,
			orgId: input.organizationId,
			authorId: "home",
			body: content,
			metadata: {
				assignmentId: assignment.id,
				childRunId: assignment.childRunId,
				childRunLatestEventAt: input.assignment.latestEventAt,
				childRunLatestEventKind: input.assignment.latestEventKind ?? null,
				childRunPreview: input.assignment.preview,
				childRunStatus: input.assignment.status,
				homeRunId: input.homeRunId,
			},
			createdAt,
		});
		// A terminal plan branch clears a blocker edge: run the unblock watcher so
		// a sibling assignment whose dispatch was deferred on this branch actually
		// dispatches (the cross-assignment deadlock fix — previously nothing fired
		// here and a deferred sibling waited forever; live repro run 234803c5).
		if (
			input.assignment.status === "completed" ||
			input.assignment.status === "canceled"
		) {
			await surfaceUnblockedDependents(
				context,
				{
					blockerWorkItemId: assignment.workItemId,
					organizationId: input.organizationId,
					createdAt,
				},
				{ enqueue: kernelUnblockEnqueue(context) },
			);
		}
	}
	const outcomeKind =
		input.assignment.status === "completed"
			? "subagent.completed"
			: input.assignment.status === "failed" ||
				  input.assignment.status === "canceled"
				? "subagent.failed"
				: null;
	if (outcomeKind) {
		await insertKernelRuntimeEvent(context, {
			id: homeRuntimeEventId({
				organizationId: input.organizationId,
				kind: outcomeKind,
				conversationId: input.conversationId,
				runId: input.homeRunId,
				suffix: assignment.id,
			}),
			organizationId: input.organizationId,
			kind: outcomeKind,
			conversationId: input.conversationId,
			runId: input.homeRunId,
			delegatedTediId: assignment.ownerTediId,
			childRunId: assignment.childRunId,
			payload: {
				childRunId: assignment.childRunId,
				childRunLatestEventAt: input.assignment.latestEventAt,
				childRunLatestEventKind: input.assignment.latestEventKind ?? null,
				childRunPreview: input.assignment.preview,
				childRunStatus: input.assignment.status,
				delegatedTediId: assignment.ownerTediId,
				homePlanAssignmentId: assignment.id,
				homeRunId: input.homeRunId,
				source: "kernelRuntime.planAssignmentCompletion",
				workItemId: assignment.workItemId ?? null,
			},
			runtimeMetadata: {
				childRunStatus: input.assignment.status,
				source: "kernelRuntime.planAssignmentCompletion",
			},
			createdAt,
		});
	}
	await insertKernelRuntimeEvent(context, {
		id: homeRuntimeEventId({
			organizationId: input.organizationId,
			kind: "message.completed",
			conversationId: input.conversationId,
			runId: input.homeRunId,
			suffix: `${assignment.id}:plan-assignment-completion`,
		}),
		organizationId: input.organizationId,
		kind: "message.completed",
		conversationId: input.conversationId,
		runId: input.homeRunId,
		// Per-assignment id family — intentionally NOT
		// asyncCompletionAssistantMessageId(), which is the run-level message id
		// that the terminal reconcile outputMessageId points at.
		messageId: `${input.homeRunId}:${assignment.id}:async-completion:assistant`,
		delegatedTediId: assignment.ownerTediId,
		childRunId: assignment.childRunId,
		payload: {
			role: "assistant",
			content,
			channel: "home",
			metadata: {
				asyncCompletion: true,
				childRunId: assignment.childRunId,
				childRunLatestEventAt: input.assignment.latestEventAt,
				childRunLatestEventKind: input.assignment.latestEventKind ?? null,
				childRunPreview: input.assignment.preview,
				childRunStatus: input.assignment.status,
				delegatedTediId: assignment.ownerTediId,
				homePlanAssignmentId: assignment.id,
				homeRunId: input.homeRunId,
				homeSubject: true,
				source: "kernelRuntime.planAssignmentCompletion",
				workItemId: assignment.workItemId ?? null,
			},
		},
		runtimeMetadata: {
			asyncCompletion: true,
			childRunId: assignment.childRunId,
			childRunLatestEventAt: input.assignment.latestEventAt,
			childRunLatestEventKind: input.assignment.latestEventKind ?? null,
			childRunStatus: input.assignment.status,
			delegatedTediId: assignment.ownerTediId,
			homePlanAssignmentId: assignment.id,
			source: "kernelRuntime.planAssignmentCompletion",
			workItemId: assignment.workItemId ?? null,
		},
		createdAt,
	});
}
