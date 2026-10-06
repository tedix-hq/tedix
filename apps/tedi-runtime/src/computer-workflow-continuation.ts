import type { ComputerEnvironment } from "./computer-environment";
import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	COMPUTER_EXECUTION_WAKE_DEADLINE_MS,
	computerExecutionWakeKey,
	formatComputerExecutionWake,
	type ComputerExecutionWakeRecord,
} from "./computer-execution-wake";
import type {
	FacetWorkflowTurnInput,
	FacetWorkflowTurnResult,
} from "./delegated-work-lease";
import type { FacetTurnUsage } from "./step-telemetry";
import { exceptionTopology } from "./exception-topology";
import { wrapUntrustedInput } from "./untrusted-input";

type Storage = Pick<DurableObjectStorage, "get" | "put" | "list" | "delete">;
export interface ComputerContinuationReadDeps {
	selected(): Promise<{
		environment?: ComputerEnvironment;
		ownerRunId?: string;
	}>;
	read(record: ComputerExecutionWakeRecord): Promise<Record<string, unknown>>;
	/** Runs after every execution identity is validated, before status transport. */
	observationStarted?(): Promise<void>;
}

export interface ComputerWorkflowSegmentResult extends FacetWorkflowTurnResult {
	facetUsage?: FacetTurnUsage;
	suppressMemoryEffects?: boolean;
	failureReason?: string;
}

interface ContinuationRun {
	identity: string;
	activeSegment: number;
}

// Work-owned native commands use durable Workflow sleeps. The conversation
// alarm has a separate cadence; increasing its backoff here delayed handoff
// long after commands had finished.
const COMPUTER_WORKFLOW_OBSERVATION_DELAY_SECONDS = 30;

const runKey = (runId: string) => `computer-continuation:${runId}`;
export const computerSegmentKey = (runId: string, segment: number) =>
	`computer-continuation-segment:${JSON.stringify([runId, segment])}`;

function fail(reason: string): never {
	throw new Error(`computer_continuation_failed: ${reason}`);
}

function segmentOf(input: FacetWorkflowTurnInput): number {
	const segment = input.computerContinuation ?? 0;
	if (!Number.isSafeInteger(segment) || segment < 0 || segment > 128)
		fail("invalid segment");
	return segment;
}

/** The original request and authority cannot change when a workflow resumes. */
function identity(input: FacetWorkflowTurnInput): string {
	return JSON.stringify([
		input.runId,
		input.workItemId,
		input.homeRunId,
		input.sessionKey,
		input.conversationId,
		input.userText,
		input.userTs,
		input.clientRequestId,
		input.traceId,
		input.executionSurface,
		input.authorityEnvelope,
		input.authorityMode,
		input.operatorConsent,
		input.trustedInstructionOrigin,
		input.learningMode,
		input.agentName,
		...(input.repositoryMode ? [input.repositoryMode] : []),
	]);
}

export function hasPendingComputerExecutions(result: unknown): boolean {
	return (
		typeof result === "object" &&
		result !== null &&
		"pendingComputerExecutions" in result &&
		Array.isArray(result.pendingComputerExecutions) &&
		result.pendingComputerExecutions.length > 0
	);
}

/** Waiting may lack prose; it must never hide a real facet/provider failure. */
export function canWaitWithoutAssistant(input: {
	failureReason: string | null;
	turnError: string | null;
	pendingComputer: boolean;
}): boolean {
	return (
		input.pendingComputer &&
		!input.turnError &&
		input.failureReason === "empty_assistant_message"
	);
}

/** Publish fenced observation starts separately from successful waiting receipts. */
export async function observeComputerWorkflowProgress(
	input: FacetWorkflowTurnInput & { executionIds: string[] },
	deps: {
		/** Invoke the callback only after admission and execution identity checks. */
		read(
			observationStarted: () => Promise<void>,
		): Promise<{ ready: boolean; retryAfterSeconds: number }>;
		publish(event: TediRuntimeEvent): Promise<void>;
		tediId: string;
		sequence(): number;
		now?: () => number;
	},
): Promise<{ ready: boolean; retryAfterSeconds: number }> {
	const publish = async (started: boolean) => {
		const sequence = deps.sequence();
		const observedAt = new Date(deps.now?.() ?? Date.now()).toISOString();
		await deps.publish({
			id: `${input.runId}:${started ? "computer-observe" : "computer-wait"}:${segmentOf(input)}:${sequence}`,
			tediId: deps.tediId,
			kind: started ? "message.progress" : "message.phase",
			conversationId: input.conversationId,
			runId: input.runId,
			sequence,
			payload: {
				phase: started ? "observing_computer" : "waiting_for_computer",
				source: "native_command_observation",
				observedAt,
				sessionKey: input.sessionKey,
				workItemId: input.workItemId,
				homeRunId: input.homeRunId,
				executionIds: input.executionIds,
				computerContinuation: segmentOf(input),
			},
			runtime: { backend: "cloudflare-agents" },
			createdAt: observedAt,
		});
	};
	const result = await deps.read(() => publish(true));
	if (!result.ready) await publish(false);
	return result;
}

/** Durable segment receipts; the caller owns admission before every operation. */
export class ComputerWorkflowContinuation {
	constructor(
		private readonly storage: Storage,
		private readonly now: () => number = Date.now,
	) {}

	private async run(input: FacetWorkflowTurnInput): Promise<ContinuationRun> {
		if (!input.workItemId || !input.homeRunId)
			fail("missing delegated identity");
		const segment = segmentOf(input);
		const existing = await this.storage.get<ContinuationRun>(
			runKey(input.runId),
		);
		if (existing) {
			if (existing.identity !== identity(input))
				fail("original run identity changed");
			return existing;
		}
		if (segment !== 0) fail("original run checkpoint missing");
		const created = {
			identity: identity(input),
			activeSegment: 0,
		};
		await this.storage.put(runKey(input.runId), created);
		return created;
	}

	private async executions(
		input: FacetWorkflowTurnInput,
		includeCollected = false,
	) {
		const records = await this.storage.list<ComputerExecutionWakeRecord>({
			prefix: "computer-exec-wake:",
		});
		return [...records.values()].filter(
			(record) =>
				record.launchedByRunId === input.runId &&
				(includeCollected || !record.collectedByRunId) &&
				record.computerContinuation === segmentOf(input),
		);
	}

	/** Detach persists identity before the running receipt is returned to the model. */
	async register(record: ComputerExecutionWakeRecord): Promise<void> {
		const existing = await this.storage.get<ComputerExecutionWakeRecord>(
			computerExecutionWakeKey(record.executionId),
		);
		if (existing) {
			if (
				existing.launchedByRunId !== record.launchedByRunId ||
				existing.workItemId !== record.workItemId ||
				existing.homeRunId !== record.homeRunId ||
				existing.sessionKey !== record.sessionKey ||
				existing.environment.leaseId !== record.environment.leaseId
			)
				fail("execution identity changed during detach replay");
			return;
		}
		const run = record.launchedByRunId
			? await this.storage.get<ContinuationRun>(runKey(record.launchedByRunId))
			: undefined;
		await this.storage.put(computerExecutionWakeKey(record.executionId), {
			...record,
			...(run ? { computerContinuation: run.activeSegment } : {}),
		});
	}

	async hasExecutions(input: FacetWorkflowTurnInput): Promise<boolean> {
		return (await this.executions(input)).length > 0;
	}

	async prepare(
		input: FacetWorkflowTurnInput,
		deps: ComputerContinuationReadDeps,
	): Promise<{
		cached?: ComputerWorkflowSegmentResult;
		completionText?: string;
	}> {
		const run = await this.run(input);
		const segment = segmentOf(input);
		const cached = await this.storage.get<ComputerWorkflowSegmentResult>(
			computerSegmentKey(input.runId, segment),
		);
		if (cached?.failureReason) throw new Error(cached.failureReason);
		if (cached) return { cached };
		if (segment < run.activeSegment || segment > run.activeSegment + 1)
			fail("out-of-order segment");
		// A deploy can interrupt after detach but before the facet returns. The
		// command is already real: recover its wait, never repeat that model segment.
		const outstanding = await this.executions(input, true);
		if (outstanding.length) {
			for (const record of outstanding)
				this.assertRecord(input, record, segment);
			const recovered: ComputerWorkflowSegmentResult = {
				text: "Waiting for the existing native command after interrupted turn delivery.",
				stopReason: "computer_pending",
				toolCalls: [],
				pendingComputerExecutions: outstanding.map(
					(record) => record.executionId,
				),
			};
			await this.storage.put(
				computerSegmentKey(input.runId, segment),
				recovered,
			);
			return { cached: recovered };
		}
		let completionText: string | undefined;
		if (segment > 0) {
			const previous = await this.storage.get<ComputerWorkflowSegmentResult>(
				computerSegmentKey(input.runId, segment - 1),
			);
			if (!previous?.pendingComputerExecutions?.length)
				fail("previous pending segment missing");
			const status = await this.read(
				{
					...input,
					computerContinuation: segment - 1,
					executionIds: previous.pendingComputerExecutions,
				},
				deps,
			);
			if (!status.ready) fail("previous command is not terminal");
			const completed = [];
			for (const id of previous.pendingComputerExecutions) {
				const record = await this.storage.get<ComputerExecutionWakeRecord>(
					computerExecutionWakeKey(id),
				);
				this.assertRecord(input, record, segment - 1);
				if (!record.terminalReceipt) fail("previous command is not terminal");
				completed.push(
					formatComputerExecutionWake(
						record,
						record.terminalReceipt,
						this.now(),
					),
				);
			}
			completionText = wrapUntrustedInput(
				completed.join("\n\n"),
				"computer_execution",
			);
		}
		await this.storage.put(runKey(input.runId), {
			...run,
			activeSegment: segment,
		});
		return { completionText };
	}

	async checkpoint(
		input: FacetWorkflowTurnInput,
		result: ComputerWorkflowSegmentResult,
	): Promise<ComputerWorkflowSegmentResult> {
		await this.run(input);
		const key = computerSegmentKey(input.runId, segmentOf(input));
		const cached = await this.storage.get<ComputerWorkflowSegmentResult>(key);
		if (cached) return cached;
		const executions = await this.executions(input);
		for (const record of executions)
			this.assertRecord(input, record, segmentOf(input));
		const checkpoint = executions.length
			? {
					...result,
					stopReason: "computer_pending",
					pendingComputerExecutions: executions.map(
						(record) => record.executionId,
					),
				}
			: result;
		await this.storage.put(key, checkpoint);
		return checkpoint;
	}

	/** A known facet failure is not an interrupted-result recovery. */
	async recordFailure(
		input: FacetWorkflowTurnInput,
		failureReason: string,
	): Promise<void> {
		if (!(await this.executions(input, true)).length) return;
		await this.storage.put(computerSegmentKey(input.runId, segmentOf(input)), {
			text: "",
			stopReason: "failed",
			toolCalls: [],
			failureReason,
		} satisfies ComputerWorkflowSegmentResult);
	}

	/** Persist-first: a retry of either a pending or final result never runs inference. */
	async settle(
		input: FacetWorkflowTurnInput,
		result: ComputerWorkflowSegmentResult,
		commit: (segment: ComputerWorkflowSegmentResult) => Promise<void>,
	): Promise<ComputerWorkflowSegmentResult> {
		const segment = await this.checkpoint(input, result);
		if (!hasPendingComputerExecutions(segment)) {
			await commit(segment);
			// Keep segment checkpoints for RPC retries, but retire the active watch
			// index only after the canonical final commit succeeded. Full process
			// evidence remains in its separately retained workstation artifacts.
			const records = await this.storage.list<ComputerExecutionWakeRecord>({
				prefix: "computer-exec-wake:",
			});
			for (const [key, record] of records) {
				if (
					record.launchedByRunId === input.runId &&
					record.workItemId === input.workItemId
				)
					await this.storage.delete(key);
			}
		}
		return segment;
	}

	private assertRecord(
		input: FacetWorkflowTurnInput,
		record: ComputerExecutionWakeRecord | undefined,
		segment: number,
	): asserts record is ComputerExecutionWakeRecord {
		if (
			!record ||
			record.launchedByRunId !== input.runId ||
			record.workItemId !== input.workItemId ||
			record.homeRunId !== input.homeRunId ||
			record.sessionKey !== input.sessionKey ||
			record.computerContinuation !== segment
		)
			fail("execution does not belong to this run and segment");
	}

	async read(
		input: FacetWorkflowTurnInput & { executionIds: string[] },
		deps: ComputerContinuationReadDeps,
	): Promise<{ ready: boolean; retryAfterSeconds: number }> {
		await this.run(input);
		const segment = await this.storage.get<ComputerWorkflowSegmentResult>(
			computerSegmentKey(input.runId, segmentOf(input)),
		);
		const expected = segment?.pendingComputerExecutions;
		if (
			!expected?.length ||
			JSON.stringify([...expected].sort()) !==
				JSON.stringify([...input.executionIds].sort())
		)
			fail("execution list differs from persisted pending segment");
		const selected = await deps.selected();
		if (selected.ownerRunId !== input.runId) fail("computer owner changed");
		let ready = true;
		const records: { id: string; record: ComputerExecutionWakeRecord }[] = [];
		for (const id of expected) {
			const record = await this.storage.get<ComputerExecutionWakeRecord>(
				computerExecutionWakeKey(id),
			);
			this.assertRecord(input, record, segmentOf(input));
			if (
				!selected.environment ||
				selected.environment.leaseId !== record.environment.leaseId
			)
				fail("original computer lease changed or disappeared");
			records.push({ id, record });
		}
		await deps.observationStarted?.();
		for (const { id, record } of records) {
			if (record.terminalReceipt) continue;
			const receipt = await deps.read(record);
			if (receipt.found === false)
				fail("computer no longer knows the original execution");
			if (receipt.ok === false || receipt.error) {
				throw new Error(
					`Computer execution status read failed: ${String(receipt.error ?? "unavailable")}`,
				);
			}
			if (receipt.terminal === true) {
				await this.storage.put(computerExecutionWakeKey(id), {
					...record,
					terminalReceipt: receipt,
				});
			} else if (
				this.now() - record.detachedAt >=
				COMPUTER_EXECUTION_WAKE_DEADLINE_MS
			) {
				fail("execution exceeded six-hour deadline without terminal evidence");
			} else if (
				receipt.status === "running" ||
				receipt.status === "queued" ||
				receipt.running === true
			) {
				ready = false;
				const attempt = record.attempt + 1;
				await this.storage.put(computerExecutionWakeKey(id), {
					...record,
					attempt,
				});
			} else
				throw new Error(
					"Computer execution status read returned no running or terminal observation",
				);
		}
		return {
			ready,
			retryAfterSeconds: COMPUTER_WORKFLOW_OBSERVATION_DELAY_SECONDS,
		};
	}
}

/** Cleanup cannot destroy an unresolved command owned by this exact run/lease.
 * A polling deadline is not terminal evidence or permission to destroy its body. */
export async function hasPendingNativeComputerExecution(
	storage: Storage,
	input: { workItemId: string; runId: string; leaseId: string },
): Promise<boolean> {
	const records = await storage.list<ComputerExecutionWakeRecord>({
		prefix: "computer-exec-wake:",
	});
	return [...records.values()].some(
		(record) =>
			record.workItemId === input.workItemId &&
			record.launchedByRunId === input.runId &&
			record.environment.leaseId === input.leaseId &&
			!record.collectedByRunId &&
			!record.terminalReceipt,
	);
}

/** A whole-run cancellation overrides retention, but only for its exact jobs. */
export async function retainComputerForNativeExecutions(
	storage: Storage,
	input: { workItemId: string; runId: string; leaseId: string },
	deps: {
		canceled: boolean;
		cancel(
			record: ComputerExecutionWakeRecord,
		): Promise<Record<string, unknown>>;
	},
): Promise<boolean> {
	if (!deps.canceled) return hasPendingNativeComputerExecution(storage, input);
	const records = await storage.list<ComputerExecutionWakeRecord>({
		prefix: "computer-exec-wake:",
	});
	for (const [key, record] of records) {
		if (
			record.workItemId !== input.workItemId ||
			record.launchedByRunId !== input.runId ||
			record.environment.leaseId !== input.leaseId ||
			record.terminalReceipt ||
			record.collectedByRunId
		)
			continue;
		try {
			const receipt = await deps.cancel(record);
			if (receipt.terminal === true)
				await storage.put(key, { ...record, terminalReceipt: receipt });
		} catch (error) {
			// Cancellation must still reach the existing bounded lease release path.
			// An unavailable cancel response is never fabricated as terminal evidence.
			console.error({
				component: "tedi-runtime-computer",
				event: "tedi.computer.native_cancellation_failed",
				exception: exceptionTopology(error),
			});
		}
	}
	return false;
}
