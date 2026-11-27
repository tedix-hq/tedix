import type { DbClient } from "@tedix/db/client";
import {
	backfillSkillRunArtifactSha256,
	compareAndSetSkillRunPendingReceipt,
	findAcceptedSkillRunRestartReceipt,
	getSkillRunArtifactContentAndSha256,
	getSkillRunRestartRetirementEvidence,
	hasSkillRunSuccessArtifact,
	insertSkillRunEpochOutcomeFence,
	insertSkillRunEpochStartedFence,
	insertSkillRunRestartReceipt,
	isSkillRunWorkflowRetired,
	listSkillRunSuccessArtifacts,
	retireUnstartedSkillRunRestart,
} from "@tedix/db/queries/skill-runtime-fences";
import { getRuntimeArtifactInlineContent } from "@tedix/db/queries/skill-runtime-store";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { skillRuntimeDb } from "./db";
import { encodeWorkflowArtifactPathSegment } from "./workflow-path";

/** A raw binding resolves to the request's selected core store. */
type WorkflowFenceDb = D1Database | DbClient;

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
	db: WorkflowFenceDb,
	runId: string,
): Promise<boolean> {
	return isSkillRunWorkflowRetired(skillRuntimeDb(db), runId);
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
	db: DbClient,
	runId: string,
	path: string,
): Promise<void> {
	const row = await getSkillRunArtifactContentAndSha256(db, runId, path);
	if (row?.content_inline == null || row.sha256 != null) return;
	await backfillSkillRunArtifactSha256(db, {
		runId,
		path,
		content: row.content_inline,
		sha256: await sha256Hex(row.content_inline),
	});
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
	db: WorkflowFenceDb;
	runId: string;
	executionEpoch: number;
}): Promise<void> {
	const db = skillRuntimeDb(input.db);
	const path = epochStartPath(input.executionEpoch);
	const startedAt = new Date().toISOString();
	const content = JSON.stringify({
		executionEpoch: input.executionEpoch,
		startedAt,
	});
	const inserted = await insertSkillRunEpochStartedFence(db, {
		id: crypto.randomUUID(),
		runId: input.runId,
		path,
		content,
		createdAt: startedAt,
	});
	// Hash after the fence lands, never before. This insert is the epoch fence
	// that restart-safety races against (start must beat a concurrent abort), so
	// it has to be the first thing this function does to the DB — awaiting a
	// digest first widens that race window and lets an abort win. The digest is
	// evidence integrity, not a fence, so it patches the row afterwards.
	if (!inserted && (await isSkillRunWorkflowRetired(db, input.runId))) {
		throw new Error(
			`WORKFLOW_INSTANCE_RETIRED: run ${input.runId} cannot enter execution epoch ${input.executionEpoch}`,
		);
	}
	await backfillWorkflowArtifactSha256(db, input.runId, path);
}

/** Durable proof that the new epoch entered the static workflow factory. */
export async function hasWorkflowExecutionEpochStarted(
	db: WorkflowFenceDb,
	runId: string,
	executionEpoch: number,
): Promise<boolean> {
	return hasSkillRunSuccessArtifact(
		skillRuntimeDb(db),
		runId,
		epochStartPath(executionEpoch),
	);
}

/** Record a factory-level failure before the dynamic tenant module can run. */
export async function recordWorkflowExecutionEpochOutcome(input: {
	db: WorkflowFenceDb;
	runId: string;
	executionEpoch: number;
	outcome: Exclude<WorkflowExecutionEpochOutcome, null>;
	terminalFingerprint?: string | null;
}): Promise<void> {
	const db = skillRuntimeDb(input.db);
	const path = `epochs/${input.executionEpoch}/${input.outcome}.json`;
	const recordedAt = new Date().toISOString();
	const content = JSON.stringify({
		executionEpoch: input.executionEpoch,
		outcome: input.outcome,
		terminalFingerprint: input.terminalFingerprint ?? null,
		recordedAt,
	});
	const inserted = await insertSkillRunEpochOutcomeFence(db, {
		id: crypto.randomUUID(),
		runId: input.runId,
		path,
		content,
		createdAt: recordedAt,
		outcomePaths: epochOutcomePaths(input.executionEpoch),
	});
	if (!inserted) {
		if (await isSkillRunWorkflowRetired(db, input.runId)) {
			throw new Error(
				`WORKFLOW_INSTANCE_RETIRED: run ${input.runId} cannot record execution epoch ${input.executionEpoch} outcome`,
			);
		}
		const existing = await getWorkflowExecutionEpochOutcome(
			db,
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
	await backfillWorkflowArtifactSha256(db, input.runId, path);
}

/** Read terminal proof emitted by the exact execution epoch. */
export async function getWorkflowExecutionEpochOutcome(
	db: WorkflowFenceDb,
	runId: string,
	executionEpoch: number,
): Promise<WorkflowExecutionEpochOutcomeEvidence | null> {
	const rows = await listSkillRunSuccessArtifacts(
		skillRuntimeDb(db),
		runId,
		epochOutcomePaths(executionEpoch),
	);
	for (const row of rows) {
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
	db: WorkflowFenceDb;
	runId: string;
	restartId: string;
	executionEpoch: number;
	from?: WorkflowRestartFrom | null;
	reason: string;
	dedupeOnly?: boolean;
}): Promise<{ deduplicated: boolean }> {
	const db = skillRuntimeDb(input.db);
	const path = restartPath(input.restartId);
	const row = await getRuntimeArtifactInlineContent(db, input.runId, path);
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
	// parseReceipt accepted the row above, so its content is non-null.
	const updated = await compareAndSetSkillRunPendingReceipt(db, {
		runId: input.runId,
		path,
		content,
		expectedContent: row!.content_inline!,
		outcome: "failure",
		absentSuccessPaths: [
			epochStartPath(input.executionEpoch),
			completedPath,
			failedPath,
		],
	});
	if (!updated) {
		const racedRow = await getRuntimeArtifactInlineContent(
			db,
			input.runId,
			path,
		);
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
	db: WorkflowFenceDb;
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
	const updated = await compareAndSetSkillRunPendingReceipt(
		skillRuntimeDb(input.db),
		{
			runId: input.runId,
			path: input.path,
			content,
			expectedContent: input.pendingContent,
		},
	);
	if (updated) return content;
	throw new WorkflowRestartConflictError(
		"workflow restart receipt changed before its execution epoch could be bound",
		"pending",
	);
}

async function findWorkflowRestartReceipt(input: {
	db: DbClient;
	runId: string;
	executionEpoch: number;
	restartCommandId?: string | null;
}): Promise<LocatedWorkflowRestartReceipt | null> {
	if (input.restartCommandId) {
		const path = restartPath(input.restartCommandId);
		const row = await getRuntimeArtifactInlineContent(
			input.db,
			input.runId,
			path,
		);
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

	const row = await findAcceptedSkillRunRestartReceipt(
		input.db,
		input.runId,
		input.executionEpoch,
	);
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
	db: WorkflowFenceDb;
	runId: string;
	executionEpoch: number;
	restartCommandId?: string | null;
	executionEpochStarted: boolean;
}): Promise<WorkflowRestartReceipt | null> {
	const lookup = { ...input, db: skillRuntimeDb(input.db) };
	const located = await findWorkflowRestartReceipt(lookup);
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
	const updated = await compareAndSetSkillRunPendingReceipt(lookup.db, {
		runId: input.runId,
		path: located.path,
		content,
		expectedContent: located.content,
		outcome: "success",
	});
	if (updated) return accepted;

	const raced = await findWorkflowRestartReceipt(lookup);
	return raced?.receipt.status === "accepted" ? raced.receipt : null;
}

/**
 * Atomically reserve a caller-provided restart command before invoking the
 * Workflows engine. A repeated accepted (or definitively rejected) command is
 * returned as a terminal deduplicated receipt; ambiguous delivery is never
 * guessed or retried.
 */
export async function claimWorkflowRestart(input: {
	db: WorkflowFenceDb;
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
	const db = skillRuntimeDb(input.db);
	const inserted = await insertSkillRunRestartReceipt(db, {
		id: crypto.randomUUID(),
		runId: input.runId,
		path,
		content,
		createdAt: receipt.updatedAt,
	});
	if (inserted) {
		return { deduplicated: false, path, receipt, pendingContent: content };
	}
	if (await isSkillRunWorkflowRetired(db, input.runId)) {
		throw new WorkflowRestartConflictError(
			"this Workflow instance is permanently retired; start a new run with a new runId/idempotencyKey instead of restarting it",
			"rejected",
		);
	}

	const existing = await getRuntimeArtifactInlineContent(db, input.runId, path);
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
	db: WorkflowFenceDb;
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
	const db = skillRuntimeDb(input.db);
	const updated = await compareAndSetSkillRunPendingReceipt(db, {
		runId: input.runId,
		path: input.path,
		content,
		expectedContent: input.pendingContent,
		outcome,
	});
	if (!updated) {
		const existing = await getRuntimeArtifactInlineContent(
			db,
			input.runId,
			input.path,
		);
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

interface UnstartedRestartRetirement {
	version: 1;
	action: "retire_unstarted_restart";
	runId: string;
	restartId: string;
	executionEpoch: number;
	request: WorkflowRestartRequest;
	reason: string;
	acceptedReceiptSha256: string;
	retiredAt: string;
	engine: { status: "complete" | "errored"; observedAt: string };
}

/** Retire before submission repair; the original accepted command stays immutable. */
export async function retireUnstartedWorkflowRestart(input: {
	db: WorkflowFenceDb;
	runId: string;
	organizationId: string;
	runtimeEnvironment: string;
	restartId: string;
	executionEpoch: number;
	from?: WorkflowRestartFrom | null;
	reason: string;
	engine: { status: string; observedAt: string } | null;
}): Promise<{ deduplicated: boolean; receipt: UnstartedRestartRetirement }> {
	const path = `controls/restart-retirements/${encodeWorkflowArtifactPathSegment(input.restartId)}.json`;
	const request = { from: normalizeFrom(input.from) };
	const db = skillRuntimeDb(input.db);
	const readRetirement = async () => {
		const row = await getSkillRunRestartRetirementEvidence(db, {
			runId: input.runId,
			path,
			organizationId: input.organizationId,
			runtimeEnvironment: input.runtimeEnvironment,
			executionEpoch: input.executionEpoch,
		});
		if (!row) return null;
		let receipt: UnstartedRestartRetirement;
		try {
			receipt = JSON.parse(row.content_inline ?? "null");
		} catch {
			throw new WorkflowRestartConflictError("retirement evidence is invalid");
		}
		if (
			!row.workflow_retired_at ||
			row.workflow_retired_at !== receipt?.retiredAt ||
			receipt?.version !== 1 ||
			receipt.action !== "retire_unstarted_restart" ||
			receipt.runId !== input.runId ||
			receipt.restartId !== input.restartId ||
			receipt.executionEpoch !== input.executionEpoch ||
			receipt.reason !== input.reason ||
			!requestMatches(receipt.request, request)
		) {
			throw new WorkflowRestartConflictError(
				"retirement does not match this exact command or permanent tombstone",
			);
		}
		return receipt;
	};
	const existing = await readRetirement();
	if (existing) return { deduplicated: true, receipt: existing };
	if (
		!input.reason.trim() ||
		!input.engine ||
		!["complete", "errored"].includes(input.engine.status)
	) {
		throw new WorkflowRestartConflictError(
			"retiring an unstarted restart requires an audit reason and a first-hand terminal engine read",
		);
	}
	const accepted = await findWorkflowRestartReceipt({
		db,
		runId: input.runId,
		executionEpoch: input.executionEpoch,
		restartCommandId: input.restartId,
	});
	if (
		accepted?.receipt.status !== "accepted" ||
		!requestMatches(accepted.receipt.request, request)
	) {
		throw new WorkflowRestartConflictError(
			"retirement requires the exact accepted restart receipt and reserved epoch",
		);
	}
	const retiredAt = new Date().toISOString();
	const receipt: UnstartedRestartRetirement = {
		version: 1,
		action: "retire_unstarted_restart",
		runId: input.runId,
		restartId: input.restartId,
		executionEpoch: input.executionEpoch,
		request,
		reason: input.reason,
		acceptedReceiptSha256: await sha256Hex(accepted.content),
		retiredAt,
		engine: {
			status: input.engine.status as "complete" | "errored",
			observedAt: input.engine.observedAt,
		},
	};
	const content = JSON.stringify(receipt);
	// This atomic unit and the factory's epoch-start INSERT arbitrate on the
	// same store. Any marker, including malformed/pending evidence, prevents
	// absence claims.
	const { retired, recorded } = await retireUnstartedSkillRunRestart(db, {
		runId: input.runId,
		organizationId: input.organizationId,
		runtimeEnvironment: input.runtimeEnvironment,
		executionEpoch: input.executionEpoch,
		restartId: input.restartId,
		retiredAt,
		acceptedPath: accepted.path,
		acceptedContent: accepted.content,
		epochPaths: [
			epochStartPath(input.executionEpoch),
			...epochOutcomePaths(input.executionEpoch),
		],
		evidence: {
			id: crypto.randomUUID(),
			path,
			content,
			sha256: await sha256Hex(content),
		},
	});
	if (retired && recorded) return { deduplicated: false, receipt };
	const raced = await readRetirement();
	if (raced) return { deduplicated: true, receipt: raced };
	throw new WorkflowRestartConflictError(
		"restart changed or epoch evidence exists; no retirement was claimed",
	);
}
