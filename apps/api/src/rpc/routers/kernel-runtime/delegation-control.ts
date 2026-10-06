import { AUTHZ, type BaseContext, ErrorCodes, createError } from "../../orpc";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { cancelWorkItem } from "@tedix/db/queries/work-items/crud";
import { deriveApprovalAuthority } from "../kernel/context-assembly";
import {
	agentReviewIsPending,
	readHomeDelegationAgentReview,
} from "../kernel/delegation-approver";
import {
	type KernelRuntimeRun,
	getKernelRuntimeRun,
	getKernelRuntimeRunStatus,
} from "@tedix/db/queries/kernel-runtime-runs";
import {
	countTediRuntimeEvents,
	listKernelRuntimeEvents,
	listTediRuntimeEvents,
} from "@tedix/db/queries/kernel-runtime-events";
import { ensureHomeConversationAccess } from "../kernel/run-store";
import {
	errorMessage,
	nonNullRecord,
	resolveOrganizationId,
	shouldFailSoftHomeRunSetRead,
	stringFromPayload,
} from "../kernel/runtime-shared";
import { getApprovalRequestById } from "@tedix/db/queries/approvals";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { homeWorkstationAttachPayload } from "../kernel/workstation-attach";
import {
	kernelRunStatusToSubmissionOutcome,
	settleKernelSubmission,
} from "../../../kernel/runtime-submission-bridge";
import {
	observedLearningEventId,
	recordObservedLearningInteraction,
} from "../../../services/learning-interaction-recorder";
import { parseCodemodeExecuteWritePayload } from "@tedix/api-contract/schemas/codemode-execute-write";
import { parseHomeToolWritePayload } from "../kernel/write-executor";
import { readOptionalHomePlanFromRun } from "../kernel/home-plan";
import { authed } from "./policy-normalization";
import {
	RUN_EVENT_RECEIPT_KINDS,
	RUN_EVENT_RECEIPT_ROWS,
	RUN_EVENT_STREAM_PAGE,
	RunEventStreamRow,
	buildRunEventStreamPage,
	buildSelectedRunEventStreamPage,
	childStreamRow,
	kernelStreamRow,
	resolveDelegatedChildRunRef,
} from "./run-reads-streams";
import {
	kernelDelegationRecommendationFromRun,
	rejectKernelPlanAssignmentsCore,
	respondDurableCodemodeApprovalCore,
	respondKernelToolWriteApprovalCore,
	respondKernelWorkstationAttachApprovalCore,
} from "./turn-delegation";
import {
	approveHomePlanAssignmentsCore,
	respondKernelDelegationRecommendationApprovalCore,
	retryKernelRunCore,
} from "./approval-control";
import {
	cancelKernelRunCore,
	retryDelegationWorkItem,
	steerKernelRunCore,
} from "./control-proposals";

export const readRunEventsRoute = authed.readRunEvents
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		// Authorize per-conversation BEFORE returning events (mirror readRun):
		// org scope alone would expose the event stream of runs in restricted
		// Home conversations to any org caller with the read scope.
		let runRow: KernelRuntimeRun | undefined;
		try {
			runRow = await getKernelRuntimeRun(context.db, {
				id: input.runId,
				organizationId,
			});
		} catch (error) {
			if (shouldFailSoftHomeRunSetRead(error)) {
				console.warn("[kernelRuntime] run events read failed", {
					organizationId,
					homeRunId: input.runId,
					error: errorMessage(error),
				});
				throw createError(ErrorCodes.NOT_FOUND, "Home run not found");
			}
			throw error;
		}
		if (!runRow) {
			throw createError(ErrorCodes.NOT_FOUND, "Home run not found");
		}
		await ensureHomeConversationAccess(context, {
			conversationId: runRow.conversationId,
			organizationId,
			required: "read",
		});
		// A delegated child selector must resolve from the authorized parent row;
		// otherwise an org-scoped caller could substitute an unrelated child run.
		// Once authorized, read the child's canonical tedi_runtime_events ledger —
		// kernel_runtime_events only contains parent projections and cannot provide
		// answer/tool/approval/terminal parity with the live Agent stream.
		const childRef = input.childRunId
			? resolveDelegatedChildRunRef(runRow, {
					childRunId: input.childRunId,
					delegatedTediId: input.delegatedTediId,
				})
			: null;
		if (input.childRunId && !childRef) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Delegated child run not found for Home run",
			);
		}
		const waitMs = Math.min(Math.max(input.waitMs ?? 0, 0), 30_000);
		// One offset page. A caller whose transport caps the response body pages in
		// smaller slices; the server page size stays the ceiling and the default.
		const pageLimit = Math.min(
			Math.max(input.limit ?? RUN_EVENT_STREAM_PAGE, 1),
			RUN_EVENT_STREAM_PAGE,
		);
		const deadline = Date.now() + waitMs;
		// `rowStatus` freshness must match the poll cadence below: the row can
		// transition to a real terminal status WHILE this loop is waiting. Re-read
		// it on every iteration. The active offset path selects only one bounded
		// event page plus a bounded receipt set; it never re-fetches full history.
		let currentRowStatus = runRow.status;
		let settlementRepairAttempted = false;
		while (true) {
			let rows: RunEventStreamRow[] = [];
			let receiptRows: RunEventStreamRow[] = [];
			let tailStart: number | null = null;
			try {
				if (childRef) {
					if (input.tail) {
						const tailLimit = Math.min(input.tail, RUN_EVENT_STREAM_PAGE);
						const [descendingRows, childReceiptRows, total] = await Promise.all(
							[
								listTediRuntimeEvents(context.db, {
									organizationId,
									tediId: childRef.delegatedTediId,
									runId: childRef.childRunId,
									order: "desc",
									limit: tailLimit,
								}),
								listTediRuntimeEvents(context.db, {
									organizationId,
									tediId: childRef.delegatedTediId,
									runId: childRef.childRunId,
									kinds: RUN_EVENT_RECEIPT_KINDS,
									order: "desc",
									limit: RUN_EVENT_RECEIPT_ROWS,
								}),
								countTediRuntimeEvents(context.db, {
									organizationId,
									tediId: childRef.delegatedTediId,
									runId: childRef.childRunId,
								}),
							],
						);
						rows = descendingRows.reverse().map(childStreamRow);
						receiptRows = childReceiptRows.map(childStreamRow);
						tailStart = Math.max(0, total - rows.length);
					} else {
						const start = input.offset ?? 0;
						const [childRows, childReceiptRows] = await Promise.all([
							listTediRuntimeEvents(context.db, {
								organizationId,
								tediId: childRef.delegatedTediId,
								runId: childRef.childRunId,
								order: "asc",
								limit: pageLimit,
								offset: start,
							}),
							listTediRuntimeEvents(context.db, {
								organizationId,
								tediId: childRef.delegatedTediId,
								runId: childRef.childRunId,
								kinds: RUN_EVENT_RECEIPT_KINDS,
								order: "desc",
								limit: RUN_EVENT_RECEIPT_ROWS,
							}),
						]);
						rows = childRows.map(childStreamRow);
						receiptRows = childReceiptRows.map(childStreamRow);
					}
				} else if (input.tail) {
					// `tail` is a one-shot inspection operation, not the active SSE
					// cursor. Preserve its exact total-relative offset semantics.
					rows = (
						await listKernelRuntimeEvents(context.db, {
							organizationId,
							runId: input.runId,
							order: "asc",
						})
					).map(kernelStreamRow);
				} else {
					const start = input.offset ?? 0;
					const [parentRows, parentReceiptRows] = await Promise.all([
						listKernelRuntimeEvents(context.db, {
							organizationId,
							runId: input.runId,
							order: "asc",
							limit: pageLimit,
							offset: start,
						}),
						listKernelRuntimeEvents(context.db, {
							organizationId,
							runId: input.runId,
							kinds: RUN_EVENT_RECEIPT_KINDS,
							order: "desc",
							limit: RUN_EVENT_RECEIPT_ROWS,
						}),
					]);
					rows = parentRows.map(kernelStreamRow);
					receiptRows = parentReceiptRows.map(kernelStreamRow);
				}
				if (!childRef) {
					const freshStatus = await getKernelRuntimeRunStatus(context.db, {
						id: input.runId,
						organizationId,
					});
					if (freshStatus) currentRowStatus = freshStatus;
				}
			} catch (error) {
				if (shouldFailSoftHomeRunSetRead(error)) {
					console.warn("[kernelRuntime] run events read failed", {
						organizationId,
						homeRunId: input.runId,
						error: errorMessage(error),
					});
					return {
						events: [],
						stream: {
							streamId: input.childRunId
								? `home:${input.runId}:child:${input.childRunId}`
								: `home:${input.runId}`,
							offset: input.offset ?? 0,
							nextOffset: input.offset ?? 0,
							closed: false,
						},
					};
				}
				throw error;
			}
			const page = input.tail
				? childRef
					? buildSelectedRunEventStreamPage(rows, receiptRows, {
							runId: input.runId,
							start: tailStart ?? 0,
							childRunId: childRef.childRunId,
						})
					: buildRunEventStreamPage(rows, {
							runId: input.runId,
							tail: input.tail,
							rowStatus: currentRowStatus,
						})
				: buildSelectedRunEventStreamPage(rows, receiptRows, {
						runId: input.runId,
						start: input.offset ?? 0,
						childRunId: childRef?.childRunId,
						rowStatus: childRef ? undefined : currentRowStatus,
					});
			const submissionOutcome =
				kernelRunStatusToSubmissionOutcome(currentRowStatus);
			if (
				!input.tail &&
				!childRef &&
				!settlementRepairAttempted &&
				page.stream.submissionId &&
				!page.stream.closed &&
				submissionOutcome
			) {
				// A terminal parent with an admitted-but-unsettled receipt is a
				// specific fail-soft gap, not steady-state history. Repair it once,
				// then re-read the same bounded page so this response can carry the
				// deterministic submission.settled fence and close immediately.
				settlementRepairAttempted = true;
				await settleKernelSubmission(context.db, {
					runId: input.runId,
					organizationId,
					conversationId: runRow.conversationId,
					outcome: submissionOutcome,
				});
				continue;
			}
			if (
				input.tail ||
				waitMs === 0 ||
				page.events.length > 0 ||
				page.stream.closed ||
				Date.now() >= deadline
			) {
				return page;
			}
			await new Promise((resolve) =>
				setTimeout(resolve, Math.min(1000, deadline - Date.now())),
			);
		}
	});

export const cancelRunRoute = authed.cancelRun
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		const existingRun = await getKernelRuntimeRun(context.db, {
			id: input.runId,
			organizationId,
		});
		if (!existingRun) {
			throw createError(ErrorCodes.NOT_FOUND, "Home run not found");
		}
		await ensureHomeConversationAccess(context, {
			conversationId: existingRun.conversationId,
			organizationId,
			required: "edit",
		});
		return cancelKernelRunCore(context, {
			organizationId,
			homeRunId: input.runId,
			reason: input.reason,
		});
	});

export const steerRunRoute = authed.steerRun
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		const existingRun = await getKernelRuntimeRun(context.db, {
			id: input.runId,
			organizationId,
		});
		if (!existingRun) {
			throw createError(ErrorCodes.NOT_FOUND, "Home run not found");
		}
		await ensureHomeConversationAccess(context, {
			conversationId: existingRun.conversationId,
			organizationId,
			required: "edit",
		});
		const result = await steerKernelRunCore(context, {
			organizationId,
			homeRunId: input.runId,
			instruction: input.instruction,
		});
		const steeredAt = result.run.updatedAt ?? new Date().toISOString();
		await recordObservedLearningInteraction(context, {
			organizationId,
			clientEventId: await observedLearningEventId(
				"kernel-steer",
				input.runId,
				steeredAt,
			),
			eventKind: "edited",
			surface: "kernel",
			issueKey: "kernel-run-steering",
			targetType: "kernel_run",
			targetId: input.runId,
			threadId: existingRun.conversationId,
			runId: input.runId,
			metadata: {
				instructionChars: input.instruction.length,
			},
			occurredAt: steeredAt,
		});
		return result;
	});

/**
 * The operator path of a held Home delegation. Tedis never decide here — the
 * Work approval plane (`workApprovals.decide`) is their only route, with its
 * designated-approver and requester≠approver checks. A human principal must
 * carry approval authority (an active org owner or admin, the same rule that
 * derives `speaker.approvalAuthority` for the dispatch gate). API keys and
 * internal service bindings are authorized by their scope plane.
 */
async function assertHomeDelegationOperatorAuthority(
	context: BaseContext,
	organizationId: string,
): Promise<void> {
	if (context.authType === "tedi" || context.tediId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Tedis decide held Home delegations through the Work approval plane, not respondApproval",
		);
	}
	const subject =
		context.authType === "user" || context.authType === "service-binding"
			? (context.descopeUserId ?? context.user?.sub ?? null)
			: null;
	if (context.authType === "user" && !subject) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Resolving a Home delegation requires an identified operator",
		);
	}
	if (!subject) return;
	const member = await getMemberByUserId(context.db, organizationId, subject);
	if (
		!member ||
		member.status !== "active" ||
		!deriveApprovalAuthority(member.role)
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Resolving a Home delegation requires an active organization owner or admin",
		);
	}
}

export const respondApprovalRoute = authed.respondApproval
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		const existingRun = await getKernelRuntimeRun(context.db, {
			id: input.runId,
			organizationId,
		});
		if (!existingRun) {
			throw createError(ErrorCodes.NOT_FOUND, "Home run not found");
		}
		await ensureHomeConversationAccess(context, {
			conversationId: existingRun.conversationId,
			organizationId,
			required: "edit",
		});
		const recordDecision = async (target: string) => {
			await recordObservedLearningInteraction(context, {
				organizationId,
				clientEventId: await observedLearningEventId(
					"kernel-approval",
					input.runId,
					target,
					input.decision,
					[...(input.assignmentIds ?? [])].sort().join(","),
				),
				signalClass: "governance",
				eventKind: input.decision === "approve" ? "accepted" : "rejected",
				surface: "kernel",
				issueKey: `kernel-approval:${target}`,
				targetType: target,
				targetId: input.runId,
				threadId: existingRun.conversationId,
				runId: input.runId,
				metadata: {
					decision: input.decision,
					hadNote: Boolean(input.note),
				},
			});
		};

		// Target 1 — write-action card: the run's metadata carries the
		// deterministic approval id (turn-work.ts parked the run
		// requires_approval) and the approval payload is kind
		// "home_tool_write". Resolution goes through the SAME canonical
		// latch + settle path as tediApprovals.resolve.
		const runMetadata = nonNullRecord(existingRun.metadata) ?? {};
		const approvalRequestId = stringFromPayload(runMetadata.approvalRequestId);
		const approval = approvalRequestId
			? await getApprovalRequestById(context.db, approvalRequestId)
			: undefined;
		const codemodeApproval = approval
			? parseCodemodeExecuteWritePayload(approval.payload)
			: null;
		if (approval && codemodeApproval?.executionMode === "durable_call") {
			const result = await respondDurableCodemodeApprovalCore(context, {
				approval,
				decision: input.decision,
				note: input.note,
				organizationId,
				payload: codemodeApproval,
				run: existingRun,
			});
			await recordDecision("durable_codemode_call");
			return result;
		}
		if (approval && parseHomeToolWritePayload(approval.payload)) {
			const result = await respondKernelToolWriteApprovalCore(context, {
				approval,
				decision: input.decision,
				note: input.note,
				organizationId,
				run: existingRun,
			});
			await recordDecision("home_tool_write");
			return result;
		}
		// Target 2 — workstation attachment and delegation work orders. The run still
		// resolves by homeRunId; the raw approval id stays server-side.
		if (approval && homeWorkstationAttachPayload(approval.payload)) {
			const result = await respondKernelWorkstationAttachApprovalCore(context, {
				approval,
				decision: input.decision,
				note: input.note,
				organizationId,
				run: existingRun,
			});
			await recordDecision("workstation_attachment");
			return result;
		}
		const pendingDelegation = approval
			? null
			: kernelDelegationRecommendationFromRun(existingRun);
		if (pendingDelegation) {
			await assertHomeDelegationOperatorAuthority(context, organizationId);
			const agentReview = readHomeDelegationAgentReview(
				pendingDelegation.delegation,
			);
			// The org's approval tedi is deciding: the operator may still reject
			// (withdraw) the delegation, but not race an approval past it.
			if (input.decision === "approve" && agentReviewIsPending(agentReview)) {
				throw createError(
					ErrorCodes.CONFLICT,
					`Home run ${input.runId} is awaiting ${agentReview?.approverTediLabel ?? "the designated approval tedi"}'s decision until ${agentReview?.expiresAt}; you can reject it now or decide after the approver declines or the review expires.`,
				);
			}
			const result = await respondKernelDelegationRecommendationApprovalCore(
				context,
				{
					decision: input.decision,
					note: input.note,
					organizationId,
					run: existingRun,
				},
			);
			if (agentReview?.workItemId && agentReview.status !== "approved") {
				// The operator decided instead: retire the held review item so it
				// cannot be admitted by a late approver decision.
				await cancelWorkItem(context.db, {
					orgId: organizationId,
					workItemId: agentReview.workItemId,
					actor: { type: "system", id: "home" },
					reason: "The operator resolved the held Home delegation",
				}).catch((error) =>
					console.warn(
						"[kernelRuntime] held Home delegation review cancel failed",
						errorMessage(error),
					),
				);
			}
			await recordDecision("delegation_recommendation");
			return result;
		}

		// Target 3 — proposed Home plan assignments.
		const homePlan = readOptionalHomePlanFromRun(existingRun);
		const hasProposedAssignments = Boolean(
			homePlan?.assignments.some(
				(assignment) => assignment.status === "proposed",
			),
		);
		if (homePlan && hasProposedAssignments) {
			if (input.decision === "reject") {
				const result = await rejectKernelPlanAssignmentsCore(context, {
					organizationId,
					homeRunId: input.runId,
					assignmentIds: input.assignmentIds,
					note: input.note,
				});
				await recordDecision("home_plan");
				return result;
			}
			const result = await approveHomePlanAssignmentsCore(context, {
				organizationId,
				homeRunId: input.runId,
				assignmentIds: input.assignmentIds,
				dispatch: true,
				approvalNote: input.note,
			});
			await recordDecision("home_plan");
			return result;
		}

		// Neither target — name what the run is actually waiting on.
		if (approval) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Home run ${input.runId} is waiting on a "${approval.actionType}" approval (request ${approval.id}, status "${approval.status}"), not a supported Home approval target.`,
			);
		}
		if (homePlan) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Home run ${input.runId} has a Home plan with no proposed assignments left (plan status "${homePlan.status}") — there is nothing pending to ${input.decision}.`,
			);
		}
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Home run ${input.runId} (status "${existingRun.status}") is not waiting on an approval: no write-action approval card, workstation attachment, delegation approval, or proposed Home plan assignments.`,
		);
	});

export const retryRunRoute = authed.retryRun
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		const existingRun = await getKernelRuntimeRun(context.db, {
			id: input.runId,
			organizationId,
		});
		if (!existingRun) {
			throw createError(ErrorCodes.NOT_FOUND, "Home run not found");
		}
		await ensureHomeConversationAccess(context, {
			conversationId: existingRun.conversationId,
			organizationId,
			required: "edit",
		});
		const result = await retryKernelRunCore(context, {
			organizationId,
			run: existingRun,
		});
		await recordObservedLearningInteraction(context, {
			organizationId,
			clientEventId: await observedLearningEventId(
				"kernel-retry",
				result.run.id,
			),
			eventKind: "retried",
			surface: "kernel",
			issueKey: "kernel-run-retry",
			targetType: "kernel_run",
			targetId: existingRun.id,
			threadId: existingRun.conversationId,
			runId: result.run.id,
			metadata: {
				retriedFromRunId: existingRun.id,
			},
		});
		return result;
	});

export const retryDelegationRoute = authed.retryDelegation
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		// Gate operator authority on the Work Item's originating Home
		// conversation BEFORE re-dispatch. retryDelegationWorkItem re-loads
		// and re-validates the item itself; this guard only proves edit access.
		const workItem = await getWorkItemById(context.db, input.workItemId);
		if (!workItem || workItem.orgId !== organizationId) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				`Work item ${input.workItemId} not found`,
			);
		}
		if (!workItem.sourceSessionKey) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				`Work item ${input.workItemId} has no source Home conversation to gate against`,
			);
		}
		await ensureHomeConversationAccess(context, {
			conversationId: workItem.sourceSessionKey,
			organizationId,
			required: "edit",
		});
		const result = await retryDelegationWorkItem(context, {
			organizationId,
			workItemId: input.workItemId,
		});
		await recordObservedLearningInteraction(context, {
			organizationId,
			clientEventId: await observedLearningEventId(
				"delegation-retry",
				input.workItemId,
				result.retryCount,
			),
			eventKind: "retried",
			surface: "kernel",
			tediId:
				workItem.accountableOwnerType === "tedi"
					? workItem.accountableOwnerId
					: null,
			issueKey: "kernel-delegation-retry",
			targetType: "work_item",
			targetId: input.workItemId,
			threadId: workItem.sourceSessionKey,
			runId: result.childRunId,
			metadata: {
				retryCount: result.retryCount,
			},
		});
		return result;
	});
