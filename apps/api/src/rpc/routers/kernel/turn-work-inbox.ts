import {
	emitProgress,
	type KernelTurnWorkDeps,
	type KernelTurnWorkInput,
} from "./turn-work-context";
import { kernelSpanContext } from "./gateway-attribution";
import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import type { TediRunStatus } from "@tedix/api-contract/schemas/cognitive-runtime";
import type { HomeRun } from "@tedix/api-contract/schemas/kernel-runtime";
import { homeRuntimeEventId } from "@tedix/api-contract/utils/runtime-events";
import {
	getKernelRuntimeRun,
	transitionKernelRuntimeRunStatus,
} from "@tedix/db/queries/kernel-runtime-runs";
import { settleKernelSubmission } from "../../../kernel/runtime-submission-bridge";
import { type KernelEnv, kernelModel } from "./llm";
import {
	DELEGATION_SYNTHESIS_SYSTEM_PROMPT,
	nonNullRecord,
} from "./runtime-shared";
import { KERNEL_RUNTIME_BACKEND } from "./turn-work-context";

const SYNTHESIS_FALLBACK_BRANCH_CHARS = 800;

function evidenceBackedSynthesisFallback(
	countNotice: string,
	transcriptBlocks: readonly string[],
): string {
	if (transcriptBlocks.length === 0) return countNotice;
	return [
		countNotice,
		"Evidence from delegated branches:",
		...transcriptBlocks.map((block) =>
			block.length > SYNTHESIS_FALLBACK_BRANCH_CHARS
				? `${block.slice(0, SYNTHESIS_FALLBACK_BRANCH_CHARS)}…`
				: block,
		),
	].join("\n\n");
}

/**
 * Inbox-wake reconciliation intercept — extracted verbatim from the former
 * inline block in {@link runKernelTurnWork}. When the DO alarm handler
 * injected this synthetic turn after one or more child delegations completed,
 * this reconciles the parent runs and settles this run, returning a result.
 * Returns `null` when the turn is not a wake turn (or the dep is absent),
 * so the caller falls through to normal turn processing.
 */
export async function runInboxWakeIntercept(
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
		createdAt,
		assistantAt,
		completedAt,
		homePlan,
		runRowMetadata,
		runtimeMetadata,
	} = input;

	// ── Inbox-wake reconciliation intercept ───────────────────────────────────
	// When the DO alarm handler injected this synthetic turn after one or more
	// child delegations completed (`source=kernel.inboxWakeAlarm`,
	// `kernelInboxRunIds` in runtimeMetadata), reconcile the parent run rows
	// (found by `childRunId IN kernelInboxRunIds`) against current child-run
	// event evidence, then settle this run and return early — skipping the LLM
	// planner entirely.
	//
	// ID namespace: the dep receives `childRunIds`, not parent run IDs. The dep
	// itself queries parents by `childRunId` column (kernel-runtime.ts).
	//
	// Fail-soft throughout: dep absent → fall through; reconcile error →
	// fail-soft returns []; wake turn still settles as completed.
	const inboxChildRunIds = (() => {
		const ids = runtimeMetadata?.kernelInboxRunIds;
		return Array.isArray(ids) && ids.length > 0
			? ids.filter((id): id is string => typeof id === "string")
			: null;
	})();
	// A wake turn (source kernel.inboxWakeAlarm) must be fully handled here and
	// never fall through to normal routing — even when kernelInboxRunIds is
	// empty/absent (a stale or already-consumed wake). Otherwise the synthetic
	// "[System: … delegated task completed …]" turn reaches answer_in_home and
	// emits a canned "This is Home:" greeting. Empty/absent ids → reconcile []
	// → no fresh delivery → quiet no-op below (never a canned greeting).
	if (
		runtimeMetadata?.source === "kernel.inboxWakeAlarm" &&
		deps.reconcileInboxWakeRuns
	) {
		emitProgress(deps, "Reconciling delegated tasks");
		const {
			runs: reconciledRuns,
			synthesisBranches = [],
			freshlySettledChildRunIds,
			canonicalDirectCompletionChildRunIds = new Set<string>(),
		} = await deps.reconcileInboxWakeRuns({
			organizationId,
			childRunIds: inboxChildRunIds ?? [],
		});

		// Direct runs are delivered by the deterministic completion event on their
		// parent run. Exclude those canonical owners even when this wake is the path
		// that freshly settled them; otherwise the wake would persist the same child
		// answer under its own synthetic run id. The remaining sets are fallback-only
		// direct runs plus plan convergence branches.
		const freshlyCompletedRuns = reconciledRuns.filter(
			(r) =>
				r.status === "completed" &&
				r.childRunId !== null &&
				freshlySettledChildRunIds.has(r.childRunId as string) &&
				!canonicalDirectCompletionChildRunIds.has(r.childRunId as string),
		);
		const freshlyFailedRuns = reconciledRuns.filter(
			(r) =>
				r.status === "failed" &&
				r.childRunId !== null &&
				freshlySettledChildRunIds.has(r.childRunId as string) &&
				!canonicalDirectCompletionChildRunIds.has(r.childRunId as string),
		);
		const directBranchIds = new Set(
			[...freshlyCompletedRuns, ...freshlyFailedRuns]
				.map((run) => run.childRunId)
				.filter((id): id is string => typeof id === "string"),
		);
		// A plan branch is individually persisted as it settles, but Home emits one
		// converged delivery only when the parent plan becomes terminal. At that
		// point synthesisBranches contains every terminal branch, not merely the
		// child whose wake happened to close the plan.
		const planBranches = synthesisBranches.filter(
			(branch) => !directBranchIds.has(branch.childRunId),
		);
		const completedBranches = [
			...freshlyCompletedRuns.flatMap((run) =>
				run.childRunId && run.delegatedTediId
					? [
							{
								childRunId: run.childRunId,
								delegatedTediId: run.delegatedTediId,
							},
						]
					: [],
			),
			...planBranches
				.filter((branch) => branch.status === "completed")
				.map((branch) => ({
					childRunId: branch.childRunId,
					delegatedTediId: branch.delegatedTediId,
				})),
		];
		const freshCompletedCount = completedBranches.length;
		const freshFailedCount =
			freshlyFailedRuns.length +
			planBranches.filter(
				(branch) => branch.status === "failed" || branch.status === "canceled",
			).length;
		const hasNewDelivery = freshCompletedCount > 0 || freshFailedCount > 0;

		const wakeProgress = deps.homeRunProgress({
			eventCount: reconciledRuns.length,
			status: "completed",
		});
		emitProgress(deps, "Finalizing");
		const wakeMeta = {
			...runRowMetadata,
			kernelInboxWake: {
				reconciledChildRunIds: inboxChildRunIds ?? [],
				canonicalDirectCompletionChildRunIds: [
					...canonicalDirectCompletionChildRunIds,
				],
				completedCount: freshCompletedCount,
				failedCount: freshFailedCount,
				// Audit: all child run IDs that were already delivered before this wake
				alreadyDeliveredChildRunIds: (inboxChildRunIds ?? []).filter(
					(id) => !freshlySettledChildRunIds.has(id),
				),
			},
		};
		await transitionKernelRuntimeRunStatus(deps.db, {
			id: runId,
			organizationId,
			fromStatus: "running",
			patch: {
				status: "completed",
				progressValue: wakeProgress.current,
				progressLabel: wakeProgress.label,
				progressDetail: wakeProgress.detail,
				completedAt,
				updatedAt: completedAt,
				metadata: wakeMeta,
			},
		});

		// When there is nothing new to deliver — direct children are already owned
		// by their canonical parent completion events, or every child was handled by
		// a prior reconcile — complete this wake turn quietly: ack the run and emit
		// run.completed but write no assistant message.
		if (!hasNewDelivery) {
			console.warn({
				component: "kernel.turn_work",
				event: "inbox_wake_no_new_delivery",
				inboxChildCount: inboxChildRunIds?.length ?? 0,
				reconciledCount: reconciledRuns.length,
			});
			await deps.insertKernelRuntimeEvent({
				organizationId,
				kind: "run.completed",
				conversationId,
				runId,
				payload: {
					status: "completed",
					approvalRequestId: null,
					inputMessageId: userMessageId,
					outputMessageId: assistantMessageId,
					childConversationId: null,
					childRunId: null,
					error: null,
					delegationError: null,
					delegationWorkOrder: null,
					homePlan,
					// Deterministic wake intercept — no route planner ran this turn.
					route: null,
				},
				runtimeMetadata: { ...runtimeMetadata, wakeNoOp: true },
				createdAt: completedAt,
			});
			// Exactly-once inline settle: this early return skips the shared settle
			// at the end of the turn, and an unsettled wake submission otherwise
			// stays `running` until the reconcile sweep — an operator-visible
			// phantom spinner (fail-soft inside the helper).
			await settleKernelSubmission(deps.db, {
				runId,
				organizationId,
				conversationId,
				outcome: "settled",
			});
			const wakeRun: HomeRun = {
				id: runId,
				organizationId,
				conversationId,
				status: "completed",
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
				metadata: wakeMeta,
				progress: wakeProgress,
			};
			return {
				idempotencyKey: runId,
				conversationId,
				status: "needs_delegation" as const,
				run: wakeRun,
				homePlan: undefined,
				// Sentinel: no assistant message written to the conversation.
				assistantMessage: {
					id: assistantMessageId,
					organizationId,
					conversationId,
					runId,
					role: "assistant" as const,
					status: "completed" as const,
					content: "",
					runtime: {
						backend: KERNEL_RUNTIME_BACKEND as typeof KERNEL_RUNTIME_BACKEND,
						metadata: {},
					},
					createdAt: completedAt,
					startedAt: completedAt,
					completedAt,
					metadata: {
						wakeNoOp: true,
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
				error: undefined,
			};
		}

		// There is at least one freshly-completed or freshly-failed child — build
		// and deliver the wake message.
		const countParts: string[] = [];
		if (freshCompletedCount > 0)
			countParts.push(
				`${freshCompletedCount} task${freshCompletedCount === 1 ? "" : "s"} completed`,
			);
		if (freshFailedCount > 0) countParts.push(`${freshFailedCount} failed`);
		// Deterministic wake notice — a factual count of the delegated work that
		// just settled (this branch only runs when at least one child finished).
		const fallbackContent =
			countParts.length > 0
				? `Update from delegated work: ${countParts.join(", ")}.`
				: content;
		const convergedPlanParent = synthesisBranches[0]?.parentRunId ?? null;
		const convergedParentRow = convergedPlanParent
			? await getKernelRuntimeRun(deps.db, {
					id: convergedPlanParent,
					organizationId,
				})
			: undefined;
		const convergedParentMetadata = nonNullRecord(convergedParentRow?.metadata);
		const redriveInput = nonNullRecord(convergedParentMetadata?.redriveInput);
		const originalOperatorRequest =
			typeof redriveInput?.content === "string"
				? redriveInput.content.trim()
				: "";

		// Secondary fix — Synthesis path: when there are freshly completed children
		// and the dep is wired, run a bounded LLM synthesis pass that interprets the
		// child's full output for the operator.
		// Fail-soft in every branch: any error falls back to the count.
		// Previously this ran over all completed children (including already-delivered
		// ones); now it runs only over freshlyCompletedRuns, which is the correct set.
		let wakeAssistantContent = fallbackContent;
		// Relay-first (harness contract): a single freshly-completed child's final
		// assistant message is the return value — relay it verbatim instead of
		// re-interpreting the transcript. Synthesis stays for multi-child
		// deliveries (cross-child interpretation) and for children that ended
		// without a final message. Fail-soft: null → synthesis/count below.
		let relayedFinalMessage: string | null = null;
		if (
			freshCompletedCount === 1 &&
			freshFailedCount === 0 &&
			deps.readChildRunFinalAssistantMessage
		) {
			const only = completedBranches[0];
			if (
				only &&
				typeof only.delegatedTediId === "string" &&
				typeof only.childRunId === "string"
			) {
				try {
					relayedFinalMessage = await deps.readChildRunFinalAssistantMessage({
						tediId: only.delegatedTediId,
						runId: only.childRunId,
						organizationId,
					});
				} catch (error) {
					console.warn({
						component: "kernel.turn_work",
						event: "wake_final_message_relay_failed",
						error: safeExceptionTopology(error),
					});
				}
			}
		}
		if (relayedFinalMessage) {
			wakeAssistantContent = relayedFinalMessage;
		} else if (freshCompletedCount > 0 && deps.readChildRunFullResult) {
			try {
				// Collect full transcript blocks even when the model is unavailable or
				// times out. The deterministic fallback must still carry branch evidence,
				// not regress to a bare task count after successful child work.
				const completedWithIds = completedBranches.sort((a, b) =>
					a.childRunId.localeCompare(b.childRunId),
				);
				const transcriptBlocks = (
					await Promise.all(
						completedWithIds.map(async (run) => {
							const fullResult = await deps.readChildRunFullResult?.({
								tediId: run.delegatedTediId,
								runId: run.childRunId,
								organizationId,
							});
							return fullResult
								? `=== Worker: ${run.delegatedTediId} (run ${run.childRunId}) ===\n${fullResult}`
								: null;
						}),
					)
				).filter((block): block is string => block !== null);
				wakeAssistantContent = evidenceBackedSynthesisFallback(
					fallbackContent,
					transcriptBlocks,
				);

				const model = kernelModel(
					deps.env as unknown as KernelEnv,
					undefined,
					organizationId,
				);
				if (model && transcriptBlocks.length > 0) {
					const { tracedAi } = await import("../../../lib/traced-ai");
					const workerBlock = transcriptBlocks.join("\n\n");
					const userBlock = originalOperatorRequest
						? `=== Original operator request ===\n${originalOperatorRequest}\n\n${workerBlock}`
						: workerBlock;
					const abortController = new AbortController();
					const timeoutId = setTimeout(() => abortController.abort(), 15_000);
					try {
						const synthResult = await tracedAi.generateText({
							model: model.model,
							system: DELEGATION_SYNTHESIS_SYSTEM_PROMPT,
							runtimeContext: kernelSpanContext({
								organizationId,
								source: "delegation_synthesis",
							}),
							telemetry: { functionId: "kernel.delegation_synthesis" },
							messages: [{ role: "user", content: userBlock }],
							maxOutputTokens: 1200,
							abortSignal: abortController.signal,
						});
						const synthesized = synthResult.text?.trim();
						if (synthesized) {
							// Use the LLM synthesis verbatim — it is the interpreted
							// operator-facing answer over the children's full output.
							wakeAssistantContent = synthesized;
						}
					} finally {
						clearTimeout(timeoutId);
					}
				}
			} catch (error) {
				console.warn({
					component: "kernel.turn_work",
					event: "delegation_synthesis_failed",
					error: safeExceptionTopology(error),
				});
				// wakeAssistantContent already set to fallbackContent above
			}
		}

		const wakeAssistantEvent = await deps.insertKernelRuntimeEvent({
			...(convergedPlanParent
				? {
						id: homeRuntimeEventId({
							organizationId,
							kind: "message.completed",
							conversationId,
							runId: convergedPlanParent,
							suffix: "plan-convergence",
						}),
						messageId: `${convergedPlanParent}:plan-convergence:assistant`,
						runId: convergedPlanParent,
					}
				: { messageId: assistantMessageId, runId }),
			organizationId,
			kind: "message.completed",
			conversationId,
			payload: {
				role: "assistant",
				content: wakeAssistantContent,
				channel: "home",
				metadata: {
					...(convergedPlanParent
						? {
								homePlanConvergence: true,
								parentHomeRunId: convergedPlanParent,
								branchRunIds: synthesisBranches.map(
									(branch) => branch.childRunId,
								),
							}
						: {}),
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
		const deliveredAssistantMessageId =
			wakeAssistantEvent.messageId ?? assistantMessageId;
		if (convergedPlanParent) {
			const parentStatus: TediRunStatus = synthesisBranches.some(
				(branch) => branch.required && branch.status !== "completed",
			)
				? "failed"
				: "completed";
			await transitionKernelRuntimeRunStatus(deps.db, {
				id: convergedPlanParent,
				organizationId,
				fromStatus: "running",
				patch: {
					status: parentStatus,
					outputMessageId: deliveredAssistantMessageId,
					preview: wakeAssistantContent,
					progressValue: 100,
					progressLabel: parentStatus === "completed" ? "Complete" : "Failed",
					progressDetail: `${synthesisBranches.length} coordinated assignments converged`,
					completedAt,
					updatedAt: completedAt,
					metadata: {
						...convergedParentMetadata,
						homePlanConvergencePending: false,
						homePlanSynthesizedAt: wakeAssistantEvent.createdAt,
						homePlanSynthesisMessageId: deliveredAssistantMessageId,
						kernelInboxRunIds: synthesisBranches.map(
							(branch) => branch.childRunId,
						),
						source: "kernelRuntime.homePlanConvergence",
					},
				},
			});
		}
		await deps.insertKernelRuntimeEvent({
			organizationId,
			kind: "run.completed",
			conversationId,
			runId,
			payload: {
				status: "completed",
				approvalRequestId: null,
				inputMessageId: userMessageId,
				outputMessageId: deliveredAssistantMessageId,
				childConversationId: null,
				childRunId: null,
				error: null,
				delegationError: null,
				delegationWorkOrder: null,
				homePlan,
				// Deterministic wake intercept — no route planner ran this turn.
				route: null,
			},
			runtimeMetadata: { ...runtimeMetadata },
			createdAt: completedAt,
		});
		// Exactly-once inline settle — same rationale as the quiet no-op branch:
		// this early return never reaches the shared end-of-turn settle, and an
		// unsettled wake submission stays `running` until the reconcile sweep.
		await settleKernelSubmission(deps.db, {
			runId,
			organizationId,
			conversationId,
			outcome: "settled",
		});
		const wakeRun: HomeRun = {
			id: runId,
			organizationId,
			conversationId,
			status: "completed",
			inputMessageId: userMessageId,
			outputMessageId: deliveredAssistantMessageId,
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
			metadata: wakeMeta,
			progress: wakeProgress,
		};
		return {
			idempotencyKey: runId,
			conversationId,
			status: "needs_delegation" as const,
			run: wakeRun,
			homePlan: undefined,
			assistantMessage: {
				id: deliveredAssistantMessageId,
				organizationId,
				conversationId,
				runId: wakeAssistantEvent.runId ?? runId,
				role: "assistant" as const,
				status: "completed" as const,
				content: wakeAssistantContent,
				runtime: wakeAssistantEvent.runtime,
				createdAt: wakeAssistantEvent.createdAt,
				startedAt: wakeAssistantEvent.createdAt,
				completedAt,
				metadata: wakeAssistantEvent.payload,
			},
			error: undefined,
		};
	}
	return null;
}
