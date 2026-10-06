import type {
	RejectedFacetDispatch,
	ReturnedFacetDispatch,
} from "./facet-dispatch-journal";
import type { ReconciledComputerAcquisition } from "./computer-acquisition";
import type { UIMessage } from "ai";

import { estimateInferenceTokens } from "./inference-guardrails";
import { emptyFacetTurnUsage, type FacetTurnUsage } from "./step-telemetry";

export interface PiProviderAttempt {
	readonly runId: string;
	readonly attemptId: string;
}

export interface PiStepReservation {
	runId: string;
	stepId: string;
	estimatedTokens: number;
}

export interface PiStepReceipt {
	runId: string;
	stepId: string;
	actualTokens: number | null;
}

export interface ReconciledComputerEffect {
	executionId: string;
	terminal: boolean;
	running?: boolean;
	exitCode: number | null;
	canceled?: boolean;
	timedOut?: boolean;
}
export type ReconciledEffect =
	| ReconciledComputerEffect
	| ReconciledComputerAcquisition
	| RejectedFacetDispatch
	| ReturnedFacetDispatch;
export interface PiAccountingAuthority {
	reconcileEffect?(
		runId: string,
		toolCallId: string,
	): Promise<ReconciledEffect | null>;
	assertActive(runId: string): Promise<void>;
	reserveStep(input: PiStepReservation): Promise<unknown>;
	recordStep(input: PiStepReceipt): Promise<unknown>;
}

interface Attempt {
	id: string;
	estimatedTokens: number;
	phase: "prepared" | "started" | "completed" | "unknown";
	usage: FacetTurnUsage | null;
	acknowledged: boolean;
	effectsStarted: boolean;
	effectIds?: string[];
	effectTools?: Record<string, string>;
	effectsSealed?: boolean;
	/** Provider-generated call identities retained before Pi enters its tool phase. */
	generatedToolCallIds?: string[];
}

export interface PiAccountingCheckpoint {
	version: 1;
	runId: string;
	attempts: Attempt[];
	fault: string | null;
	receiptFault?: boolean;
	recoveredEffects?: Array<ReconciledEffect & { toolCallId: string }>;
}

export interface PiAccountingPolicy {
	/** Durable provider-call ceiling; absent means no step-count stop. */
	maxSteps?: number;
}

type JournalStorage = Pick<DurableObjectStorage, "get" | "put">;

// These tools observe state without changing it; repeating a read after a reset
// needs no mutation receipt. Keep unknown tools and repository replacement fenced.
const REPLAY_SAFE_TOOL_NAMES = new Set([
	"artifact_list_files",
	"artifact_read_file",
	"ls",
	"find",
	"grep",
	"code_search",
	"deliverable_read_artifact",
	"read",
	"read_execution",
	"read_skill",
	"repo_load",
]);

export function isReplaySafeRecoveryTool(toolName: string): boolean {
	return REPLAY_SAFE_TOOL_NAMES.has(toolName);
}

/** Accounting/policy errors must not trip the model provider circuit breaker. */
export class PiAccountingError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "PiAccountingError";
	}
}

/** Run-scoped accounting outbox. Persist reservations before native provider
 * dispatch and usage before parent acknowledgement. Faults survive instance resets.
 */
export class PiTurnAccounting {
	private fault: Error | null = null;
	private activeAttempt: string | null = null;
	private runId: string | null = null;
	private toolFence: Promise<void> = Promise.resolve();
	private receiptFence: Promise<void> = Promise.resolve();

	constructor(
		private readonly storage: JournalStorage,
		private readonly authority: PiAccountingAuthority,
	) {}

	hasFault(): boolean {
		return this.fault !== null;
	}

	private key(runId: string): string {
		return `pi-accounting:${runId}`;
	}

	async inspect(runId: string): Promise<PiAccountingCheckpoint> {
		if (await this.storage.get(`think-accounting:${runId}`))
			throw new PiAccountingError(
				"Original accounting requires explicit state cutover",
			);
		const stored = await this.storage.get<PiAccountingCheckpoint>(
			this.key(runId),
		);
		if (
			stored &&
			(stored.version !== 1 ||
				stored.runId !== runId ||
				!Array.isArray(stored.attempts) ||
				(stored.fault !== null && typeof stored.fault !== "string") ||
				(stored.receiptFault !== undefined &&
					typeof stored.receiptFault !== "boolean") ||
				stored.attempts.some(
					(attempt) =>
						!attempt ||
						typeof attempt.id !== "string" ||
						!attempt.id ||
						!Number.isSafeInteger(attempt.estimatedTokens) ||
						attempt.estimatedTokens <= 0 ||
						!["prepared", "started", "completed", "unknown"].includes(
							attempt.phase,
						) ||
						typeof attempt.acknowledged !== "boolean" ||
						typeof attempt.effectsStarted !== "boolean" ||
						(attempt.effectsSealed !== undefined &&
							typeof attempt.effectsSealed !== "boolean") ||
						(attempt.effectIds !== undefined &&
							(!Array.isArray(attempt.effectIds) ||
								attempt.effectIds.some(
									(id) => typeof id !== "string" || !id,
								))) ||
						(attempt.phase === "completed"
							? !attempt.usage ||
								(["inputTokens", "outputTokens", "totalTokens"] as const)
									.map((field) => attempt.usage![field])
									.some(
										(value) =>
											value !== null &&
											(!Number.isSafeInteger(value) || value < 0),
									)
							: attempt.usage !== null),
				) ||
				new Set(stored.attempts.map((attempt) => attempt.id)).size !==
					stored.attempts.length)
		) {
			throw new Error("Invalid durable Pi accounting checkpoint");
		}
		return stored ?? { version: 1, runId, attempts: [], fault: null };
	}

	/** Enrollment is anchored to this run's history, not the currently bound conversation. */
	async enrollDispatch(
		runId: string,
		enroll: () => Promise<void>,
	): Promise<void> {
		const checkpoint = await this.inspect(runId);
		if (checkpoint.attempts.length !== 0) return;
		if (checkpoint.fault) throw new PiAccountingError(checkpoint.fault);
		if (this.runId === runId && this.fault) throw this.fault;
		await enroll();
	}

	private async save(checkpoint: PiAccountingCheckpoint): Promise<void> {
		await this.storage.put(this.key(checkpoint.runId), checkpoint);
	}

	private assertHealthy(checkpoint: PiAccountingCheckpoint): void {
		if (this.fault) throw this.fault;
		if (checkpoint.fault) throw new PiAccountingError(checkpoint.fault);
	}

	private async fail(
		runId: string,
		cause: unknown,
		receiptFault = false,
	): Promise<never> {
		const error =
			cause instanceof PiAccountingError ? cause : new PiAccountingError(cause);
		if (this.runId === runId) this.fault = error;
		try {
			const checkpoint = await this.inspect(runId);
			if (
				error.message ===
				"Interrupted tool effects require reconciliation before recovery"
			)
				console.error("[pi-accounting] interrupted effects fenced", {
					runId,
					attempts: checkpoint.attempts
						.filter(
							(attempt) => attempt.effectsStarted && !attempt.effectsSealed,
						)
						.map((attempt) => ({
							id: attempt.id,
							phase: attempt.phase,
							effectIds: attempt.effectIds,
							effectTools: attempt.effectTools,
						})),
				});
			checkpoint.receiptFault =
				receiptFault ||
				(checkpoint.fault === error.message &&
					checkpoint.receiptFault === true);
			checkpoint.fault = error.message;
			await this.save(checkpoint);
		} catch {
			// In-memory fence still prevents another call. A persisted started
			// attempt retains its reservation if storage itself is unavailable.
		}
		throw error;
	}

	async block(cause: unknown): Promise<never> {
		if (!this.runId) throw new PiAccountingError(cause);
		return this.fail(this.runId, cause);
	}

	/** Bind each native Pi invocation, including retry and continuation. */
	async begin(runId: string | null | undefined): Promise<void> {
		if (!runId?.trim())
			throw new Error("Pi accounting requires a run identity");
		if (this.runId !== runId) this.fault = null;
		this.runId = runId;
		this.activeAttempt = null;
		try {
			const checkpoint = await this.inspect(runId);
			this.assertHealthy(checkpoint);
			await this.authority.assertActive(runId);
			await this.flush(checkpoint);
		} catch (error) {
			return this.fail(runId, error);
		}
	}

	private async flush(checkpoint: PiAccountingCheckpoint): Promise<void> {
		for (const attempt of checkpoint.attempts) {
			if (
				(attempt.phase !== "completed" && attempt.phase !== "unknown") ||
				attempt.acknowledged
			)
				continue;
			await this.authority.recordStep({
				runId: checkpoint.runId,
				stepId: attempt.id,
				actualTokens: attempt.usage?.totalTokens ?? null,
			});
			attempt.acknowledged = true;
			await this.save(checkpoint);
		}
	}

	/** Reserve the next provider dispatch before native Pi enters inference. */
	async prepareStep(
		ctx: { messages: readonly unknown[]; estimatedTokens?: number },
		policy: PiAccountingPolicy,
	): Promise<number> {
		const runId = this.runId;
		if (!runId) throw new Error("Pi accounting invocation was not initialized");
		try {
			if (
				policy.maxSteps !== undefined &&
				(!Number.isSafeInteger(policy.maxSteps) || policy.maxSteps < 1)
			)
				throw new Error("Invalid durable inference policy");
			if (
				ctx.estimatedTokens !== undefined &&
				(!Number.isSafeInteger(ctx.estimatedTokens) || ctx.estimatedTokens < 1)
			)
				throw new Error("Invalid inference token estimate");
			const checkpoint = await this.inspect(runId);
			this.assertHealthy(checkpoint);
			await this.authority.assertActive(runId);
			await this.flush(checkpoint);
			for (const attempt of checkpoint.attempts) {
				if (attempt.phase !== "started") continue;
				if (attempt.effectsStarted && !attempt.effectsSealed)
					throw new Error(
						"Interrupted tool effects require reconciliation before recovery",
					);
				// A reset lost the provider receipt. Keep its reservation, distinct
				// from measured usage, before admitting a separately charged retry.
				attempt.phase = "unknown";
			}
			await this.save(checkpoint);
			await this.flush(checkpoint);
			const prepared = checkpoint.attempts.find(
				(attempt) => attempt.phase === "prepared",
			);
			const started = checkpoint.attempts.filter(
				(attempt) => attempt.phase !== "prepared",
			).length;
			if (policy.maxSteps !== undefined && started >= policy.maxSteps)
				throw new Error("Durable provider-call ceiling reached");
			const attempt: Attempt = prepared ?? {
				id: crypto.randomUUID(),
				estimatedTokens:
					ctx.estimatedTokens ?? estimateInferenceTokens(ctx.messages),
				phase: "prepared",
				usage: null,
				acknowledged: false,
				effectsStarted: false,
			};
			if (!prepared) checkpoint.attempts.push(attempt);
			await this.save(checkpoint);
			await this.authority.reserveStep({
				runId,
				stepId: attempt.id,
				estimatedTokens: attempt.estimatedTokens,
			});
			// Cancellation can arrive during reservation RPC.
			await this.authority.assertActive(runId);
			attempt.phase = "started";
			await this.save(checkpoint);
			this.activeAttempt = attempt.id;
			return started;
		} catch (error) {
			return this.fail(runId, error);
		}
	}

	/** A reset during a tool effect cannot silently re-execute that effect. */
	async beforeToolCall(toolCallId?: string, toolName?: string): Promise<void> {
		if (!this.activeAttempt && toolCallId)
			await this.restoreAttemptForTool(toolCallId);
		if (toolName && isReplaySafeRecoveryTool(toolName)) {
			const checkpoint = await this.current();
			this.assertHealthy(checkpoint);
			await this.authority.assertActive(checkpoint.runId);
			return;
		}
		const operation = this.toolFence.then(() =>
			this.persistToolFence(toolCallId, toolName),
		);
		this.toolFence = operation.catch(() => {});
		return operation;
	}

	private async persistToolFence(
		toolCallId?: string,
		toolName?: string,
	): Promise<void> {
		try {
			const checkpoint = await this.current();
			this.assertHealthy(checkpoint);
			await this.authority.assertActive(checkpoint.runId);
			const attempt = checkpoint.attempts.find(
				(item) => item.id === this.activeAttempt,
			);
			if (!attempt)
				throw new Error("Tool call has no durable inference attempt");
			attempt.effectsStarted = true;
			if (toolCallId)
				attempt.effectIds = [
					...new Set([...(attempt.effectIds ?? []), toolCallId]),
				];
			if (toolCallId && toolName)
				attempt.effectTools = {
					...attempt.effectTools,
					[toolCallId]: toolName,
				};
			await this.save(checkpoint);
		} catch (error) {
			return this.block(error);
		}
	}

	/** Capture once before dispatch, never when its asynchronous receipt returns. */
	async captureProviderAttempt(): Promise<Readonly<PiProviderAttempt>> {
		const runId = this.runId,
			attemptId = this.activeAttempt;
		if (!runId || !attemptId)
			throw new PiAccountingError("Provider dispatch has no prepared attempt");
		const checkpoint = await this.inspect(runId);
		const attempt = checkpoint.attempts.find((item) => item.id === attemptId);
		if (!attempt || attempt.phase !== "started")
			throw new PiAccountingError(
				"Provider dispatch has no started reserved attempt",
			);
		return Object.freeze({ runId, attemptId });
	}

	/** Usage acknowledges only the captured original reservation, even after rebind or cancellation. */
	async recordProviderUsage(
		usage: FacetTurnUsage,
		toolCallIds: string[],
		original: PiProviderAttempt,
	): Promise<void> {
		const captured = Object.freeze({
			runId: original?.runId,
			attemptId: original?.attemptId,
		});
		const receivedUsage = { ...usage },
			receivedCalls = [...toolCallIds];
		const operation = this.receiptFence.then(() =>
			this.persistProviderReceipt(receivedUsage, receivedCalls, captured),
		);
		this.receiptFence = operation.catch(() => {});
		return operation;
	}

	/** A Pi tool task can recover after the provider phase; bind its exact stored attempt. */
	async restoreAttemptForTool(toolCallId: string): Promise<void> {
		const checkpoint = await this.current();
		this.assertHealthy(checkpoint);
		const candidates = checkpoint.attempts.filter(
			(attempt) =>
				attempt.generatedToolCallIds?.includes(toolCallId) ||
				attempt.effectIds?.includes(toolCallId),
		);
		if (candidates.length !== 1)
			return this.block(
				new Error(
					"Tool call has missing or ambiguous durable inference attempt",
				),
			);
		const candidate = candidates[0];
		if (!candidate)
			return this.block(
				new Error("Tool call has no durable inference attempt"),
			);
		this.activeAttempt = candidate.id;
	}

	private async persistProviderReceipt(
		usage: FacetTurnUsage,
		generatedToolCallIds: string[],
		original: PiProviderAttempt,
	): Promise<void> {
		if (!original?.runId?.trim() || !original.attemptId?.trim())
			throw new PiAccountingError(
				"Step receipt has no original provider attempt",
			);
		const { runId, attemptId } = original;
		let receiptPersisted = false;
		let existingFault: Error | null = null;
		try {
			const checkpoint = await this.inspect(runId);
			existingFault =
				(this.runId === runId ? this.fault : null) ??
				(checkpoint.fault ? new PiAccountingError(checkpoint.fault) : null);
			const attempt = checkpoint.attempts.find((item) => item.id === attemptId);
			if (!attempt || attempt.phase === "prepared")
				throw new Error(
					"Step receipt has no started reserved inference attempt",
				);
			if (generatedToolCallIds.some((id) => typeof id !== "string" || !id))
				throw new Error("Invalid provider tool call receipt");
			const calls = [...new Set(generatedToolCallIds)].sort();
			for (const value of Object.values(usage))
				if (value !== null && (!Number.isSafeInteger(value) || value < 0))
					throw new Error("Invalid provider usage receipt");
			if (
				attempt.phase === "completed" &&
				(JSON.stringify(attempt.usage) !== JSON.stringify(usage) ||
					JSON.stringify([...(attempt.generatedToolCallIds ?? [])].sort()) !==
						JSON.stringify(calls))
			)
				throw new Error("Conflicting inference receipt");
			if (attempt.phase !== "completed") {
				if (attempt.phase === "unknown") attempt.acknowledged = false;
				attempt.generatedToolCallIds = calls;
				attempt.phase = "completed";
				attempt.usage = { ...usage };
				await this.save(checkpoint);
			}
			receiptPersisted = true;
			await this.flush(checkpoint);
		} catch (error) {
			return this.fail(runId, error, receiptPersisted && !existingFault);
		}
		if (existingFault) throw existingFault;
	}

	private async current(): Promise<PiAccountingCheckpoint> {
		if (!this.runId)
			throw new Error("Pi accounting invocation was not initialized");
		return this.inspect(this.runId);
	}

	async assertComplete(): Promise<void> {
		const checkpoint = await this.current();
		this.assertHealthy(checkpoint);
		await this.flush(checkpoint);
		if (
			checkpoint.attempts.some(
				(attempt) =>
					attempt.phase === "started" || attempt.phase === "prepared",
			)
		)
			throw new Error("Inference ended without a durable usage receipt");
		for (const attempt of checkpoint.attempts) attempt.effectsSealed = true;
		await this.save(checkpoint);
	}

	async usage(): Promise<FacetTurnUsage> {
		const checkpoint = await this.current();
		const result = emptyFacetTurnUsage();
		if (checkpoint.attempts.length === 0) return result;
		for (const field of [
			"inputTokens",
			"outputTokens",
			"totalTokens",
		] as const) {
			if (checkpoint.attempts.some((attempt) => attempt.usage?.[field] == null))
				continue;
			result[field] = checkpoint.attempts.reduce(
				(sum, attempt) => sum + (attempt.usage?.[field] ?? 0),
				0,
			);
		}
		return result;
	}

	/** Reconcile exact durable executions without replay; provider usage stays unknown and reserved. */
	async reconcileEffects(
		runId: string,
		partialParts: UIMessage["parts"] = [],
	): Promise<Array<ReconciledEffect & { toolCallId: string }>> {
		const checkpoint = await this.inspect(runId);
		const interruptedFault =
			"Interrupted tool effects require reconciliation before recovery";
		if (checkpoint.fault && checkpoint.fault !== interruptedFault) return [];
		if (
			!checkpoint.attempts.some(
				(attempt) => attempt.effectsStarted && !attempt.effectsSealed,
			)
		)
			return checkpoint.recoveredEffects ?? [];
		await this.authority.assertActive(runId);
		const terminalIds = new Set(
			partialParts.flatMap((part) =>
				"toolCallId" in part &&
				"state" in part &&
				["output-available", "output-error", "output-denied"].includes(
					String(part.state),
				)
					? [part.toolCallId]
					: [],
			),
		);
		for (const attempt of checkpoint.attempts) {
			if (!attempt.effectsStarted || attempt.effectsSealed) continue;
			if (!attempt.effectIds?.length) return [];
			const resolved = [];
			for (const toolCallId of attempt.effectIds) {
				if (terminalIds.has(toolCallId)) continue;
				const result = await this.authority.reconcileEffect?.(
					runId,
					toolCallId,
				);
				if (
					!result ||
					(result.terminal !== true &&
						(!("running" in result) || result.running !== true))
				)
					return [];
				resolved.push({ ...result, toolCallId });
			}
			checkpoint.recoveredEffects = [
				...(checkpoint.recoveredEffects ?? []),
				...resolved,
			];
			attempt.effectsSealed = true;
		}
		if (checkpoint.fault === interruptedFault) {
			checkpoint.fault = null;
			if (this.runId === runId) this.fault = null;
		}
		await this.save(checkpoint);
		return checkpoint.recoveredEffects ?? [];
	}
}
