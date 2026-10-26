import { exceptionTopology } from "@tedix/worker-kit/exception-topology";
import { buildTediConversationId } from "@tedix/api-contract/utils/runtime-identity";
import { SessionHarness } from "@tedix/tedi-session/session-harness";
import { deriveIdempotencyKey } from "@tedix/tedi-session/session-repo";
import { type TurnImagePart } from "@tedix/voice/stt";
import { errorMessage } from "@tedix/worker-kit/error-message";
import type { RecentTurn } from "./bridge-turn-input";
import type { ChatTurnParams } from "./chat-turn-input";
import {
	type ComputerCodeBinding,
	ComputerCodeRouting,
} from "./computer-codemode-routing";
import { ComputerEnvironmentController } from "./computer-environment";
import { cleanupComputerWorkflow } from "./computer-workflow-cleanup";
import { retainComputerForNativeExecutions } from "./computer-workflow-continuation";
import {
	computerWorkspaceScope,
	type ComputerWorkspaceScope,
	ScopedComputerWorkspace,
} from "./computer-workspace-scope";
import { summarizeCronTurnTransitions } from "./cron";
import {
	cronSuppressionReason,
	isBudgetExhaustedWorkflowResult,
} from "./cron-budget-control";
import {
	delegatedWorkLeaseTerminalKey,
	type FacetWorkflowTurnInput,
	reconcileWorkflowOnce,
} from "./delegated-work-lease";
import type { AgentTediDO } from "./do";
import type { State } from "./runtime-state";
import { type RecoverableCodemodeRuntimeHandle } from "./durable-codemode-recovery";
import { isTransientWorkflowRedriveError } from "./durable-object-recovery";
import { turnRetryDelaySeconds } from "./facet-turn-admission";
import { DoInferenceBudgetStore } from "./inference-budget-store-do";
import {
	buildRunId,
	buildWorkflowInstanceId,
	type MirrorFailedTurnOpts,
	sanitizeTurnKey,
} from "./ledger-mirror";
import { RuntimeAdmissionDO } from "./runtime-admission-do";
import { isTerminalFailureWorkflowResult } from "./runtime-error-settlement";
import { logTediRuntimeFailure } from "./runtime-failure-log";
import {
	WorkflowImageCleanup,
	type WorkflowImageCleanupAuthority,
	type WorkflowImageCleanupInput,
	type WorkflowImageCleanupObligation,
} from "./workflow-image-cleanup";
import {
	describeWorkflowImages,
	persistWorkflowImages,
	type WorkflowImageRef,
} from "./workflow-image-handoff";
import {
	decideWorkflowStartReconciliation,
	WORKFLOW_START_WATCHDOG_DELAY_SECONDS,
	type WorkflowDispatchContext,
} from "./workflow-start-watchdog";
import {
	armWorkflowTerminalReconciliation,
	decideWorkflowTerminalReconciliation,
	turnFailureNoticeText,
	WORKFLOW_TERMINAL_MAX_REDRIVES,
	WORKFLOW_TERMINAL_RECONCILE_DELAY_SECONDS,
	WORKFLOW_TERMINAL_RECONCILE_MAX_POLLS,
	workflowRetryOwnershipPayload,
} from "./workflow-terminal-reconciliation";
import { type WorkstationProcessCancelInput } from "./workstation";
import { type WorkstationTurnContext } from "./workstation-turn-context";

export interface RuntimeWorkflowHost {
	suppressCronAfterBudgetFailure(
		workflowId: string,
		reason: string,
	): Promise<void>;
	settleWorkflowFailure(
		workflowId: string,
		error: string,
		options?: { assistantText?: string },
	): Promise<void>;
	settleWorkflowSuccess(workflowId: string, result?: unknown): Promise<void>;
	ctx: DurableObjectState<{}>;
	reconcileChatWorkflowTerminal(input: {
		workflowInstanceId: string;
		attempt: number;
		/** The recurring Work lease owns the next observation. */
		renewal?: boolean;
	}): Promise<boolean>;
	broadcast: AgentTediDO["broadcast"];
	broadcastWorkflowFailure(workflowId: string, error: string): void;
	mirrorWorkflowFailure(
		workflowId: string,
		error: string,
		assistantText?: string,
	): Promise<void>;
	clearFanoutSlot(workflowInstanceId: string): Promise<void>;
	stampCronExecution(stamp: {
		phase: "started" | "finished";
		fireKey: string;
		cronName: string;
		runId?: string;
		startedAt: string;
		finishedAt?: string;
		status?: "success" | "failure";
		transitions?: Record<string, unknown>;
		error?: string;
	}): Promise<void>;
	clearWorkflowDispatch(
		workflowInstanceId: string,
		imageCleanup?: "terminal" | "cancelled",
	): Promise<void>;
	workflowTerminalReconciliations: Map<string, Promise<boolean>>;
	reconcileChatWorkflowTerminalInner(input: {
		workflowInstanceId: string;
		attempt: number;
		/** The recurring Work lease owns the next observation. */
		renewal?: boolean;
	}): Promise<boolean>;
	getWorkflowStatus: AgentTediDO["getWorkflowStatus"];
	onWorkflowComplete(
		workflowName: string,
		workflowId: string,
		result?: unknown,
	): Promise<void>;
	redriveTransientWorkflow(
		key: string,
		context: WorkflowDispatchContext,
		workflowInstanceId: string,
		error: string,
	): Promise<void>;
	recordWorkflowRetryOwnership(
		context: WorkflowDispatchContext,
		payload: Record<string, unknown>,
	): Promise<void>;
	schedule: AgentTediDO["schedule"];
	assertChatTurnActive(runId: string | null | undefined): Promise<void>;
	getInferenceBudgetStore(): DoInferenceBudgetStore;
	inferenceBudgetLimits(): {
		dailyMessageLimit: number;
		dailyTokenLimit: number;
		operatorMessageReserve: number;
		operatorTokenReserve: number;
		governedLearningMessageReserve: number;
		governedLearningTokenReserve: number;
	};
	restartWorkflow: AgentTediDO["restartWorkflow"];
	isWorkflowRunCanceled(runId: string): Promise<boolean>;
	computerEnvironment(
		scope: ComputerWorkspaceScope,
		turnContext: WorkstationTurnContext | null,
	): ComputerEnvironmentController;
	cancelWorkstationJobTool(
		input: Omit<WorkstationProcessCancelInput, "processId"> & { jobId: string },
		turnContext?: WorkstationTurnContext | null,
	): Promise<unknown>;
	computerWorkspace(scope: ComputerWorkspaceScope): ScopedComputerWorkspace;
	computerCodeRouting: ComputerCodeRouting;
	getDurableCodemodeRuntime(
		scope: ComputerCodeBinding,
	): Promise<RecoverableCodemodeRuntimeHandle>;
	cleanupChatWorkflowImages(input: {
		workflowInstanceId: string;
		runId: string;
		intent: "terminal" | "cancelled";
		attempt?: number;
	}): Promise<void>;
	workflowImageCleanup: WorkflowImageCleanup | undefined;
	runtimeAdmission(): RuntimeAdmissionDO | null;
	state: State;
	completeRuntimeTurn(
		runId: string,
		sourceId: string,
		receipt: unknown,
	): Promise<void>;
	env: Cloudflare.Env;
	enrollFacetDispatchRun(runId: string): Promise<void>;
	imageCleanupJournal(): WorkflowImageCleanup;
	getMaxConcurrentWorkItems(): Promise<number>;
	liveWorkItemSlots: Map<string, string>;
	acceptRuntimeTurn(
		runId: string,
		sessionKey: string,
		input: unknown,
		reuseAccepted?: boolean,
	): Promise<void>;
	recordWorkflowDispatch(
		workflowInstanceId: string,
		ctx: {
			runId: string;
			traceId?: string;
			sessionKey: string;
			userText: string;
			userTs: number;
			workItemId?: string;
			/** Cron execution-stamp identity for cron-fired turns (see onCronFire). */
			cron?: WorkflowDispatchContext["cron"];
		},
	): Promise<boolean>;
	dispatchAdmittedChatWorkflow(
		binding: "CHAT_TURN_WORKFLOW",
		params: ChatTurnParams & Pick<FacetWorkflowTurnInput, "operatorConsent">,
		options: { id: string; agentBinding: "TEDI_AGENT" },
	): Promise<void>;
	name: string;
	sessionHarness: SessionHarness;
	mirrorFailedTurn(input: {
		sessionKey: string;
		/** Pre-built stable runId (`{tediId}:{surface}:{turnKey}`) for this turn. */
		runId: string;
		/** Cross-layer request trace propagated from the MCP gateway, when present. */
		traceId?: string;
		user: RecentTurn;
		assistant?: RecentTurn;
		error: string;
		/** Recovery-exhaustion context, attached to the `run.failed` payload. */
		recovery?: MirrorFailedTurnOpts["recovery"];
	}): Promise<void>;
	workflowEvent: (
		name: string,
		payload: unknown,
		seq?: number,
	) => { type: "event"; event: string; payload: unknown; seq?: number };
	unknownRecord: (value: unknown) => Record<string, unknown> | null;
	identityValue: (value: string | null | undefined) => string | undefined;
}

export const runtimeWorkflow = {
	async onWorkflowComplete(
		this: RuntimeWorkflowHost,
		workflowName: string,
		workflowId: string,
		result?: unknown,
	): Promise<void> {
		console.log(
			`[isolate.workflow] complete name=${workflowName} id=${workflowId}`,
		);
		const cronSuppression = cronSuppressionReason(result);
		if (cronSuppression) {
			try {
				await this.suppressCronAfterBudgetFailure(workflowId, cronSuppression);
			} catch (error) {
				// Never strand the logical run if the suppression marker cannot be
				// persisted. Atomic provider admission remains the final backstop.
				console.warn(
					"[isolate.cron] failed to persist budget suppression marker",
					{ exception: exceptionTopology(error) },
				);
			}
		}
		if (isBudgetExhaustedWorkflowResult(result)) {
			await this.settleWorkflowFailure(workflowId, result.error);
			return;
		}
		if (isTerminalFailureWorkflowResult(result)) {
			await this.settleWorkflowFailure(workflowId, result.error, {
				assistantText: result.text || undefined,
			});
			return;
		}
		await this.settleWorkflowSuccess(workflowId, result);
	},

	async onWorkflowError(
		this: RuntimeWorkflowHost,
		workflowName: string,
		workflowId: string,
		error: string,
	): Promise<void> {
		console.warn(
			`[isolate.workflow] error name=${workflowName} id=${workflowId}: ${error}`,
		);
		const key = `wfctx:${workflowId}`;
		const dispatchCtx = await this.ctx.storage
			.get<WorkflowDispatchContext>(key)
			.catch(() => undefined);
		if (workflowName === "CHAT_TURN_WORKFLOW" && dispatchCtx) {
			await this.ctx.storage.put<WorkflowDispatchContext>(key, {
				...dispatchCtx,
				latestAttemptError: error,
				errorCallbackCount: (dispatchCtx.errorCallbackCount ?? 0) + 1,
			});
			// The callback is attempt-scoped: after a transient loss the native
			// instance (or the re-drive below) still reruns this turn, so claim the
			// run before the platform orphan sweep fails it in the silent gap.
			if (
				isTransientWorkflowRedriveError(error) &&
				(dispatchCtx.redriveCount ?? 0) < WORKFLOW_TERMINAL_MAX_REDRIVES
			)
				await this.recordWorkflowRetryOwnership(
					dispatchCtx,
					workflowRetryOwnershipPayload({
						operation: "workflow_attempt_retry",
						redriveCount: dispatchCtx.redriveCount ?? 0,
						error,
						now: Date.now(),
					}),
				);
			await this.reconcileChatWorkflowTerminal({
				workflowInstanceId: workflowId,
				attempt: 0,
			});
			return;
		}

		// Preserve the existing behavior for callbacks without Tedix's durable
		// ChatTurnWorkflow dispatch context.
		await this.settleWorkflowFailure(workflowId, error);
	},

	broadcastWorkflowFailure(
		this: RuntimeWorkflowHost,
		workflowId: string,
		error: string,
	): void {
		// Broadcast a turn-level error frame so live clients aren't left hanging.
		try {
			this.broadcast(
				JSON.stringify(
					this.workflowEvent(
						"error",
						{
							stream: "error",
							data: { message: error, workflowId },
						},
						0,
					),
				),
			);
		} catch {
			/* no connections */
		}
	},

	async settleWorkflowFailure(
		this: RuntimeWorkflowHost,
		workflowId: string,
		error: string,
		options?: { assistantText?: string },
	): Promise<void> {
		const context = await this.ctx.storage.get<WorkflowDispatchContext>(
			`wfctx:${workflowId}`,
		);
		if (context?.workItemId)
			await this.ctx.storage.put(delegatedWorkLeaseTerminalKey(context.runId), {
				workflowInstanceId: workflowId,
			});
		this.broadcastWorkflowFailure(workflowId, error);
		// Always leave a visible terminal row; transient redrives return earlier.
		const assistantText =
			options?.assistantText ?? turnFailureNoticeText(error);
		// Seal exhausted workflows now; stable sequencing deduplicates late events.
		await this.mirrorWorkflowFailure(workflowId, error, assistantText);
		await this.clearFanoutSlot(workflowId);
	},

	async settleWorkflowSuccess(
		this: RuntimeWorkflowHost,
		workflowId: string,
		result?: unknown,
	): Promise<void> {
		// Seal the cron execution stamp BEFORE clearing dispatch context, which
		// carries the identity of the exact persisted cron fire.
		const dispatchCtx = await this.ctx.storage
			.get<WorkflowDispatchContext>(`wfctx:${workflowId}`)
			.catch(() => undefined);
		if (dispatchCtx?.workItemId)
			await this.ctx.storage.put(
				delegatedWorkLeaseTerminalKey(dispatchCtx.runId),
				{ workflowInstanceId: workflowId },
			);
		if (dispatchCtx?.cron) {
			await this.stampCronExecution({
				phase: "finished",
				fireKey: dispatchCtx.cron.fireKey,
				cronName: dispatchCtx.cron.name,
				runId: dispatchCtx.runId,
				startedAt: dispatchCtx.cron.startedAtIso,
				finishedAt: new Date().toISOString(),
				status: "success",
				transitions: summarizeCronTurnTransitions(result),
			});
		}
		await this.clearWorkflowDispatch(workflowId, "terminal");
		await this.clearFanoutSlot(workflowId);
	},

	async reconcileChatWorkflowTerminal(
		this: RuntimeWorkflowHost,
		input: {
			workflowInstanceId: string;
			attempt: number;
			/** The recurring Work lease owns the next observation. */
			renewal?: boolean;
		},
	): Promise<boolean> {
		return reconcileWorkflowOnce(
			this.workflowTerminalReconciliations,
			input.workflowInstanceId,
			() => this.reconcileChatWorkflowTerminalInner(input),
		);
	},

	async reconcileChatWorkflowTerminalInner(
		this: RuntimeWorkflowHost,
		input: {
			workflowInstanceId: string;
			attempt: number;
			/** The recurring Work lease owns the next observation. */
			renewal?: boolean;
		},
	): Promise<boolean> {
		const key = `wfctx:${input.workflowInstanceId}`;
		const context = await this.ctx.storage
			.get<WorkflowDispatchContext>(key)
			.catch(() => undefined);
		if (!context) return false;

		let nativeStatus: InstanceStatus | undefined;
		try {
			nativeStatus = await this.getWorkflowStatus(
				"CHAT_TURN_WORKFLOW",
				input.workflowInstanceId,
			);
		} catch (e) {
			console.warn(
				`[isolate.workflow] terminal reconciliation status failed id=${input.workflowInstanceId}`,
				{ exception: exceptionTopology(e) },
			);
		}

		const terminalError =
			nativeStatus?.error?.message ??
			context.latestAttemptError ??
			"workflow failed";
		const decision = decideWorkflowTerminalReconciliation(
			nativeStatus?.status,
			{
				errorIsTransientReset: isTransientWorkflowRedriveError(terminalError),
				redrivesRemaining:
					(context.redriveCount ?? 0) < WORKFLOW_TERMINAL_MAX_REDRIVES,
			},
		);
		if (decision.action === "complete") {
			await this.onWorkflowComplete(
				"CHAT_TURN_WORKFLOW",
				input.workflowInstanceId,
				nativeStatus?.output,
			);
			return true;
		}
		if (decision.action === "redrive") {
			// (b) DEPLOY-WINDOW DO RESETS: a deploy/OOM/storage reset retired the DO
			// mid-step (a cron fired into an active deploy). Re-drive rather than
			// seal `lastSuccess:false` — this is a runtime loss, not a turn failure.
			await this.redriveTransientWorkflow(
				key,
				context,
				input.workflowInstanceId,
				terminalError,
			);
			return false;
		}
		if (decision.action === "fail") {
			await this.settleWorkflowFailure(input.workflowInstanceId, terminalError);
			return true;
		}

		if (input.renewal) return false;
		if (input.attempt >= WORKFLOW_TERMINAL_RECONCILE_MAX_POLLS) {
			console.warn(
				`[isolate.workflow] terminal reconciliation remains nonterminal id=${input.workflowInstanceId} status=${nativeStatus?.status ?? "lookup-failed"}; retaining dispatch context`,
			);
			return false;
		}
		try {
			await this.schedule(
				WORKFLOW_TERMINAL_RECONCILE_DELAY_SECONDS,
				"reconcileChatWorkflowTerminal",
				{
					workflowInstanceId: input.workflowInstanceId,
					attempt: input.attempt + 1,
				},
				{ idempotent: true, retry: { maxAttempts: 3 } },
			);
		} catch (e) {
			// The SDK may deliver another attempt callback, completion still seals
			// success, and the coarse orphan reconciler remains the last safety net.
			// Never turn a local scheduling failure into a false native terminal.
			console.warn(
				`[isolate.workflow] terminal reconciliation schedule failed id=${input.workflowInstanceId}`,
				{ exception: exceptionTopology(e) },
			);
		}
		return false;
	},

	/**
	 * (b) DEPLOY-WINDOW DO RESETS: re-drive a native instance whose TERMINAL error
	 * was a transient runtime loss (deploy code-update reset, isolate OOM, storage
	 * reset) instead of sealing `lastSuccess:false`. Restarting the SAME tracked
	 * instance preserves its stable id + Cloudflare checkpoints; the idempotent
	 * `facet-turn` step re-runs on a fresh isolate and settles exactly-once
	 * (settled fast-path / dedup-keyed writes). Bounded by `redriveCount` so a run
	 * that resets on every attempt still terminalizes rather than looping. A
	 * restart that itself fails falls back to the honest failure seal.
	 */

	async redriveTransientWorkflow(
		this: RuntimeWorkflowHost,
		key: string,
		context: WorkflowDispatchContext,
		workflowInstanceId: string,
		error: string,
	): Promise<void> {
		const nextRedriveCount = (context.redriveCount ?? 0) + 1;
		try {
			await this.assertChatTurnActive(context.runId);
			if (
				!(await this.getInferenceBudgetStore().canRecoverTurn(
					context.runId,
					this.inferenceBudgetLimits(),
				))
			)
				throw new Error("Original workflow accounting remains unresolved");
			const now = Date.now();
			const notBefore =
				context.redriveNotBefore ??
				now + turnRetryDelaySeconds(context.runId) * 1000;
			if (notBefore > now) {
				await this.ctx.storage.put<WorkflowDispatchContext>(key, {
					...context,
					redriveNotBefore: notBefore,
					latestAttemptError: error,
				});
				await this.schedule(
					Math.ceil((notBefore - now) / 1000),
					"reconcileChatWorkflowTerminal",
					{ workflowInstanceId, attempt: 0 },
					{ idempotent: true, retry: { maxAttempts: 3 } },
				);
				return;
			}
			await this.ctx.storage.put<WorkflowDispatchContext>(key, {
				...context,
				redriveCount: nextRedriveCount,
				redriveNotBefore: undefined,
				latestAttemptError: error,
			});
			await this.recordWorkflowRetryOwnership(
				context,
				workflowRetryOwnershipPayload({
					operation: "workflow_redrive",
					redriveCount: nextRedriveCount,
					error,
					now: Date.now(),
				}),
			);
			await this.restartWorkflow(workflowInstanceId, { resetTracking: false });
			console.warn(
				`[isolate.workflow] re-drove transient-reset workflow id=${workflowInstanceId} redrive=${nextRedriveCount}/${WORKFLOW_TERMINAL_MAX_REDRIVES}: ${error}`,
			);
		} catch (e) {
			// A restart that itself fails must not leave the run un-terminalized —
			// seal the honest failure so the kernel/Home sees a fast terminal.
			console.warn(
				`[isolate.workflow] transient-reset re-drive failed id=${workflowInstanceId}`,
				{ exception: exceptionTopology(e) },
			);
			await this.settleWorkflowFailure(workflowInstanceId, error);
			return;
		}
		// Re-arm terminal reconciliation to keep watching the re-driven instance.
		// Its natural onWorkflowComplete/onWorkflowError also settle it; this is
		// the poll safety net, mirroring the defer path's re-arm.
		try {
			await this.schedule(
				WORKFLOW_TERMINAL_RECONCILE_DELAY_SECONDS,
				"reconcileChatWorkflowTerminal",
				{ workflowInstanceId, attempt: 0 },
				{ idempotent: true, retry: { maxAttempts: 3 } },
			);
		} catch (e) {
			console.warn(
				`[isolate.workflow] re-drive reconcile re-arm failed id=${workflowInstanceId}`,
				{ exception: exceptionTopology(e) },
			);
		}
	},

	/** Persist workflow context so terminal callbacks can seal the exact run. */

	async recordWorkflowDispatch(
		this: RuntimeWorkflowHost,
		workflowInstanceId: string,
		ctx: {
			runId: string;
			traceId?: string;
			sessionKey: string;
			userText: string;
			userTs: number;
			workItemId?: string;
			/** Cron execution-stamp identity for cron-fired turns (see onCronFire). */
			cron?: WorkflowDispatchContext["cron"];
		},
	): Promise<boolean> {
		try {
			const key = `wfctx:${workflowInstanceId}`;
			const existing = await this.ctx.storage.get<WorkflowDispatchContext>(key);
			await this.ctx.storage.put<WorkflowDispatchContext>(key, {
				...ctx,
				admittedAt: existing?.admittedAt ?? Date.now(),
				startedAt: existing?.startedAt,
				restartCount: existing?.restartCount ?? 0,
				redriveCount: existing?.redriveCount,
				redriveNotBefore: existing?.redriveNotBefore,
				latestAttemptError: existing?.latestAttemptError,
				errorCallbackCount: existing?.errorCallbackCount,
			});
		} catch (e) {
			logTediRuntimeFailure("tedi.runtime.workflow_dispatch_record_failed", e);
			return false;
		}
		try {
			await this.schedule(
				WORKFLOW_START_WATCHDOG_DELAY_SECONDS,
				"reconcileChatWorkflowStart",
				{ workflowInstanceId, attempt: 0 },
				{ idempotent: true, retry: { maxAttempts: 3 } },
			);
		} catch (e) {
			// Dispatch still proceeds. The kernel's coarse stale-run reconciler remains
			// the final safety net if the local start watchdog could not be armed.
			logTediRuntimeFailure(
				"tedi.runtime.workflow_watchdog_schedule_failed",
				e,
			);
		}
		return true;
	},

	/**
	 * Durable cancel-before-admission fence for delegated chat workflows. A
	 * kernel cancel can reach this DO before the matching async inject has
	 * created its Workflow instance; a missing native instance is not proof of settlement. Keep the abort intent by
	 * stable run id so admission, the first workflow checkpoint, and final
	 * assistant settlement all observe the same winner across request races and
	 * DO restarts. This tombstone is intentionally retained: replaying a canceled
	 * idempotency key must never resurrect the turn.
	 */

	async recordWorkflowCancellation(
		this: RuntimeWorkflowHost,
		runId: string,
	): Promise<void> {
		await this.ctx.storage.put(`wfcancel:${runId}`, {
			runId,
			canceledAt: Date.now(),
		});
	},

	async isWorkflowRunCanceled(
		this: RuntimeWorkflowHost,
		runId: string,
	): Promise<boolean> {
		return Boolean(
			await this.ctx.storage.get(`wfcancel:${runId}`).catch(() => undefined),
		);
	},

	/** Called by ChatTurnWorkflow's first durable checkpoint. */

	async markChatWorkflowStarted(
		this: RuntimeWorkflowHost,
		workflowInstanceId: string,
		runId: string,
	): Promise<boolean> {
		if (await this.isWorkflowRunCanceled(runId)) {
			await this.clearWorkflowDispatch(workflowInstanceId, "cancelled");
			return false;
		}
		const existing = await this.ctx.storage
			.get<WorkflowDispatchContext>(`wfctx:${workflowInstanceId}`)
			.catch(() => undefined);
		if (!existing || existing.runId !== runId || existing.startedAt)
			return true;
		await this.ctx.storage.put<WorkflowDispatchContext>(
			`wfctx:${workflowInstanceId}`,
			{
				...existing,
				startedAt: Date.now(),
			},
		);
		await armWorkflowTerminalReconciliation(
			workflowInstanceId,
			this.schedule.bind(this),
		);
		return true;
	},

	/**
	 * Reconcile the narrow admission gap where runWorkflow() returned an id but
	 * the Workflow never reached its first checkpoint. Restarting the same
	 * tracked instance preserves its stable id and Cloudflare checkpoints; the
	 * bounded counter prevents an infinite poison-run loop.
	 */

	async reconcileChatWorkflowStart(
		this: RuntimeWorkflowHost,
		input: {
			workflowInstanceId: string;
			attempt: number;
		},
	): Promise<void> {
		const key = `wfctx:${input.workflowInstanceId}`;
		const context = await this.ctx.storage
			.get<WorkflowDispatchContext>(key)
			.catch(() => undefined);
		if (!context || context.startedAt) return;

		let status = "unknown";
		try {
			status = (
				await this.getWorkflowStatus(
					"CHAT_TURN_WORKFLOW",
					input.workflowInstanceId,
				)
			).status;
		} catch (e) {
			console.warn(
				`[isolate.workflow] start watchdog status failed id=${input.workflowInstanceId}`,
				{ exception: exceptionTopology(e) },
			);
		}

		const decision = decideWorkflowStartReconciliation({ context, status });
		if (decision.action === "ignore") return;
		if (decision.action === "fail") {
			await this.mirrorWorkflowFailure(
				input.workflowInstanceId,
				decision.reason,
			);
			return;
		}

		await this.ctx.storage.put<WorkflowDispatchContext>(key, {
			...context,
			restartCount: decision.nextRestartCount,
		});
		try {
			await this.assertChatTurnActive(context.runId);
			if (
				!(await this.getInferenceBudgetStore().canRecoverTurn(
					context.runId,
					this.inferenceBudgetLimits(),
				))
			)
				throw new Error("Original workflow accounting remains unresolved");
			await this.restartWorkflow(input.workflowInstanceId, {
				resetTracking: false,
			});
			console.warn(
				`[isolate.workflow] restarted unstarted workflow id=${input.workflowInstanceId} attempt=${decision.nextRestartCount} priorStatus=${status}`,
			);
		} catch (e) {
			console.warn(
				`[isolate.workflow] start watchdog restart failed id=${input.workflowInstanceId}`,
				{ exception: exceptionTopology(e) },
			);
		}
		await this.schedule(
			WORKFLOW_START_WATCHDOG_DELAY_SECONDS * 2 ** decision.nextRestartCount,
			"reconcileChatWorkflowStart",
			{
				workflowInstanceId: input.workflowInstanceId,
				attempt: decision.nextRestartCount,
			},
			{ idempotent: true, retry: { maxAttempts: 3 } },
		);
	},

	async clearWorkflowDispatch(
		this: RuntimeWorkflowHost,
		workflowInstanceId: string,
		imageCleanup?: "terminal" | "cancelled",
	): Promise<void> {
		const context = await this.ctx.storage.get<WorkflowDispatchContext>(
			`wfctx:${workflowInstanceId}`,
		);
		await cleanupComputerWorkflow(this.ctx.storage, workflowInstanceId, {
			scope: computerWorkspaceScope,
			computer: (scope) => this.computerEnvironment(scope, null),
			hasActiveCode: async (scope, environment) => {
				if (
					context?.workItemId &&
					(await retainComputerForNativeExecutions(
						this.ctx.storage,
						{
							workItemId: context.workItemId,
							runId: context.runId,
							leaseId: environment.leaseId,
						},
						{
							canceled: await this.isWorkflowRunCanceled(context.runId),
							cancel: async (record) =>
								this.unknownRecord(
									await this.cancelWorkstationJobTool(
										{ ...record.environment, jobId: record.executionId },
										null,
									),
								) ?? {},
						},
					))
				)
					return true;
				const id = `${this.computerWorkspace(scope).id}:${environment.leaseId}`;
				if (!(await this.computerCodeRouting.isRegistered(id))) return false;
				const runtime = await this.getDurableCodemodeRuntime({
					...scope,
					environment,
				});
				return (await runtime.executions()).some(
					(e) => e.status === "running" || e.status === "paused",
				);
			},
			defer: () =>
				this.schedule(
					60,
					"reconcileChatWorkflowTerminal",
					{ workflowInstanceId, attempt: 0 },
					{ idempotent: false, retry: { maxAttempts: 3 } },
				),
		});
		if (
			imageCleanup &&
			context &&
			!(await this.ctx.storage.get(`wfctx:${workflowInstanceId}`))
		) {
			await this.cleanupChatWorkflowImages({
				workflowInstanceId,
				runId: context.runId,
				intent: imageCleanup,
			});
		}
	},

	imageCleanupJournal(this: RuntimeWorkflowHost): WorkflowImageCleanup {
		if (this.workflowImageCleanup) return this.workflowImageCleanup;
		const admission = () => {
			const current = this.runtimeAdmission();
			if (!current)
				throw new Error("Workflow image cleanup requires admitted custody");
			return current;
		};
		const assertOriginal = async (
			authority: WorkflowImageCleanupAuthority,
			input: WorkflowImageCleanupInput,
		) => {
			if (
				input.tediId !== this.state.tediId ||
				input.orgId !== this.state.orgId ||
				authority.runId !==
					`workflow-image-cleanup:${encodeURIComponent(input.runId)}`
			)
				throw new Error("Workflow image cleanup owner changed");
			const accepted = await admission().assertOriginalClaim({
				runId: authority.runId,
				sessionKey: input.sessionKey,
				input,
			});
			if (
				accepted.requestHash !== authority.requestHash ||
				accepted.generation !== authority.generation
			)
				throw new Error("Workflow image cleanup original authority changed");
		};
		this.workflowImageCleanup = new WorkflowImageCleanup({
			storage: this.ctx.storage,
			owner: () => ({ tediId: this.state.tediId, orgId: this.state.orgId }),
			admitCleanup: async (input) => {
				const gate = admission();
				const original = await gate.assertAcceptedTurn({
					runId: input.runId,
					sessionKey: input.sessionKey,
				});
				if (
					original.owner.tediId !== input.tediId ||
					original.owner.orgId !== input.orgId
				)
					throw new Error("Workflow image cleanup original owner changed");
				const runId = `workflow-image-cleanup:${encodeURIComponent(input.runId)}`;
				const { accepted } = await gate.beginAcceptedTurn({
					runId,
					sessionKey: input.sessionKey,
					principalId: original.principalId,
					input,
					expectedGeneration: original.generation,
				});
				const rechecked = await gate.assertAcceptedTurn({
					runId: input.runId,
					sessionKey: input.sessionKey,
					inputHash: original.inputHash,
					principalId: original.principalId,
				});
				if (
					rechecked.requestHash !== original.requestHash ||
					rechecked.generation !== original.generation
				)
					throw new Error("Workflow image original accepted authority changed");
				return {
					runId,
					generation: accepted.generation,
					requestHash: accepted.requestHash,
				};
			},
			assertCleanupOriginal: assertOriginal,
			assertCleanupActive: async (authority, input) => {
				await assertOriginal(authority, input);
				const accepted = await admission().assertAcceptedTurn({
					runId: authority.runId,
					sessionKey: input.sessionKey,
					input,
				});
				const journalKey = `workflow-image-cleanup:${input.runId}`;
				const hadJournal = !!this.ctx.storage.kv.get(journalKey);
				return () => {
					const current =
						this.ctx.storage.kv.get<WorkflowImageCleanupObligation>(journalKey);
					if (hadJournal && !current)
						throw new Error("Workflow image cleanup journal missing");
					if (current) {
						const {
							authority: savedAuthority,
							dispatchRequested: _dispatch,
							terminalIntent: _terminal,
							page: _page,
							completed: _completed,
							...savedInput
						} = current;
						if (
							current.completed ||
							JSON.stringify(savedInput) !== JSON.stringify(input) ||
							JSON.stringify(savedAuthority) !== JSON.stringify(authority)
						)
							throw new Error("Workflow image cleanup journal changed");
					}
					if (
						input.tediId !== this.state.tediId ||
						input.orgId !== this.state.orgId
					)
						throw new Error("Workflow image cleanup owner changed");
					admission().assertAcceptedTurnSync({
						runId: authority.runId,
						expected: accepted,
					});
				};
			},
			completeCleanup: async (authority, input, receipt) => {
				await assertOriginal(authority, input);
				const row = await this.ctx.storage.get<WorkflowImageCleanupObligation>(
					`workflow-image-cleanup:${input.runId}`,
				);
				if (
					!row ||
					JSON.stringify({
						kind: row.kind,
						tediId: row.tediId,
						orgId: row.orgId,
						runId: row.runId,
						workflowInstanceId: row.workflowInstanceId,
						sessionKey: row.sessionKey,
						refs: row.refs,
						intent: row.intent,
					}) !== JSON.stringify(input) ||
					JSON.stringify(row.authority) !== JSON.stringify(authority) ||
					row.page?.stage !== "acknowledged" ||
					row.page.truncated ||
					JSON.stringify({
						keys: row.page.keys,
						cursor: row.page.cursor,
						nextCursor: row.page.nextCursor,
						truncated: row.page.truncated,
					}) !== JSON.stringify(receipt)
				)
					throw new Error(
						"Workflow image cleanup final acknowledgment unavailable",
					);
				await this.completeRuntimeTurn(authority.runId, authority.runId, {
					input,
					receipt,
				});
			},
			bucket: () => this.env.TEDI_STORAGE,
			nativeStatus: async (id) =>
				(await (await this.env.CHAT_TURN_WORKFLOW.get(id)).status()).status,
			canceled: (runId) => this.isWorkflowRunCanceled(runId),
			scheduleRetry: async (input) => {
				const row = await this.ctx.storage.get<WorkflowImageCleanupObligation>(
					`workflow-image-cleanup:${input.runId}`,
				);
				if (!row || row.workflowInstanceId !== input.workflowInstanceId)
					throw new Error(
						"Workflow image cleanup retry lacks original authority",
					);
				const {
					authority,
					dispatchRequested: _dispatch,
					terminalIntent: _intent,
					page: _page,
					completed: _completed,
					...originalInput
				} = row;
				await assertOriginal(authority, originalInput);
				await admission().assertAcceptedTurn({
					runId: authority.runId,
					sessionKey: row.sessionKey,
					input: originalInput,
				});
				return this.schedule(60, "cleanupChatWorkflowImages", input, {
					retry: { maxAttempts: 3 },
				});
			},
		});
		return this.workflowImageCleanup;
	},

	/** Native conversation images outlive one model round so transcript replay can resolve the same bytes. */

	async prepareNativeConversationImages(
		this: RuntimeWorkflowHost,
		input: {
			runId: string;
			operationId: string;
			sessionKey: string;
			images: TurnImagePart[];
		},
	): Promise<WorkflowImageRef[]> {
		await this.assertChatTurnActive(input.runId);
		const admission = this.runtimeAdmission();
		if (!admission)
			throw new Error("Native image upload requires admitted custody");
		const original = await admission.assertAcceptedTurn({
			runId: input.runId,
			sessionKey: input.sessionKey,
		});

		if (!this.state.tediId || !this.state.orgId)
			throw new Error(
				"Native image ownership requires authenticated tedi and organization",
			);
		const refs = await describeWorkflowImages(
			this.state.tediId,
			input.runId,
			input.images,
		);
		await this.enrollFacetDispatchRun(input.runId);
		if (
			this.state.tediId !== original.owner.tediId ||
			this.state.orgId !== original.owner.orgId
		)
			throw new Error("Native image original owner changed");
		admission.assertAcceptedTurnSync({
			runId: input.runId,
			expected: original,
		});
		const owner = {
			tediId: this.state.tediId,
			orgId: this.state.orgId,
			runId: input.runId,
			operationId: input.operationId,
			sessionKey: input.sessionKey,
			refs,
		};
		const key = `pi-native-image-owner:${encodeURIComponent(input.runId)}`;
		this.ctx.storage.transactionSync(() => {
			const prior = this.ctx.storage.kv.get<typeof owner>(key);
			if (prior && JSON.stringify(prior) !== JSON.stringify(owner))
				throw new Error(
					"Native image operation changed immutable ownership or descriptors",
				);
			if (!prior) this.ctx.storage.kv.put(key, owner);
		});
		await this.assertChatTurnActive(input.runId);
		const persisted = await persistWorkflowImages(
			this.env.TEDI_STORAGE,
			this.state.tediId,
			input.runId,
			input.images,
			async () => {
				await this.assertChatTurnActive(input.runId);
				const current = await admission.assertAcceptedTurn({
					runId: input.runId,
					sessionKey: input.sessionKey,
					inputHash: original.inputHash,
					principalId: original.principalId,
				});
				if (
					current.requestHash !== original.requestHash ||
					current.generation !== original.generation
				)
					throw new Error("Native image accepted authority changed");
				return () => {
					const stored = this.ctx.storage.kv.get(key);
					if (
						JSON.stringify(stored) !== JSON.stringify(owner) ||
						this.state.tediId !== owner.tediId ||
						this.state.orgId !== owner.orgId
					)
						throw new Error("Native image ownership changed");
					if (this.ctx.storage.kv.get(`wfcancel:${input.runId}`))
						throw new Error(
							`Chat inference denied for canceled or stopped run: ${input.runId}`,
						);
					// No await after the final physical-owner and current-generation checks.
					admission.assertAcceptedTurnSync({
						runId: input.runId,
						expected: original,
					});
				};
			},
		);
		if (JSON.stringify(persisted) !== JSON.stringify(refs))
			throw new Error(
				"Native image manifest differs from admitted descriptors",
			);
		return refs;
	},

	/** Durable ownership/descriptors precede every private write; bytes stay outside DO state. */

	async prepareWorkflowImages(
		this: RuntimeWorkflowHost,
		runId: string,
		workflowInstanceId: string,
		images: TurnImagePart[],
		sessionKey: string,
	): Promise<WorkflowImageRef[]> {
		if (!images.length) {
			await this.imageCleanupJournal().claim(
				runId,
				workflowInstanceId,
				[],
				sessionKey,
			);
			return [];
		}
		await this.assertChatTurnActive(runId);
		const admission = this.runtimeAdmission();
		if (!admission)
			throw new Error("Workflow image upload requires admitted custody");
		const original = await admission.assertAcceptedTurn({ runId, sessionKey });
		const refs = await describeWorkflowImages(this.state.tediId, runId, images);
		try {
			await this.imageCleanupJournal().claim(
				runId,
				workflowInstanceId,
				refs,
				sessionKey,
			);
		} catch (error) {
			if (error instanceof Error && error.message === "workflow_image_conflict")
				throw error;
			throw new Error(
				`Cannot dispatch tedi run ${runId}: durable context unavailable`,
				{ cause: error },
			);
		}
		return persistWorkflowImages(
			this.env.TEDI_STORAGE,
			this.state.tediId,
			runId,
			images,
			async () => {
				const assertUpload =
					await this.imageCleanupJournal().assertUploadReady(runId);
				const current = await admission.assertAcceptedTurn({
					runId,
					sessionKey,
					inputHash: original.inputHash,
					principalId: original.principalId,
				});
				if (
					current.requestHash !== original.requestHash ||
					current.generation !== original.generation
				)
					throw new Error("Workflow image original upload authority changed");
				return () => {
					assertUpload();
					const row = this.ctx.storage.kv.get<WorkflowImageCleanupObligation>(
						`workflow-image-cleanup:${runId}`,
					);
					if (
						!row ||
						row.page ||
						row.completed ||
						row.tediId !== this.state.tediId ||
						row.orgId !== this.state.orgId ||
						row.runId !== runId ||
						row.workflowInstanceId !== workflowInstanceId ||
						row.sessionKey !== sessionKey ||
						JSON.stringify(row.refs) !== JSON.stringify(refs) ||
						row.authority.runId !==
							`workflow-image-cleanup:${encodeURIComponent(runId)}`
					)
						throw new Error("Workflow image upload ownership changed");
					// Cancellation stops new writes, while cleanup retains its independent delete authority.
					if (this.ctx.storage.kv.get(`wfcancel:${runId}`))
						throw new Error(
							`Chat inference denied for canceled or stopped run: ${runId}`,
						);
					admission.assertAcceptedTurnSync({ runId, expected: original });
					const cleanup = admission.assertAcceptedTurnSync({
						runId: row.authority.runId,
					});
					if (
						cleanup.requestHash !== row.authority.requestHash ||
						cleanup.generation !== row.authority.generation ||
						cleanup.sessionKey !== sessionKey ||
						cleanup.owner.tediId !== row.tediId ||
						cleanup.owner.orgId !== row.orgId
					)
						throw new Error("Workflow image cleanup upload authority changed");
				};
			},
		);
	},

	/** Existing scheduled deliveries remain valid; failed cleanup stays journaled for maintenance. */

	async cleanupChatWorkflowImages(
		this: RuntimeWorkflowHost,
		input: {
			workflowInstanceId: string;
			runId: string;
			intent: "terminal" | "cancelled";
			attempt?: number;
		},
	): Promise<void> {
		await this.imageCleanupJournal().terminal(input);
	},

	/** Dispatch independent work through its own durable workflow and budget slot. */

	async dispatchIndependentWorkItem(
		this: RuntimeWorkflowHost,
		item: {
			/** Caller-generated stable id — THE idempotency key; unique per item. */
			clientRequestId: string;
			userText: string;
			parentRunId: string;
			parentConversationId: string;
			/** Must be true to fan out; false/absent falls through to serial path. */
			independent?: boolean;
			/** Human-readable label for the assignment record (CLI panel). */
			objective?: string;
		},
	): Promise<{
		dispatched: boolean;
		childRunId?: string;
		sessionKey?: string;
	}> {
		// Coherent (non-independent) item → byte-identical serial fallback.
		if (!item.independent) {
			return { dispatched: false };
		}

		const tediId = this.identityValue(this.state.tediId);
		if (!tediId) return { dispatched: false };

		// childRunId is the idempotency key — same clientRequestId → same id, so a
		// retried dispatch dedups on the session/ledger tables.
		const childRunId = buildRunId(tediId, item.clientRequestId, "fanout");
		// Each item gets its own sessionKey so it writes its own session entry.
		// Collision-safe across distinct sessionKeys: session (session_key,
		// idempotency_key) is UNIQUE + INSERT OR IGNORE.
		const sessionKey = `fanout:${sanitizeTurnKey(item.clientRequestId)}`;
		const conversationId = buildTediConversationId({
			tediRef: this.state.slug || tediId,
			sessionKey,
		});

		// Budget check: over-budget → fail-soft (caller falls through to serial).
		const maxSlots = await this.getMaxConcurrentWorkItems();
		if (this.liveWorkItemSlots.size >= maxSlots) {
			console.warn(
				`[isolate.fanout] budget exceeded (${this.liveWorkItemSlots.size}/${maxSlots}), ` +
					`falling back to serial for clientRequestId=${item.clientRequestId}`,
			);
			return { dispatched: false };
		}

		// Cloudflare Workflow instance ids reject colons/punctuation — derive a
		// deterministic safe id (same input → same id keeps redelivery idempotent),
		// identical to the async-inject dispatch path.
		const workflowInstanceId = buildWorkflowInstanceId(item.clientRequestId);

		await this.acceptRuntimeTurn(childRunId, sessionKey, {
			kind: "fanout",
			item,
		});
		const userTs = Date.now();

		// HomePlanAssignment-shaped slot (matches HomePlanAssignmentSchema) so the
		// existing reconcile + child-tree + CLI live-panel read it with no new code.
		const assignmentRecord = {
			id: `${item.parentRunId}:fanout:${childRunId}`,
			ownerTediId: tediId,
			ownerSlug: this.state.slug ?? null,
			ownerLabel: item.objective ?? item.userText.slice(0, 80),
			routeKind: "agent" as const,
			objective: item.objective ?? item.userText.slice(0, 200),
			expectedEvidence: [] as string[],
			risk: "low" as const,
			confidence: 1,
			requiresApproval: false,
			status: "queued" as const,
			childRunId,
			childConversationId: conversationId,
			dispatchedAt: new Date(userTs).toISOString(),
		};
		try {
			await this.ctx.storage.put(`fanoutslot:${childRunId}`, assignmentRecord);
			await this.recordWorkflowDispatch(workflowInstanceId, {
				runId: childRunId,
				sessionKey,
				userText: item.userText,
				userTs,
			});
		} catch (e) {
			console.warn("[isolate.fanout] storage write failed:", {
				error: errorMessage(e),
			});
			return { dispatched: false };
		}

		// Register the in-memory budget slot BEFORE dispatch so a concurrent fanout
		// call on the same single-threaded DO sees it immediately.
		this.liveWorkItemSlots.set(childRunId, workflowInstanceId);

		try {
			await this.dispatchAdmittedChatWorkflow(
				"CHAT_TURN_WORKFLOW",
				{
					agentName: this.name,
					sessionKey,
					userText: item.userText,
					userTs,
					conversationId,
					runId: childRunId,
					clientRequestId: item.clientRequestId,
				},
				// Same explicit binding the async-inject dispatch uses — the binding
				// can't be auto-detected from the class name in this dispatch context.
				{ id: workflowInstanceId, agentBinding: "TEDI_AGENT" },
			);
		} catch (e) {
			// Dispatch failed — clean up both storage records and the budget entry so
			// no half-registered slot leaks. Caller falls through to serial enqueue.
			this.liveWorkItemSlots.delete(childRunId);
			await this.clearWorkflowDispatch(workflowInstanceId);
			await this.ctx.storage.delete(`fanoutslot:${childRunId}`).catch(() => {});
			console.warn(
				"[isolate.fanout] workflow dispatch failed, falling back to serial:",
				e instanceof Error ? e.message : e,
			);
			return { dispatched: false };
		}

		return { dispatched: true, childRunId, sessionKey };
	},

	/** Release the terminal workflow from its fan-out budget slot. */

	async clearFanoutSlot(
		this: RuntimeWorkflowHost,
		workflowInstanceId: string,
	): Promise<void> {
		for (const [childRunId, wfId] of this.liveWorkItemSlots) {
			if (wfId === workflowInstanceId) {
				this.liveWorkItemSlots.delete(childRunId);
				await this.ctx.storage
					.delete(`fanoutslot:${childRunId}`)
					.catch(() => {});
				break;
			}
		}
	},

	async mirrorWorkflowFailure(
		this: RuntimeWorkflowHost,
		workflowId: string,
		error: string,
		assistantText?: string,
	): Promise<void> {
		const ctx = await this.ctx.storage
			.get<WorkflowDispatchContext>(`wfctx:${workflowId}`)
			.catch(() => undefined);
		if (!ctx) return;
		const visibleAssistantText = assistantText?.trim();
		const assistant = visibleAssistantText
			? {
					role: "assistant" as const,
					content: visibleAssistantText,
					sessionKey: ctx.sessionKey,
					ts: Date.now(),
				}
			: undefined;
		if (!assistant) {
			// Preserve the existing terminal-without-commit signal: synchronous
			// run_tedi_turn waiters may stop as soon as the native failure settles.
			await this.clearWorkflowDispatch(workflowId, "terminal");
		}
		try {
			if (assistant) {
				await this.sessionHarness.appendTurn(
					ctx.sessionKey,
					assistant,
					deriveIdempotencyKey(ctx.runId, "assistant"),
				);
			}
			if (ctx.cron) {
				await this.stampCronExecution({
					phase: "finished",
					fireKey: ctx.cron.fireKey,
					cronName: ctx.cron.name,
					runId: ctx.runId,
					startedAt: ctx.cron.startedAtIso,
					finishedAt: new Date().toISOString(),
					status: "failure",
					error,
				});
			}
			await this.mirrorFailedTurn({
				sessionKey: ctx.sessionKey,
				runId: ctx.runId,
				traceId: ctx.traceId,
				user: {
					role: "user" as const,
					content: ctx.userText,
					sessionKey: ctx.sessionKey,
					ts: ctx.userTs,
				},
				...(assistant ? { assistant } : {}),
				error: `workflow errored before terminal: ${error}`,
			});
		} catch (err) {
			logTediRuntimeFailure(
				"tedi.runtime.workflow_terminal_mirror_failed",
				err,
			);
		} finally {
			// Keep the dispatch record present until any user-visible fallback is
			// committed. The synchronous run_tedi_turn waiter treats record removal
			// as terminal and would otherwise race past the assistant row.
			if (assistant) await this.clearWorkflowDispatch(workflowId, "terminal");
		}
	},
};
