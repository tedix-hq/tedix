import {
	LaneExecutionPolicySchema,
	type LaneCheckpoint,
	type LaneExecutor,
	type LaneExecutionPolicy,
} from "@tedix/api-contract/schemas/lane-execution";
import type { KernelRequestRow } from "@tedix/db/schema/kernel-requests";

/** Trusted source adapter. Catalog membership alone never authorizes continuation. */
export interface KernelExecutorRouter {
	readContext(row: KernelRequestRow): Promise<{
		policy: LaneExecutionPolicy;
		attemptCount: number;
		requiredCapabilities: string[];
	}>;
	readFailure(row: KernelRequestRow): Promise<{
		kind: "provider_credit_exhausted";
		attemptId: string;
		executorId: string;
		writeReceiptRefs: string[];
		uncertainWriteRefs: string[];
	} | null>;
	/** Provider readbacks only. Adapters must retain reservations for unresolved refs. */
	reconcileWrites(
		row: KernelRequestRow,
		checkpoint: LaneCheckpoint,
	): Promise<string[]>;
	/** Re-read canonical ownership, capabilities, authority, pricing and budget on every call. */
	eligible(row: KernelRequestRow, executor: LaneExecutor): Promise<boolean>;
	/**
	 * Must reconcile by checkpoint.key before doing anything on replay. Uses the
	 * existing Work admission/reservation path, after fenced terminal settlement of
	 * the predecessor. An uncertain result retains reservations, never retries a write.
	 * Local adapters must obtain an actual host-channel acknowledgment of that key.
	 */
	continue(
		row: KernelRequestRow,
		checkpoint: LaneCheckpoint,
		executor: LaneExecutor,
	): Promise<{
		workItemId: string;
		previousAttemptId: string;
		attemptId: string;
		admissionId: string;
		hostAcknowledgmentRef: string | null;
	}>;
}

export async function routeKernelRequest(
	initial: KernelRequestRow,
	router: KernelExecutorRouter,
	save: (
		row: KernelRequestRow,
		checkpoint: LaneCheckpoint,
	) => Promise<KernelRequestRow>,
	now: string,
	retryWindowMs: number,
) {
	let row = initial;
	const context = await router.readContext(row);
	const policy = LaneExecutionPolicySchema.parse(context.policy);
	let existing = row.snapshot.laneCheckpoint;
	if (!existing || existing.status === "continued") {
		const failure = await router.readFailure(row);
		if (!failure || failure.attemptId !== row.snapshot.attemptId) return row;
		const failed = policy.executors.find((e) => e.id === failure.executorId);
		const created: LaneCheckpoint = {
			previousAttemptId: failure.attemptId,
			executorId: failure.executorId,
			key: `${row.id}:${failure.attemptId}:credit`,
			status: "reconcile",
			writeReceiptRefs: failure.writeReceiptRefs,
			uncertainWriteRefs: failure.uncertainWriteRefs,
			reconciledRefs: [],
			failedCostMicros: failed?.costMicros ?? null,
			successorExecutorId: null,
			successorAttemptId: null,
			hostAcknowledgmentRef: null,
			deadline: new Date(Date.parse(now) + retryWindowMs).toISOString(),
			reason: null,
		};
		row = await save(row, created);
		if (row.snapshot.laneCheckpoint?.key !== created.key) return row;
		existing = row.snapshot.laneCheckpoint;
	}
	let checkpoint: LaneCheckpoint = existing;
	if (checkpoint.status === "held" || checkpoint.status === "continued")
		return row;
	const hold = async (reason: string) =>
		save(row, { ...checkpoint, status: "held", reason });
	if (Date.parse(now) >= Date.parse(checkpoint.deadline))
		return hold("Continuation deadline expired");
	if (
		policy.delegationDepth > policy.maxDelegationDepth ||
		(checkpoint.status !== "dispatching" &&
			context.attemptCount >= policy.maxAttempts)
	)
		return hold("Retry or delegation depth budget exhausted");
	if (checkpoint.failedCostMicros === null)
		return hold("Failed executor pricing unavailable");
	if (checkpoint.status === "reconcile") {
		const refs = await router.reconcileWrites(row, checkpoint);
		if (!checkpoint.uncertainWriteRefs.every((ref) => refs.includes(ref)))
			return row;
		row = await save(row, {
			...checkpoint,
			status: "ready",
			reconciledRefs: refs,
		});
		checkpoint = row.snapshot.laneCheckpoint!;
		if (checkpoint.status !== "ready") return row;
	}
	const candidates = policy.executors
		.filter(
			(e) =>
				e.id !== checkpoint.executorId &&
				e.costMicros !== null &&
				e.costMicros < checkpoint.failedCostMicros! &&
				context.requiredCapabilities.every((c) => e.capabilities.includes(c)) &&
				(!checkpoint.successorExecutorId ||
					checkpoint.successorExecutorId === e.id),
		)
		.sort((a, b) => a.costMicros! - b.costMicros! || a.id.localeCompare(b.id));
	for (const executor of candidates) {
		if (!(await router.eligible(row, executor))) continue;
		if (checkpoint.status === "ready") {
			row = await save(row, {
				...checkpoint,
				status: "dispatching",
				successorExecutorId: executor.id,
			});
			checkpoint = row.snapshot.laneCheckpoint!;
			if (
				checkpoint.status !== "dispatching" ||
				checkpoint.successorExecutorId !== executor.id
			)
				return row;
		}
		// Refresh authority after the durable claim as well as on every recovery.
		if (!(await router.eligible(row, executor))) return row;
		const receipt = await router.continue(row, checkpoint, executor);
		if (
			receipt.workItemId !== row.snapshot.workItemId ||
			receipt.previousAttemptId !== checkpoint.previousAttemptId ||
			!receipt.admissionId ||
			!receipt.attemptId ||
			receipt.attemptId === checkpoint.previousAttemptId
		)
			throw new Error(
				"Continuation receipt does not match the canonical Work and admission",
			);
		if (
			(executor.kind === "codex" || executor.kind === "claude") &&
			!receipt.hostAcknowledgmentRef
		)
			return row;
		return save(row, {
			...checkpoint,
			status: "continued",
			successorAttemptId: receipt.attemptId,
			hostAcknowledgmentRef: receipt.hostAcknowledgmentRef,
		});
	}
	return row;
}
