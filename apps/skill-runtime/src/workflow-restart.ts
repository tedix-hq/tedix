import { sha256Hex } from "@tedix/worker-kit/crypto";
import { encodeWorkflowArtifactPathSegment } from "./workflow-path";

export type WorkflowRestartStepType = "do" | "sleep" | "waitForEvent";

export interface WorkflowRestartFrom {
	name: string;
	count?: number;
	type?: WorkflowRestartStepType;
}

export type WorkflowRestartReceiptStatus =
	| "pending"
	| "accepted"
	| "unknown"
	| "rejected";

interface WorkflowRestartRequest {
	from: WorkflowRestartFrom | null;
}

export interface WorkflowRestartReceipt {
	restartId: string;
	request: WorkflowRestartRequest;
	status: WorkflowRestartReceiptStatus;
	executionEpoch?: number;
	updatedAt: string;
	resolution?: {
		action: "operator_abort";
		reason: string;
		resolvedAt: string;
	};
}

export type WorkflowRestartBarrierState = "none" | "blocked" | "released";

export type WorkflowExecutionEpochOutcome = "completed" | "failed" | null;

export interface WorkflowExecutionEpochOutcomeEvidence {
	outcome: Exclude<WorkflowExecutionEpochOutcome, null>;
	terminalFingerprint: string | null;
}

export class WorkflowRestartConflictError extends Error {
	readonly code = "WORKFLOW_RESTART_CONFLICT";

	constructor(
		message: string,
		readonly receiptStatus?: WorkflowRestartReceiptStatus,
	) {
		super(message);
		this.name = "WorkflowRestartConflictError";
	}
}

export type WorkflowRestartClaim =
	| {
			deduplicated: false;
			path: string;
			receipt: WorkflowRestartReceipt & { status: "pending" };
			pendingContent: string;
	  }
	| {
			deduplicated: true;
			path: string;
			receipt:
				| (WorkflowRestartReceipt & {
						status: "accepted";
						executionEpoch: number;
				  })
				| (WorkflowRestartReceipt & { status: "rejected" });
	  };

export type WorkflowRestartFinalization =
	| { status: "accepted"; executionEpoch: number }
	| { status: "unknown"; executionEpoch?: number }
	| { status: "rejected"; executionEpoch?: number };

interface LocatedWorkflowRestartReceipt {
	path: string;
	content: string;
	receipt: WorkflowRestartReceipt;
}

function restartPath(restartId: string): string {
	let encodedRestartId: string;
	try {
		encodedRestartId = encodeWorkflowArtifactPathSegment(restartId);
	} catch {
		throw new WorkflowRestartConflictError(
			"restartId is invalid or too large after URI encoding",
		);
	}
	return `controls/restarts/${encodedRestartId}.json`;
}

function epochStartPath(executionEpoch: number): string {
	if (!Number.isInteger(executionEpoch) || executionEpoch < 0) {
		throw new Error("executionEpoch must be a non-negative integer");
	}
	return `epochs/${executionEpoch}/started.json`;
}

function epochOutcomePaths(executionEpoch: number): [string, string] {
	return [
		`epochs/${executionEpoch}/completed.json`,
		`epochs/${executionEpoch}/failed.json`,
	];
}

/**
 * Retirement permanently fences the underlying Workflow instance. An
 * operator-aborted invocation may still arrive later, while revocation may
 * delete every evidence artifact. The canonical run-row marker (plus legacy
 * REVOKED/error and abort-receipt fallbacks) therefore guards both future
 * claims and every static-factory entry.
 */
export async function isWorkflowInstanceRetired(
	db: D1Database,
	runId: string,
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS present
			 WHERE EXISTS (
			   SELECT 1 FROM skill_runs
			    WHERE id = ?1
			      AND (workflow_retired_at IS NOT NULL
			           OR COALESCE(error, '') = 'REVOKED'
			           OR COALESCE(error, '') GLOB 'REVOKED:*')
			 ) OR EXISTS (
			   SELECT 1 FROM skill_run_artifacts
			    WHERE run_id = ?1
			      AND path LIKE 'controls/restarts/%'
			      AND CASE WHEN json_valid(content_inline)
			        THEN json_extract(content_inline, '$.status') END = 'rejected'
			      AND CASE WHEN json_valid(content_inline)
			        THEN json_extract(content_inline, '$.resolution.action') END = 'operator_abort'
			 )
			 LIMIT 1`,
		)
		.bind(runId)
		.first<{ present: number }>();
	return row?.present === 1;
}

/**
 * Classify whether engine state may be projected while a restart intent is
 * open. A pre-restart snapshot can only be terminal because Tedix admits a
 * restart from complete/errored. Once Cloudflare accepts the restart, every
 * recognized non-terminal/terminated state therefore belongs to the new
 * execution; only complete/errored still needs exact-epoch fingerprint proof.
 */
export function workflowRestartBarrierState(input: {
	restartRequestedAt: string | null;
	acceptedRestart: WorkflowRestartReceipt | null;
	engineStatus: string | null;
	executionEpochOutcome: WorkflowExecutionEpochOutcomeEvidence | null;
	engineTerminalFingerprint: string | null;
}): WorkflowRestartBarrierState {
	if (!input.restartRequestedAt) return "none";
	if (!input.acceptedRestart) return "blocked";
	if (input.engineStatus === "completed" || input.engineStatus === "failed") {
		return input.executionEpochOutcome?.outcome === input.engineStatus &&
			input.executionEpochOutcome.terminalFingerprint != null &&
			input.executionEpochOutcome.terminalFingerprint ===
				input.engineTerminalFingerprint
			? "released"
			: "blocked";
	}
	return input.engineStatus === "queued" ||
		input.engineStatus === "running" ||
		input.engineStatus === "paused" ||
		input.engineStatus === "canceled"
		? "released"
		: "blocked";
}

/**
 * Content-address a marker after its fencing INSERT has won. Hashing before
 * that INSERT yields to competing restart controls and changes their atomic
 * ordering; hashing the stored bytes afterward preserves the lock while an
 * idempotent replay repairs any interruption between the two writes.
 */
async function backfillWorkflowArtifactSha256(
	db: D1Database,
	runId: string,
	path: string,
): Promise<void> {
	const row = await db
		.prepare(
			`SELECT content_inline, sha256 FROM skill_run_artifacts
			 WHERE run_id = ?1 AND path = ?2 LIMIT 1`,
		)
		.bind(runId, path)
		.first<{ content_inline: string | null; sha256: string | null }>();
	if (row?.content_inline == null || row.sha256 != null) return;
	const sha256 = await sha256Hex(row.content_inline);
	await db
		.prepare(
			`UPDATE skill_run_artifacts
			 SET sha256 = ?4
			 WHERE run_id = ?1 AND path = ?2
			   AND content_inline = ?3 AND sha256 IS NULL`,
		)
		.bind(runId, path, row.content_inline, sha256)
		.run();
}

/** Fingerprint a serializable Workflow result without persisting its content. */
export async function fingerprintWorkflowOutput(
	value: unknown,
): Promise<string | null> {
	try {
		const serialized = JSON.stringify(value);
		return sha256Hex(
			`output:${serialized === undefined ? "<undefined>" : serialized}`,
		);
	} catch {
		return null;
	}
}

/** Fingerprint the engine-visible error message for terminal epoch fencing. */
export async function fingerprintWorkflowError(
	message: string | null,
): Promise<string | null> {
	return message == null ? null : sha256Hex(`error:${message}`);
}

/**
 * Record the first entry into a concrete execution epoch. This runs in the
 * static dispatcher factory, before tenant source is compiled or invoked, so
 * even loader/validation failures have an epoch fence.
 */
export async function recordWorkflowExecutionEpochStarted(input: {
	db: D1Database;
	runId: string;
	executionEpoch: number;
}): Promise<void> {
	const path = epochStartPath(input.executionEpoch);
	const startedAt = new Date().toISOString();
	const content = JSON.stringify({
		executionEpoch: input.executionEpoch,
		startedAt,
	});
	const inserted = await input.db
		.prepare(
			`INSERT INTO skill_run_artifacts (
			   id, run_id, path, mime_type, size_bytes, content_inline,
			   attempt, outcome, created_at
			 )
			 SELECT ?1, ?2, ?3, 'application/json', ?4, ?5, 1, 'success', ?6
			 WHERE EXISTS (
			   SELECT 1 FROM skill_runs
			    WHERE id = ?2
			      AND workflow_retired_at IS NULL
			      AND COALESCE(error, '') <> 'REVOKED'
			      AND COALESCE(error, '') NOT GLOB 'REVOKED:*'
			 )
			   AND NOT EXISTS (
			   SELECT 1 FROM skill_run_artifacts
			    WHERE run_id = ?2
			      AND path LIKE 'controls/restarts/%'
			      AND CASE WHEN json_valid(content_inline)
			        THEN json_extract(content_inline, '$.status') END = 'rejected'
			      AND CASE WHEN json_valid(content_inline)
			        THEN json_extract(content_inline, '$.resolution.action') END = 'operator_abort'
			 )
			 ON CONFLICT(run_id, path) DO NOTHING`,
		)
		.bind(
			crypto.randomUUID(),
			input.runId,
			path,
			new TextEncoder().encode(content).byteLength,
			content,
			startedAt,
		)
		.run();
	// Hash after the fence lands, never before. This insert is the epoch fence
	// that restart-safety races against (start must beat a concurrent abort), so
	// it has to be the first thing this function does to the DB — awaiting a
	// digest first widens that race window and lets an abort win. The digest is
	// evidence integrity, not a fence, so it patches the row afterwards.
	if (
		(inserted.meta.changes ?? 0) === 0 &&
		(await isWorkflowInstanceRetired(input.db, input.runId))
	) {
		throw new Error(
			`WORKFLOW_INSTANCE_RETIRED: run ${input.runId} cannot enter execution epoch ${input.executionEpoch}`,
		);
	}
	await backfillWorkflowArtifactSha256(input.db, input.runId, path);
}

/** Durable proof that the new epoch entered the static workflow factory. */
export async function hasWorkflowExecutionEpochStarted(
	db: D1Database,
	runId: string,
	executionEpoch: number,
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS present FROM skill_run_artifacts
			 WHERE run_id = ?1 AND path = ?2 AND outcome = 'success'
			 LIMIT 1`,
		)
		.bind(runId, epochStartPath(executionEpoch))
		.first<{ present: number }>();
	return row?.present === 1;
}

/** Record a factory-level failure before the dynamic tenant module can run. */
export async function recordWorkflowExecutionEpochOutcome(input: {
	db: D1Database;
	runId: string;
	executionEpoch: number;
	outcome: Exclude<WorkflowExecutionEpochOutcome, null>;
	terminalFingerprint?: string | null;
}): Promise<void> {
	const path = `epochs/${input.executionEpoch}/${input.outcome}.json`;
	const recordedAt = new Date().toISOString();
	const content = JSON.stringify({
		executionEpoch: input.executionEpoch,
		outcome: input.outcome,
		terminalFingerprint: input.terminalFingerprint ?? null,
		recordedAt,
	});
	const inserted = await input.db
		.prepare(
			`INSERT INTO skill_run_artifacts (
			   id, run_id, path, mime_type, size_bytes, content_inline,
			   attempt, outcome, created_at
			 )
			 SELECT ?1, ?2, ?3, 'application/json', ?4, ?5, 1, 'success', ?6
			 WHERE EXISTS (
			   SELECT 1 FROM skill_runs
			    WHERE id = ?2
			      AND workflow_retired_at IS NULL
			      AND COALESCE(error, '') <> 'REVOKED'
			      AND COALESCE(error, '') NOT GLOB 'REVOKED:*'
			 )
			   AND NOT EXISTS (
			   SELECT 1 FROM skill_run_artifacts
			    WHERE run_id = ?2 AND path IN (?7, ?8)
			 )
			 ON CONFLICT(run_id, path) DO NOTHING`,
		)
		.bind(
			crypto.randomUUID(),
			input.runId,
			path,
			new TextEncoder().encode(content).byteLength,
			content,
			recordedAt,
			`epochs/${input.executionEpoch}/completed.json`,
			`epochs/${input.executionEpoch}/failed.json`,
		)
		.run();
	if ((inserted.meta.changes ?? 0) === 0) {
		if (await isWorkflowInstanceRetired(input.db, input.runId)) {
			throw new Error(
				`WORKFLOW_INSTANCE_RETIRED: run ${input.runId} cannot record execution epoch ${input.executionEpoch} outcome`,
			);
		}
		const existing = await getWorkflowExecutionEpochOutcome(
			input.db,
			input.runId,
			input.executionEpoch,
		);
		if (
			existing?.outcome !== input.outcome ||
			existing.terminalFingerprint !== (input.terminalFingerprint ?? null)
		) {
			throw new Error(
				`WORKFLOW_EPOCH_OUTCOME_CONFLICT: epoch ${input.executionEpoch} already has a different terminal outcome`,
			);
		}
	}
	await backfillWorkflowArtifactSha256(input.db, input.runId, path);
}

/** Read terminal proof emitted by the exact execution epoch. */
export async function getWorkflowExecutionEpochOutcome(
	db: D1Database,
	runId: string,
	executionEpoch: number,
): Promise<WorkflowExecutionEpochOutcomeEvidence | null> {
	const rows = await db
		.prepare(
			`SELECT path, content_inline FROM skill_run_artifacts
			 WHERE run_id = ?1
			   AND path IN (?2, ?3)
			   AND outcome = 'success'
			 LIMIT 2`,
		)
		.bind(
			runId,
			`epochs/${executionEpoch}/completed.json`,
			`epochs/${executionEpoch}/failed.json`,
		)
		.all<{ path: string; content_inline: string | null }>();
	for (const row of rows.results ?? []) {
		const outcome = row.path.endsWith("/completed.json")
			? "completed"
			: row.path.endsWith("/failed.json")
				? "failed"
				: null;
		if (!outcome) continue;
		let terminalFingerprint: string | null = null;
		try {
			const parsed = JSON.parse(row.content_inline ?? "null") as {
				terminalFingerprint?: unknown;
			} | null;
			terminalFingerprint =
				typeof parsed?.terminalFingerprint === "string"
					? parsed.terminalFingerprint
					: null;
		} catch {}
		return { outcome, terminalFingerprint };
	}
	return null;
}

function normalizeFrom(
	from: WorkflowRestartFrom | null | undefined,
): WorkflowRestartFrom | null {
	if (!from) return null;
	return {
		name: from.name,
		...(from.count !== undefined ? { count: from.count } : {}),
		...(from.type !== undefined ? { type: from.type } : {}),
	};
}

function requestMatches(
	left: WorkflowRestartRequest,
	right: WorkflowRestartRequest,
): boolean {
	// `normalizeFrom` gives the fixed-shape restart coordinate a canonical key
	// order, so JSON equality remains exact without accepting partial matches.
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Explicitly close a fail-closed pending/unknown restart after an operator has
 * verified that Cloudflare did not begin the reserved epoch. This never calls
 * the engine; the route separately checks engine status and epoch-start proof.
 */
export async function abortAmbiguousWorkflowRestart(input: {
	db: D1Database;
	runId: string;
	restartId: string;
	executionEpoch: number;
	from?: WorkflowRestartFrom | null;
	reason: string;
	dedupeOnly?: boolean;
}): Promise<{ deduplicated: boolean }> {
	const path = restartPath(input.restartId);
	const row = await input.db
		.prepare(
			`SELECT content_inline FROM skill_run_artifacts
			 WHERE run_id = ?1 AND path = ?2 LIMIT 1`,
		)
		.bind(input.runId, path)
		.first<{ content_inline: string | null }>();
	const prior = parseReceipt(row?.content_inline);
	if (
		!prior ||
		prior.restartId !== input.restartId ||
		prior.executionEpoch !== input.executionEpoch ||
		!requestMatches(prior.request, { from: normalizeFrom(input.from) })
	) {
		throw new WorkflowRestartConflictError(
			"restart abort does not match the active reserved command",
			prior?.status,
		);
	}
	if (prior.status === "accepted") {
		throw new WorkflowRestartConflictError(
			"an accepted restart cannot be aborted",
			prior.status,
		);
	}
	if (prior.status === "rejected") {
		if (prior.resolution?.action === "operator_abort") {
			if (prior.resolution.reason !== input.reason) {
				throw new WorkflowRestartConflictError(
					"restart was already operator-aborted with a different reason",
					prior.status,
				);
			}
			return { deduplicated: true };
		}
		throw new WorkflowRestartConflictError(
			"restart was already rejected for a different reason",
			prior.status,
		);
	}
	if (input.dedupeOnly) {
		throw new WorkflowRestartConflictError(
			"restart intent is no longer active and has no matching completed operator abort",
			prior.status,
		);
	}
	const resolvedAt = new Date().toISOString();
	const rejected: WorkflowRestartReceipt = {
		...prior,
		status: "rejected",
		updatedAt: resolvedAt,
		resolution: {
			action: "operator_abort",
			reason: input.reason,
			resolvedAt,
		},
	};
	const content = JSON.stringify(rejected);
	const [completedPath, failedPath] = epochOutcomePaths(input.executionEpoch);
	const updated = await input.db
		.prepare(
			`UPDATE skill_run_artifacts
			 SET content_inline = ?3, size_bytes = ?4, outcome = 'failure'
			 WHERE run_id = ?1 AND path = ?2 AND content_inline = ?5
			   AND outcome = 'pending'
			   AND NOT EXISTS (
			     SELECT 1 FROM skill_run_artifacts
			      WHERE run_id = ?1
			        AND path IN (?6, ?7, ?8)
			        AND outcome = 'success'
			   )`,
		)
		.bind(
			input.runId,
			path,
			content,
			new TextEncoder().encode(content).byteLength,
			row?.content_inline,
			epochStartPath(input.executionEpoch),
			completedPath,
			failedPath,
		)
		.run();
	if ((updated.meta.changes ?? 0) !== 1) {
		const racedRow = await input.db
			.prepare(
				`SELECT content_inline FROM skill_run_artifacts
				 WHERE run_id = ?1 AND path = ?2 LIMIT 1`,
			)
			.bind(input.runId, path)
			.first<{ content_inline: string | null }>();
		const raced = parseReceipt(racedRow?.content_inline);
		if (
			raced?.restartId === input.restartId &&
			raced.executionEpoch === input.executionEpoch &&
			raced.status === "rejected" &&
			raced.resolution?.action === "operator_abort" &&
			raced.resolution.reason === input.reason &&
			requestMatches(raced.request, { from: normalizeFrom(input.from) })
		) {
			return { deduplicated: true };
		}
		throw new WorkflowRestartConflictError(
			"restart receipt changed while the operator abort was recorded",
			prior.status,
		);
	}
	return { deduplicated: false };
}

function parseReceipt(
	content: string | null | undefined,
): WorkflowRestartReceipt | null {
	if (!content) return null;
	try {
		const value = JSON.parse(content) as Partial<WorkflowRestartReceipt>;
		if (
			typeof value.restartId !== "string" ||
			!value.request ||
			!("from" in value.request) ||
			!(["pending", "accepted", "unknown", "rejected"] as const).includes(
				value.status as WorkflowRestartReceiptStatus,
			) ||
			typeof value.updatedAt !== "string"
		) {
			return null;
		}
		if (
			value.status === "accepted" &&
			(!Number.isInteger(value.executionEpoch) ||
				(value.executionEpoch as number) < 0)
		) {
			return null;
		}
		return value as WorkflowRestartReceipt;
	} catch {
		return null;
	}
}

/** Bind the next epoch to the pending receipt before reserving the run row. */
export async function bindWorkflowRestartExecutionEpoch(input: {
	db: D1Database;
	runId: string;
	path: string;
	pendingContent: string;
	executionEpoch: number;
}): Promise<string> {
	const pending = parseReceipt(input.pendingContent);
	if (pending?.status !== "pending") {
		throw new WorkflowRestartConflictError(
			"workflow restart epoch can only be bound to a pending receipt",
		);
	}
	const content = JSON.stringify({
		...pending,
		executionEpoch: input.executionEpoch,
		updatedAt: new Date().toISOString(),
	} satisfies WorkflowRestartReceipt);
	const updated = await input.db
		.prepare(
			`UPDATE skill_run_artifacts
			 SET content_inline = ?3, size_bytes = ?4
			 WHERE run_id = ?1 AND path = ?2
			   AND content_inline = ?5 AND outcome = 'pending'`,
		)
		.bind(
			input.runId,
			input.path,
			content,
			new TextEncoder().encode(content).byteLength,
			input.pendingContent,
		)
		.run();
	if ((updated.meta?.changes ?? 0) === 1) return content;
	throw new WorkflowRestartConflictError(
		"workflow restart receipt changed before its execution epoch could be bound",
		"pending",
	);
}

async function findWorkflowRestartReceipt(input: {
	db: D1Database;
	runId: string;
	executionEpoch: number;
	restartCommandId?: string | null;
}): Promise<LocatedWorkflowRestartReceipt | null> {
	if (input.restartCommandId) {
		const path = restartPath(input.restartCommandId);
		const row = await input.db
			.prepare(
				`SELECT content_inline FROM skill_run_artifacts
				 WHERE run_id = ?1 AND path = ?2 LIMIT 1`,
			)
			.bind(input.runId, path)
			.first<{ content_inline: string | null }>();
		const receipt = parseReceipt(row?.content_inline);
		if (
			!receipt ||
			receipt.restartId !== input.restartCommandId ||
			receipt.executionEpoch !== input.executionEpoch ||
			!row?.content_inline
		) {
			return null;
		}
		return { path, content: row.content_inline, receipt };
	}

	const row = await input.db
		.prepare(
			`SELECT path, content_inline FROM skill_run_artifacts
			 WHERE run_id = ?1
			   AND path LIKE 'controls/restarts/%'
			   AND outcome = 'success'
			   AND json_extract(content_inline, '$.status') = 'accepted'
			   AND json_extract(content_inline, '$.executionEpoch') = ?2
			 LIMIT 1`,
		)
		.bind(input.runId, input.executionEpoch)
		.first<{ path: string; content_inline: string | null }>();
	const receipt = parseReceipt(row?.content_inline);
	return row?.content_inline && receipt?.status === "accepted"
		? { path: row.path, content: row.content_inline, receipt }
		: null;
}

/**
 * Resolve the active accepted receipt. If the Worker crashed after native
 * restart acceptance but before finalization, epoch start evidence promotes
 * the exact run-reserved pending/unknown command to accepted.
 */
export async function resolveAcceptedWorkflowRestart(input: {
	db: D1Database;
	runId: string;
	executionEpoch: number;
	restartCommandId?: string | null;
	executionEpochStarted: boolean;
}): Promise<WorkflowRestartReceipt | null> {
	const located = await findWorkflowRestartReceipt(input);
	if (!located) return null;
	if (located.receipt.status === "accepted") return located.receipt;
	if (
		!input.restartCommandId ||
		!input.executionEpochStarted ||
		(located.receipt.status !== "pending" &&
			located.receipt.status !== "unknown")
	) {
		return null;
	}

	const accepted: WorkflowRestartReceipt = {
		...located.receipt,
		status: "accepted",
		executionEpoch: input.executionEpoch,
		updatedAt: new Date().toISOString(),
	};
	const content = JSON.stringify(accepted);
	const updated = await input.db
		.prepare(
			`UPDATE skill_run_artifacts
			 SET content_inline = ?3, size_bytes = ?4, outcome = 'success'
			 WHERE run_id = ?1 AND path = ?2
			   AND content_inline = ?5
			   AND outcome = 'pending'`,
		)
		.bind(
			input.runId,
			located.path,
			content,
			new TextEncoder().encode(content).byteLength,
			located.content,
		)
		.run();
	if ((updated.meta?.changes ?? 0) === 1) return accepted;

	const raced = await findWorkflowRestartReceipt(input);
	return raced?.receipt.status === "accepted" ? raced.receipt : null;
}

/**
 * Atomically reserve a caller-provided restart command before invoking the
 * Workflows engine. A repeated accepted (or definitively rejected) command is
 * returned as a terminal deduplicated receipt; ambiguous delivery is never
 * guessed or retried.
 */
export async function claimWorkflowRestart(input: {
	db: D1Database;
	runId: string;
	restartId: string;
	from?: WorkflowRestartFrom | null;
}): Promise<WorkflowRestartClaim> {
	const path = restartPath(input.restartId);
	const request: WorkflowRestartRequest = {
		from: normalizeFrom(input.from),
	};
	const receipt: WorkflowRestartReceipt & { status: "pending" } = {
		restartId: input.restartId,
		request,
		status: "pending",
		updatedAt: new Date().toISOString(),
	};
	const content = JSON.stringify(receipt);
	const result = await input.db
		.prepare(
			`INSERT INTO skill_run_artifacts (
			   id, run_id, path, mime_type, size_bytes, content_inline,
			   attempt, outcome, created_at
			 )
			 SELECT ?1, ?2, ?3, 'application/json', ?4, ?5, 1, 'pending', ?6
			 WHERE EXISTS (
			   SELECT 1 FROM skill_runs
			    WHERE id = ?2
			      AND restart_requested_at IS NULL
			      AND workflow_retired_at IS NULL
			      AND COALESCE(error, '') <> 'REVOKED'
			      AND COALESCE(error, '') NOT GLOB 'REVOKED:*'
			 )
			   AND NOT EXISTS (
			     SELECT 1 FROM skill_run_artifacts
			      WHERE run_id = ?2
			        AND path LIKE 'controls/restarts/%'
			        AND CASE WHEN json_valid(content_inline)
			          THEN json_extract(content_inline, '$.status') END = 'rejected'
			        AND CASE WHEN json_valid(content_inline)
			          THEN json_extract(content_inline, '$.resolution.action') END = 'operator_abort'
			   )
			 ON CONFLICT(run_id, path) DO NOTHING`,
		)
		.bind(
			crypto.randomUUID(),
			input.runId,
			path,
			new TextEncoder().encode(content).byteLength,
			content,
			receipt.updatedAt,
		)
		.run();
	if ((result.meta?.changes ?? 0) > 0) {
		return { deduplicated: false, path, receipt, pendingContent: content };
	}
	if (await isWorkflowInstanceRetired(input.db, input.runId)) {
		throw new WorkflowRestartConflictError(
			"this Workflow instance is permanently retired; start a new run with a new runId/idempotencyKey instead of restarting it",
			"rejected",
		);
	}

	const existing = await input.db
		.prepare(
			`SELECT content_inline FROM skill_run_artifacts
			 WHERE run_id = ?1 AND path = ?2 LIMIT 1`,
		)
		.bind(input.runId, path)
		.first<{ content_inline: string | null }>();
	const prior = parseReceipt(existing?.content_inline);
	if (!prior || prior.restartId !== input.restartId) {
		throw new WorkflowRestartConflictError(
			`restart ${input.restartId} cannot be claimed while another restart intent is open or the run is unavailable; inspect the run before taking another action`,
		);
	}
	if (!requestMatches(prior.request, request)) {
		throw new WorkflowRestartConflictError(
			`restart ${input.restartId} was already claimed with a different from request`,
			prior.status,
		);
	}
	if (prior.status === "pending" || prior.status === "unknown") {
		throw new WorkflowRestartConflictError(
			`restart ${input.restartId} has an ambiguous or in-flight delivery; inspect the run before taking another action`,
			prior.status,
		);
	}
	if (prior.status === "accepted") {
		return {
			deduplicated: true,
			path,
			receipt: prior as WorkflowRestartReceipt & {
				status: "accepted";
				executionEpoch: number;
			},
		};
	}
	return {
		deduplicated: true,
		path,
		receipt: prior as WorkflowRestartReceipt & { status: "rejected" },
	};
}

/** Persist the definitive or ambiguous outcome of one reserved restart. */
export async function finalizeWorkflowRestart(input: {
	db: D1Database;
	runId: string;
	path: string;
	restartId: string;
	from?: WorkflowRestartFrom | null;
	pendingContent: string;
	result: WorkflowRestartFinalization;
}): Promise<void> {
	const receipt: WorkflowRestartReceipt = {
		restartId: input.restartId,
		request: { from: normalizeFrom(input.from) },
		status: input.result.status,
		...(input.result.executionEpoch !== undefined
			? { executionEpoch: input.result.executionEpoch }
			: {}),
		updatedAt: new Date().toISOString(),
	};
	const content = JSON.stringify(receipt);
	const outcome =
		input.result.status === "accepted"
			? "success"
			: input.result.status === "rejected"
				? "failure"
				: "pending";
	const updated = await input.db
		.prepare(
			`UPDATE skill_run_artifacts
			 SET content_inline = ?3, size_bytes = ?4, outcome = ?5
			 WHERE run_id = ?1 AND path = ?2
			   AND content_inline = ?6 AND outcome = 'pending'`,
		)
		.bind(
			input.runId,
			input.path,
			content,
			new TextEncoder().encode(content).byteLength,
			outcome,
			input.pendingContent,
		)
		.run();
	if ((updated.meta?.changes ?? 0) !== 1) {
		const existing = await input.db
			.prepare(
				`SELECT content_inline FROM skill_run_artifacts
				 WHERE run_id = ?1 AND path = ?2 LIMIT 1`,
			)
			.bind(input.runId, input.path)
			.first<{ content_inline: string | null }>();
		const prior = parseReceipt(existing?.content_inline);
		if (
			prior?.restartId === input.restartId &&
			prior.status === input.result.status &&
			prior.executionEpoch === input.result.executionEpoch &&
			requestMatches(prior.request, receipt.request)
		) {
			return;
		}
		throw new WorkflowRestartConflictError(
			`restart ${input.restartId} receipt changed while the outcome was being finalized`,
		);
	}
}
