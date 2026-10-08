import {
	workstationDispatchIdentity,
	inspectWorkstationDispatchAdmission,
} from "../kernel/workstation-dispatch";
import { type BaseContext, ErrorCodes, createError } from "../../orpc";
import {
	acceptWorkItem,
	createWorkItem,
	listWorkItems,
} from "@tedix/db/queries/work-items/crud";
import { ExecutionRequirementSchema } from "@tedix/api-contract/schemas/execution-evidence";
import type {
	HomePlan,
	HomePlanAssignmentApprovalResult,
	HomeRun,
} from "@tedix/api-contract/schemas/kernel-runtime";
import {
	KERNEL_DELEGATE_ENQUEUE_BUDGET_MS,
	createDelegationWorkItem,
	directDelegationDispatchContent,
} from "../kernel/delegation-work-item";
import {
	type KernelRuntimeRun,
	compareAndTouchKernelRuntimeRun,
	getKernelRuntimeRun,
	updateKernelRuntimeRun,
} from "@tedix/db/queries/kernel-runtime-runs";
import { addWorkItemComment } from "@tedix/db/queries/work-items/comments";
import {
	addWorkItemRelation,
	queryWorkItemBlockers,
} from "@tedix/db/queries/work-items/relations";
import { approvedHomePlanStatus } from "../kernel/home-plan";
import {
	assignmentIsWriteBearing,
	renderDelegationWorkOrderMessage,
	serializedFanOutChainEdges,
	shouldSerializeFanOut,
} from "../kernel/delegation-dispatch";
import { auditActor } from "../../audit-helpers";
import {
	errorMessage,
	homeRunProgress,
	isTerminalBlockerStatus,
	isTerminalHomeRunStatus,
	nonNullRecord,
	nowIso,
	offsetIso,
	predictAgentRunId,
	stringFromPayload,
	withTimeout,
} from "../kernel/runtime-shared";
import { homePlanAssignmentDispatchContent } from "../kernel/plan-dispatch";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import {
	insertKernelRuntimeEvent,
	insertKernelRuntimeRun,
	normalizeHomeRunRecord,
	recordHomeDelegationDispatchFailure,
} from "../kernel/run-store";
import { resolveKernelFanOutCap } from "@tedix/api-contract/utils/approval-policy";
import { settleKernelSubmission } from "../../../kernel/runtime-submission-bridge";
import { startWorkItemAttempt } from "@tedix/db/queries/work-items/attempts";
import { toJsonRecord } from "@tedix/db/utils/json";
import { workItemPurposeFor } from "@tedix/db/queries/work-items/purpose";
import {
	kernelDelegateRunner,
	kernelPlanWorkItemDescription,
	kernelPlanWorkItemTitle,
	readKernelPlanFromRun,
	readOrgGovernancePolicy,
} from "./policy-normalization";
import {
	createHomePlanDependencyRelations,
	readKernelUserMessageContent,
	resolveKernelDelegateTarget,
} from "./run-reads-streams";
import {
	HomePlanAssignmentsCoreResult,
	approvedExecutionWorkOrder,
	kernelDelegationRecommendationFromRun,
} from "./turn-delegation";
import { internalDelegationContext } from "./delegation-context";
import { runWorkstationWorkOrderDispatch } from "./workstation-dispatch";
import {
	admitWorkAttempt,
	WORK_ATTEMPT_ADMISSION_TTL_MS,
} from "../work-items/attempt-admission";

export async function respondKernelDelegationRecommendationApprovalCore(
	context: BaseContext,
	input: {
		decision: "approve" | "reject";
		note?: string;
		organizationId: string;
		run: KernelRuntimeRun;
		/**
		 * The held Work Item an agent approver admitted
		 * (`homeDelegation.agentReview.workItemId`). Reused so its approval
		 * receipt satisfies admission, instead of minting a new item.
		 */
		approvedWorkItemId?: string;
		/** Who resolved: the operator (default) or the approval tedi. */
		resolvedBy?: { type: "user" | "tedi"; id: string };
	},
): Promise<{
	run: HomeRun;
	assignments: HomePlanAssignmentApprovalResult[];
}> {
	if (isTerminalHomeRunStatus(input.run.status))
		throw createError(
			ErrorCodes.CONFLICT,
			"Terminal Home run cannot resolve a delegation approval",
		);
	const pending = kernelDelegationRecommendationFromRun(input.run);
	if (!pending) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Home run ${input.run.id} is not waiting on a delegation approval.`,
		);
	}
	const resolutionStatus = stringFromPayload(
		pending.delegation.resolutionStatus,
	);
	if (resolutionStatus) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Home run ${input.run.id} delegation approval is already "${resolutionStatus}".`,
		);
	}
	let resolvedAt = nowIso();
	if (resolvedAt === input.run.updatedAt) resolvedAt = offsetIso(resolvedAt, 1);
	// Atomic latch: the resolutionStatus check above is a read. Advance the
	// run's updatedAt with a compare-and-set against the row this resolver read,
	// so a concurrent operator and agent (or two operators) cannot both resolve.
	if (
		!(await compareAndTouchKernelRuntimeRun(context.db, {
			id: input.run.id,
			organizationId: input.organizationId,
			status: input.run.status,
			expectedUpdatedAt: input.run.updatedAt,
			updatedAt: resolvedAt,
		}))
	) {
		throw createError(
			ErrorCodes.CONFLICT,
			`Home run ${input.run.id} delegation approval changed while it was being resolved; reload and retry.`,
		);
	}
	const baseWorkOrder = {
		...pending.workOrder,
		status: input.decision === "approve" ? "approved" : "rejected",
	};
	const nextWorkOrder =
		input.decision === "approve"
			? approvedExecutionWorkOrder({
					delegation: pending.delegation,
					note: input.note,
					workOrder: baseWorkOrder,
				})
			: baseWorkOrder;
	const nextDelegation = {
		...pending.delegation,
		resolution: input.note ?? null,
		resolutionStatus: input.decision === "approve" ? "approved" : "rejected",
		resolvedAt,
		...(input.resolvedBy ? { resolvedBy: input.resolvedBy } : {}),
		workOrder: nextWorkOrder,
	};
	const eventId = [
		"home",
		input.organizationId,
		"event",
		"delegation.approval.resolved",
		input.run.conversationId,
		input.run.id,
		resolvedAt,
	].join(":");
	await insertKernelRuntimeEvent(context, {
		id: eventId,
		organizationId: input.organizationId,
		kind: "approval.resolved",
		conversationId: input.run.conversationId,
		runId: input.run.id,
		delegatedTediId: pending.targetTediId,
		payload: {
			delegationWorkOrder: nextWorkOrder,
			resolution: input.note ?? null,
			status: nextDelegation.resolutionStatus,
		},
		runtimeMetadata: {
			source: "kernelRuntime.respondApproval",
			dispatch:
				input.decision === "approve"
					? "home-delegation-approved"
					: "home-delegation-rejected",
		},
		createdAt: resolvedAt,
	});
	if (input.decision === "reject") {
		await updateKernelRuntimeRun(context.db, input.run.id, {
			status: "canceled",
			progressValue: 100,
			progressLabel: "Rejected",
			progressDetail: "Delegation rejected by operator",
			latestEventKind: "approval.resolved",
			latestEventAt: resolvedAt,
			preview: "Delegation rejected by operator.",
			completedAt: resolvedAt,
			updatedAt: resolvedAt,
			metadata: toJsonRecord({
				...pending.metadata,
				homeDelegation: nextDelegation,
			}),
		});
		const updatedRun = await getKernelRuntimeRun(context.db, {
			id: input.run.id,
		});
		return {
			run: normalizeHomeRunRecord(updatedRun ?? input.run),
			assignments: [],
		};
	}
	const target = await resolveKernelDelegateTarget(context, {
		delegateToTediId: pending.targetTediId,
		organizationId: input.organizationId,
	});
	const sourceContent =
		(await readKernelUserMessageContent(context, {
			conversationId: input.run.conversationId,
			organizationId: input.organizationId,
			runId: input.run.id,
		})) ??
		stringFromPayload(pending.workOrder.sourceContent) ??
		"Complete the approved Home delegation work order.";
	const approvedMetadata = {
		...pending.metadata,
		homeDelegation: nextDelegation,
		delegationWorkOrder: nextWorkOrder,
	};
	const approvedExecutionRequirement = ExecutionRequirementSchema.safeParse(
		nonNullRecord(nextWorkOrder)?.executionRequirement,
	);
	if (!approvedExecutionRequirement.success) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Approved delegation work order has no valid execution requirement",
		);
	}
	if (!target)
		throw createError(ErrorCodes.NOT_FOUND, "Delegated tedi not found");
	if (approvedExecutionRequirement.data.surface === "workstation") {
		const identity = workstationDispatchIdentity({
			homeRunId: input.run.id,
			target,
		});
		const requestedWorkItemId =
			input.approvedWorkItemId ??
			stringFromPayload(nonNullRecord(approvedMetadata)?.workItemId) ??
			stringFromPayload(nonNullRecord(input.run.runtimeMetadata)?.workItemId);
		if (requestedWorkItemId)
			await inspectWorkstationDispatchAdmission(context, {
				organizationId: input.organizationId,
				workItemId: requestedWorkItemId,
				targetTediId: target.id,
				runtimeRunId: identity.runtimeRunId,
				now: resolvedAt,
			});
		const workstationWorkItemId = await createDelegationWorkItem(context, {
			assigneeTediId: pending.targetTediId,
			childRunId: identity.runtimeRunId,
			content: sourceContent,
			conversationId: input.run.conversationId,
			createdAt: resolvedAt,
			executionRequirement: approvedExecutionRequirement.data,
			homeRunId: input.run.id,
			organizationId: input.organizationId,
			objectiveId:
				stringFromPayload(
					nonNullRecord(input.run.runtimeMetadata)?.objectiveId,
				) ?? stringFromPayload(nonNullRecord(input.run.metadata)?.objectiveId),
			workItemId: requestedWorkItemId,
		});
		await runWorkstationWorkOrderDispatch(context, {
			content: sourceContent,
			conversationId: input.run.conversationId,
			delegateToTediId: pending.targetTediId,
			existingMetadata: approvedMetadata,
			existingRuntimeMetadata: nonNullRecord(input.run.runtimeMetadata),
			organizationId: input.organizationId,
			runId: input.run.id,
			trigger:
				input.resolvedBy?.type === "tedi" ? "agent-approval" : "human-approval",
			userMessageId: input.run.inputMessageId ?? `${input.run.id}:input`,
			workItemId: workstationWorkItemId,
			workOrder: nextWorkOrder,
		});
		const updatedRun = await getKernelRuntimeRun(context.db, {
			id: input.run.id,
		});
		return {
			run: normalizeHomeRunRecord(updatedRun ?? input.run),
			assignments: [],
		};
	}
	const clientRequestId = `${input.run.id}:approved:${pending.targetTediId}`;
	const predictedChildRunId = predictAgentRunId({
		clientRequestId,
		tediId: pending.targetTediId,
	});
	const requestedDelegationWorkItemId =
		input.approvedWorkItemId ??
		stringFromPayload(nonNullRecord(approvedMetadata)?.workItemId) ??
		stringFromPayload(nonNullRecord(input.run.runtimeMetadata)?.workItemId);
	const delegationWorkItemId = await createDelegationWorkItem(context, {
		assigneeTediId: pending.targetTediId,
		childRunId: predictedChildRunId,
		content: sourceContent,
		conversationId: input.run.conversationId,
		createdAt: resolvedAt,
		executionRequirement: approvedExecutionRequirement.data,
		homeRunId: input.run.id,
		organizationId: input.organizationId,
		objectiveId:
			stringFromPayload(
				nonNullRecord(input.run.runtimeMetadata)?.objectiveId,
			) ?? stringFromPayload(nonNullRecord(input.run.metadata)?.objectiveId),
		workItemId: requestedDelegationWorkItemId,
	});
	if (requestedDelegationWorkItemId && !delegationWorkItemId) {
		throw createError(
			ErrorCodes.CONFLICT,
			`Work Item ${requestedDelegationWorkItemId} is unavailable for this delegation`,
		);
	}
	const approvedDispatchMetadata = {
		...approvedMetadata,
		...(delegationWorkItemId
			? {
					workItemId: delegationWorkItemId,
				}
			: {}),
	};
	const workOrderDispatchContent = renderDelegationWorkOrderMessage({
		fallbackContent: sourceContent,
		fallbackWorkOrderId: `work-order:${input.run.id}`,
		label: "DELEGATION",
		workOrder: nextWorkOrder,
	});
	const childDispatchContent = delegationWorkItemId
		? directDelegationDispatchContent({
				content: workOrderDispatchContent,
				delegateToTediId: pending.targetTediId,
				homeRunId: input.run.id,
				workItemId: delegationWorkItemId,
			})
		: workOrderDispatchContent;
	const internalContext = internalDelegationContext(
		context,
		input.organizationId,
	);
	const childResult = await withTimeout(
		kernelDelegateRunner({
			context: internalContext,
			childRunId: clientRequestId,
			content: childDispatchContent,
			delegateToTediId: pending.targetTediId,
			metadata: toJsonRecord({
				source: "kernelRuntime.respondApproval",
				homeConversationId: input.run.conversationId,
				homeRunId: input.run.id,
				homeMessageId: input.run.inputMessageId ?? `${input.run.id}:input`,
				delegationWorkOrder: nextWorkOrder,
				executionSurface: approvedExecutionRequirement.data.surface,
				...(nonNullRecord(input.run.runtimeMetadata)?.requiredProofKind ===
				"code"
					? { requiredProofKind: "code" }
					: {}),
				dispatchTrigger:
					input.resolvedBy?.type === "tedi"
						? "agent-approval"
						: "human-approval",
				...(delegationWorkItemId
					? {
							workItemId: delegationWorkItemId,
						}
					: {}),
			}),
		}),
		KERNEL_DELEGATE_ENQUEUE_BUDGET_MS,
		"Home approved delegation dispatch",
	).catch((error) => ({
		childRunId: predictedChildRunId,
		childConversationId: undefined,
		error: errorMessage(error),
		status: "failed" as const,
	}));
	if (childResult.status === "failed") {
		await recordHomeDelegationDispatchFailure(context, {
			childConversationId: childResult.childConversationId,
			childRunId: childResult.childRunId,
			conversationId: input.run.conversationId,
			delegatedTediId: pending.targetTediId,
			error: childResult.error ?? "Delegated child dispatch failed",
			existingMetadata: approvedDispatchMetadata,
			organizationId: input.organizationId,
			runId: input.run.id,
		});
	} else {
		await updateKernelRuntimeRun(context.db, input.run.id, {
			status: "queued",
			delegatedTediId: pending.targetTediId,
			childRunId: childResult.childRunId,
			childConversationId: childResult.childConversationId ?? null,
			progressValue: 24,
			progressLabel: "Dispatched",
			progressDetail: "Delegation work order delivered to the target tedi",
			latestEventKind: "run.started",
			latestEventAt: resolvedAt,
			preview:
				"Delegation work order dispatched to the target tedi; progress will stream into this work card.",
			completedAt: null,
			startedAt: resolvedAt,
			updatedAt: resolvedAt,
			metadata: toJsonRecord({
				...approvedDispatchMetadata,
				childConversationId: childResult.childConversationId ?? null,
				childRunId: childResult.childRunId,
				delegatedTediId: pending.targetTediId,
				delegationStatus: "queued",
				homeApprovedDispatch: {
					childRunId: childResult.childRunId,
					dispatchedAt: resolvedAt,
					source: "kernelRuntime.respondApproval",
					...(delegationWorkItemId
						? {
								workItemId: delegationWorkItemId,
							}
						: {}),
				},
			}),
		});
	}
	const updatedRun = await getKernelRuntimeRun(context.db, {
		id: input.run.id,
	});
	return {
		run: normalizeHomeRunRecord(updatedRun ?? input.run),
		assignments: [],
	};
}

// Approve proposed Home plan assignments: promote them into Work Items and
// optionally dispatch isolate child runs. Shared by approvePlanAssignments
// (approve_home_plan) and respondApproval (decision: "approve" on a plan
// target).

export // Approve proposed Home plan assignments: promote them into Work Items and
// optionally dispatch isolate child runs. Shared by approvePlanAssignments
// (approve_home_plan) and respondApproval (decision: "approve" on a plan
// target).
async function approveHomePlanAssignmentsCore(
	context: BaseContext,
	input: {
		organizationId: string;
		homeRunId: string;
		assignmentIds?: string[];
		dispatch: boolean;
		approvalNote?: string;
	},
): Promise<HomePlanAssignmentsCoreResult> {
	const { organizationId } = input;
	const existingRun = await getKernelRuntimeRun(context.db, {
		id: input.homeRunId,
		organizationId,
	});
	if (!existingRun) {
		throw createError(ErrorCodes.NOT_FOUND, "Home run not found");
	}
	const existingPlan = readKernelPlanFromRun(existingRun);
	const selectedIds = new Set(
		input.assignmentIds?.length
			? input.assignmentIds
			: existingPlan.assignments
					.filter((assignment) => assignment.status === "proposed")
					.map((assignment) => assignment.id),
	);
	const selectedAssignments = existingPlan.assignments.filter((assignment) =>
		selectedIds.has(assignment.id),
	);
	if (selectedAssignments.length === 0) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"No proposed Home plan assignments matched the approval request",
		);
	}

	// Fan-out cap (a spawn_bounds-style pattern): the approval-dispatch action
	// itself counts as 1 toward the cap, matching the "dispatch tool counts"
	// rule. The cap limits child tedi spawns per approval turn. Fail-CLOSED:
	// if the plan would exceed the cap, reject before any dispatch occurs so
	// the operator sees a clear error rather than a partial/silent truncation.
	if (input.dispatch) {
		const governancePolicy = await readOrgGovernancePolicy(
			context,
			organizationId,
		);
		const fanOutCap = resolveKernelFanOutCap(governancePolicy);
		// Count the approval action itself as 1 dispatch (the "spawn tool").
		// Remaining budget is fanOutCap - 1 child dispatches.
		const allowedChildDispatches = Math.max(0, fanOutCap - 1);
		if (selectedAssignments.length > allowedChildDispatches) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`fan-out cap reached: this approval would dispatch ${selectedAssignments.length} child tedi(s) but maxDelegationsPerTurn=${fanOutCap} (counting the approval action itself) allows at most ${allowedChildDispatches}. Reduce the number of selected assignments or raise the cap in your governance policy.`,
			);
		}
	}
	const approvedAt = nowIso();
	const existingRunMetadata = nonNullRecord(existingRun.metadata);
	const redriveInput = nonNullRecord(existingRunMetadata?.redriveInput);
	const sourceRequest =
		typeof redriveInput?.content === "string" ? redriveInput.content : null;
	const approvalResults: HomePlanAssignmentApprovalResult[] = [];
	const dispatches: Promise<unknown>[] = [];
	const assignmentResults = new Map<
		string,
		{
			childConversationId?: string | null;
			childRunId?: string | null;
			error?: string | null;
			status: HomePlan["assignments"][number]["status"];
			workItemId: string;
		}
	>();

	// PRE-PASS — materialize the whole approved set BEFORE any blocker gate runs.
	// Create every selected assignment's Work Item (+ its home_plan_approved audit
	// comment) and record owner→workItemId, THEN write the inferred cross-owner
	// dependency relations, and ONLY THEN run the dispatch/gate loop below. This
	// ordering is REQUIRED: the gate (queryWorkItemBlockers) must observe the
	// just-written relations, so a blocker that appears later in the plan still
	// defers its earlier dependent (interleaving creation with the gate would miss
	// a blocker created after its dependent). Order is preserved from
	// selectedAssignments so the `:plan:<index>` childClientRequestId ids stay stable.
	const created: Array<{
		assignment: (typeof selectedAssignments)[number];
		workItem: Awaited<ReturnType<typeof createWorkItem>>;
	}> = [];
	const ownerToWorkItemId = new Map<string, string>();
	for (const assignment of selectedAssignments) {
		const existingWorkItem = (
			await listWorkItems(context.db, {
				orgId: organizationId,
				limit: 1_000,
			})
		).find((candidate) => candidate.sourceIntentId === assignment.id);
		let workItem =
			existingWorkItem ??
			(await createWorkItem(context.db, {
				id: crypto.randomUUID(),
				orgId: organizationId,
				title: kernelPlanWorkItemTitle(assignment),
				description: kernelPlanWorkItemDescription({
					assignment,
					homeRunId: input.homeRunId,
					plan: existingPlan,
					sourceRequest,
				}),
				workKind: "operations",
				priority: assignment.risk === "high" ? "high" : "medium",
				accountableOwnerType: "tedi",
				accountableOwnerId: assignment.ownerTediId,
				...workItemPurposeFor({
					objectiveId: existingPlan.objectiveId,
					workClass: "maintenance",
					now: new Date(approvedAt),
				}),
				sourceSessionKey: existingRun.conversationId,
				sourceIntentId: assignment.id,
				provenance: {
					source: "kernelRuntime.approvePlanAssignments",
					homePlanId: existingPlan.id,
					homeRunId: input.homeRunId,
					assignmentId: assignment.id,
				},
				metadata: {
					approvalNote: input.approvalNote ?? null,
					expectedEvidence: assignment.expectedEvidence,
					homePlanAssignment: assignment,
				},
				createdAt: approvedAt,
			}));
		if (workItem.disposition === "proposed")
			workItem = await acceptWorkItem(context.db, {
				orgId: organizationId,
				workItemId: workItem.id,
				acceptanceContract: {
					version: 1,
					doneLooksLike:
						"The assigned owner settled its Attempt with a durable result reference (artifact, receipt, or commit).",
				},
				actor: { type: "system", id: "home" },
				acceptedAt: approvedAt,
			});
		await addWorkItemComment(context.db, {
			id: crypto.randomUUID(),
			workItemId: workItem.id,
			orgId: organizationId,
			authorType: "system",
			authorId: "home",
			body: `Home approved ${assignment.ownerLabel} for this assignment and linked it to plan ${existingPlan.id}.`,
			metadata: {
				approvalNote: input.approvalNote ?? null,
				assignmentId: assignment.id,
				homePlanId: existingPlan.id,
				homeRunId: input.homeRunId,
			},
			createdAt: approvedAt,
		});
		created.push({
			assignment,
			workItem,
		});
		ownerToWorkItemId.set(assignment.ownerTediId, workItem.id);
	}

	// Materialize the plan's inferred blocker→dependent edges into work_item_relations
	// now that every approved owner has a Work Item — so the dispatch gate below sees
	// them. Fail-soft; never throws.
	await createHomePlanDependencyRelations(context, {
		plan: existingPlan,
		ownerToWorkItemId,
		organizationId,
		homePlanId: existingPlan.id,
		createdAt: approvedAt,
	});

	// Fleet fan-out = independent-reads-only (Anthropic's orchestrator-worker
	// envelope; decisions/agentic-kernel-architecture.md). Parallel fan-out is
	// proven for breadth-first INDEPENDENT work; a WRITE-BEARING fan-out (2+ members
	// MUTATE shared work-item/ledger/facet state) is a cross-facet write race, so it
	// serializes its dispatch (await each child before the next) instead of firing
	// in parallel. A read-only independent fan-out keeps the parallel path.
	// Cross-tedi DEPENDENCY ordering is NOT decided here — the cross-tedi blocker
	// gate below already DEFERS any dependent whose blocker is non-terminal
	// (completion-gated, strictly stronger than enqueue serialization), so a
	// deferred dependent never dispatches this turn and dependency edges add no
	// serialization the gate did not already enforce. Mechanical/policy only — no
	// LLM verdict (assignmentIsWriteBearing keys off routeKind + a mutation-verb
	// signal on the objective).
	const writeBearingCount = created.reduce(
		(count, { assignment }) =>
			assignmentIsWriteBearing({
				routeKind: assignment.routeKind,
				objective: assignment.objective,
			})
				? count + 1
				: count,
		0,
	);
	const serializeFanOut = shouldSerializeFanOut({
		dispatch: input.dispatch,
		assignmentCount: created.length,
		writeBearingCount,
	});
	if (serializeFanOut) {
		console.warn(
			"[kernelRuntime.approvePlanAssignments] serializing write-bearing multi-tedi fan-out",
			{
				homePlanId: existingPlan.id,
				assignments: created.length,
				writeBearingCount,
			},
		);
		// Real serialization: awaiting the async delegate enqueue below single-threads
		// NOTHING (the await resolves once the child turn is merely queued in its DO,
		// not when its work runs — the children still execute concurrently in their
		// own runtimes and their writes still race). Instead, CHAIN the fan-out into
		// one line of blocker edges so the cross-tedi blocker gate defers every member
		// but the chain head and the unblock watcher advances the rest one at a time —
		// the completion-gated supervision the plan's explicit edges already ride, and
		// the exact mechanism that retired the redundant dependency-edge branch. The
		// chain is a linear extension of the plan's dependency DAG, so no synthetic
		// edge can introduce a cycle (which would deadlock the plan).
		const chainEdges = serializedFanOutChainEdges({
			orderedWorkItemIds: created.map(({ workItem }) => workItem.id),
			existingEdges: existingPlan.dependencies.flatMap((edge) => {
				const fromWorkItemId = ownerToWorkItemId.get(edge.fromOwnerTediId);
				const toWorkItemId = ownerToWorkItemId.get(edge.toOwnerTediId);
				return fromWorkItemId && toWorkItemId
					? [
							{
								fromWorkItemId,
								toWorkItemId,
							},
						]
					: [];
			}),
		});
		for (const edge of chainEdges) {
			try {
				await addWorkItemRelation(context.db, {
					id: crypto.randomUUID(),
					orgId: organizationId,
					fromWorkItemId: edge.fromWorkItemId,
					toWorkItemId: edge.toWorkItemId,
					relationType: "blocks",
					metadata: {
						source: "kernelRuntime.plan.serializedFanOut",
						homePlanId: existingPlan.id,
					},
					createdAt: approvedAt,
				});
			} catch (error) {
				console.warn(
					"[kernelRuntime.approvePlanAssignments] serialized fan-out chain edge insert failed (fail-soft)",
					{
						...edge,
						error: errorMessage(error),
					},
				);
			}
		}
	}
	for (const [index, { assignment, workItem }] of created.entries()) {
		// CROSS-TEDI BLOCKER GATE: before dispatching this assignment, check whether
		// its Work Item is blocked_by any other Work Item that is not yet terminal.
		// A non-terminal blocker DEFERS the dispatch — the Work Item is created and
		// approved, but no child run is minted. The operator must re-approve (or the
		// unblock watcher will surface it) once the blocker reaches a terminal state.
		// Fail-soft: a blocker-check error must NEVER break the dispatch loop; on
		// error we warn and fall through to normal dispatch.
		if (input.dispatch) {
			let pendingBlocker: {
				id: string;
				title: string;
				disposition: string;
			} | null = null;
			try {
				const blockers = await queryWorkItemBlockers(context.db, workItem.id);
				pendingBlocker =
					blockers.find((b) => !isTerminalBlockerStatus(b.disposition)) ?? null;
			} catch (error) {
				console.warn(
					"[kernelRuntime.approvePlanAssignments] blocker check failed (fail-soft, dispatching)",
					{
						workItemId: workItem.id,
						error: errorMessage(error),
					},
				);
				pendingBlocker = null;
			}
			if (pendingBlocker) {
				const reason = `waiting for ${pendingBlocker.title}`;
				await addWorkItemComment(context.db, {
					id: crypto.randomUUID(),
					workItemId: workItem.id,
					orgId: organizationId,
					authorType: "system",
					authorId: "home",
					body: `Dispatch deferred: ${reason} (blocker ${pendingBlocker.id} is ${pendingBlocker.disposition}). This assignment will not start until its blocker is completed or cancelled.`,
					metadata: {
						source: "kernelRuntime.approvePlanAssignments",
						assignmentId: assignment.id,
						blockerWorkItemId: pendingBlocker.id,
						blockerTitle: pendingBlocker.title,
						blockerDisposition: pendingBlocker.disposition,
						homePlanId: existingPlan.id,
						homeRunId: input.homeRunId,
					},
					createdAt: approvedAt,
				});
				// Keep the assignment status "approved" (operator-gated, not dispatched)
				// and surface the human-visible reason via `error`. No child run minted.
				assignmentResults.set(assignment.id, {
					childConversationId: null,
					childRunId: null,
					error: reason,
					status: "approved",
					workItemId: workItem.id,
				});
				approvalResults.push({
					assignmentId: assignment.id,
					ownerTediId: assignment.ownerTediId,
					status: "approved",
					workItemId: workItem.id,
					childRunId: null,
					childConversationId: null,
				});
				continue;
			}
		}
		const childClientRequestId = `${input.homeRunId}:plan:${index + 1}:delegate:${assignment.ownerTediId}`;
		const predictedChildRunId = input.dispatch
			? predictAgentRunId({
					clientRequestId: childClientRequestId,
					tediId: assignment.ownerTediId,
				})
			: null;
		assignmentResults.set(assignment.id, {
			childConversationId: input.dispatch ? "agent:main:main" : null,
			childRunId: predictedChildRunId,
			status: input.dispatch ? "queued" : "approved",
			workItemId: workItem.id,
		});
		approvalResults.push({
			assignmentId: assignment.id,
			ownerTediId: assignment.ownerTediId,
			status: input.dispatch ? "queued" : "approved",
			workItemId: workItem.id,
			childRunId: predictedChildRunId,
			childConversationId: input.dispatch ? "agent:main:main" : null,
		});
		if (input.dispatch) {
			const admission = await admitWorkAttempt(context.db, {
				workItem,
				executor: { type: "tedi", id: assignment.ownerTediId },
				leaseTtlMs: WORK_ATTEMPT_ADMISSION_TTL_MS,
				now: approvedAt,
			});
			await startWorkItemAttempt(context.db, {
				orgId: organizationId,
				workItemId: workItem.id,
				admissionId: admission.id,
				executor: { type: "tedi", id: assignment.ownerTediId },
				runId: predictedChildRunId ?? childClientRequestId,
				startedAt: approvedAt,
				expiresAt: admission.expiresAt,
			});
			const delegateWork = kernelDelegateRunner({
				context,
				childRunId: childClientRequestId,
				content: homePlanAssignmentDispatchContent({
					assignment,
					homeRunId: input.homeRunId,
					plan: existingPlan,
					sourceRequest,
					workItemId: workItem.id,
				}),
				delegateToTediId: assignment.ownerTediId,
				metadata: {
					source: "kernelRuntime.plan.approve",
					homeConversationId: existingRun.conversationId,
					homePlanId: existingPlan.id,
					homeRunId: input.homeRunId,
					homePlanAssignmentId: assignment.id,
					workItemId: workItem.id,
				},
			}).catch((error) => {
				const message = errorMessage(error);
				console.warn(
					"[kernelRuntime.approvePlanAssignments] child dispatch failed",
					message,
				);
				assignmentResults.set(assignment.id, {
					childConversationId: "agent:main:main",
					childRunId: predictedChildRunId,
					error: message,
					status: "failed",
					workItemId: workItem.id,
				});
			});
			// A serialized (write-bearing) fan-out is single-threaded by the synthetic
			// blocker chain written above, NOT by awaiting here: the blocker gate has
			// already deferred every member but the chain head, so at most one child
			// dispatches this turn and the unblock watcher advances the rest one at a
			// time. Awaiting the async enqueue would serialize nothing (it resolves at
			// queue time, not completion). Every dispatch — serialized or parallel —
			// collects here so the settle below drains them before persist (identical
			// dispatch-failure status on both paths).
			dispatches.push(delegateWork);
		}
	}

	// Dispatch-failure persistence parity: settle every dispatch BEFORE
	// building/persisting nextPlan. A thrown child dispatch runs its `.catch` above
	// (which mutates assignmentResults to status:"failed"), so a failed dispatch
	// persists "failed" regardless of whether the plan was serialized. Previously
	// the parallel path deferred settlement to a post-persist `context.waitUntil`,
	// so the run row was written with the optimistic "queued" status (and a
	// predicted childRunId that never settles) — divergent persisted state for the
	// same failure. Settlement here is bounded: delegateWork resolves when the child
	// turn is ENQUEUED (dispatchMode:"async"), not when the child finishes.
	if (dispatches.length > 0) {
		await Promise.all(dispatches);
	}

	// Reconcile the returned/event-payload assignment rows from the now-settled
	// assignmentResults so the API return value and the home.plan.approved event
	// agree with the persisted plan below (the `.catch` only mutates
	// assignmentResults; without this an approvalResult for a thrown dispatch would
	// still read "queued" while nextPlan reads "failed").
	for (const result of approvalResults) {
		const settled = assignmentResults.get(result.assignmentId);
		if (!settled) continue;
		result.status = settled.status;
		result.childRunId = settled.childRunId ?? null;
		result.childConversationId = settled.childConversationId ?? null;
		result.error = settled.error ?? null;
	}
	const dispatchedAt = input.dispatch ? nowIso() : null;
	const nextPlan: HomePlan = {
		...existingPlan,
		assignments: existingPlan.assignments.map((assignment) => {
			const result = assignmentResults.get(assignment.id);
			if (!result) return assignment;
			return {
				...assignment,
				approvedAt,
				childConversationId: result.childConversationId ?? null,
				childRunId: result.childRunId ?? null,
				dispatchedAt,
				error: result.error ?? null,
				status: result.status,
				workItemId: result.workItemId,
			};
		}),
		attentionRoutes: existingPlan.attentionRoutes.map((route) => {
			const matching = existingPlan.assignments.find(
				(assignment) =>
					assignment.ownerTediId === route.ownerTediId &&
					assignmentResults.has(assignment.id),
			);
			if (!matching) return route;
			return {
				...route,
				outcome: input.dispatch ? "dispatched" : "approved",
			};
		}),
		status: "approved",
	};
	nextPlan.status = approvedHomePlanStatus(nextPlan);
	const nextProgress = homeRunProgress({
		eventCount: approvalResults.length,
		status: input.dispatch ? "queued" : "requires_approval",
	});
	const existingMetadata = nonNullRecord(existingRun.metadata) ?? {};
	const nextMetadata = {
		...existingMetadata,
		homePlan: nextPlan,
		homePlanApprovedAt: approvedAt,
		homePlanApprovalNote: input.approvalNote ?? null,
		progress: nextProgress,
	};
	await updateKernelRuntimeRun(context.db, input.homeRunId, {
		status: input.dispatch ? "queued" : "requires_approval",
		progressValue: nextProgress.current,
		progressLabel: nextProgress.label,
		progressDetail: nextProgress.detail,
		latestEventKind: input.dispatch ? "run.started" : "decision.recorded",
		latestEventAt: approvedAt,
		preview: `Approved ${approvalResults.length} Home plan assignment${approvalResults.length === 1 ? "" : "s"}.`,
		updatedAt: approvedAt,
		metadata: nextMetadata,
	});
	await insertKernelRuntimeEvent(context, {
		id: [
			"home",
			organizationId,
			"event",
			"home.plan.approved",
			existingRun.conversationId,
			input.homeRunId,
			approvedAt,
		].join(":"),
		organizationId,
		kind: "decision.recorded",
		conversationId: existingRun.conversationId,
		runId: input.homeRunId,
		payload: {
			action: "home.plan.approved",
			assignments: approvalResults,
			dispatch: input.dispatch,
			homePlan: nextPlan,
			status: nextPlan.status,
		},
		runtimeMetadata: {
			source: "kernelRuntime.approvePlanAssignments",
			homePlanId: nextPlan.id,
		},
		createdAt: approvedAt,
	});

	// Dispatches were already settled above (before persist) so nextPlan and the
	// persisted run row reflect real dispatch outcomes; nothing to defer here.

	const updatedRun = await getKernelRuntimeRun(context.db, {
		id: input.homeRunId,
	});
	return {
		run: normalizeHomeRunRecord(updatedRun ?? existingRun),
		homePlan: nextPlan,
		assignments: approvalResults,
	};
}

/**
 * Retry a failed delegated Home run by creating a NEW run row with a fresh
 * idempotency key and re-dispatching the same delegation work order to the
 * same target tedi. The original failed run is left untouched (immutable audit
 * trail). Guard: only valid when the run is terminal "failed" AND carries both
 * a `delegatedTediId` and a `delegationWorkOrder` in its metadata.
 *
 * Double-dispatch prevention: the new run id is a fresh `crypto.randomUUID()`,
 * so two concurrent POSTs produce two independent rows with distinct ids.
 * If an operator wants true idempotency they should cancel one immediately after.
 * This is intentional — retrying a failed run is an operator action, not a
 * machine re-enqueue, and the "deduplicate by key" pattern would silently drop
 * the second retry click when both actually need to proceed after the first
 * also fails.
 */

export /**
 * Retry a failed delegated Home run by creating a NEW run row with a fresh
 * idempotency key and re-dispatching the same delegation work order to the
 * same target tedi. The original failed run is left untouched (immutable audit
 * trail). Guard: only valid when the run is terminal "failed" AND carries both
 * a `delegatedTediId` and a `delegationWorkOrder` in its metadata.
 *
 * Double-dispatch prevention: the new run id is a fresh `crypto.randomUUID()`,
 * so two concurrent POSTs produce two independent rows with distinct ids.
 * If an operator wants true idempotency they should cancel one immediately after.
 * This is intentional — retrying a failed run is an operator action, not a
 * machine re-enqueue, and the "deduplicate by key" pattern would silently drop
 * the second retry click when both actually need to proceed after the first
 * also fails.
 */
async function retryKernelRunCore(
	context: BaseContext,
	input: {
		organizationId: string;
		run: KernelRuntimeRun;
	},
): Promise<{
	run: HomeRun;
	newRunId: string;
}> {
	const { organizationId } = input;
	const existingRun = input.run;

	// Guard 1: only terminal failed runs can be retried.
	if (existingRun.status !== "failed") {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Home run ${existingRun.id} is "${existingRun.status}" — only failed runs can be retried`,
		);
	}

	// Guard 2: must have a delegatedTediId and a delegationWorkOrder.
	const existingMetadata = nonNullRecord(existingRun.metadata) ?? {};
	const delegatedTediId =
		existingRun.delegatedTediId ??
		(typeof existingMetadata.delegatedTediId === "string"
			? existingMetadata.delegatedTediId
			: null);
	const delegationWorkOrder = nonNullRecord(
		existingMetadata.delegationWorkOrder,
	);
	if (!delegatedTediId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Home run ${existingRun.id} cannot be retried: no delegatedTediId on the failed run`,
		);
	}
	if (!delegationWorkOrder) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Home run ${existingRun.id} cannot be retried: no delegationWorkOrder on the failed run (only delegation runs are retryable)`,
		);
	}
	const workItemId =
		stringFromPayload(delegationWorkOrder.workItemId) ??
		stringFromPayload(existingMetadata.workItemId) ??
		stringFromPayload(nonNullRecord(existingRun.runtimeMetadata)?.workItemId);

	// Extract the original source content from the work order (used as the
	// dispatch message body, same as respondKernelDelegationRecommendationApprovalCore).
	const sourceContent =
		(typeof delegationWorkOrder.sourceContent === "string"
			? delegationWorkOrder.sourceContent
			: null) ??
		(typeof existingMetadata.objective === "string"
			? existingMetadata.objective
			: null) ??
		"Retry: please complete the delegated work order.";
	const retriedAt = nowIso();
	const assistantAt = offsetIso(retriedAt, 1);
	const completedAt = offsetIso(retriedAt, 2);

	// Fresh run id — this is a NEW run, not a resurrection of the failed one.
	const newRunId = crypto.randomUUID();
	const userMessageId = `${newRunId}:input`;
	const assistantMessageId = `${newRunId}:assistant`;
	// The child request id for the dispatch runner; mirrors the respondApproval
	// path's `${run.id}:approved:${targetTediId}` pattern.
	const childClientRequestId = `${newRunId}:retry:${delegatedTediId}`;
	const predictedChildRunId = predictAgentRunId({
		clientRequestId: childClientRequestId,
		tediId: delegatedTediId,
	});
	const retryMetadata = {
		source: "kernelRuntime.retryRun",
		contentLength: sourceContent.length,
		idempotencyKey: newRunId,
		delegatedTediId,
		delegationWorkOrder,
		retriedFromRunId: existingRun.id,
		...(workItemId
			? {
					workItemId,
				}
			: {}),
		childRunId: predictedChildRunId,
		childConversationId: "agent:main:main",
		approvalRequestId: null,
		homePlan: null,
		homeDispatchPolicy: null,
		kernelRoute: null,
		kernelEvidence: null,
	};
	const runtimeMetadata = {
		...(nonNullRecord(existingRun.runtimeMetadata)?.requiredProofKind === "code"
			? { requiredProofKind: "code" }
			: {}),
		source: "kernelRuntime.retryRun",
		subject: "home",
		delegation: "retry",
		retriedFromRunId: existingRun.id,
		childRunId: predictedChildRunId,
		delegatedTediId,
		...(workItemId
			? {
					workItemId,
				}
			: {}),
	};

	// Persist-first: insert transcript events + run row before dispatching.
	await insertKernelRuntimeEvent(context, {
		organizationId,
		kind: "message.received",
		conversationId: existingRun.conversationId,
		runId: newRunId,
		messageId: userMessageId,
		payload: {
			role: "user",
			content: sourceContent,
			channel: "home",
			metadata: {
				retried: true,
				retriedFromRunId: existingRun.id,
			},
		},
		runtimeMetadata,
		createdAt: retriedAt,
	});
	await insertKernelRuntimeEvent(context, {
		organizationId,
		kind: "run.started",
		conversationId: existingRun.conversationId,
		runId: newRunId,
		messageId: userMessageId,
		payload: {
			status: "dispatched",
			inputMessageId: userMessageId,
			retriedFromRunId: existingRun.id,
		},
		runtimeMetadata,
		createdAt: retriedAt,
	});
	await insertKernelRuntimeRun(context, {
		id: newRunId,
		organizationId,
		conversationId: existingRun.conversationId,
		status: "running",
		inputMessageId: userMessageId,
		outputMessageId: assistantMessageId,
		delegatedTediId,
		childRunId: predictedChildRunId,
		childConversationId: "agent:main:main",
		progress: homeRunProgress({
			eventCount: 0,
			status: "running",
		}),
		metadata: retryMetadata,
		runtimeMetadata,
		startedAt: retriedAt,
		completedAt: null,
		createdAt: retriedAt,
		updatedAt: retriedAt,
	});

	// Dispatch to the target tedi using the SAME work order content the original
	// run used. Mirrors respondKernelDelegationRecommendationApprovalCore exactly.
	const internalContext = internalDelegationContext(context, organizationId);
	const childResult = await withTimeout(
		kernelDelegateRunner({
			context: internalContext,
			childRunId: childClientRequestId,
			content: renderDelegationWorkOrderMessage({
				fallbackContent: sourceContent,
				fallbackWorkOrderId: `work-order:${newRunId}`,
				label: "RETRY",
				workOrder: delegationWorkOrder,
			}),
			delegateToTediId: delegatedTediId,
			metadata: {
				source: "kernelRuntime.retryRun",
				...(runtimeMetadata.requiredProofKind
					? { requiredProofKind: runtimeMetadata.requiredProofKind }
					: {}),
				homeConversationId: existingRun.conversationId,
				homeRunId: newRunId,
				homeMessageId: userMessageId,
				delegationWorkOrder,
				retriedFromRunId: existingRun.id,
				dispatchTrigger: "operator-retry",
				...(workItemId
					? {
							workItemId,
						}
					: {}),
			},
		}),
		KERNEL_DELEGATE_ENQUEUE_BUDGET_MS,
		"Home retry delegation dispatch",
	).catch((error) => ({
		childRunId: predictedChildRunId,
		childConversationId: undefined,
		error: errorMessage(error),
		status: "failed" as const,
		reason: undefined,
	}));
	if (childResult.status === "failed") {
		await recordHomeDelegationDispatchFailure(context, {
			childConversationId: childResult.childConversationId,
			childRunId: childResult.childRunId,
			conversationId: existingRun.conversationId,
			delegatedTediId,
			error: childResult.error ?? "Retry dispatch failed",
			existingMetadata: retryMetadata,
			organizationId,
			reason: childResult.reason ?? "dispatch_failed",
			runId: newRunId,
		});
	} else {
		// Update the new run row with the actual child run id from dispatch.
		await updateKernelRuntimeRun(context.db, newRunId, {
			status: "queued",
			childRunId: childResult.childRunId,
			childConversationId: childResult.childConversationId ?? null,
			progressValue: 24,
			progressLabel: "Dispatched",
			progressDetail: "Retry work order delivered to the target tedi",
			latestEventKind: "run.started",
			latestEventAt: retriedAt,
			preview:
				"Retry dispatched to the target tedi; progress will stream into this work card.",
			completedAt: null,
			startedAt: retriedAt,
			updatedAt: retriedAt,
			metadata: toJsonRecord({
				...retryMetadata,
				childRunId: childResult.childRunId,
				childConversationId: childResult.childConversationId ?? null,
				delegationStatus: "queued",
				homeRetryDispatch: {
					childRunId: childResult.childRunId,
					dispatchedAt: retriedAt,
					retriedFromRunId: existingRun.id,
					source: "kernelRuntime.retryRun",
				},
			}),
		});
	}

	// Emit the assistant message event and run-terminal event, same pattern as
	// enqueueMessage's delegation path.
	const actualChildRunId = childResult.childRunId ?? predictedChildRunId;
	const dispatchFailed = childResult.status === "failed";
	const assistantContent = dispatchFailed
		? `Retry dispatch failed: ${childResult.error ?? "unknown error"}`
		: "Retry work order dispatched to the target tedi — progress will stream into this work card.";
	await insertKernelRuntimeEvent(context, {
		organizationId,
		kind: "message.completed",
		conversationId: existingRun.conversationId,
		runId: newRunId,
		messageId: assistantMessageId,
		delegatedTediId,
		childRunId: actualChildRunId,
		payload: {
			role: "assistant",
			content: assistantContent,
			channel: "home",
			metadata: {
				homeSubject: true,
				delegatedTediId,
				childRunId: actualChildRunId,
				childConversationId: childResult.childConversationId ?? null,
				delegationError: childResult.error ?? null,
				delegationWorkOrder,
				retriedFromRunId: existingRun.id,
			},
		},
		runtimeMetadata: {
			...runtimeMetadata,
			childConversationId: childResult.childConversationId,
			delegationStatus: childResult.status,
			delegationError: childResult.error,
		},
		createdAt: assistantAt,
	});
	await insertKernelRuntimeEvent(context, {
		organizationId,
		kind: dispatchFailed ? "run.failed" : "run.completed",
		conversationId: existingRun.conversationId,
		runId: newRunId,
		messageId: assistantMessageId,
		delegatedTediId,
		childRunId: actualChildRunId,
		payload: {
			status: dispatchFailed ? "failed" : "queued",
			inputMessageId: userMessageId,
			outputMessageId: assistantMessageId,
			childRunId: actualChildRunId,
			childConversationId: childResult.childConversationId ?? null,
			retriedFromRunId: existingRun.id,
			delegationWorkOrder,
		},
		runtimeMetadata: {
			...runtimeMetadata,
			childConversationId: childResult.childConversationId,
			delegationStatus: childResult.status,
		},
		createdAt: completedAt,
	});

	// Audit trail.
	// Carry the original run's kernelRoute into the audit event so
	// home-reflection-producer can mine the kernel's routing rationale into
	// delegation-decision facts. Fail-soft: absent → null (producer skips the
	// "because:" clause and emits the bare fact text, zero regression).
	const retryKernelRoute = existingMetadata.kernelRoute ?? null;
	const actor = auditActor(context);
	await insertAuditEvent(context.db, {
		organizationId,
		actorId: actor.actorId,
		actorType: actor.actorType,
		action: "kernel.run.retried",
		resourceType: "kernel_run",
		resourceId: newRunId,
		metadata: toJsonRecord({
			...actor.actorMetadata,
			source: "kernelRuntime.retryRun",
			conversationId: existingRun.conversationId,
			retriedFromRunId: existingRun.id,
			delegatedTediId,
			childRunId: actualChildRunId,
			dispatchStatus: childResult.status,
			...(workItemId
				? {
						workItemId,
					}
				: {}),
			kernelRoute: retryKernelRoute,
		}),
		ipAddress: context.headers.get("CF-Connecting-IP"),
		userAgent: context.headers.get("User-Agent"),
	});

	// Settle the durable submission ledger for the failed-dispatch case.
	if (dispatchFailed) {
		const settleRetry = settleKernelSubmission(context.db, {
			runId: newRunId,
			organizationId,
			conversationId: existingRun.conversationId,
			outcome: "failed",
		}).catch(() => {});
		if (context.waitUntil) {
			context.waitUntil(settleRetry);
		} else {
			await settleRetry;
		}
	}
	const updatedRun = await getKernelRuntimeRun(context.db, {
		id: newRunId,
	});
	if (!updatedRun) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Retry run row not found after insert",
		);
	}
	return {
		run: normalizeHomeRunRecord(updatedRun),
		newRunId,
	};
}
