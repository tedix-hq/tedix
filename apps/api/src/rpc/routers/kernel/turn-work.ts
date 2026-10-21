import {
	runChatApprovalReplyIntercept,
	runWorkflowConfirmIntercept,
	recordOrNull,
} from "./turn-work-intercepts";
import { runInboxWakeIntercept } from "./turn-work-inbox";
import {
	KERNEL_RUNTIME_BACKEND,
	emitProgress,
	emitProgressEvent,
	type HomeTurnRuntimeEventInput,
	type KernelTurnWorkDeps,
	type KernelTurnWorkInput,
} from "./turn-work-context";
import {
	kernelWriteSummary,
	type DirectKernelWriteInput,
	type executeDirectKernelWrite,
} from "./write-approval-settlement";
/**
 * kernel turn work — the detached-execution body of
 * `kernelRuntime.enqueueMessage`'s kernel path (route decision, optional write
 * proposal, completion patch, transcript events).
 *
 * Why this is a separate module, and the dated findings behind the ordering
 * below: `docs/engineering/cognition/kernel-execution-model.md`.
 *
 * Contracts:
 *  - Runs in two execution contexts: inline in the HTTP request (awaited +
 *    `context.waitUntil`) and inside `KernelDO.processTurn`, where a
 *    disconnected caller cannot cancel the turn.
 *  - Persist-first: the `message.received` / `run.started` / run-row inserts
 *    happen before this function is called. The run row is patched
 *    running → terminal/requires_approval here with a conditional update, so
 *    operator cancels and double execution cannot clobber a terminal state.
 *  - Dependencies (the `./run-store` insert helpers, render helpers, the
 *    `activeKernel`/`activeKernelWriteProposalPlanner` test seams) are injected
 *    via {@link KernelTurnWorkDeps}; see `buildKernelTurnWorkDeps`.
 *  - This module must not import `kernel-runtime.ts` — the router imports this
 *    module, so a value import back would create a cycle.
 */

import { aggregateTurnUsage } from "./turn-usage";
import { type KernelExecutionAttempt } from "./gateway-attribution";
import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import type { BodyExecutionResult } from "@tedix/api-contract/schemas/body-certification";
import type { TediRunStatus } from "@tedix/api-contract/schemas/cognitive-runtime";
import type { HarnessSubjectVersion } from "@tedix/api-contract/schemas/harness-version";
import type {
	HomePlan,
	HomeRun,
	KernelRuntimeEvent,
} from "@tedix/api-contract/schemas/kernel-runtime";
import {
	decideKernelWriteApproval,
	type KernelWriteApprovalDecision,
	resolveApprovalTtlHours,
	resolveKernelFanOutCap,
} from "@tedix/api-contract/utils/approval-policy";
import { buildBodyExecutionResult } from "@tedix/api-contract/utils/body-execution-result";
import { traceBundleId as buildTraceBundleId } from "@tedix/context-core/harness-version";
import {
	createApprovalRequestWithAudit,
	getApprovalRequestById,
} from "@tedix/db/queries/approvals";
import {
	getKernelRuntimeRun,
	transitionKernelRuntimeRunStatus,
} from "@tedix/db/queries/kernel-runtime-runs";
import { toJsonRecord } from "@tedix/db/utils/json";
import { priceKernelUsage } from "../../../services/provider-model-pricing";
import {
	kernelRunStatusToSubmissionOutcome,
	settleKernelSubmission,
} from "../../../kernel/runtime-submission-bridge";
import {
	createKernelTurnStageTimings,
	type KernelTurnType,
} from "../../../kernel/turn-stage-timings";
import {
	type AutoDelegationDispatchResult,
	shouldAutoDispatch,
} from "./auto-dispatch";
import {
	type BillingPolicyDenialCode,
	billingPolicyDenialCode,
} from "./billing-reservation";
import {
	adviseTurnCost,
	type CostAdvisorVerdict,
	readCostAdvisorMode,
} from "./cost-advisor";
import {
	type HomeDelegationAgentReview,
	renderHeldDelegationLine,
} from "./delegation-approver";
import { homeNarrationMetadata } from "./home-narration";
import type { KernelResult, runKernel } from "./index";
import { recordKernelTraceEvidence } from "./kernel-trace-recording";
import {
	KERNEL_ROUTE_MODEL_REF_DEFAULT,
	type KernelEnv,
	kernelModel,
} from "./llm";
import { nonNullRecord } from "./runtime-shared";
import type { HomeToolWritePayload } from "./write-executor";
import {
	type KernelWriteProposal,
	type KernelWriteProposalDeclined,
	type KernelWriteProposalStage,
	type planKernelWriteProposal,
	renderWriteDeclined,
	type WriteProposalEnv,
} from "./write-proposal";

/** Explicit or run-stamped parent tedi of a nested delegation. */
function readParentTediId(...sources: Array<unknown>): string | null {
	for (const source of sources) {
		if (source && typeof source === "object") {
			const value = (source as { parentTediId?: unknown }).parentTediId;
			if (typeof value === "string" && value.trim()) return value.trim();
		}
	}
	return null;
}

/**
 * Operator-facing notice when the kernel route decision could not be produced
 * because the configured routing model did not produce a valid decision. There is no heuristic fallback: a turn the
 * LLM never routed settles `failed` with this clear message, so a provider/gateway
 * outage is legible instead of masked by a fabricated answer.
 */
const KERNEL_MODEL_UNAVAILABLE_MESSAGE =
	"I couldn't finish routing this turn because the configured model did not produce a valid route decision. Your message is saved; please retry shortly.";

/**
 * Operator-facing notice when the kernel turn was denied by the workspace's
 * runtime-entitlement/billing admission — a deterministic policy denial, not a
 * provider failure. Kept distinct from {@link KERNEL_MODEL_UNAVAILABLE_MESSAGE}
 * so a suspended billing account never impersonates an infra outage. The turn
 * still settles `failed`.
 */
function renderKernelBillingBlockedMessage(
	code: BillingPolicyDenialCode,
): string {
	return `I couldn't run this turn — runtime inference is blocked for this workspace by its billing/entitlement state (${code}). This is a policy denial, not a provider outage; retrying won't help until the entitlement changes. A workspace administrator can review and update it on the Team page's Runtime entitlement card.`;
}

function durationMs(startedAt: string, endedAt: string): number | null {
	const started = Date.parse(startedAt);
	const ended = Date.parse(endedAt);
	if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;
	return Math.max(0, ended - started);
}

function summaryExcerpt(content: string | null | undefined): string | null {
	const trimmed = content?.trim();
	if (!trimmed) return null;
	return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
}

/**
 * Compact route-decision snapshot for the durable event ledger. The full
 * decision stays on the run row (`metadata.kernelRoute`); this payload is small
 * by design: no answer text, no tool args, no message bodies, rationale capped
 * at ~300 chars. Optional keys (targetTediId/workflowHint) are omitted rather
 * than null when inapplicable. Why it exists:
 * `docs/engineering/cognition/kernel-execution-model.md`.
 */
function compactRouteDecision(
	route: KernelResult["route"] | null | undefined,
): Record<string, unknown> | null {
	if (!route) return null;
	const rationale =
		typeof route.rationale === "string" ? route.rationale.trim() : "";
	return {
		routeKind: route.routeKind,
		confidence: typeof route.confidence === "number" ? route.confidence : null,
		...(route.routeDecision ? { routeDecision: route.routeDecision } : {}),
		effortClass: route.effortClass ?? null,
		...(route.targetTediId ? { targetTediId: route.targetTediId } : {}),
		...(route.workflowHint ? { workflowHint: route.workflowHint } : {}),
		rationale:
			rationale.length > 300 ? `${rationale.slice(0, 297)}...` : rationale,
	};
}

export type KernelTurnWorkResult = Awaited<
	ReturnType<typeof runKernelTurnWork>
>;

/**
 * Pre-materialize cancel gate (P0). An operator cancel that landed while the
 * kernel was in flight already won the run-row status; this settles the turn
 * with a short truthful canceled marker instead of materializing the routed
 * answer/ack. Also the landing spot for an aborted planner pass
 * (`AbortController.abort()` from `KernelDO.cancelTurn` — see
 * `docs/engineering/cognition/kernel-execution-model.md` "Operator cancel"): the aborted
 * kernel call rejects, `kernelResult` is null, but `currentRunStatus` already
 * reads "canceled" (`cancelKernelRunCore` durably marks the run canceled
 * before calling the DO's `cancelTurn`), so this same gate settles it as a
 * clean cancel — never as a model-unavailable provider failure. Returns
 * `null` when the run was not canceled, so the caller falls through to the
 * normal terminal-patch + settle path.
 */
async function runPreMaterializeCancelGate(params: {
	deps: KernelTurnWorkDeps;
	organizationId: string;
	conversationId: string;
	runId: string;
	userMessageId: string;
	assistantMessageId: string;
	createdAt: string;
	assistantAt: string;
	completedAt: string;
	homePlan: HomePlan | null;
	runRowMetadata: Record<string, unknown>;
	runtimeMetadata: Record<string, unknown>;
	canceledBeforeDispatch: boolean;
	currentRunStatus: string | null;
	currentRunMetadata: Record<string, unknown> | null;
	autoDispatchSucceeded: boolean;
	autoDelegatedTediId: string | null;
	autoChildRunId: string | null;
	autoDispatch: AutoDelegationDispatchResult | null;
}) {
	const {
		deps,
		organizationId,
		conversationId,
		runId,
		userMessageId,
		assistantMessageId,
		createdAt,
		assistantAt,
		completedAt,
		homePlan,
		runRowMetadata,
		runtimeMetadata,
		canceledBeforeDispatch,
		currentRunStatus,
		currentRunMetadata,
		autoDispatchSucceeded,
		autoDelegatedTediId,
		autoChildRunId,
		autoDispatch,
	} = params;

	// ── Pre-materialize cancel gate (P0) ───────────────────────────────────────
	// An operator cancel that landed while the kernel was in flight already won
	// the run-row status (the terminal patch below is guarded `WHERE
	// status='running'`). Settle the canceled turn with a short truthful marker
	// message: it becomes the turn's completion content, so Tedix OS renders it
	// with no frontend change. No run.completed event is written — the cancel
	// core already emitted run.canceled. Why the gate exists:
	// `docs/engineering/cognition/kernel-execution-model.md`.
	const turnCanceled =
		canceledBeforeDispatch || currentRunStatus === "canceled";
	if (turnCanceled) {
		emitProgress(deps, "Canceled");
		const canceledContent = autoDispatchSucceeded
			? "Turn canceled — stopping the delegated run."
			: "Turn canceled — no work was dispatched.";
		// A dispatch that slipped through before the cancel landed: persist the
		// parent↔child link onto the (already canceled) run row — the cancel core
		// saw childRunId null and skipped its child-stop cascade, and the guarded
		// terminal patch below will never link it. With the link durable, the
		// run-set reconcile stops the still-running child on the next read.
		// Status is deliberately NOT touched (`WHERE status='canceled'`).
		if (autoDispatchSucceeded && autoDelegatedTediId && autoChildRunId) {
			const canceledLinkMetadata = {
				...currentRunMetadata,
				childConversationId: autoDispatch?.childConversationId ?? null,
				childRunId: autoChildRunId,
				delegatedTediId: autoDelegatedTediId,
				delegationStatus: autoDispatch?.status ?? "queued",
				homeAutoDispatch: {
					delegatedTediId: autoDelegatedTediId,
					childRunId: autoChildRunId,
					status: autoDispatch?.status ?? "queued",
					canceledAfterDispatch: true,
				},
			};
			try {
				await transitionKernelRuntimeRunStatus(deps.db, {
					id: runId,
					organizationId,
					fromStatus: "canceled",
					patch: {
						delegatedTediId: autoDelegatedTediId,
						childRunId: autoChildRunId,
						metadata: canceledLinkMetadata,
					},
				});
			} catch (error) {
				console.warn({
					component: "kernel.turn_work",
					event: "canceled_child_link_persist_failed",
					error: safeExceptionTopology(error),
				});
			}

			// Do not wait for the next Tedix OS run-set poll to discover the link. The
			// child may finish during that read interval, which previously produced
			// a contradictory `Completed` receipt after the parent was canceled.
			// Stop now through the same canonical cognitiveRuntime.stopRun path;
			// The durable child link above remains the retry/backstop if this
			// best-effort RPC fails or the Worker is interrupted mid-call.
			if (deps.stopCanceledAutoDelegation) {
				try {
					await deps.stopCanceledAutoDelegation({
						organizationId,
						delegatedTediId: autoDelegatedTediId,
						childRunId: autoChildRunId,
						childConversationId: autoDispatch?.childConversationId ?? null,
						reason: "Parent Home run canceled by operator",
					});
				} catch (error) {
					console.warn({
						component: "kernel.turn_work",
						event: "canceled_child_stop_failed",
						error: safeExceptionTopology(error),
					});
				}
			}
		}
		const canceledEvent = await deps.insertKernelRuntimeEvent({
			organizationId,
			kind: "message.completed",
			conversationId,
			runId,
			messageId: assistantMessageId,
			...(autoDispatchSucceeded && autoDelegatedTediId
				? { delegatedTediId: autoDelegatedTediId }
				: {}),
			...(autoDispatchSucceeded && autoChildRunId
				? { childRunId: autoChildRunId }
				: {}),
			payload: {
				role: "assistant",
				content: canceledContent,
				channel: "home",
				metadata: {
					homeSubject: true,
					turnCanceled: true,
					// One delegation = one row: when the dispatch had already landed
					// this turn also carries the delegation receipt, whose status slot
					// resolves to "Canceled". The prose ("Turn canceled — stopping the
					// delegated run.") restates it, so the read path blanks it. The
					// no-dispatch variant ("Turn canceled — no work was dispatched.")
					// is not stamped: it renders no receipt, so its prose is the only
					// record the operator's cancel landed.
					...(autoDispatchSucceeded
						? homeNarrationMetadata("turn_canceled_delegated")
						: {}),
					approvalRequestId: null,
					delegatedTediId: autoDispatchSucceeded ? autoDelegatedTediId : null,
					childConversationId: autoDispatchSucceeded
						? (autoDispatch?.childConversationId ?? null)
						: null,
					childRunId: autoDispatchSucceeded ? autoChildRunId : null,
					delegationError: null,
					delegationWorkOrder: null,
					homePlan,
				},
			},
			runtimeMetadata: { ...runtimeMetadata, turnCanceled: true },
			createdAt: assistantAt,
		});
		// Exactly-once submission settle: the operator cancel is this run's
		// terminal outcome (fail-soft inside the helper).
		await settleKernelSubmission(deps.db, {
			runId,
			organizationId,
			conversationId,
			outcome: "canceled",
		});
		const canceledProgress = deps.homeRunProgress({
			eventCount: 0,
			status: "canceled",
		});
		const canceledRun: HomeRun = {
			id: runId,
			organizationId,
			conversationId,
			status: "canceled",
			inputMessageId: userMessageId,
			outputMessageId: assistantMessageId,
			delegatedTediId: autoDispatchSucceeded ? autoDelegatedTediId : null,
			childRunId: autoDispatchSucceeded ? autoChildRunId : null,
			runtime: {
				backend: KERNEL_RUNTIME_BACKEND,
				externalId: runId,
				metadata: { ...runtimeMetadata, turnCanceled: true },
			},
			startedAt: createdAt,
			completedAt,
			createdAt,
			updatedAt: completedAt,
			metadata: currentRunMetadata ?? runRowMetadata,
			progress: canceledProgress,
		};
		return {
			idempotencyKey: runId,
			conversationId,
			// The enqueue contract's narrow union has no `canceled` member; the
			// neutral terminal (same choice as the quiet inbox-wake no-op) carries
			// the truthful run snapshot (run.status === "canceled", DB authoritative).
			status: "needs_delegation" as const,
			run: canceledRun,
			homePlan: undefined,
			assistantMessage: {
				id: assistantMessageId,
				organizationId,
				conversationId,
				runId,
				role: "assistant" as const,
				status: "completed" as const,
				content: canceledContent,
				runtime: canceledEvent.runtime,
				createdAt: canceledEvent.createdAt,
				startedAt: canceledEvent.createdAt,
				completedAt,
				metadata: canceledEvent.payload,
			},
			error: undefined,
		};
	}
	return null;
}

/**
 * Approved-write layer (v1) — extracted verbatim from the former inline block
 * in {@link runKernelTurnWork}. A `propose_tool_write` route plans one
 * concrete write call and parks it behind a human approval card; the run
 * never executes anything before approval. Fail-soft at every gate: when
 * planning or approval-row creation fails, the turn keeps the
 * recommendation-text fallback behavior (`writeProposal` stays null).
 */
async function planAndParkKernelWriteProposal(
	deps: KernelTurnWorkDeps,
	input: KernelTurnWorkInput,
	kernelResult: KernelResult | null,
	workspaceContext: Parameters<
		typeof planKernelWriteProposal
	>[0]["workspaceContext"],
	executionAttempts: KernelExecutionAttempt[],
	onStage?: (stage: KernelWriteProposalStage) => void,
): Promise<{
	writeProposal: KernelWriteProposal | null;
	writeProposalDeclined: KernelWriteProposalDeclined | null;
	writeApprovalRequestId: string | null;
	preparedAutoWrite?: Pick<
		DirectKernelWriteInput,
		"approval" | "requestedAudit"
	>;
}> {
	const { organizationId, conversationId, runId, content, createdAt } = input;
	// Approved-write layer (v1): a propose_tool_write route plans one
	// concrete write call and parks it behind a human approval card —
	// the run never executes anything before approval. Fail-soft at
	// every gate: when planning or approval-row creation fails, the
	// turn keeps today's recommendation-text behavior.
	let writeProposal: KernelWriteProposal | null = null;
	let writeProposalDeclined: KernelWriteProposalDeclined | null = null;
	if (kernelResult?.route?.routeKind === "propose_tool_write") {
		emitProgress(
			deps,
			"Drafting write proposal",
			undefined,
			undefined,
			"generating",
		);
		const writeGatewayContext = {
			organizationId,
			runId,
			sessionKey: conversationId,
			source: "kernel:write-proposal",
		};
		// Same measured first-round model as the route pass: on the role default
		// (`cloudflare/auto`, Kimi) the selection and argument passes took 10–20 s
		// each and a rename timed out at 200 s. Role default only when absent.
		const writeModel =
			kernelModel(
				deps.env as unknown as KernelEnv,
				{ modelRef: KERNEL_ROUTE_MODEL_REF_DEFAULT },
				writeGatewayContext,
			) ??
			kernelModel(
				deps.env as unknown as KernelEnv,
				undefined,
				writeGatewayContext,
			);
		writeProposal = await deps
			.writeProposalPlanner({
				db: deps.db,
				env: deps.env as unknown as WriteProposalEnv,
				organizationId,
				route: kernelResult.route,
				actingUserId: input.descopeUserId,
				content,
				workspaceContext,
				gatewayContext: { organizationId, runId, sessionKey: conversationId },
				onExecutionAttempts: (attempts) => executionAttempts.push(...attempts),
				model: writeModel?.model ?? null,
				onStage,
				onDecline: (declined) => {
					writeProposalDeclined = declined;
				},
			})
			.catch((error) => {
				console.warn({
					component: "kernel.turn_work",
					event: "write_proposal_planning_failed",
					error: safeExceptionTopology(error),
				});
				writeProposalDeclined = {
					stage: "error",
					detail: deps.errorMessage(error).slice(0, 200),
				};
				return null;
			});
		executionAttempts.push(...(writeModel?.attempts ?? []));
	}
	let writeApprovalRequestId: string | null = null;
	let preparedAutoWrite:
		| Pick<DirectKernelWriteInput, "approval" | "requestedAudit">
		| undefined;
	if (writeProposal) {
		try {
			const anchorTediId =
				await deps.resolveKernelWriteAnchorTediId(organizationId);
			if (anchorTediId) {
				const writeApprovalId =
					await deps.homeToolWriteApprovalRequestId(runId);
				const writePayload: HomeToolWritePayload = {
					kind: "home_tool_write",
					appSlug: writeProposal.appSlug,
					toolName: writeProposal.toolName,
					args: writeProposal.args,
					organizationId,
					homeRunId: runId,
					conversationId,
					initiatedByUserId: input.descopeUserId ?? null,
					transport: writeProposal.transport,
					...(writeProposal.editableFields?.length
						? { editableFields: writeProposal.editableFields }
						: {}),
				};
				const writeApprovalTtlHours = resolveApprovalTtlHours(
					input.governancePolicy,
				);
				const prepared = {
					approval: {
						id: writeApprovalId,
						tediId: anchorTediId,
						orgId: organizationId,
						actionType: "home.tool_write",
						description: kernelWriteSummary(writeProposal),
						payload: toJsonRecord(writePayload),
						createdAt,
						expiresAt: deps.offsetIso(
							createdAt,
							writeApprovalTtlHours * 60 * 60 * 1000,
						),
					},
					requestedAudit: {
						organizationId,
						actorId: "kernel",
						actorType: "kernel",
						action: "approval.requested",
						resourceType: "approval_request",
						resourceId: writeApprovalId,
						metadata: {
							source: "kernelRuntime.proposeToolWrite",
							actionType: "home.tool_write",
							homeRunId: runId,
							conversationId,
							appSlug: writeProposal.appSlug,
							toolName: writeProposal.toolName,
							riskTier: writeProposal.riskTier,
							initiatedByUserId: input.descopeUserId ?? null,
						},
					},
				} satisfies Pick<DirectKernelWriteInput, "approval" | "requestedAudit">;
				const decision = decideKernelWriteApproval({
					policy: input.governancePolicy,
					sessionAllowlist: input.sessionWriteAllowlist,
					proposal: writeProposal,
				});
				if (decision.autoResolve && deps.executeDirectWrite) {
					preparedAutoWrite = prepared;
				} else {
					const existingApproval = await getApprovalRequestById(
						deps.db,
						writeApprovalId,
					);
					if (!existingApproval)
						await createApprovalRequestWithAudit(
							deps.db,
							prepared.approval,
							prepared.requestedAudit,
						);
				}
				writeApprovalRequestId = writeApprovalId;
			} else {
				console.warn({
					component: "kernel.turn_work",
					event: "write_approval_anchor_missing",
				});
			}
		} catch (error) {
			console.warn({
				component: "kernel.turn_work",
				event: "write_approval_creation_failed",
				error: safeExceptionTopology(error),
			});
			writeApprovalRequestId = null;
		}
	}
	return {
		writeProposal,
		writeProposalDeclined,
		writeApprovalRequestId,
		preparedAutoWrite,
	};
}

/**
 * Run one kernel-eligible Home turn end to end. Behavior-preserving extraction
 * of the `turnWork` IIFE from `kernelRuntime.enqueueMessage` — see module doc.
 */
/**
 * Read side: extract this run's delegation-chain depth from its metadata
 * (stamped by `kernelDelegateRunner` as parent+1). Reads `runRowMetadata` first,
 * then `runtimeMetadata`; a non-numeric/absent value ⇒ 0 (a top-level Home turn).
 */
export function readDelegationDepth(...sources: Array<unknown>): number {
	for (const source of sources) {
		if (source && typeof source === "object") {
			const value = (source as { delegationDepth?: unknown }).delegationDepth;
			if (typeof value === "number" && Number.isFinite(value)) return value;
		}
	}
	return 0;
}

export async function runKernelTurnWork(
	deps: KernelTurnWorkDeps,
	input: KernelTurnWorkInput,
) {
	const {
		organizationId,
		conversationId,
		runId,
		userMessageId,
		assistantMessageId,
		content,
		modelRef,
		createdAt,
		assistantAt,
		completedAt,
		approvalRequestId,
		delegationWorkOrder,
		homePlan,
		runRowMetadata,
		runtimeMetadata,
	} = input;

	// Per-stage first-token latency instrumentation (advisory — see
	// kernel/turn-stage-timings.ts). Created at entry so `enqueueToWorkMs`
	// (persist-first insert → turn-body start: edge/DO dispatch + isolate wait)
	// is measured from the true body start. Intercepted turns (inbox wake,
	// workflow confirm) return early and never snapshot — only the main kernel
	// body attaches `metadata.kernelTurnTimings`, on its existing terminal
	// metadata write.
	const stageTimings = deps.stageTimings ?? createKernelTurnStageTimings();

	const persistedExecutionPolicy =
		input.runtimeMetadata.executionPolicy === "observe_only" ||
		input.runRowMetadata.executionPolicy === "observe_only"
			? "observe_only"
			: input.runtimeMetadata.executionPolicy === "normal" ||
				  input.runRowMetadata.executionPolicy === "normal"
				? "normal"
				: undefined;
	const executionPolicy =
		input.executionPolicy ?? persistedExecutionPolicy ?? "normal";
	const observeOnly = executionPolicy === "observe_only";
	{
		const { claimKernelExecutionPolicy } =
			await import("../../../kernel/runtime-submission-bridge");
		await claimKernelExecutionPolicy(deps.db, {
			runId,
			organizationId,
			conversationId,
			idempotencyKey: runId,
			delegatedTediId: null,
			executionPolicy,
		});
	}
	const wakeResult = observeOnly
		? null
		: await runInboxWakeIntercept(deps, input);
	if (wakeResult) return wakeResult;

	const approvalReplyResult = observeOnly
		? null
		: await runChatApprovalReplyIntercept(deps, input);
	if (approvalReplyResult) return approvalReplyResult;

	const workflowConfirmResult = observeOnly
		? null
		: await runWorkflowConfirmIntercept(deps, input);
	if (workflowConfirmResult) return workflowConfirmResult;

	// Delegation depth: read this run's chain depth once (stamped on the run
	// metadata by kernelDelegateRunner as parent+1). Reused by both the planner's
	// own delegate-decision gate and the auto-dispatch metadata below, so an
	// auto-delegated child inherits parent+1 instead of being re-stamped to 1.
	const currentDelegationDepth = readDelegationDepth(
		runRowMetadata,
		runtimeMetadata,
	);
	const objectiveId =
		typeof runtimeMetadata.objectiveId === "string" &&
		runtimeMetadata.objectiveId.length > 0
			? runtimeMetadata.objectiveId
			: undefined;
	const workspaceContextRecord = nonNullRecord(
		runtimeMetadata.workspaceContext,
	);
	const workspaceWorkpiece = nonNullRecord(workspaceContextRecord?.workpiece);
	const workspaceKind = workspaceWorkpiece?.kind;
	const workspaceContext: Parameters<typeof runKernel>[0]["workspaceContext"] =
		typeof workspaceContextRecord?.workspaceId === "string" &&
		typeof workspaceContextRecord.workspaceName === "string"
			? {
					workspaceId: workspaceContextRecord.workspaceId,
					workspaceName: workspaceContextRecord.workspaceName,
					...((workspaceKind === "gadget" || workspaceKind === "output") &&
					typeof workspaceWorkpiece?.id === "string" &&
					typeof workspaceWorkpiece.name === "string"
						? {
								workpiece: {
									kind: workspaceKind,
									id: workspaceWorkpiece.id,
									name: workspaceWorkpiece.name,
								},
							}
						: {}),
				}
			: undefined;
	// Context assembly runs first inside `deps.kernel`; its end is marked by the
	// planner's "thinking" milestone, which moves the phase on to planning.
	emitProgress(
		deps,
		"Planning route",
		undefined,
		undefined,
		"preparing_context",
	);
	stageTimings.mark("routePlanStarted");
	// Billing-policy denial thread: the planner rethrows the canonical
	// `Inference blocked by billing policy: <code>` admission denial instead of
	// folding it into the provider-outage null (route-planner.ts). Classify it
	// here so the settle below renders the honest billing notice; every other
	// throw stays the fail-soft null → model-unavailable path.
	const executionAttempts: KernelExecutionAttempt[] = [];
	let billingDenialCode: BillingPolicyDenialCode | null = null;
	let residencyDenialMessage: string | null = null;
	const kernelResult = await deps
		.kernel({
			holdDecisionWork: deps.holdAfterSettle,
			onExecutionAttempts: (attempts) => executionAttempts.push(...attempts),
			attachments: input.attachments,
			...(deps.relevanceCandidates
				? { relevanceCandidates: deps.relevanceCandidates }
				: {}),
			...(deps.previousRelevanceRecall
				? { previousRelevanceRecall: deps.previousRelevanceRecall }
				: {}),
			...(deps.previousHistoryCheckpoint
				? { previousHistoryCheckpoint: deps.previousHistoryCheckpoint }
				: {}),
			...(deps.onHistoryCheckpoint
				? { onHistoryCheckpoint: deps.onHistoryCheckpoint }
				: {}),
			...(deps.previousInventorySnapshot
				? { previousInventorySnapshot: deps.previousInventorySnapshot }
				: {}),
			...(deps.onInventorySnapshot
				? { onInventorySnapshot: deps.onInventorySnapshot }
				: {}),
			...(typeof input.runRowMetadata.promptTokenBudget === "number"
				? { promptTokenBudget: input.runRowMetadata.promptTokenBudget }
				: {}),
			...(typeof input.runRowMetadata.rankingBudgetMs === "number"
				? { rankingBudgetMs: input.runRowMetadata.rankingBudgetMs }
				: {}),
			...(deps.contextCache ? { contextCache: deps.contextCache } : {}),
			db: deps.db,
			env: deps.env as unknown as Parameters<typeof runKernel>[0]["env"],
			organizationId,
			// Advisory mid-turn progress is re-wrapped through emitProgress so
			// planner emissions inherit the same fail-soft guarantee as milestones.
			// Stage marks piggyback on the same seam: the first planner emission
			// (in practice the post-context-assembly "thinking" milestone) splits
			// context assembly from the LLM call, and the first answerDelta is the
			// turn's first streamed token. mark() is first-occurrence-only.
			onProgress: (progress) => {
				stageTimings.mark("plannerFirstProgress");
				if (progress.answerDelta) stageTimings.mark("firstAnswerDelta");
				emitProgressEvent(
					deps,
					observeOnly && progress.answerDelta
						? { ...progress, answerDelta: undefined }
						: progress,
				);
			},
			// Acting user used for org context and authority assembly.
			descopeUserId: input.descopeUserId,
			content,
			modelRef,
			runId,
			workItemId:
				typeof runtimeMetadata.workItemId === "string"
					? runtimeMetadata.workItemId
					: undefined,
			inferenceSource:
				typeof runtimeMetadata.source === "string"
					? `kernel:${runtimeMetadata.source}`
					: "kernel:route",
			// Kernel conversational memory: the conversation id scopes the
			// bounded history read; the user message id excludes this turn's
			// already-persisted `message.received` row (persist-first ordering
			// above) so it is not duplicated alongside `content`.
			conversationId,
			currentUserMessageId: userMessageId,
			// Per-turn operator abort (docs/engineering/cognition/kernel-execution-model.md
			// "Operator cancel"): absent on the inline turn-work path. When
			// present (KernelDO), combined by planKernelRoute with its own
			// internal timeout/idle signals so a cancel actually stops the
			// in-flight LLM call.
			abortSignal: deps.plannerAbortSignal,
			// Read side: surface this run's chain depth (stamped on the run
			// metadata by kernelDelegateRunner as parent+1) so the kernel's own
			// delegate decision enforces MAX_DELEGATION_DEPTH end-to-end. Read from
			// runRowMetadata first, then runtimeMetadata; absent ⇒ 0 (top-level).
			delegationDepth: currentDelegationDepth,
			parentTediId: readParentTediId(runRowMetadata, runtimeMetadata),
			requesterTediId: deps.requesterTediId ?? null,
			workspaceContext,
			selectedWorkspaceDocument: input.selectedWorkspaceDocument,
		})
		.catch((e) => {
			billingDenialCode = billingPolicyDenialCode(e);
			if (
				billingDenialCode?.startsWith("eu_") ||
				billingDenialCode === "residency_policy_unavailable"
			) {
				const message = e instanceof Error ? e.message : String(e);
				residencyDenialMessage =
					message
						.split(" — ")
						.slice(1)
						.join(" — ")
						.replace(
							/^(?:EU_PROVIDER_[A-Z_]+|RESIDENCY_POLICY_UNAVAILABLE): /,
							"",
						) ||
					"An administrator must configure a verified EU model provider and its credential for this organization.";
			}
			if (billingDenialCode) {
				console.warn({
					component: "kernel.turn_work",
					event: "billing_policy_denied",
					code: billingDenialCode,
				});
			} else {
				console.warn({
					component: "kernel.turn_work",
					event: "kernel_planner_failed",
					organizationId,
					runId,
					error: safeExceptionTopology(e),
				});
			}
			return null;
		});
	stageTimings.mark("routePlanEnded");
	// The streamed pass is over: persist the trailing answer/rationale partial
	// now, before `settledAt` is read below, so the last delta row sorts ahead
	// of `message.completed` instead of ~0.8s behind it (see the dep's doc).
	if (deps.flushStreamedProgress) {
		try {
			deps.flushStreamedProgress();
		} catch {
			// Advisory only — never let a progress sink break the turn.
		}
	}
	// Harness evidence v1:
	// the route planner stamps a deterministic content-hash `routerVersion` on
	// every successful decision (route-planner.ts → StampedKernelRouteDecision).
	// Lift it to a top-level key on the run/event metadata so persisted evidence
	// is groupable by router version without descending into the nested
	// `kernelRoute` object. JSON-only — no schema change (the runtime D1 tables
	// have no `harness_version_id` column; that's a parked schema slice). The
	// static `KernelResult.route` type is `KernelRouteDecision` and does not
	// surface `routerVersion` (it is stamped post-parse, server-side), so we
	// read it defensively and fail soft: absent/non-string ⇒ null, never throw.
	// Null/absent on answer-less or error turns is backward compatible.
	const routerVersion: string | null = (() => {
		const candidate = (kernelResult?.route as { routerVersion?: unknown })
			?.routerVersion;
		return typeof candidate === "string" ? candidate : null;
	})();
	// Started here, resolved right before the terminal metadata needs it: the
	// ensure is its own D1 round trip and nothing between here and the terminal
	// writes reads it, so it overlaps the write-proposal / dispatch work instead
	// of serializing ahead of it. Fail-soft: null on any failure, never throws.
	const kernelHarnessVersionWork: Promise<HarnessSubjectVersion | null> =
		routerVersion && deps.ensureKernelHarnessVersion
			? Promise.resolve()
					.then(() =>
						deps.ensureKernelHarnessVersion?.({
							organizationId,
							routerVersion,
							createdAt,
						}),
					)
					.then((ensured) => ensured?.version ?? null)
					.catch((error: unknown) => {
						console.warn({
							component: "kernel.turn_work",
							event: "harness_version_ensure_failed",
							error: safeExceptionTopology(error),
						});
						return null;
					})
			: Promise.resolve(null);
	// Per-turn cost advisor (advise / shadow-telemetry mode only).
	// Derives a shadow verdict from the existing route decision — no second LLM
	// call. The verdict is recorded into run metadata below as
	// `kernelCostAdvisor` and never alters the model actually used (applied:false
	// always in this pass). Off by default; flip KERNEL_COST_ADVISOR_MODE=advise
	// to activate shadow telemetry. See kernel/cost-advisor.ts.
	// TODO: implement optimize mode (actually swap the model) once shadow data
	// proves the tier mapping is accurate enough to act on.
	const costAdvisorMode = readCostAdvisorMode(
		deps.env as unknown as Record<string, unknown>,
	);
	let costAdvisorVerdict: CostAdvisorVerdict | null = null;
	if (costAdvisorMode !== "off" && kernelResult?.route) {
		costAdvisorVerdict = adviseTurnCost({
			mode: costAdvisorMode,
			route: kernelResult.route,
			currentModelDeployment: deps.currentModelDeployment ?? null,
		});
	}
	stageTimings.mark("writeProposalPlanStarted");
	const {
		writeProposal,
		writeProposalDeclined,
		writeApprovalRequestId,
		preparedAutoWrite,
	} = observeOnly
		? {
				writeProposal: null,
				writeProposalDeclined: null,
				writeApprovalRequestId: null,
			}
		: await planAndParkKernelWriteProposal(
				deps,
				input,
				kernelResult,
				workspaceContext,
				executionAttempts,
				(stage) => stageTimings.mark(stage),
			);
	stageTimings.mark("writeProposalPlanEnded");
	const writeProposalActive = Boolean(writeProposal && writeApprovalRequestId);
	const delegationApprovalActive = Boolean(
		!observeOnly &&
		kernelResult?.route?.routeKind === "delegate_tedi" &&
		kernelResult.delegation?.decision.mode === "needs_approval",
	);
	// The target is at its delegated-run limit: the run waits `queued` with no
	// approval card, and KernelDO reconciliation dispatches it when a slot frees.
	const delegationDeferred = Boolean(
		!observeOnly &&
		kernelResult?.route?.routeKind === "delegate_tedi" &&
		kernelResult.delegation?.decision.mode === "deferred",
	);
	// The same policy decision gates direct execution and the parked approval path.
	const writeApprovalDecision: KernelWriteApprovalDecision | null =
		writeProposal && writeApprovalRequestId
			? decideKernelWriteApproval({
					policy: input.governancePolicy,
					sessionAllowlist: input.sessionWriteAllowlist,
					proposal: {
						appSlug: writeProposal.appSlug,
						toolName: writeProposal.toolName,
						riskTier: writeProposal.riskTier,
					},
				})
			: null;
	const writeWillAutoResolve = Boolean(
		writeProposalActive &&
		writeApprovalDecision?.autoResolve &&
		(deps.autoResolveKernelWrite || deps.executeDirectWrite),
	);
	// Agent-in-the-loop review of a held delegation: an agent-routable hold
	// with a resolved approver becomes a held Work Item plus a Work approval
	// proposal for that tedi. Anything that prevents it keeps the operator card.
	const heldDelegation = delegationApprovalActive
		? (kernelResult?.delegation ?? null)
		: null;
	let delegationAgentReview: HomeDelegationAgentReview | null = null;
	if (
		heldDelegation?.decision.approvalRoute === "agent" &&
		heldDelegation.approver
	) {
		const approver = heldDelegation.approver;
		const unavailable = (reason: string): HomeDelegationAgentReview => ({
			status: "unavailable",
			approverTediId: approver.tediId,
			approverTediLabel: approver.label,
			reason: reason.slice(0, 300),
		});
		const boundWorkItemId =
			typeof runRowMetadata.workItemId === "string"
				? runRowMetadata.workItemId
				: typeof runtimeMetadata.workItemId === "string"
					? runtimeMetadata.workItemId
					: null;
		if (!deps.requestDelegationAgentReview) {
			delegationAgentReview = unavailable(
				"agent review is not wired in this runtime",
			);
		} else if (boundWorkItemId) {
			delegationAgentReview = unavailable(
				`this run is already bound to Work Item ${boundWorkItemId}`,
			);
		} else {
			const requestedAt = deps.nowIso();
			const route = kernelResult?.route;
			try {
				delegationAgentReview = await deps.requestDelegationAgentReview({
					organizationId,
					conversationId,
					homeRunId: runId,
					content,
					objectiveId,
					approverTediId: approver.tediId,
					approverTediLabel: approver.label,
					targetTediId: heldDelegation.workOrder.targetTediId,
					targetTediLabel: heldDelegation.workOrder.targetTediLabel ?? null,
					holdReason: heldDelegation.decision.reason,
					route: {
						risk: route?.risk ?? "unknown",
						targetActivityId: route?.targetActivityId ?? null,
						effortClass: route?.effortClass ?? null,
						rationale: route?.rationale ?? "",
					},
					workOrder: heldDelegation.workOrder as unknown as Record<
						string,
						unknown
					>,
					executionRequirement: heldDelegation.workOrder.executionRequirement,
					requestedAt,
					expiresAt: new Date(
						Date.parse(requestedAt) +
							resolveApprovalTtlHours(input.governancePolicy) * 3_600_000,
					).toISOString(),
				});
			} catch (error) {
				console.warn({
					component: "kernel.turn_work",
					event: "delegation_agent_review_request_failed",
					error: safeExceptionTopology(error),
				});
				delegationAgentReview = unavailable(deps.errorMessage(error));
			}
		}
	}
	const agentReviewPending = delegationAgentReview?.status === "pending";
	if (writeProposalActive || delegationApprovalActive) {
		// The approval row exists — the run parks as requires_approval; either a
		// human resolves the card, or (when trusted) the auto-resolve sink settles
		// it in-turn right after parking.
		emitProgress(
			deps,
			writeWillAutoResolve
				? "Auto-approving trusted write"
				: agentReviewPending
					? `Awaiting ${delegationAgentReview?.approverTediLabel ?? "approver"} decision`
					: "Awaiting approval",
		);
	}
	const declinedRecord =
		writeProposalDeclined as KernelWriteProposalDeclined | null;

	// Autonomous delegation dispatch: when the verdict is `auto` and a dispatcher
	// is wired, spawn a supervised child run on the target tedi. Fail-soft — a
	// dispatch error is recorded on the run (homeAutoDispatch.status="failed")
	// and the parent turn is marked failed instead of pretending a handoff was
	// delivered. Dormant by data: tedis default requiresApproval:true, so the gate
	// returns needs_approval (not auto) until a tedi is explicitly opted in via
	// policy.
	//
	// Fan-out cap (a spawn_bounds-style pattern): the dispatch spawn call itself
	// counts as the first delegation, so a cap of N admits N-1 child dispatches
	// per turn. A single kernel auto-dispatch path always issues exactly 1 child,
	// so the cap fires only when maxDelegationsPerTurn < 2 (cap of 1 = the spawn
	// call alone fills it → kill-switch). Fail-closed past the cap: blocked
	// dispatch produces an explicit "fan-out cap reached" error, not a silent drop.
	//
	// KERNEL_MAX_DELEGATIONS: env-configurable override (default 32). Takes
	// precedence over the governance-policy cap when set. Fail-soft: bad value
	// falls through to resolveKernelFanOutCap(governancePolicy).
	const fanOutCap = (() => {
		const raw = (deps.env as unknown as { KERNEL_MAX_DELEGATIONS?: string })
			.KERNEL_MAX_DELEGATIONS;
		if (raw !== undefined && raw !== "") {
			const n = Number.parseInt(raw, 10);
			if (Number.isFinite(n) && n >= 1) return n;
		}
		return resolveKernelFanOutCap(input.governancePolicy);
	})();
	let autoDispatch: AutoDelegationDispatchResult | null = null;
	let autoDelegationWorkItemId: string | null = null;
	const autoDelegation =
		!observeOnly &&
		kernelResult?.delegation &&
		shouldAutoDispatch(kernelResult.delegation)
			? kernelResult.delegation
			: null;
	// Every auto-dispatched child is an MCP-supervised execution. Its credential
	// exchange and runtime binding require the durable `{homeRunId, workItemId}`
	// pair; dispatching a child without the Work Item creates an unauthorizable
	// run that fails before its first tool call. Explicit delegation intent still
	// controls routing, but cannot control this execution-identity prerequisite.
	const mintDelegationWorkItem = Boolean(autoDelegation);
	// Spawn-bound counting (spawn_bounds-style semantics): the dispatch spawn
	// call itself is the first counted delegation, so `fanOutCap < 2` means the
	// spawn call alone fills the cap — no room for this turn's single child.
	const fanOutCapBlocked = fanOutCap < 2;
	// ── Pre-dispatch cancel gate (P0) ──────────────────────────────────────────
	// An operator cancel that lands while the kernel is planning must prevent
	// the child dispatch entirely. Re-read the run row immediately before a
	// dispatch would fire: cancelKernelRunCore durably moves the row to
	// `canceled` while this turn is in flight, so a canceled row here means the
	// operator already aborted — skip the spawn and settle the turn with the
	// canceled marker below. Fail-open on a read error: the dispatch proceeds
	// exactly as today and the post-cancel run-set reconcile (run-store) stops
	// the child on the next read.
	let canceledBeforeDispatch = false;
	if (deps.dispatchAutoDelegation && autoDelegation && !fanOutCapBlocked) {
		try {
			const gateRow = await getKernelRuntimeRun(deps.db, {
				id: runId,
				organizationId,
			});
			canceledBeforeDispatch = gateRow?.status === "canceled";
		} catch {
			canceledBeforeDispatch = false;
		}
	}
	// When canceledBeforeDispatch is true neither branch fires: no dispatch and
	// no fan-out-cap failure record — the turn is already canceled and the
	// canceled settle below owns the terminal transcript state.
	if (
		!canceledBeforeDispatch &&
		deps.dispatchAutoDelegation &&
		autoDelegation &&
		fanOutCapBlocked
	) {
		// Fail-closed: record an explicit cap-exceeded failure so the run row
		// surfaces the block reason rather than silently completing without dispatch.
		autoDispatch = {
			childRunId: "",
			status: "failed",
			error: `fan-out cap reached: maxDelegationsPerTurn=${fanOutCap} counts the dispatch spawn itself, leaving no room for a child delegation this turn — fan out in waves across turns (raise maxDelegationsPerTurn to widen each wave)`,
		};
	} else if (
		!canceledBeforeDispatch &&
		deps.dispatchAutoDelegation &&
		autoDelegation &&
		(!deps.createDelegationWorkItem || !deps.predictAutoDelegationChildRunId)
	) {
		// Fail closed rather than creating the known-invalid `homeRunId`-only
		// child context. Production wiring supplies both dependencies; this guards
		// future runtimes and test hosts that accidentally omit the authority mint.
		autoDispatch = {
			childRunId: "",
			status: "failed",
			error:
				"supervised delegation requires Work Item minting and a deterministic child run id",
		};
	} else if (
		!canceledBeforeDispatch &&
		deps.dispatchAutoDelegation &&
		autoDelegation
	) {
		emitProgress(
			deps,
			`Dispatching to `,
			autoDelegation.workOrder.targetTediLabel || undefined,
			undefined,
			"delegating",
		);
		stageTimings.mark("dispatchStarted");
		try {
			if (
				mintDelegationWorkItem &&
				deps.createDelegationWorkItem &&
				deps.predictAutoDelegationChildRunId
			) {
				const predictedChildRunId = deps.predictAutoDelegationChildRunId({
					homeRunId: runId,
					delegatedTediId: autoDelegation.workOrder.targetTediId,
				});
				autoDelegationWorkItemId = await deps.createDelegationWorkItem({
					autonomyClass: autoDelegation.workOrder.autonomyClass,
					assigneeTediId: autoDelegation.workOrder.targetTediId,
					childRunId: predictedChildRunId,
					content,
					conversationId,
					createdAt,
					executionRequirement: autoDelegation.workOrder.executionRequirement,
					homeRunId: runId,
					organizationId,
					objectiveId,
				});
			}
			autoDispatch = await deps.dispatchAutoDelegation({
				attachments: input.attachments,
				homeRunId: runId,
				homeConversationId: conversationId,
				userMessageId,
				content,
				delegatedTediId: autoDelegation.workOrder.targetTediId,
				organizationId,
				workOrder: autoDelegation.workOrder,
				...(autoDelegationWorkItemId
					? { workItemId: autoDelegationWorkItemId }
					: {}),
				// Depth propagation: thread this run's chain depth so the child
				// runner stamps the auto-delegated child at parent+1. Without this the
				// child was always stamped 1 and MAX_DELEGATION_DEPTH never bounded the
				// self-propagating auto-delegation runaway.
				delegationDepth: currentDelegationDepth,
			});
		} catch (error) {
			console.warn({
				component: "kernel.turn_work",
				event: "auto_dispatch_failed",
				error: safeExceptionTopology(error),
			});
			autoDispatch = {
				childRunId: "",
				status: "failed",
				error: deps.errorMessage(error),
			};
		}
		stageTimings.mark("dispatchEnded");
	}
	const autoDelegatedTediId =
		autoDispatch && autoDelegation
			? autoDelegation.workOrder.targetTediId
			: null;
	const autoChildRunId = autoDispatch?.childRunId
		? autoDispatch.childRunId
		: null;
	const autoDispatchSucceeded =
		autoDispatch?.status === "queued" &&
		Boolean(autoDelegatedTediId && autoChildRunId);
	const autoDispatchFailed = autoDispatch?.status === "failed";
	// Work-Item auto-tracking for a router-decided single delegation. The eager
	// create on the explicit `delegateToTediId` path (kernel-runtime.ts) never
	// fires here — a `delegate_tedi` route runs in this turn body, not on that
	// path — so a router-decided delegation was untracked. Mirror it: effective
	// assignee = the resolved-route tedi (`autoDelegatedTediId`). Idempotent
	// (sourceIntentId=childRunId dedupes a re-fired turn) + fail-soft (helper
	// returns null). The plan path is excluded by construction — homePlan turns
	// are not kernelEligible and never reach this body (approvePlanAssignments
	// owns plan Work Items), so there is no double-create.
	autoDelegationWorkItemId ??=
		mintDelegationWorkItem &&
		deps.createDelegationWorkItem &&
		autoDelegation &&
		autoDispatchSucceeded &&
		autoDelegatedTediId &&
		autoChildRunId
			? await deps.createDelegationWorkItem({
					assigneeTediId: autoDelegatedTediId,
					childRunId: autoChildRunId,
					content,
					conversationId,
					createdAt,
					executionRequirement: autoDelegation.workOrder.executionRequirement,
					homeRunId: runId,
					organizationId,
					objectiveId,
				})
			: null;

	// When a propose_tool_write route was declined internally (declinedRecord set,
	// writeProposalActive false), the planner's optimistic "Confirm and I'll
	// prepare it for approval" text must not reach the operator — the write moat
	// held and nothing was created. Render an honest per-stage line instead.
	// When an active human approval exists, use the card. A trusted write that
	// will resolve through policy/session authorization must not falsely tell the
	// operator that a human click is still required; its terminal execution
	// receipt follows through the same audited approval latch. Otherwise, fall
	// back to the honest declined line or the kernel answer.
	// The kernel is LLM-only: a null `kernelResult` means the selected model was
	// unavailable or failed to produce a valid decision. There is no heuristic responder — the turn
	// settles `failed` with a clear model-unavailable notice so the outage is
	// legible rather than masked behind a fabricated answer. The one exception:
	// a billing-policy admission denial (billingDenialCode set) also yields a
	// null kernelResult but renders the honest billing-blocked notice — a policy
	// denial must never impersonate a provider outage.
	const modelUnavailable = !kernelResult;
	const routedAssistantContent = autoDispatchFailed
		? "The delegated request failed during dispatch. No completed result was received. Open the run details for the error, and check any changes before retrying."
		: kernelResult?.assistantContent;
	const assistantContent = observeOnly
		? `Observation only: Kernel selected ${kernelResult?.route?.routeKind ?? "no route"}. No tools, workflows, approvals, writes, Work Items, or delegations were executed.`
		: modelUnavailable
			? billingDenialCode
				? (residencyDenialMessage ??
					renderKernelBillingBlockedMessage(billingDenialCode))
				: KERNEL_MODEL_UNAVAILABLE_MESSAGE
			: writeProposalActive && writeProposal && writeApprovalRequestId
				? writeWillAutoResolve
					? `${writeApprovalDecision?.source === "session" ? "Authorized for this conversation" : "Authorized by tenant policy"}: executing \`${writeProposal.toolName}\` on ${writeProposal.appSlug}.`
					: deps.kernelWriteCardContent({
							approvalRequestId: writeApprovalRequestId,
							proposal: writeProposal,
						})
				: declinedRecord && kernelResult?.route
					? renderWriteDeclined(declinedRecord, kernelResult.route)
					: heldDelegation?.approver && !agentReviewPending
						? // The approver could not be engaged: the operator decides.
							renderHeldDelegationLine(
								heldDelegation.workOrder.targetTediLabel?.trim() ||
									"the selected tedi",
								null,
							)
						: (routedAssistantContent ?? KERNEL_MODEL_UNAVAILABLE_MESSAGE);
	const dispatchAwareStatus: TediRunStatus = modelUnavailable
		? "failed"
		: writeProposalActive || delegationApprovalActive
			? "requires_approval"
			: autoDispatchSucceeded || delegationDeferred
				? "queued"
				: autoDispatchFailed
					? "failed"
					: "completed";
	const dispatchAwareProgress = deps.homeRunProgress({
		eventCount: autoDispatchSucceeded ? 1 : 0,
		status: dispatchAwareStatus,
	});
	// Real terminal wall clock. The persist-first `completedAt` argument is a
	// +2ms ordering placeholder minted before the asynchronous turn body starts;
	// exposing it as the run completion timestamp made an 11s turn look like a
	// 2ms turn even though bodyExecutionResult carried the correct duration.
	const settledAt = deps.nowIso();
	const dispatchAwareCompletedAt =
		dispatchAwareStatus === "queued" ||
		dispatchAwareStatus === "requires_approval"
			? null
			: settledAt;
	const dispatchWorkOrder = autoDelegation?.workOrder ?? delegationWorkOrder;
	// A Home answer is a finished turn: nothing is queued, parked or waiting on
	// a delegation choice. Every other settled-but-undispatched route (a
	// delegate recommendation the router could not dispatch, a handoff
	// suggestion, a human question) keeps the needs_delegation sentinel.
	const answeredInHome = kernelResult?.route?.routeKind === "answer_in_home";
	const terminalPayloadStatus = modelUnavailable
		? "failed"
		: observeOnly
			? "completed"
			: writeProposalActive || delegationApprovalActive
				? "requires_approval"
				: autoDispatchSucceeded || delegationDeferred
					? "queued"
					: autoDispatchFailed
						? "failed"
						: answeredInHome
							? "completed"
							: "needs_delegation";
	// Three independent reads the terminal metadata needs, in flight together:
	// the harness version (started after the kernel returned), the usage price
	// (D1 rate lookups per attempt) and the current run row (metadata merge +
	// cancel gate below). No write touches the run row between here and the
	// cancel gate, so reading it before pricing observes the same state.
	const [kernelHarnessVersion, price, currentRun] = await Promise.all([
		kernelHarnessVersionWork,
		priceKernelUsage(deps.env, { attempts: executionAttempts }),
		getKernelRuntimeRun(deps.db, { id: runId, organizationId }).catch(
			() => undefined,
		),
	]);
	const traceBundleId = kernelHarnessVersion ? buildTraceBundleId(runId) : null;
	// Aggregate routing, ranking, and post-route judgments from unique receipts.
	// Missing provider counters stay unknown instead of understating turn usage.
	const routeUsage = aggregateTurnUsage(
		kernelResult?.routeUsage,
		executionAttempts,
	);
	// Route-decision half of the orchestration trace: a compact snapshot of the
	// kernel's typed route decision for the terminal event payload. Null only
	// when the planner produced no route (model unavailable) — every routed turn
	// (answer_in_home included) carries it.
	const routeDecision = compactRouteDecision(kernelResult?.route);
	// Complete turn total is known only when every execution reports usage.
	const turnTokensUsed: number | null =
		routeUsage?.inputTokens !== null &&
		routeUsage?.outputTokens !== null &&
		routeUsage !== null
			? (routeUsage.inputTokens ?? 0) + (routeUsage.outputTokens ?? 0) || null
			: null;
	const modelCostUsd = price.costUsd;
	// True end-of-turn wall clock. The `createdAt`/`completedAt` inputs are
	// persist-first placeholders (createdAt + 2ms) minted by `startKernelTurn`
	// before this work ran, so deriving duration from them reported ~2ms instead
	// of the real multi-second turn. Stamp the settle moment from the injected
	// clock so body-execution `endedAt`/`durationMs` reflect actual latency.
	// Latency split by what the turn actually was: the route decision, not the
	// dispatch outcome — a delegate_tedi route whose dispatch failed still paid
	// the delegated turn's serial pre-answer work.
	const turnType: KernelTurnType =
		kernelResult?.route?.routeKind === "propose_tool_write"
			? "write_proposal"
			: kernelResult?.route?.routeKind === "delegate_tedi"
				? "delegated"
				: "answer";
	const bodyExecutionResult: BodyExecutionResult = buildBodyExecutionResult({
		id: `${runId}:body-execution-result`,
		bodyKind: "kernel",
		status: modelUnavailable
			? "failed"
			: writeProposalActive
				? "blocked"
				: autoDispatchFailed
					? "failed"
					: "completed",
		runId,
		tediId: null,
		orgId: organizationId,
		conversationId,
		sessionKey: conversationId,
		harnessVersionId: kernelHarnessVersion?.id ?? null,
		traceBundleId,
		startedAt: createdAt,
		endedAt: settledAt,
		durationMs: durationMs(createdAt, settledAt),
		summary: summaryExcerpt(assistantContent),
		structuredResult: {
			homeStatus: dispatchAwareStatus,
			routeKind: kernelResult?.route?.routeKind ?? null,
			routerVersion,
			harnessSubjectKind: kernelHarnessVersion?.subjectKind ?? null,
			harnessSubjectId: kernelHarnessVersion?.subjectId ?? null,
			writeProposalActive,
			autoDispatchStatus: autoDispatch?.status ?? null,
		},
		// Route-planner LLM usage/cost (null fields when the planner fell back).
		...(routeUsage ? { usage: routeUsage } : {}),
		cost: {
			billingType: "included",
			biller: "kernel",
			modelCostUsd,
			totalCostUsd: modelCostUsd,
			pricing: price.pricing,
		},
		error: modelUnavailable
			? billingDenialCode
				? {
						kind: "policy" as const,
						message:
							residencyDenialMessage ??
							`Runtime inference blocked by billing policy (${billingDenialCode})`,
						retryable: false,
					}
				: {
						kind: "model" as const,
						message:
							"Configured kernel model did not produce a valid route decision",
						retryable: true,
					}
			: null,
		session: {
			beforeRef: null,
			afterRef: `kernel_runtime_runs:${runId}`,
			adapterSessionRef: null,
			clearSession: false,
		},
		approvalIds: writeApprovalRequestId ? [writeApprovalRequestId] : [],
		runtimeServices: ["kernel-runtime", "home", "mcp"],
	});
	const routeFailure =
		modelUnavailable && !billingDenialCode
			? { code: "HOME_ROUTE_UNAVAILABLE", retryable: true, retryRunId: runId }
			: null;
	const turnRunMetadata = {
		...runRowMetadata,
		...(routeFailure ? { routeFailure } : {}),
		...(writeProposalActive && writeProposal
			? {
					approvalRequestId: writeApprovalRequestId,
					kernelWriteProposal: {
						appSlug: writeProposal.appSlug,
						toolName: writeProposal.toolName,
						summary: kernelWriteSummary(writeProposal),
						args: writeProposal.args,
						riskTier: writeProposal.riskTier,
						transport: writeProposal.transport,
					},
				}
			: {}),
		// Trusted-write gating decision (auto-resolve vs human gate) for audit.
		...(writeApprovalDecision
			? {
					kernelWriteApproval: {
						autoResolve: writeApprovalDecision.autoResolve,
						source: writeApprovalDecision.source,
						reason: writeApprovalDecision.reason,
						willAutoResolve: writeWillAutoResolve,
					},
				}
			: {}),
		// Fail-soft must not be fail-silent: when a propose_tool_write route
		// produced no card, the run records why (diagnosis without log tails).
		...(declinedRecord
			? {
					kernelWriteProposalDeclined: {
						stage: declinedRecord.stage,
						...(declinedRecord.detail
							? { detail: declinedRecord.detail.slice(0, 200) }
							: {}),
					},
				}
			: {}),
		kernelRoute: observeOnly ? null : (kernelResult?.route ?? null),
		...(observeOnly
			? {
					kernelObservation: {
						selectedRoute: kernelResult?.route ?? null,
						outcome: kernelResult?.route
							? "effects_suppressed"
							: "observation_failed",
					},
				}
			: {}),
		kernelEvidence: null,
		// delegate_tedi authorization evidence: the constructed work order + the
		// fail-closed dispatch verdict (mode auto|needs_approval|blocked). Recorded
		// for observability + the next-slice auto-dispatch; null on non-delegation
		// turns. JSON-only — no schema change (runtime D1 metadata is a JSON bag).
		homeDelegation: observeOnly
			? null
			: kernelResult?.delegation
				? {
						...kernelResult.delegation,
						...(delegationAgentReview
							? { agentReview: delegationAgentReview }
							: {}),
					}
				: null,
		...(observeOnly
			? { executionPolicy: "observe_only", effectsSuppressed: true }
			: {}),
		...(autoDelegatedTediId && autoChildRunId
			? {
					childConversationId: autoDispatch?.childConversationId ?? null,
					childRunId: autoChildRunId,
					delegatedTediId: autoDelegatedTediId,
					delegationStatus: autoDispatch?.status ?? "queued",
				}
			: {}),
		// Linkage: stamp the Work Item id so reconcile resolves it from the
		// run-metadata fast path (resolveDelegationWorkItemId), same as the
		// explicit `delegateToTediId` path. Fallback = sourceIntentId=childRunId.
		...(autoDelegationWorkItemId
			? { workItemId: autoDelegationWorkItemId }
			: {}),
		// Autonomous dispatch outcome (present only when the verdict was `auto`
		// and dispatch was attempted). Records the spawned child run id + status
		// so the operator can follow the supervised run; null on every other turn.
		...(autoDispatch
			? {
					homeAutoDispatch: {
						delegatedTediId: autoDelegatedTediId,
						childRunId: autoChildRunId,
						status: autoDispatch.status,
						...(autoDispatch.error
							? { error: autoDispatch.error.slice(0, 200) }
							: {}),
					},
				}
			: {}),
		// Shadow cost-advisor verdict (advise mode only — never applied).
		// Derived from the existing effortClass/confidence signals; no second LLM
		// call. Present only when KERNEL_COST_ADVISOR_MODE=advise|optimize.
		// Null when mode=off (default) or when no effortClass was produced.
		...(costAdvisorVerdict ? { kernelCostAdvisor: costAdvisorVerdict } : {}),
		// Top-level mirror of the route's content-hash version (also nested in
		// `kernelRoute.routerVersion`) so the run row is queryable by version
		// without descending into the route object. Null on route-less turns.
		...(routerVersion ? { routerVersion } : {}),
		...(kernelResult
			? {
					contextManifest: {
						...kernelResult.contextManifest,
						inputTokens: routeUsage?.inputTokens ?? null,
					},
				}
			: {}),
		...(kernelHarnessVersion
			? {
					harnessVersionId: kernelHarnessVersion.id,
					harnessSubjectKind: kernelHarnessVersion.subjectKind,
					harnessSubjectId: kernelHarnessVersion.subjectId,
				}
			: {}),
		// Per-stage first-token latency snapshot (kernel/turn-stage-timings.ts):
		// turn-type + cold/warm-isolate tags, enqueue→work gap, and ms offsets
		// for each stage boundary the turn passed. Rides this existing terminal
		// metadata write — never a separate persist — and reaches the operator
		// via readRun → Tedix OS loadHomeRun like every other metadata key.
		kernelTurnTimings: stageTimings.snapshot({
			enqueuedAt: createdAt,
			settledAt,
			turnType,
		}),
		// Route-pass hedge record (route-planner.ts `KernelRouteHedge`): whether
		// a second identical request fired, which one won, and what the loser
		// consumed. Present on every streamed route pass, fired or not, so the
		// fire rate is readable from run metadata.
		...(kernelResult?.routeHedge
			? { kernelRouteHedge: kernelResult.routeHedge }
			: {}),
		bodyExecutionResult,
	};
	const currentRunMetadata = recordOrNull(currentRun?.metadata);
	const currentRunStatus =
		typeof currentRun?.status === "string" ? currentRun.status : null;
	const preMaterializeCanceled = await runPreMaterializeCancelGate({
		deps,
		organizationId,
		conversationId,
		runId,
		userMessageId,
		assistantMessageId,
		createdAt,
		assistantAt,
		completedAt,
		homePlan,
		runRowMetadata,
		runtimeMetadata,
		canceledBeforeDispatch,
		currentRunStatus,
		currentRunMetadata,
		autoDispatchSucceeded,
		autoDelegatedTediId,
		autoChildRunId,
		autoDispatch,
	});
	if (preMaterializeCanceled) return preMaterializeCanceled;
	const mergedTurnRunMetadata = currentRunMetadata
		? { ...currentRunMetadata, ...turnRunMetadata }
		: turnRunMetadata;
	// Last advisory stage before the terminal patch + transcript events land.
	emitProgress(deps, "Finalizing", undefined, undefined, "finalizing");
	// running → terminal/requires_approval only: an operator cancel
	// that landed while the kernel was in flight wins over this patch.
	const runTransition = {
		id: runId,
		organizationId,
		fromStatus: "running" as const,
		patch: {
			status: dispatchAwareStatus,
			progressValue: dispatchAwareProgress.current,
			progressLabel: dispatchAwareProgress.label,
			progressDetail: dispatchAwareProgress.detail,
			completedAt: dispatchAwareCompletedAt,
			updatedAt: settledAt,
			metadata: toJsonRecord(mergedTurnRunMetadata),
			// Parent↔child link columns for reconciliation parity with the forced
			// delegateToTediId path — set only on a successful auto-dispatch.
			...(autoDelegatedTediId && autoChildRunId
				? { delegatedTediId: autoDelegatedTediId, childRunId: autoChildRunId }
				: {}),
		},
	};
	const assistantEventInput: HomeTurnRuntimeEventInput = {
		organizationId,
		kind: "message.completed",
		conversationId,
		runId,
		messageId: assistantMessageId,
		delegatedTediId: autoDelegatedTediId ?? undefined,
		childRunId: autoChildRunId ?? undefined,
		payload: {
			role: "assistant",
			content: assistantContent,
			channel: "home",
			// Usage invariant: kernel turns always report token counts when the
			// route-planner LLM round-trip succeeds. Null on fail-soft turns only.
			...(turnTokensUsed !== null ? { tokensUsed: turnTokensUsed } : {}),
			// Canonical per-turn usage breakdown (the same `routeUsage` object the
			// bodyExecutionResult carries) under `payload.usage`, so the cognitive
			// ledger's typed `TediRuntimeEvent.usage` field is populated on read.
			// `tokensUsed` stays as the scalar analytics mirror.
			...(routeUsage ? { usage: routeUsage } : {}),
			metadata: {
				homeSubject: true,
				approvalRequestId: writeApprovalRequestId ?? approvalRequestId,
				delegatedTediId: autoDelegatedTediId,
				childConversationId: autoDispatch?.childConversationId ?? null,
				childRunId: autoChildRunId,
				delegationError: autoDispatch?.error ?? null,
				delegationWorkOrder: dispatchWorkOrder,
				homePlan,
				// One delegation = one row. A succeeded auto-dispatch stamps
				// `delegatedTediId` + `childRunId` above, which is exactly what Tedix OS
				// builds the delegation receipt from — so this turn already renders
				// "Delegated to {tedi} · Working…" and the ack prose ("On it —
				// delegating to {tedi} now…") is a duplicate. Gated on the dispatch
				// outcome, not on the ack text: a `needs_approval` delegation writes
				// no child run, renders no receipt, and keeps its prose (it is the
				// only surface asking the operator to approve).
				...(autoDispatchSucceeded &&
				kernelResult?.route?.routeKind === "delegate_tedi"
					? homeNarrationMetadata("delegation_ack")
					: {}),
				...(writeProposalActive && writeProposal
					? {
							kernelWriteProposal: {
								appSlug: writeProposal.appSlug,
								toolName: writeProposal.toolName,
								args: writeProposal.args,
								transport: writeProposal.transport,
							},
						}
					: {}),
			},
		},
		runtimeMetadata: {
			...runtimeMetadata,
			childConversationId: autoDispatch?.childConversationId,
			delegationStatus: autoDispatch?.status,
			delegationError: autoDispatch?.error,
			delegationWorkOrder: dispatchWorkOrder,
			// Stamp the router version onto the event ledger (not just the run
			// row) so the transcript event carries the harness version too.
			...(routerVersion ? { routerVersion } : {}),
			...(kernelHarnessVersion
				? {
						harnessVersionId: kernelHarnessVersion.id,
						harnessSubjectKind: kernelHarnessVersion.subjectKind,
						harnessSubjectId: kernelHarnessVersion.subjectId,
					}
				: {}),
		},
		// This row is appended after every streamed answer delta. Do not reuse the
		// persist-first `assistantAt` placeholder (+1 ms from enqueue): the durable
		// offset stream is ordered by (createdAt, id), so backdating this late insert
		// places the final frame behind an already-advanced live cursor and leaves OS
		// stuck on the preceding `finalizing` phase forever.
		createdAt: settledAt,
	};
	const terminalEventInput: HomeTurnRuntimeEventInput = {
		organizationId,
		// A model-unavailable turn (no route) emits run.failed; any parked decision
		// emits approval.requested instead of a terminal run event — the run is
		// waiting on the human card; otherwise the turn completed.
		kind: modelUnavailable
			? "run.failed"
			: writeProposalActive || delegationApprovalActive
				? "approval.requested"
				: "run.completed",
		conversationId,
		runId,
		messageId: assistantMessageId,
		delegatedTediId: autoDelegatedTediId ?? undefined,
		childRunId: autoChildRunId ?? undefined,
		payload: {
			status: terminalPayloadStatus,
			...(routeFailure ? { routeFailure } : {}),
			approvalRequestId: writeApprovalRequestId ?? approvalRequestId,
			inputMessageId: userMessageId,
			outputMessageId: assistantMessageId,
			childConversationId: autoDispatch?.childConversationId ?? null,
			childRunId: autoChildRunId,
			error: modelUnavailable
				? billingDenialCode
					? (residencyDenialMessage ??
						`Billing policy denied inference (${billingDenialCode})`)
					: "Model unavailable"
				: null,
			delegationError: autoDispatch?.error ?? null,
			delegationWorkOrder: dispatchWorkOrder,
			homePlan,
			// Compact route decision (routeKind/confidence/effortClass/rationale…) —
			// the decision half of the orchestration-trace dataset. `homePlan` above
			// is always null on the kernel path, so without this the persisted
			// run.completed row carried no record of what the kernel decided. The
			// full decision stays in run metadata (`kernelRoute`); the payload stays
			// compact by design.
			route: routeDecision,
			// Usage invariant: carry token counts on the terminal event so analytics
			// queries can sum across run.completed rows without joining message.completed.
			...(turnTokensUsed !== null ? { tokensUsed: turnTokensUsed } : {}),
			// Canonical per-turn usage breakdown promoted into `TediRuntimeEvent.usage`.
			...(routeUsage ? { usage: routeUsage } : {}),
		},
		runtimeMetadata: {
			...runtimeMetadata,
			childConversationId: autoDispatch?.childConversationId,
			delegationStatus: autoDispatch?.status,
			delegationError: autoDispatch?.error,
			delegationWorkOrder: dispatchWorkOrder,
			...(routerVersion ? { routerVersion } : {}),
			...(kernelHarnessVersion
				? {
						harnessVersionId: kernelHarnessVersion.id,
						harnessSubjectKind: kernelHarnessVersion.subjectKind,
						harnessSubjectId: kernelHarnessVersion.subjectId,
					}
				: {}),
		},
		// Keep the terminal receipt strictly after `message.completed` in the same
		// run-local offset stream even when settlement completes within one clock ms.
		createdAt: deps.offsetIso(settledAt, 1),
	};
	// The terminal run patch, `message.completed` and the terminal receipt land
	// together: one D1 batch when the batched persist is wired, otherwise the
	// same three writes in sequence. The stream order (message.completed before
	// the receipt) is carried by `createdAt`, not by write order.
	let writeAutoResolveResult:
		| Awaited<ReturnType<typeof executeDirectKernelWrite>>
		| {
				executed: boolean;
				finalStatus: TediRunStatus | null;
				assistantEvent: KernelRuntimeEvent | null;
		  }
		| null = null;
	if (preparedAutoWrite && writeApprovalDecision && deps.executeDirectWrite) {
		try {
			writeAutoResolveResult = await deps.executeDirectWrite({
				...preparedAutoWrite,
				decision: writeApprovalDecision,
				runId,
				conversationId,
				metadata: mergedTurnRunMetadata,
				holdAfterSettle: deps.holdAfterSettle,
			});
		} catch (error) {
			console.warn({
				component: "kernel.turn_work",
				event: "direct_write_failed",
				error: safeExceptionTopology(error),
			});
			const existing = await getApprovalRequestById(
				deps.db,
				preparedAutoWrite.approval.id,
			);
			if (existing?.status === "approved") throw error;
			if (!existing)
				await createApprovalRequestWithAudit(
					deps.db,
					preparedAutoWrite.approval,
					preparedAutoWrite.requestedAudit,
				);
		}
	}
	let assistantEvent: KernelRuntimeEvent;
	let terminalEvent: KernelRuntimeEvent;
	if (
		writeAutoResolveResult &&
		"terminalEvent" in writeAutoResolveResult &&
		writeAutoResolveResult.assistantEvent &&
		writeAutoResolveResult.terminalEvent
	) {
		assistantEvent = writeAutoResolveResult.assistantEvent;
		terminalEvent = writeAutoResolveResult.terminalEvent;
	} else if (deps.persistTurnSettlement) {
		const persisted = await deps.persistTurnSettlement({
			holdAfterSettle: deps.holdAfterSettle,
			run: runTransition,
			events: [assistantEventInput, terminalEventInput],
		});
		assistantEvent = persisted.assistantEvent;
		terminalEvent = persisted.terminalEvent;
	} else {
		await transitionKernelRuntimeRunStatus(deps.db, runTransition);
		assistantEvent = await deps.insertKernelRuntimeEvent(assistantEventInput);
		terminalEvent = await deps.insertKernelRuntimeEvent(terminalEventInput);
	}
	stageTimings.mark("settleWriteEnded");
	// Reconcile the auxiliary submission ledger only after the operator-visible
	// transcript is durable. Submission settlement is fail-soft, multi-step
	// (reserve → finalize → `submission.settled`, stamped with the wall clock,
	// so it stays last in the stream) and can contend on D1; it must never
	// hold the answer behind it. Non-terminal kernel statuses leave the
	// submission in flight as before.
	// Post-settlement work that must not delay the settled answer. `holdAfterSettle`
	// (inline path: `context.waitUntil`; KernelDO: a tracker parked on the DO's
	// waitUntil once the live turn state clears) keeps each promise alive;
	// without a holder the turn body awaits them before resolving, so nothing
	// is ever detached in a context that could drop it. Every held promise is
	// caught: a lost title or trace bundle is logged, never a broken settle.
	const heldAfterSettle: Promise<void>[] = [];
	const holdAfterSettle = (event: string, work: Promise<unknown>): void => {
		const safe = work.then(
			() => undefined,
			(error: unknown) => {
				console.warn({
					component: "kernel.turn_work",
					event,
					error: safeExceptionTopology(error),
				});
			},
		);
		if (deps.holdAfterSettle) deps.holdAfterSettle(safe);
		else heldAfterSettle.push(safe);
	};
	// Deferred history fold (index.ts, dormant without a per-request budget):
	// runs after the answer has left, held like the title and trace work, and
	// persists the checkpoint the next turn starts from.
	if (kernelResult?.deferredHistoryCompaction) {
		try {
			holdAfterSettle(
				"history_compaction_failed",
				kernelResult.deferredHistoryCompaction(),
			);
		} catch (error) {
			console.warn({
				component: "kernel.turn_work",
				event: "history_compaction_failed",
				error: safeExceptionTopology(error),
			});
		}
	}
	// Conversation auto-title (ChatGPT parity): when this settle completed the
	// conversation's first exchange and no label exists yet, generate a short
	// title from the exchange, after the terminal patch and transcript events
	// are durable — a lost title is acceptable, a broken settle is not. Skipped
	// on model-unavailable turns (no real reply to summarize). The dep owns the
	// guard + LLM + persist. A `void` return means the dep already parked the
	// work on a real `waitUntil`; a returned promise is held as above (bounded:
	// 10s LLM abort inside). The try/catch shields a synchronously throwing sink.
	if (!modelUnavailable && deps.generateConversationTitle) {
		try {
			const titleWork = deps.generateConversationTitle({
				organizationId,
				conversationId,
				runId,
				userContent: content,
				assistantContent,
			});
			if (titleWork)
				holdAfterSettle("conversation_title_dispatch_failed", titleWork);
		} catch (error) {
			console.warn({
				component: "kernel.turn_work",
				event: "conversation_title_dispatch_failed",
				error: safeExceptionTopology(error),
			});
		}
	}
	// Wake the approval tedi only after the run parked: its decision resolves
	// against the requires_approval row.
	if (
		agentReviewPending &&
		delegationAgentReview?.proposalId &&
		deps.wakeDelegationAgentReview
	) {
		try {
			const wake = deps.wakeDelegationAgentReview({
				organizationId,
				proposalId: delegationAgentReview.proposalId,
			});
			if (wake) await wake;
		} catch (error) {
			console.warn({
				component: "kernel.turn_work",
				event: "delegation_agent_review_wake_failed",
				error: safeExceptionTopology(error),
			});
		}
	}
	// Trusted-write auto-resolve (after parking): the run is now requires_approval
	// and the approval.requested event has landed — the audit row exists. When the
	// write is policy-trusted+low-risk or session pre-authorized, settle it through
	// the same latch a human approval uses (resolvedBy:'policy'), executing the
	// stored call in-turn. Fail-soft: a null result leaves the row pending so a
	// human can still resolve it — the per-click tax is removed only on a clean
	// auto-resolution, never the audit trail.
	if (
		!preparedAutoWrite &&
		writeWillAutoResolve &&
		writeApprovalRequestId &&
		writeApprovalDecision &&
		deps.autoResolveKernelWrite
	) {
		writeAutoResolveResult = await deps
			.autoResolveKernelWrite({
				approvalRequestId: writeApprovalRequestId,
				organizationId,
				runId,
				conversationId,
				decision: writeApprovalDecision,
			})
			.catch((error) => {
				console.warn({
					component: "kernel.turn_work",
					event: "write_auto_resolve_failed",
					error: safeExceptionTopology(error),
				});
				return null;
			});
	}
	// Trace evidence (R2 folder + D1 bundle index) is read by later harness
	// views, never by the settled answer or the client's next read — held, not
	// awaited.
	if (kernelHarnessVersion && traceBundleId && deps.recordKernelTraceBundle) {
		const traceWork = recordKernelTraceEvidence({
			kernelHarnessVersion,
			traceBundleId,
			recordKernelTraceBundle: deps.recordKernelTraceBundle,
			writeKernelTraceBundle: deps.writeKernelTraceBundle,
			errorMessage: deps.errorMessage,
			organizationId,
			conversationId,
			runId,
			createdAt: completedAt,
			assistantEventId: assistantEvent.id,
			terminalEventId: terminalEvent.id,
			runRowMetadata,
			kernelResult,
			assistantContent,
			bodyExecutionResult,
			outcome:
				writeProposalActive || delegationApprovalActive
					? "escalated"
					: "success",
			routerVersion,
			contextManifest: turnRunMetadata.contextManifest ?? {},
		});
		holdAfterSettle("trace_evidence_record_failed", traceWork);
	}
	const submissionOutcome = kernelRunStatusToSubmissionOutcome(
		writeAutoResolveResult?.finalStatus ?? dispatchAwareStatus,
	);
	if (submissionOutcome) {
		// Held, not awaited: the multi-step submission settle measured 0.7-0.8 s
		// of D1 round trips between the terminal write and the answer leaving
		// (stage marks settleWriteEnded → turnEnded). The run row and the
		// transcript are already terminal; `submission.settled` still lands
		// last because it starts after them.
		holdAfterSettle(
			"submission_settle_failed",
			settleKernelSubmission(deps.db, {
				runId,
				organizationId,
				conversationId,
				outcome: submissionOutcome,
			}),
		);
	}
	// No holder was injected: the turn body itself keeps the post-settlement
	// work alive (each promise is already caught above).
	if (heldAfterSettle.length > 0) await Promise.all(heldAfterSettle);
	// When a trusted write auto-resolved in-turn, the settle hook transitioned the
	// run past requires_approval to its terminal state — reflect that in the
	// returned snapshot so the immediate response isn't a stale "requires_approval".
	// (Fail-soft: no clean execution ⇒ the parked snapshot stands and a human card
	// remains.)
	const autoResolvedStatus =
		writeAutoResolveResult?.executed && writeAutoResolveResult.finalStatus
			? writeAutoResolveResult.finalStatus
			: null;
	const effectiveStatus: TediRunStatus =
		autoResolvedStatus ?? dispatchAwareStatus;
	const effectiveCompletedAt = autoResolvedStatus
		? settledAt
		: dispatchAwareCompletedAt;
	const replyEvent = writeAutoResolveResult?.assistantEvent ?? assistantEvent;
	const replyContent =
		typeof replyEvent.payload?.content === "string"
			? replyEvent.payload.content
			: assistantContent;
	const run: HomeRun = {
		id: runId,
		organizationId,
		conversationId,
		status: effectiveStatus,
		inputMessageId: userMessageId,
		outputMessageId: replyEvent.messageId ?? assistantMessageId,
		delegatedTediId: autoDelegatedTediId,
		childRunId: autoChildRunId,
		runtime: {
			backend: KERNEL_RUNTIME_BACKEND,
			externalId: runId,
			metadata: {
				...runtimeMetadata,
				childConversationId: autoDispatch?.childConversationId,
				delegationStatus: autoDispatch?.status,
				delegationError: autoDispatch?.error,
				delegationWorkOrder: dispatchWorkOrder,
			},
		},
		startedAt: createdAt,
		completedAt: effectiveCompletedAt,
		createdAt,
		updatedAt: settledAt,
		metadata: writeAutoResolveResult?.assistantEvent
			? {
					...mergedTurnRunMetadata,
					kernelRoute: {
						...nonNullRecord(mergedTurnRunMetadata.kernelRoute),
						answer: replyContent,
					},
				}
			: mergedTurnRunMetadata,
		progress: dispatchAwareProgress,
	};
	stageTimings.mark("turnEnded");
	return {
		idempotencyKey: runId,
		conversationId,
		status:
			autoResolvedStatus === "completed" || autoResolvedStatus === "failed"
				? autoResolvedStatus
				: modelUnavailable
					? ("failed" as const)
					: writeProposalActive || delegationApprovalActive
						? ("requires_approval" as const)
						: autoDispatchSucceeded || delegationDeferred
							? ("queued" as const)
							: autoDispatchFailed
								? ("failed" as const)
								: answeredInHome
									? ("completed" as const)
									: ("needs_delegation" as const),
		run,
		homePlan: undefined,
		assistantMessage: {
			id: replyEvent.messageId ?? assistantMessageId,
			organizationId,
			conversationId,
			runId,
			role: "assistant" as const,
			status: "completed" as const,
			content: replyContent,
			runtime: replyEvent.runtime,
			createdAt: replyEvent.createdAt,
			startedAt: replyEvent.createdAt,
			completedAt: run.completedAt,
			metadata: replyEvent.payload,
		},
		error: undefined,
	};
}
