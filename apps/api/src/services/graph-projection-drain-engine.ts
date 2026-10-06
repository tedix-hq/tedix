/**
 * The one graph projection drain shell.
 *
 * Batching loop, cursor advancement and lease fencing live here exactly once.
 * The durable Workflow and the inline `graph.sync` drain are its two callers:
 * they differ only in how a unit of work is executed (a durable `step.do` vs a
 * direct call), how a batch is hydrated, and what they do when the engine
 * stops. Everything about *when* the cursor may move and *who* may renew the
 * lease is decided here.
 *
 * Two invariants this file owns:
 *
 * 1. The cursor never passes an unprocessed event. It only ever advances to
 *    `plan.endSequence` — the end of the contiguous prefix the plan
 *    acknowledged — and only after the phased Neo4j write for that prefix has
 *    returned successfully. Every advance is a CAS against the cursor the
 *    batch was planned from.
 * 2. A lease is only ever renewed by its holder. Renewal is token-fenced in
 *    D1: `renewGraphProjectionLease` matches on the token, so a caller whose
 *    token was stolen by an expiry-driven re-acquire gets `false` and the
 *    engine stops instead of writing or advancing.
 */

import type { WorkflowStepConfig } from "cloudflare:workers";
import type { DbClient } from "@tedix/db/client";
import {
	advanceGraphProjectionCursor,
	getGraphProjectionCursor,
	GRAPH_PROJECTION_LEASE_MS,
	readGraphProjectionBatch,
	recordGraphProjectionFailure,
	renewGraphProjectionLease,
} from "@tedix/db/queries/graph-projection";
import type { GraphProjectionOutboxEvent } from "@tedix/db/schema/graph-projection";
import type { SyncEvent } from "../integrations/graph-db/types";
import {
	type DurableGraphProjectionWriteResult,
	runFencedGraphProjectionWrite,
} from "./graph-projection-batch-execution";
import {
	buildDurableGraphProjectionBatchPlan,
	type DurableGraphProjectionBatchPlan,
} from "./graph-projection-batch-plan";

/** The durable Workflow step configuration, shared verbatim with `step.do`. */
export type GraphProjectionStepOptions = WorkflowStepConfig;

/**
 * One unit of drain work.
 *
 * The Workflow adapter runs this as `step.do`, so every body handed to it must
 * be **re-runnable** and must resolve to a JSON-serializable value. The engine
 * keeps that contract by construction:
 *
 * - `read-initial-cursor` and `plan-*` are pure reads; the plan freezes the
 *   time-dependent prefix so a replay never re-evaluates `nextAttemptAt`
 *   against a later wall clock.
 * - `hydrate-*` re-reads canonical rows; re-reading is free of side effects.
 * - `project-*` renews the lease and replays the phased MERGE batch, which is
 *   idempotent in Neo4j; a second run of the same batch converges to the same
 *   graph.
 * - `checkpoint-*` is a lease-fenced CAS from the planned cursor that also
 *   admits a cursor already sitting at the sequence being advanced to, so a
 *   replay of an advance that already committed reports its own outcome rather
 *   than fencing itself out.
 * - the failure-recording and release steps are the only ones with a
 *   non-idempotent effect (`attemptCount` is incremented per run). They are
 *   terminal: the engine returns immediately afterwards, so a retry of the
 *   enclosing step is the only way to re-enter them, and spending one extra
 *   retry attempt on an event that is already failing is the safe direction.
 */
export type GraphProjectionStepRunner = <T>(
	name: string,
	options: GraphProjectionStepOptions,
	body: () => Promise<T>,
) => Promise<T>;

/** The inline runner: no durability, no serialization, same call order. */
export const runGraphProjectionStepInline: GraphProjectionStepRunner = (
	_name,
	_options,
	body,
) => body();

const READ_STEP: GraphProjectionStepOptions = {
	retries: { limit: 3, delay: "2 seconds" },
	timeout: "30 seconds",
};
const PROJECT_STEP: GraphProjectionStepOptions = {
	retries: { limit: 5, delay: "5 seconds" },
	timeout: "5 minutes",
};
const CHECKPOINT_STEP: GraphProjectionStepOptions = {
	retries: { limit: 5, delay: "2 seconds" },
	timeout: "30 seconds",
};
const RECORD_STEP: GraphProjectionStepOptions = {
	retries: { limit: 3, delay: "2 seconds" },
	timeout: "1 minute",
};

/**
 * Thrown by a hydrator that knows which outbox events are responsible.
 *
 * The inline drain hydrates event by event and can name the exact offender;
 * the Workflow hydrates the batch in one D1 round trip and cannot, so its
 * failure retains every coalesced event. Both go through the same engine path.
 */
export class GraphProjectionHydrationError extends Error {
	readonly failedEvents: readonly GraphProjectionOutboxEvent[];

	constructor(
		cause: unknown,
		failedEvents: readonly GraphProjectionOutboxEvent[],
	) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = "GraphProjectionHydrationError";
		this.cause = cause;
		this.failedEvents = failedEvents;
	}
}

export type GraphProjectionDrainStop =
	/** Nothing left to read at the cursor. */
	| { kind: "drained" }
	/** The caller's batch budget is spent; backlog may remain. */
	| { kind: "batch_budget" }
	/** The head event is still waiting out its retry backoff. */
	| { kind: "retry_backoff"; headSequence: number }
	| {
			kind: "hydration_failed";
			error: unknown;
			failedSequence: number | null;
	  }
	| {
			kind: "projection_failed";
			error: Error;
			failedSequence: number | null;
	  }
	/** The lease was taken from us; nothing was written or advanced. */
	| { kind: "lease_lost"; phase: "project" | "checkpoint" }
	/** The write committed but the cursor CAS lost to a concurrent holder. */
	| { kind: "cursor_fenced"; throughSequence: number }
	/** A lease-store/step failure, never an outbox-data failure. */
	| {
			kind: "coordination_failed";
			phase: "project" | "checkpoint";
			error: unknown;
	  };

export type GraphProjectionDrainRun = {
	cursorBefore: number;
	cursor: number;
	processed: number;
	batches: number;
	/** Highest sequence observed in the outbox, backoff tail included. */
	highWaterSequence: number;
	/** Non-null when events were acknowledged without being projected. */
	degradedReason: string | null;
	stop: GraphProjectionDrainStop;
};

export type GraphProjectionDrainEngineInput = {
	db: DbClient;
	organizationId: string;
	leaseToken: string;
	/** Omitted means the shared D1 default. */
	leaseMs?: number;
	batchSize?: number;
	maxBatches: number;
	/** Durable adapter; defaults to running each unit inline. */
	runStep?: GraphProjectionStepRunner;
	/** Overridable only so tests can pin the backoff evaluation instant. */
	now?: () => number;
	hydrate: (events: GraphProjectionOutboxEvent[]) => Promise<SyncEvent[]>;
	project: (events: SyncEvent[]) => Promise<void>;
	/**
	 * Called exactly once for every stop that is not a clean end of work,
	 * inside the same unit of work that records outbox failures. Callers use it
	 * to publish readiness and release the lease. Errors from an abort after a
	 * pure coordination failure are logged and swallowed, as the lease is
	 * already unusable; errors from an abort that also records outbox failures
	 * propagate.
	 */
	onAbort?: (
		stop: GraphProjectionDrainStop,
		context: { cursor: number },
	) => Promise<void>;
};

type CheckpointOutcome =
	| { status: "advanced" }
	| { status: "lease_lost" }
	| { status: "fenced" };

async function recordBatchFailure(
	db: DbClient,
	events: readonly GraphProjectionOutboxEvent[],
	error: unknown,
): Promise<void> {
	for (const event of events) {
		await recordGraphProjectionFailure(db, event, error);
	}
}

/**
 * Drain the projection outbox for one organization.
 *
 * The caller owns the lease lifecycle (acquire before, release after or in
 * `onAbort`) because the Workflow keeps holding the same lease through
 * stale-generation cleanup and certification long after the loop ends.
 */
export async function runGraphProjectionDrain(
	input: GraphProjectionDrainEngineInput,
): Promise<GraphProjectionDrainRun> {
	const {
		db,
		organizationId,
		leaseToken,
		leaseMs = GRAPH_PROJECTION_LEASE_MS,
		maxBatches,
	} = input;
	const runStep = input.runStep ?? runGraphProjectionStepInline;
	const now = input.now ?? Date.now;

	const renewLease = () =>
		renewGraphProjectionLease(db, organizationId, leaseToken, leaseMs);

	const cursorBefore = await runStep("read-initial-cursor", READ_STEP, () =>
		getGraphProjectionCursor(db, organizationId),
	);

	let cursor = cursorBefore;
	let processed = 0;
	let batches = 0;
	let highWaterSequence = cursorBefore;
	let degradedReason: string | null = null;

	const finish = (stop: GraphProjectionDrainStop): GraphProjectionDrainRun => ({
		cursorBefore,
		cursor,
		processed,
		batches,
		highWaterSequence,
		degradedReason,
		stop,
	});

	for (let batchIndex = 0; batchIndex < maxBatches; batchIndex++) {
		const plan = await runStep(
			`plan-${cursor}`,
			READ_STEP,
			async (): Promise<DurableGraphProjectionBatchPlan> => {
				const fetched =
					input.batchSize === undefined
						? await readGraphProjectionBatch(db, organizationId, cursor)
						: await readGraphProjectionBatch(
								db,
								organizationId,
								cursor,
								input.batchSize,
							);
				return buildDurableGraphProjectionBatchPlan(fetched, now());
			},
		);
		batches++;
		if (plan.fetchedEndSequence !== null) {
			highWaterSequence = plan.fetchedEndSequence;
		}
		if (plan.blockedReason) degradedReason = plan.blockedReason;
		if (plan.endSequence === null) {
			// Nothing read at all is a clean drain; a full batch of rows that are
			// all still in backoff is the head waiting for its next attempt.
			return plan.headSequence === null
				? finish({ kind: "drained" })
				: finish({ kind: "retry_backoff", headSequence: plan.headSequence });
		}
		const coalesced = plan.coalesced;
		const nextCursor = plan.endSequence;

		let syncEvents: SyncEvent[];
		try {
			syncEvents = await runStep(
				`hydrate-${cursor}-${nextCursor}`,
				READ_STEP,
				() => input.hydrate(coalesced),
			);
		} catch (error) {
			const failedEvents =
				error instanceof GraphProjectionHydrationError
					? error.failedEvents
					: coalesced;
			const stop: GraphProjectionDrainStop = {
				kind: "hydration_failed",
				error:
					error instanceof GraphProjectionHydrationError ? error.cause : error,
				failedSequence: failedEvents[0]?.sequence ?? null,
			};
			await runStep(
				`record-hydration-failure-${cursor}-${nextCursor}`,
				RECORD_STEP,
				async () => {
					await recordBatchFailure(db, failedEvents, stop.error);
					await input.onAbort?.(stop, { cursor });
				},
			);
			return finish(stop);
		}

		let writeResult: DurableGraphProjectionWriteResult;
		try {
			writeResult = await runStep(
				`project-${cursor}-${nextCursor}`,
				PROJECT_STEP,
				() =>
					runFencedGraphProjectionWrite({
						renewLease,
						project: () => input.project(syncEvents),
					}),
			);
		} catch (error) {
			// Only lease-store/step coordination failures escape the fenced write;
			// a Neo4j error is a tagged result below. Coordination must never
			// consume an event's poison budget.
			return finish(
				await abortForCoordination(
					input,
					{ kind: "coordination_failed", phase: "project", error },
					`release-after-project-coordination-${cursor}-${nextCursor}`,
					cursor,
				),
			);
		}

		if (writeResult.status === "lease_lost") {
			return finish(
				await abortForCoordination(
					input,
					{ kind: "lease_lost", phase: "project" },
					`release-after-lease-loss-${cursor}-${nextCursor}`,
					cursor,
				),
			);
		}
		if (writeResult.status === "projection_failed") {
			// The phased UNWIND write is one logical verified batch and the Neo4j
			// API gives no per-row failure counter, so retain every coalesced
			// source event rather than guessing which row failed. Neither caller
			// advances its cursor past them.
			const stop: GraphProjectionDrainStop = {
				kind: "projection_failed",
				error: new Error(writeResult.error),
				failedSequence: coalesced[0]?.sequence ?? null,
			};
			await runStep(
				`record-projection-failure-${cursor}-${nextCursor}`,
				RECORD_STEP,
				async () => {
					await recordBatchFailure(db, coalesced, stop.error);
					await input.onAbort?.(stop, { cursor });
				},
			);
			return finish(stop);
		}

		const plannedFrom = cursor;
		let checkpoint: CheckpointOutcome;
		try {
			checkpoint = await runStep(
				`checkpoint-${nextCursor}`,
				CHECKPOINT_STEP,
				async (): Promise<CheckpointOutcome> => {
					const renewed = await renewLease();
					if (!renewed) return { status: "lease_lost" };
					const advanced = await advanceGraphProjectionCursor(
						db,
						organizationId,
						leaseToken,
						nextCursor,
						{ expectedCursor: plannedFrom },
					);
					// The CAS admits both `plannedFrom` and `nextCursor`, so a durable
					// replay of an advance that already committed reports success
					// instead of fencing itself out. Anything else lost the cursor to
					// a concurrent holder and must not be retried.
					return advanced ? { status: "advanced" } : { status: "fenced" };
				},
			);
		} catch (error) {
			// A checkpoint is coordination after a verified Neo4j write. Its
			// lease/CAS/D1 failures must not consume outbox poison budget.
			return finish(
				await abortForCoordination(
					input,
					{ kind: "coordination_failed", phase: "checkpoint", error },
					`release-after-checkpoint-${cursor}-${nextCursor}`,
					cursor,
				),
			);
		}

		if (checkpoint.status === "lease_lost") {
			return finish(
				await abortForCoordination(
					input,
					{ kind: "lease_lost", phase: "checkpoint" },
					`release-after-checkpoint-${cursor}-${nextCursor}`,
					cursor,
				),
			);
		}
		if (checkpoint.status === "fenced") {
			return finish(
				await abortForCoordination(
					input,
					{ kind: "cursor_fenced", throughSequence: nextCursor },
					`release-after-checkpoint-${cursor}-${nextCursor}`,
					cursor,
				),
			);
		}

		cursor = nextCursor;
		processed += plan.eligibleCount;
	}

	return finish({ kind: "batch_budget" });
}

/**
 * Abort after a coordination failure. The lease is already unusable, so a
 * failure to release it is logged rather than replacing the original cause.
 */
async function abortForCoordination(
	input: GraphProjectionDrainEngineInput,
	stop: GraphProjectionDrainStop,
	stepName: string,
	cursor: number,
): Promise<GraphProjectionDrainStop> {
	if (!input.onAbort) return stop;
	const runStep = input.runStep ?? runGraphProjectionStepInline;
	try {
		await runStep(stepName, READ_STEP, () => input.onAbort!(stop, { cursor }));
	} catch (abortError) {
		console.warn(
			"Failed to finalize graph projection lease after a coordination failure",
			abortError,
		);
	}
	return stop;
}
