import { resolveHomeAttachments } from "./attachment-storage";
import { type BaseContext, ErrorCodes, createError } from "../../orpc";
import type { CodemodeExecuteWritePayload } from "@tedix/api-contract/schemas/codemode-execute-write";
import type {
	HomePlan,
	HomePlanAssignmentApprovalResult,
	HomeRun,
} from "@tedix/api-contract/schemas/kernel-runtime";
import {
	type KernelRuntimeRun,
	getKernelRuntimeRun,
	updateKernelRuntimeRun,
} from "@tedix/db/queries/kernel-runtime-runs";
import type {
	KernelTurnWorkDeps,
	KernelTurnWorkInput,
} from "../kernel/turn-work";
import type { TediApprovalRequest } from "@tedix/db/schema/approvals";
import type { WorkflowConfirmDispatcher } from "../kernel/workflow-confirm";
import { addWorkItemComment } from "@tedix/db/queries/work-items/comments";
import {
	autoResolveKernelWriteApproval,
	homeToolWriteApprovalRequestId,
	kernelWriteCardContent,
	resolveKernelFallbackTediId,
	settleHomeToolWriteApproval,
} from "../kernel/write-approval-settlement";
import { buildAutoDelegationDispatcher } from "../kernel/auto-dispatch";
import {
	buildInternalServiceBindingContext,
	errorMessage,
	homeRunProgress,
	isTerminalHomeRunStatus,
	nonNullRecord,
	nowIso,
	offsetIso,
	predictAgentRunId,
	stringFromPayload,
} from "../kernel/runtime-shared";
import { createDelegationWorkItem } from "../kernel/delegation-work-item";
import { createRouterClient } from "@orpc/server";
import { ensureActiveKernelHarnessVersion } from "../../../services/harness-persistence";
import { generateAndPersistHomeConversationTitle } from "../kernel/conversation-title";
import { getOrganizationTedi } from "@tedix/db/queries/kernel-runtime-support";
import { getProvisioningConfig } from "../tedis/helpers";
import { getSkillEntryBySlug } from "@tedix/db/queries/cognitive/skill-crud";
import { homeRunStatusFromPlanStatus } from "../kernel/home-plan";
import { homeWorkstationAttachPayload } from "../kernel/workstation-attach";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import {
	existingRunStartedCause,
	insertKernelRuntimeEvent,
	insertKernelRuntimeRun,
	normalizeHomeRunRecord,
} from "../kernel/run-store";
import {
	readChildRunFinalAssistantMessage,
	readChildRunFullResult,
} from "../kernel/child-run-reads";
import { recordHarnessSubjectTraceBundle } from "@tedix/db/queries/harness-version/trace-bundles";
import { resolveApprovalRequest } from "@tedix/db/queries/approvals";
import { skillsContractRouter } from "../cognitive";
import { toJsonRecord } from "@tedix/db/utils/json";
import { cancelWorkItem } from "@tedix/db/queries/work-items/crud";
import {
	activeKernel,
	activeKernelWriteProposalPlanner,
	kernelChildStopper,
	kernelDelegateRunner,
	readKernelPlanFromRun,
	readOrgGovernancePolicy,
	readSessionWriteAllowlist,
} from "./policy-normalization";
import {
	assertKernelApprovalStillPending,
	reconcileInboxWakeRuns,
} from "./run-reads-streams";
import { resolveKernelWorkstationAttachWorkOrder } from "./control-proposals";
import {
	requestHomeDelegationAgentReview,
	wakeHomeDelegationAgentReview,
} from "./delegation-agent-review";
import { internalDelegationContext } from "./delegation-context";
import { runWorkstationWorkOrderDispatch } from "./workstation-dispatch";
import { writeKernelTraceBundle } from "../kernel/kernel-trace-bundle-writer";
import { claimKernelExecutionPolicy } from "../../../kernel/runtime-submission-bridge";
import type { KernelExecutionPolicy } from "@tedix/api-contract/schemas/kernel-runtime";

/**
 * Wire {@link runKernelTurnWork}'s injected dependencies from a context. Used by
 * BOTH execution contexts: inline in `enqueueMessage` (request context) and
 * inside `KernelDO` (synthetic context built via `createContext`).
 *
 * `kernel` / `writeProposalPlanner` read the module-level test seams
 * (`activeKernel` / `activeKernelWriteProposalPlanner`) at CALL time — not at
 * deps-build time — so `kernelRuntimeTestHooks` stubbing keeps working wherever
 * the turn body runs.
 */
export function buildKernelTurnWorkDeps(
	context: BaseContext,
): KernelTurnWorkDeps {
	return {
		db: context.db,
		env: context.env,
		kernel: async (args) =>
			activeKernel({
				...args,
				resolveAttachments: (attachments) =>
					resolveHomeAttachments(
						context.env.TEDI_R2_BUCKET,
						args.organizationId,
						attachments,
					),
				attachments: await resolveHomeAttachments(
					context.env.TEDI_R2_BUCKET,
					args.organizationId,
					args.attachments,
				),
			}),
		writeProposalPlanner: (args) => activeKernelWriteProposalPlanner(args),
		insertKernelRuntimeEvent: (input) =>
			insertKernelRuntimeEvent(context, input),
		resolveKernelWriteAnchorTediId: (organizationId) =>
			resolveKernelFallbackTediId(context, organizationId),
		// Trusted-write auto-resolve arm: resolve the (already-created) approval
		// audit row through the canonical latch (resolvedBy:'policy') + execute via
		// the same settle a human approval drives. The gating decision is made
		// fail-closed in `runKernelTurnWork`; this only runs when it said autoResolve.
		autoResolveKernelWrite: (autoResolveInput) =>
			autoResolveKernelWriteApproval(context, autoResolveInput),
		homeToolWriteApprovalRequestId,
		homeRunProgress,
		kernelWriteCardContent,
		errorMessage,
		offsetIso,
		nowIso,
		ensureKernelHarnessVersion: ({
			organizationId,
			routerVersion,
			createdAt,
		}) =>
			ensureActiveKernelHarnessVersion(context.db, {
				orgId: organizationId,
				components: {
					attention_router: routerVersion,
				},
				reason: "kernel router version observed",
				metadata: {
					routerVersion,
					surface: "home.kernel",
				},
				createdAt,
			}),
		recordKernelTraceBundle: (bundle) =>
			recordHarnessSubjectTraceBundle(context.db, bundle),
		writeKernelTraceBundle: (evidence) =>
			writeKernelTraceBundle({
				bucket: context.env.TEDI_R2_BUCKET,
				evidence,
				knownSecrets: [context.env.CF_AI_GATEWAY_TOKEN],
			}),
		// Work-Item eager-create for a router-decided single delegation: the SAME
		// helper the explicit `delegateToTediId` path uses, so an auto-dispatched
		// `delegate_tedi` route tracks a claimed Work Item keyed to its child run id
		// (idempotent via sourceIntentId=childRunId). Fail-soft inside the helper.
		createDelegationWorkItem: (workItemInput) =>
			createDelegationWorkItem(context, workItemInput),
		predictAutoDelegationChildRunId: ({ homeRunId, delegatedTediId }) =>
			predictAgentRunId({
				clientRequestId: `${homeRunId}:auto:${delegatedTediId}`,
				tediId: delegatedTediId,
			}),
		// Autonomous Kernel→tedi delegation dispatch. The fail-closed authorization
		// gate lives in `shouldAutoDispatch(decideDelegationDispatch(...))`; when it
		// returns `auto`, this injected dispatcher reuses the same idempotent
		// cognitive-runtime enqueue + deterministic child-run id as the forced
		// delegateToTediId path (`defaultKernelDelegateRunner`).
		dispatchAutoDelegation: buildAutoDelegationDispatcher({
			predictChildRunId: predictAgentRunId,
			enqueueChild: async (args) => {
				// The kernel is a trusted internal caller, but the request context
				// that reaches here on the MCP path (ask → service-binding)
				// carries only an acting-user identity, no re-presentable credential
				// for the in-process cognitive-runtime enqueue (it fails withAuth's 4
				// strategies → "No valid credentials"). Dispatch under the same
				// internal service-binding identity the child steer/stop forwarders
				// use (`X-Service-Binding` + `X-Tedix-Org-Id`). SAFE — the target tedi is
				// already org-validated by the capability card + the `auto` verdict
				// (decideDelegationDispatch); this is not external input.
				const internalContext = buildInternalServiceBindingContext(
					context,
					args.organizationId,
				);
				// Reuse the forced-path runner; adapt its {childRunId,
				// childConversationId} shape to the dispatcher's {runId,
				// conversationId} contract.
				const r = await kernelDelegateRunner({
					attachments: args.attachments,
					context: internalContext,
					childRunId: args.idempotencyKey,
					content: args.content,
					delegateToTediId: args.tediId,
					metadata: args.metadata,
				});
				return {
					runId: r.childRunId,
					conversationId: r.childConversationId,
					error: r.error,
					status: r.status,
				};
			},
		}),
		// A parent cancel can land after the pre-dispatch gate but before the
		// child enqueue returns. Stop that just-admitted child from inside the
		// turn body immediately; keep this wiring beside the dispatcher so every
		// execution context gets it. Run-set reconciliation remains the retry path.
		stopCanceledAutoDelegation: (stopInput) =>
			kernelChildStopper({
				context,
				...stopInput,
			}),
		// Cost advisor: supply the currently-configured Azure deployment name as a
		// placeholder for the optimize-mode `suggestedModel` field. Read
		// defensively — absent when the kernel is unconfigured.
		currentModelDeployment:
			(
				context.env as unknown as {
					AZURE_CHAT_DEPLOYMENT?: string;
				}
			).AZURE_CHAT_DEPLOYMENT?.trim() || null,
		// Workflow confirm dispatcher: dispatches a named skill workflow when the
		// operator confirms a prior `run_workflow` route. Uses the SAME internal
		// service-binding context as the auto-delegation dispatcher — the kernel is
		// a trusted internal caller here. The tediId is resolved from the skill
		// entry's own tediId when present. Org-owned baseline skills fall back to
		// the deterministic org executor so Home never advertises a workflow that
		// its confirm path cannot dispatch.
		// Fail-soft: missing SKILL_RUNTIME binding → dep omitted → turn falls
		// through to normal LLM planning.
		...(() => {
			const dispatchWorkflowConfirm = buildWorkflowConfirmDispatcher(context);
			return dispatchWorkflowConfirm
				? {
						dispatchWorkflowConfirm,
					}
				: {};
		})(),
		// Inbox-wake reconciler: finds PARENT run rows whose childRunId is in the
		// supplied child-run IDs, then reconciles their status/progress/preview
		// against current child-run evidence.
		reconcileInboxWakeRuns: (input) => reconcileInboxWakeRuns(context, input),
		// Delegation-synthesis transcript reader: injected so the wake intercept
		// can call readChildRunFullResult without importing kernel-runtime.ts
		// (which would create a cycle). Absent in tests that don't exercise synthesis.
		readChildRunFullResult: (input) => readChildRunFullResult(context, input),
		// Relay-first single-child delivery: the child's final assistant message
		// IS the return value, relayed verbatim by the wake intercept.
		readChildRunFinalAssistantMessage: (input) =>
			readChildRunFinalAssistantMessage(context, input),
		// Conversation auto-title (ChatGPT-parity sidebar labels): background task
		// dispatched by the turn body after settle. The helper is fail-soft
		// internally (guard → cheap kernelModel call → `conversation.updated`
		// event, source `kernelRuntime.autoTitle`). Durability contract with
		// `runKernelTurnWork`:
		// - `context.waitUntil` present (inline /rpc HTTP path, Hono executionCtx):
		//   register the work with waitUntil and return `void` — fire-and-forget,
		//   the settle gains zero latency.
		// - `context.waitUntil` ABSENT (the KernelDO's synthetic `turnContext()`
		//   has no execution context): RETURN the promise so the turn body awaits
		//   it. Detaching here is what dropped titles live — the DO's
		//   `ctx.waitUntil` is a lifetime no-op and the instance can be
		//   aborted/idled (version-reset `ctx.abort`) before the detached promise
		//   resumes. Awaiting is bounded: 10s LLM abort inside, never rejects
		//   past the `.catch` below.
		// Agent-in-the-loop review of a held delegation (Work approval plane).
		requesterTediId: context.tediId ?? null,
		requestDelegationAgentReview: (reviewInput) =>
			requestHomeDelegationAgentReview(context, reviewInput),
		// Same durability contract as the title sink below.
		wakeDelegationAgentReview: (wakeInput) => {
			const work = wakeHomeDelegationAgentReview(context, wakeInput).catch(
				(error) => {
					console.warn(
						"[kernelRuntime] delegation agent review wake failed; cron redrive retries",
						errorMessage(error),
					);
				},
			);
			if (context.waitUntil) {
				context.waitUntil(work);
				return;
			}
			return work;
		},
		generateConversationTitle: (titleInput) => {
			const work = generateAndPersistHomeConversationTitle(
				context,
				titleInput,
			).catch((error) => {
				console.warn(
					"[kernelRuntime] conversation auto-title background task failed",
					errorMessage(error),
				);
			});
			if (context.waitUntil) {
				context.waitUntil(work);
				return;
			}
			return work;
		},
	};
}

export function buildWorkflowConfirmDispatcher(
	context: BaseContext,
): WorkflowConfirmDispatcher | undefined {
	const skillRuntime = (
		context.env as {
			SKILL_RUNTIME?: unknown;
		}
	).SKILL_RUNTIME;
	if (!skillRuntime) return undefined;
	return async (input) => {
		try {
			const internalContext = buildInternalServiceBindingContext(
				context,
				input.organizationId,
			);
			const client = createRouterClient(skillsContractRouter, {
				context: internalContext,
			});
			// Look up the skill by slug. Tedi-owned skills keep their declared
			// executor; org-owned baseline skills use the stable Home fallback below.
			// A missing skill is a normal failed reply, never a turn crash.
			const skill = await getSkillEntryBySlug(
				context.db,
				input.organizationId,
				input.workflowSlug,
			).catch(() => null);
			if (!skill) {
				return {
					workflowRunId: "",
					status: "failed",
					error: `skill '${input.workflowSlug}' not found`,
				};
			}
			// A tedi-owned skill keeps its declared executor. An org-owned baseline
			// skill is deliberately runnable from Home too; select the same stable
			// org tedi fallback used for other Home-originated actions rather than
			// advertising a workflow that the confirm path can never start.
			const executorTediId =
				skill.tediId ??
				(await resolveKernelFallbackTediId(context, input.organizationId));
			if (!executorTediId) {
				return {
					workflowRunId: "",
					status: "failed",
					error: `skill '${input.workflowSlug}' has no eligible executor tedi`,
				};
			}
			const result = await client.runWorkflow({
				slug: input.workflowSlug,
				tediId: executorTediId,
				params: {
					source: "kernelRuntime.workflowConfirm",
					homeRunId: input.homeRunId,
					homeConversationId: input.conversationId,
				},
			});
			return {
				workflowRunId: result.runId,
				workflowTediId: executorTediId,
				status: "dispatched",
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				workflowRunId: "",
				status: "failed",
				error: msg.slice(0, 200),
			};
		}
	};
}

/**
 * Persist-first phase for a DO-initiated kernel turn (the voice DO, the
 * inbox-wake injection): `message.received` + `run.started` transcript events
 * and the durable `running` run row, via the SAME insert helpers
 * `enqueueMessage` uses — those turns are ledger-identical to HTTP turns.
 *
 * Kernel-only by construction (no delegation, no plan), mirroring
 * `enqueueMessage`'s `kernelEligible` branch shapes exactly: run.started
 * carries `status: "needs_delegation"`, the run row starts `running` with
 * `kernelRoute`/`kernelEvidence` null, and ids derive from the runId. Returns the
 * {@link KernelTurnWorkInput} for `runKernelTurnWork`.
 */
export async function startKernelTurn(
	context: BaseContext,
	input: {
		organizationId: string;
		conversationId: string;
		content: string;
		descopeUserId?: string;
		/** Idempotency key; a re-send with the same runId reuses every row. */
		runId?: string;
		metadata?: Record<string, unknown>;
		/** Ledger source marker; defaults to the HTTP path's value. */
		source?: string;
		/** Immutable authority ceiling; internal callers default to normal. */
		executionPolicy?: KernelExecutionPolicy;
	},
): Promise<KernelTurnWorkInput> {
	const createdAt = nowIso();
	const assistantAt = offsetIso(createdAt, 1);
	const completedAt = offsetIso(createdAt, 2);
	const runId = input.runId ?? crypto.randomUUID();
	const userMessageId = `${runId}:input`;
	const assistantMessageId = `${runId}:assistant`;
	const metadata = input.metadata ?? {};
	const source = input.source ?? "kernelRuntime.enqueueMessage";
	const executionPolicy = input.executionPolicy ?? "normal";
	await claimKernelExecutionPolicy(context.db, {
		runId,
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		idempotencyKey: runId,
		delegatedTediId: null,
		executionPolicy,
	});
	const runtimeMetadata = {
		source,
		subject: "home",
		delegation: "none",
		childRunId: null,
		homePlanId: undefined,
		...metadata,
		executionPolicy,
	};
	const runRowMetadata = {
		source,
		contentLength: input.content.length,
		attachmentCount: 0,
		idempotencyKey: runId,
		approvalRequestId: null,
		childConversationId: null,
		childRunId: null,
		delegatedTediId: null,
		delegationWorkOrder: null,
		homePlan: null,
		homeDispatchPolicy: null,
		executionPolicy,
	};
	const priorCause = await existingRunStartedCause(context, {
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		runId,
		messageId: userMessageId,
	});
	const inputEvent = await insertKernelRuntimeEvent(context, {
		organizationId: input.organizationId,
		kind: "message.received",
		conversationId: input.conversationId,
		runId,
		messageId: userMessageId,
		payload: {
			role: "user",
			content: input.content,
			channel: "home",
			metadata,
		},
		runtimeMetadata,
		createdAt,
	});
	await insertKernelRuntimeEvent(context, {
		organizationId: input.organizationId,
		kind: "run.started",
		conversationId: input.conversationId,
		runId,
		messageId: userMessageId,
		causeEventId: priorCause === undefined ? inputEvent.id : priorCause,
		payload: {
			status: "needs_delegation",
			inputMessageId: userMessageId,
		},
		runtimeMetadata,
		createdAt,
	});
	await insertKernelRuntimeRun(context, {
		id: runId,
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		status: "running",
		inputMessageId: userMessageId,
		outputMessageId: assistantMessageId,
		childConversationId: null,
		progress: homeRunProgress({
			eventCount: 0,
			status: "running",
		}),
		metadata: {
			...runRowMetadata,
			kernelRoute: null,
			kernelEvidence: null,
		},
		runtimeMetadata,
		startedAt: createdAt,
		completedAt: null,
		createdAt,
		updatedAt: createdAt,
	});
	const governancePolicy = await readOrgGovernancePolicy(
		context,
		input.organizationId,
	);
	const sessionWriteAllowlist = await readSessionWriteAllowlist(context, {
		organizationId: input.organizationId,
		conversationId: input.conversationId,
	});
	return {
		executionPolicy,
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		runId,
		userMessageId,
		assistantMessageId,
		content: input.content,
		descopeUserId: input.descopeUserId,
		createdAt,
		assistantAt,
		completedAt,
		approvalRequestId: null,
		delegationWorkOrder: null,
		homePlan: null,
		runRowMetadata,
		runtimeMetadata,
		governancePolicy,
		sessionWriteAllowlist,
	};
}

// Reject proposed Home plan assignments: cancel their Work Items + mark the
// plan/run canceled. Shared by respondApproval (decision: "reject" on a plan
// target).

export // Reject proposed Home plan assignments: cancel their Work Items + mark the
// plan/run canceled. Shared by respondApproval (decision: "reject" on a plan
// target).
type HomePlanAssignmentsCoreResult = {
	run: HomeRun;
	homePlan: HomePlan;
	assignments: HomePlanAssignmentApprovalResult[];
};

export async function rejectKernelPlanAssignmentsCore(
	context: BaseContext,
	input: {
		organizationId: string;
		homeRunId: string;
		assignmentIds?: string[];
		note?: string;
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
			"No proposed Home plan assignments matched the rejection request",
		);
	}
	const rejectedAt = nowIso();
	const rejectedIds = new Set(
		selectedAssignments.map((assignment) => assignment.id),
	);
	const assignmentResults: HomePlanAssignmentApprovalResult[] = [];
	for (const assignment of selectedAssignments) {
		if (assignment.workItemId) {
			await cancelWorkItem(context.db, {
				orgId: organizationId,
				workItemId: assignment.workItemId,
				actor: { type: "system", id: "home" },
				reason: input.note ?? "Home plan assignment rejected",
				cancelledAt: rejectedAt,
			});
			await addWorkItemComment(context.db, {
				id: crypto.randomUUID(),
				workItemId: assignment.workItemId,
				orgId: organizationId,
				authorType: "system",
				authorId: "home",
				body: `Home rejected ${assignment.ownerLabel} for this assignment on plan ${existingPlan.id}.`,
				metadata: {
					note: input.note ?? null,
					assignmentId: assignment.id,
					homePlanId: existingPlan.id,
					homeRunId: input.homeRunId,
				},
				createdAt: rejectedAt,
			});
		}
		assignmentResults.push({
			assignmentId: assignment.id,
			ownerTediId: assignment.ownerTediId,
			status: "canceled",
			workItemId: assignment.workItemId ?? "",
			childRunId: assignment.childRunId ?? null,
			childConversationId: assignment.childConversationId ?? null,
		});
	}
	const nextPlan: HomePlan = {
		...existingPlan,
		assignments: existingPlan.assignments.map((assignment) =>
			rejectedIds.has(assignment.id)
				? {
						...assignment,
						status: "canceled",
						error: null,
					}
				: assignment,
		),
		status: "canceled",
	};
	const nextRunStatus = homeRunStatusFromPlanStatus(nextPlan.status);
	const nextProgress = homeRunProgress({
		eventCount: assignmentResults.length,
		status: nextRunStatus,
	});
	const existingMetadata = nonNullRecord(existingRun.metadata) ?? {};
	const nextMetadata = {
		...existingMetadata,
		homePlan: nextPlan,
		homePlanRejectedAt: rejectedAt,
		homePlanRejectionNote: input.note ?? null,
		progress: nextProgress,
	};
	await updateKernelRuntimeRun(context.db, input.homeRunId, {
		status: nextRunStatus,
		progressValue: nextProgress.current,
		progressLabel: nextProgress.label,
		progressDetail: nextProgress.detail,
		latestEventKind: "decision.recorded",
		latestEventAt: rejectedAt,
		preview: `Rejected ${assignmentResults.length} Home plan assignment${assignmentResults.length === 1 ? "" : "s"}.`,
		completedAt: rejectedAt,
		updatedAt: rejectedAt,
		metadata: nextMetadata,
	});
	await insertKernelRuntimeEvent(context, {
		id: [
			"home",
			organizationId,
			"event",
			"home.plan.rejected",
			existingRun.conversationId,
			input.homeRunId,
			rejectedAt,
		].join(":"),
		organizationId,
		kind: "decision.recorded",
		conversationId: existingRun.conversationId,
		runId: input.homeRunId,
		payload: {
			action: "home.plan.rejected",
			assignments: assignmentResults,
			homePlan: nextPlan,
			status: nextPlan.status,
		},
		runtimeMetadata: {
			source: "kernelRuntime.respondApproval",
			homePlanId: nextPlan.id,
		},
		createdAt: rejectedAt,
	});
	const updatedRun = await getKernelRuntimeRun(context.db, {
		id: input.homeRunId,
	});
	return {
		run: normalizeHomeRunRecord(updatedRun ?? existingRun),
		homePlan: nextPlan,
		assignments: assignmentResults,
	};
}

/**
 * Resolve a parked `home_tool_write` approval card from the Home-shaped
 * surface (respondApproval): the caller supplied a homeRunId and the approval
 * row was located via `run.metadata.approvalRequestId`. Routes through THE
 * SAME canonical resolution path as `tediApprovals.resolve` — the
 * `resolveApprovalRequest` pending→resolved conditional update is the
 * exactly-once latch and `settleHomeToolWriteApproval` executes (approve) or
 * closes (reject) the run; neither is duplicated here.
 */

export /**
 * Resolve a parked `home_tool_write` approval card from the Home-shaped
 * surface (respondApproval): the caller supplied a homeRunId and the approval
 * row was located via `run.metadata.approvalRequestId`. Routes through THE
 * SAME canonical resolution path as `tediApprovals.resolve` — the
 * `resolveApprovalRequest` pending→resolved conditional update is the
 * exactly-once latch and `settleHomeToolWriteApproval` executes (approve) or
 * closes (reject) the run; neither is duplicated here.
 */
async function respondKernelToolWriteApprovalCore(
	context: BaseContext,
	input: {
		approval: TediApprovalRequest;
		decision: "approve" | "reject";
		note?: string;
		organizationId: string;
		run: KernelRuntimeRun;
	},
): Promise<{
	run: HomeRun;
	assignments: HomePlanAssignmentApprovalResult[];
}> {
	const { approval, organizationId } = input;
	if (approval.orgId !== organizationId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Access denied to this approval request",
		);
	}
	if (approval.status !== "pending") {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Home run ${input.run.id} write-action approval is already "${approval.status}" — nothing is pending to ${input.decision}.`,
		);
	}
	assertKernelApprovalStillPending(approval);
	const status = input.decision === "approve" ? "approved" : "rejected";
	const resolvedBy = context.user?.sub ?? context.authType ?? "unknown";
	// Canonical exactly-once latch (shared with tediApprovals.resolve): the
	// conditional pending→resolved update; a concurrent resolve loses here.
	const resolved = await resolveApprovalRequest(context.db, approval.id, {
		status,
		resolvedBy,
		resolution: input.note,
	});
	if (!resolved) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Failed to resolve request. It may have already been resolved.",
		);
	}
	// Audit parity with tediApprovals.resolve.
	await insertAuditEvent(context.db, {
		organizationId,
		actorId: resolvedBy,
		actorType: context.authType === "service-binding" ? "service" : "user",
		action: `approval.${status}`,
		resourceType: "approval_request",
		resourceId: approval.id,
		metadata: toJsonRecord({
			tediId: resolved.tediId,
			actionType: resolved.actionType,
			resolution: input.note ?? null,
			source: "kernelRuntime.respondApproval",
			homeRunId: input.run.id,
		}),
	});
	// Canonical settle hook (shared with tediApprovals.resolve/cancel):
	// approve executes the SERVER-STORED call exactly once (approval latch +
	// conditional run claim inside the settle); reject closes the run without
	// executing.
	await settleHomeToolWriteApproval(context, {
		approval: resolved,
		status,
	});
	const updatedRun = await getKernelRuntimeRun(context.db, {
		id: input.run.id,
	});
	return {
		run: normalizeHomeRunRecord(updatedRun ?? input.run),
		assignments: [],
	};
}

export async function resolveDurableCodemodeAtRuntime(
	context: BaseContext,
	input: {
		decision: "approve" | "reject";
		organizationId: string;
		payload: CodemodeExecuteWritePayload;
	},
): Promise<Record<string, unknown>> {
	const tedi = await getOrganizationTedi(context.db, {
		id: input.payload.tediId,
		organizationId: input.organizationId,
	});
	if (!tedi?.slug) {
		throw createError(ErrorCodes.NOT_FOUND, "Delegated tedi not found");
	}
	const config = getProvisioningConfig(tedi, context.env);
	const masterKey = context.env.SECRETS_MASTER_KEY;
	if (!config || !masterKey) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Tedi runtime approval transport is unavailable",
		);
	}
	const headers = new Headers({
		"Content-Type": "application/json",
		"X-Tedix-Admin-Token": masterKey,
	});
	if (config.fetcher || config.isDev) headers.set("X-Service-Binding", "true");
	if (config.hostOverride) headers.set("X-Tedix-Host", config.hostOverride);
	const response = await (config.fetcher?.fetch.bind(config.fetcher) ?? fetch)(
		`${config.workerUrl.replace(/\/+$/, "")}/__admin/durable-code/resolve`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({
				decision: input.decision,
				executionId: input.payload.executionId,
				seq: input.payload.pendingSeq,
			}),
		},
	);
	const result = (await response.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	if (!response.ok || result.ok !== true) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			`Durable Code Mode ${input.decision} failed`,
			{
				cause: result,
			},
		);
	}
	return result;
}

export async function respondDurableCodemodeApprovalCore(
	context: BaseContext,
	input: {
		approval: TediApprovalRequest;
		decision: "approve" | "reject";
		note?: string;
		organizationId: string;
		payload: CodemodeExecuteWritePayload;
		run: KernelRuntimeRun;
	},
): Promise<{
	run: HomeRun;
	assignments: HomePlanAssignmentApprovalResult[];
}> {
	if (
		input.payload.executionMode !== "durable_call" ||
		input.payload.homeRunId !== input.run.id ||
		input.payload.childRunId !== input.run.childRunId ||
		input.approval.orgId !== input.organizationId
	) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Approval is not the pending durable execution for this Home run",
		);
	}
	if (input.approval.status !== "pending") {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Durable execution approval is already "${input.approval.status}"`,
		);
	}
	assertKernelApprovalStillPending(input.approval);

	// The runtime owns exactly-once replay. Resolve there first; concurrent calls
	// are safe because CodemodeRuntime.approve/reject are explicit-id no-ops once
	// the execution has moved on. Only then close the canonical approval latch.
	const runtimeResult = await resolveDurableCodemodeAtRuntime(context, input);
	const status = input.decision === "approve" ? "approved" : "rejected";
	const resolvedBy = context.user?.sub ?? context.authType ?? "unknown";
	const resolved = await resolveApprovalRequest(context.db, input.approval.id, {
		status,
		resolvedBy,
		resolution: input.note,
	});
	if (!resolved) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Failed to resolve request. It may have already been resolved.",
		);
	}
	await insertAuditEvent(context.db, {
		organizationId: input.organizationId,
		actorId: resolvedBy,
		actorType: context.authType === "service-binding" ? "service" : "user",
		action: `approval.${status}`,
		resourceType: "approval_request",
		resourceId: resolved.id,
		metadata: toJsonRecord({
			source: "kernelRuntime.respondApproval",
			homeRunId: input.run.id,
			childRunId: input.payload.childRunId,
			executionId: input.payload.executionId,
			runtimeResult,
		}),
	});
	const runtimeOutput = nonNullRecord(runtimeResult.result);
	const runtimeStatus = stringFromPayload(runtimeOutput?.status);
	if (runtimeStatus === "completed" || input.decision === "reject") {
		const resolvedAt = nowIso();
		const latest = await getKernelRuntimeRun(context.db, {
			id: input.run.id,
		});
		const metadata = nonNullRecord(latest?.metadata) ?? {};
		const durableResultPreview =
			input.decision === "reject"
				? `Rejected ${input.payload.connector}.${input.payload.method} in durable execution ${input.payload.executionId}.`
				: `Completed ${input.payload.connector}.${input.payload.method} in durable execution ${input.payload.executionId}.`;
		await updateKernelRuntimeRun(context.db, input.run.id, {
			status: input.decision === "reject" ? "canceled" : "completed",
			progressValue: 100,
			progressLabel: input.decision === "reject" ? "Rejected" : "Complete",
			progressDetail:
				input.decision === "reject"
					? "Durable execution rejected by operator"
					: "Durable execution approved and completed",
			latestEventKind:
				input.decision === "reject" ? "run.canceled" : "run.completed",
			latestEventAt: resolvedAt,
			completedAt: resolvedAt,
			preview: durableResultPreview,
			updatedAt: resolvedAt,
			metadata: toJsonRecord({
				...metadata,
				durableCodeResult: {
					executionId: input.payload.executionId,
					connector: input.payload.connector,
					method: input.payload.method,
					seq: input.payload.pendingSeq,
					status: input.decision === "reject" ? "rejected" : runtimeStatus,
					resolvedAt,
				},
				durableCodeApproval: {
					...nonNullRecord(metadata.durableCodeApproval),
					status,
					resolvedAt,
					resolvedBy,
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

/**
 * Resolve a parked Home workstation attachment from the Home-shaped
 * surface. This mirrors the write-card path: respondApproval owns the
 * pending->resolved latch, then the existing work-order resolver links the
 * approval back to the Home run and dispatches or cancels it.
 */

export /**
 * Resolve a parked Home workstation attachment from the Home-shaped
 * surface. This mirrors the write-card path: respondApproval owns the
 * pending->resolved latch, then the existing work-order resolver links the
 * approval back to the Home run and dispatches or cancels it.
 */
async function respondKernelWorkstationAttachApprovalCore(
	context: BaseContext,
	input: {
		approval: TediApprovalRequest;
		decision: "approve" | "reject";
		note?: string;
		organizationId: string;
		run: KernelRuntimeRun;
	},
): Promise<{
	run: HomeRun;
	assignments: HomePlanAssignmentApprovalResult[];
}> {
	const { approval, organizationId } = input;
	if (approval.orgId !== organizationId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Access denied to this approval request",
		);
	}
	const payload = homeWorkstationAttachPayload(approval.payload);
	if (!payload || payload.homeRunId !== input.run.id) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Approval is not a Home workstation attachment work order for this run",
		);
	}
	if (approval.status !== "pending") {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Home run ${input.run.id} workstation attachment approval is already "${approval.status}" — nothing is pending to ${input.decision}.`,
		);
	}
	assertKernelApprovalStillPending(approval);
	const status = input.decision === "approve" ? "approved" : "rejected";
	const resolvedBy = context.user?.sub ?? context.authType ?? "unknown";
	const resolved = await resolveApprovalRequest(context.db, approval.id, {
		status,
		resolvedBy,
		resolution: input.note,
	});
	if (!resolved) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Failed to resolve request. It may have already been resolved.",
		);
	}
	await insertAuditEvent(context.db, {
		organizationId,
		actorId: resolvedBy,
		actorType: context.authType === "service-binding" ? "service" : "user",
		action: `approval.${status}`,
		resourceType: "approval_request",
		resourceId: approval.id,
		metadata: {
			tediId: resolved.tediId,
			actionType: resolved.actionType,
			resolution: input.note ?? null,
			source: "kernelRuntime.respondApproval",
			homeRunId: input.run.id,
		},
	});
	const result = await resolveKernelWorkstationAttachWorkOrder(context, {
		approvalRequestId: resolved.id,
		organizationId,
		resolution: input.note,
		status,
	});
	return {
		run: result.run,
		assignments: [],
	};
}

export function kernelDelegationRecommendationFromRun(run: KernelRuntimeRun): {
	delegation: Record<string, unknown>;
	metadata: Record<string, unknown>;
	targetTediId: string;
	workOrder: Record<string, unknown>;
} | null {
	if (isTerminalHomeRunStatus(run.status)) return null;
	const metadata = nonNullRecord(run.metadata) ?? {};
	const delegation = nonNullRecord(metadata.homeDelegation);
	const decision = nonNullRecord(delegation?.decision);
	const workOrder = nonNullRecord(delegation?.workOrder);
	if (!delegation || !decision || !workOrder) return null;
	if (stringFromPayload(decision.mode) !== "needs_approval") return null;
	const targetTediId = stringFromPayload(workOrder.targetTediId);
	if (!targetTediId) return null;
	return {
		delegation,
		metadata,
		targetTediId,
		workOrder,
	};
}

export const OPERATOR_HELD_DISPATCH_REASON =
	"operator explicitly held dispatch for approval";

export function clampWorkOrderText(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function workOrderStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

export function approvalHeldDelegation(
	delegation: Record<string, unknown>,
): boolean {
	const decision = nonNullRecord(delegation.decision);
	return stringFromPayload(decision?.reason) === OPERATOR_HELD_DISPATCH_REASON;
}

export function approvedExecutionWorkOrder(input: {
	delegation: Record<string, unknown>;
	note?: string;
	workOrder: Record<string, unknown>;
}): Record<string, unknown> {
	if (!approvalHeldDelegation(input.delegation)) return input.workOrder;
	const originalSource =
		stringFromPayload(input.workOrder.sourceContent) ??
		"Original request was not available.";
	const targetLabel =
		stringFromPayload(input.workOrder.targetTediLabel) ?? "the target tedi";
	const note = input.note?.trim();
	const existingBoundaries = workOrderStringArray(input.workOrder.boundaries);
	const boundaries = [
		...existingBoundaries,
		"Approval has already been granted for this delegation; execute the approved task now instead of creating another approval gate.",
		"Respect the original request's mutation limits exactly.",
		"Do not create a candidate Work Item unless the approved task explicitly asks for another tracking item.",
	];
	return {
		...input.workOrder,
		objective: clampWorkOrderText(
			[
				`The operator approved this previously parked delegation to ${targetLabel}.`,
				"Execute the intended delegated task now.",
				"Do not create another approval gate, candidate Work Item, or parked handoff.",
				"Use the original request only for task scope and boundaries.",
				"",
				"Original request:",
				originalSource,
			].join("\n"),
			1600,
		),
		outputContract: clampWorkOrderText(
			[
				"Return the completed delegated task result with concrete evidence and file/tool references.",
				"If the original request names an intended task, satisfy that task now.",
				"Do not report that the task is merely parked or awaiting another approval.",
			].join(" "),
			800,
		),
		sourceContent: [
			"Approved Home delegation.",
			note ? `Approval note: ${note}` : null,
			"Execute the intended delegated task from the original request now; do not park another approval or Work Item.",
			"",
			"Original request:",
			originalSource,
		]
			.filter(Boolean)
			.join("\n"),
		boundaries: [...new Set(boundaries)].slice(0, 8),
	};
}
