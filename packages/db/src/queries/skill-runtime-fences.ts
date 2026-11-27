/**
 * Workflow restart, epoch and approval fences on `skill_runs` and
 * `skill_run_artifacts`. Every guarded write is one statement (or one atomic
 * batch) so the run-row tombstone, REVOKED markers and operator-abort receipts
 * arbitrate on the selected core store exactly as they do on D1.
 */
import {
	and,
	eq,
	exists,
	inArray,
	isNotNull,
	isNull,
	not,
	notExists,
	or,
	sql,
	type SQL,
	type SQLWrapper,
} from "drizzle-orm";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { coreStore, jsonRead, likeText } from "../core-store/dialect";
import { skillRunArtifacts, skillRuns } from "../schema/cognitive";

type ArtifactOutcome = "pending" | "success" | "failure";

function byteLength(content: string): number {
	return new TextEncoder().encode(content).byteLength;
}

/** INSERT … SELECT resolves untyped Postgres parameters to text. */
function bigintValue(db: DbClient, value: number): SQL<number> {
	return coreStore(db) === "postgres"
		? sql<number>`${value}::bigint`
		: sql<number>`${value}`;
}

/** The legacy REVOKED audit markers: exactly `REVOKED` or a `REVOKED:` prefix. */
function revokedMarker(error: SQLWrapper): SQL {
	return sql`(COALESCE(${error}, '') = 'REVOKED' OR substr(COALESCE(${error}, ''), 1, 8) = 'REVOKED:')`;
}

/** Run row is not tombstoned and carries no legacy REVOKED audit marker. */
function runEnterable(db: DbClient): SQL {
	const r = coreTable(db, skillRuns);
	return and(isNull(r.workflowRetiredAt), not(revokedMarker(r.error)))!;
}

/** A JSON field of `content_inline`, or NULL when the content is not JSON. */
function receiptField(
	db: DbClient,
	path: readonly string[],
	kind: "text" | "number" = "text",
): SQL {
	const content = coreTable(db, skillRunArtifacts).contentInline;
	return coreStore(db) === "postgres"
		? sql`CASE WHEN ${content} IS JSON THEN ${jsonRead(db, sql`(${content})::jsonb`, path, kind)} END`
		: sql`CASE WHEN json_valid(${content}) THEN ${jsonRead(db, content, path, kind)} END`;
}

/** An operator-aborted restart receipt permanently retires the instance. */
function operatorAbortedRestart(db: DbClient, runId: string) {
	const a = coreTable(db, skillRunArtifacts);
	return db
		.select({ id: a.id })
		.from(a)
		.where(
			and(
				eq(a.runId, runId),
				likeText(db, a.path, "controls/restarts/%"),
				sql`${receiptField(db, ["status"])} = 'rejected'`,
				sql`${receiptField(db, ["resolution", "action"])} = 'operator_abort'`,
			),
		);
}

export async function isSkillRunWorkflowRetired(
	db: DbClient,
	runId: string,
): Promise<boolean> {
	const r = coreTable(db, skillRuns);
	const [run] = await db
		.select({ id: r.id })
		.from(r)
		.where(
			and(
				eq(r.id, runId),
				or(isNotNull(r.workflowRetiredAt), revokedMarker(r.error)),
			),
		)
		.limit(1);
	if (run) return true;
	const [aborted] = await operatorAbortedRestart(db, runId).limit(1);
	return aborted != null;
}

interface GuardedArtifactInput {
	id: string;
	runId: string;
	path: string;
	content: string;
	createdAt: string;
}

/**
 * INSERT … SELECT from the run's own row (its primary key), so the guard and
 * the write are one statement. A conflicting path inserts nothing.
 */
async function insertGuardedArtifact(
	db: DbClient,
	input: GuardedArtifactInput,
	outcome: ArtifactOutcome,
	guard: SQL | undefined,
): Promise<boolean> {
	const r = coreTable(db, skillRuns);
	const a = coreTable(db, skillRunArtifacts);
	const rows = await db
		.insert(a)
		.select(
			db
				.select({
					id: sql<string>`${input.id}`.as("id"),
					runId: sql<string>`${input.runId}`.as("run_id"),
					path: sql<string>`${input.path}`.as("path"),
					mimeType: sql<string>`'application/json'`.as("mime_type"),
					sizeBytes: bigintValue(db, byteLength(input.content)).as(
						"size_bytes",
					),
					contentInline: sql<string>`${input.content}`.as("content_inline"),
					attempt: sql<number>`1`.as("attempt"),
					outcome: sql<ArtifactOutcome>`${outcome}`.as("outcome"),
					createdAt: sql<string>`${input.createdAt}`.as("created_at"),
				})
				.from(r)
				.where(and(eq(r.id, input.runId), runEnterable(db), guard)),
		)
		.onConflictDoNothing({ target: [a.runId, a.path] })
		.returning({ id: a.id });
	return rows.length > 0;
}

/** First entry into an epoch; refused once the instance is retired. */
export function insertSkillRunEpochStartedFence(
	db: DbClient,
	input: GuardedArtifactInput,
): Promise<boolean> {
	return insertGuardedArtifact(
		db,
		input,
		"success",
		notExists(operatorAbortedRestart(db, input.runId)),
	);
}

/** One terminal outcome per epoch; refused once the instance is retired. */
export function insertSkillRunEpochOutcomeFence(
	db: DbClient,
	input: GuardedArtifactInput & { outcomePaths: readonly [string, string] },
): Promise<boolean> {
	const a = coreTable(db, skillRunArtifacts);
	return insertGuardedArtifact(
		db,
		input,
		"success",
		notExists(
			db
				.select({ id: a.id })
				.from(a)
				.where(
					and(
						eq(a.runId, input.runId),
						inArray(a.path, [input.outcomePaths[0], input.outcomePaths[1]]),
					),
				),
		),
	);
}

/** Pending restart receipt, only while no restart intent is open. */
export function insertSkillRunRestartReceipt(
	db: DbClient,
	input: GuardedArtifactInput,
): Promise<boolean> {
	const r = coreTable(db, skillRuns);
	return insertGuardedArtifact(
		db,
		input,
		"pending",
		and(
			isNull(r.restartRequestedAt),
			notExists(operatorAbortedRestart(db, input.runId)),
		),
	);
}

/** Pending approval receipt, only for the active, non-terminal epoch. */
export function insertSkillRunApprovalReceipt(
	db: DbClient,
	input: GuardedArtifactInput & { executionEpoch: number },
): Promise<boolean> {
	const r = coreTable(db, skillRuns);
	return insertGuardedArtifact(
		db,
		input,
		"pending",
		and(
			eq(r.executionEpoch, input.executionEpoch),
			isNull(r.restartRequestedAt),
			sql`${r.status} NOT IN ('completed','failed','canceled')`,
		),
	);
}

/**
 * Replace a pending receipt only if it still holds the expected bytes.
 * `absentSuccessPaths` additionally refuses the write once any of those
 * artifacts has a success outcome.
 */
export async function compareAndSetSkillRunPendingReceipt(
	db: DbClient,
	input: {
		runId: string;
		path: string;
		content: string;
		expectedContent: string;
		outcome?: ArtifactOutcome;
		absentSuccessPaths?: readonly [string, string, string];
	},
): Promise<boolean> {
	const a = coreTable(db, skillRunArtifacts);
	const rows = await db
		.update(a)
		.set({
			contentInline: input.content,
			sizeBytes: byteLength(input.content),
			...(input.outcome ? { outcome: input.outcome } : {}),
		})
		.where(
			and(
				eq(a.runId, input.runId),
				eq(a.path, input.path),
				eq(a.contentInline, input.expectedContent),
				eq(a.outcome, "pending"),
				input.absentSuccessPaths
					? notExists(
							db
								.select({ id: a.id })
								.from(a)
								.where(
									and(
										eq(a.runId, input.runId),
										inArray(a.path, [
											input.absentSuccessPaths[0],
											input.absentSuccessPaths[1],
											input.absentSuccessPaths[2],
										]),
										eq(a.outcome, "success"),
									),
								),
						)
					: undefined,
			),
		)
		.returning({ id: a.id });
	return rows.length === 1;
}

export async function getSkillRunArtifactContentAndSha256(
	db: DbClient,
	runId: string,
	path: string,
): Promise<{ content_inline: string | null; sha256: string | null } | null> {
	const t = coreTable(db, skillRunArtifacts);
	const [row] = await db
		.select({ content_inline: t.contentInline, sha256: t.sha256 })
		.from(t)
		.where(and(eq(t.runId, runId), eq(t.path, path)))
		.limit(1);
	return row ?? null;
}

/** Content-address stored bytes once; never overwrite an existing digest. */
export async function backfillSkillRunArtifactSha256(
	db: DbClient,
	input: { runId: string; path: string; content: string; sha256: string },
): Promise<void> {
	const t = coreTable(db, skillRunArtifacts);
	await db
		.update(t)
		.set({ sha256: input.sha256 })
		.where(
			and(
				eq(t.runId, input.runId),
				eq(t.path, input.path),
				eq(t.contentInline, input.content),
				isNull(t.sha256),
			),
		);
}

export async function hasSkillRunSuccessArtifact(
	db: DbClient,
	runId: string,
	path: string,
): Promise<boolean> {
	const t = coreTable(db, skillRunArtifacts);
	const [row] = await db
		.select({ id: t.id })
		.from(t)
		.where(and(eq(t.runId, runId), eq(t.path, path), eq(t.outcome, "success")))
		.limit(1);
	return row != null;
}

export async function listSkillRunSuccessArtifacts(
	db: DbClient,
	runId: string,
	paths: readonly [string, string],
): Promise<Array<{ path: string; content_inline: string | null }>> {
	const t = coreTable(db, skillRunArtifacts);
	return db
		.select({ path: t.path, content_inline: t.contentInline })
		.from(t)
		.where(
			and(
				eq(t.runId, runId),
				inArray(t.path, [paths[0], paths[1]]),
				eq(t.outcome, "success"),
			),
		)
		.limit(paths.length);
}

/** The accepted restart receipt that reserved this exact epoch. */
export async function findAcceptedSkillRunRestartReceipt(
	db: DbClient,
	runId: string,
	executionEpoch: number,
): Promise<{ path: string; content_inline: string | null } | null> {
	const t = coreTable(db, skillRunArtifacts);
	// D1 keeps its historical unguarded json_extract; Postgres cannot cast
	// non-JSON text, so it reads only JSON content.
	const field = (path: readonly string[], kind?: "number") =>
		coreStore(db) === "postgres"
			? receiptField(db, path, kind)
			: jsonRead(db, t.contentInline, path);
	const [row] = await db
		.select({ path: t.path, content_inline: t.contentInline })
		.from(t)
		.where(
			and(
				eq(t.runId, runId),
				likeText(db, t.path, "controls/restarts/%"),
				eq(t.outcome, "success"),
				sql`${field(["status"])} = 'accepted'`,
				sql`${field(["executionEpoch"], "number")} = ${executionEpoch}`,
			),
		)
		.limit(1);
	return row ?? null;
}

/** Retirement evidence, joined to the exact run, tenant and epoch. */
export async function getSkillRunRestartRetirementEvidence(
	db: DbClient,
	input: {
		runId: string;
		path: string;
		organizationId: string;
		runtimeEnvironment: string;
		executionEpoch: number;
	},
): Promise<{
	content_inline: string | null;
	workflow_retired_at: string | null;
} | null> {
	const a = coreTable(db, skillRunArtifacts);
	const r = coreTable(db, skillRuns);
	const [row] = await db
		.select({
			content_inline: a.contentInline,
			workflow_retired_at: r.workflowRetiredAt,
		})
		.from(a)
		.innerJoin(r, eq(r.id, a.runId))
		.where(
			and(
				eq(a.runId, input.runId),
				eq(a.path, input.path),
				eq(r.organizationId, input.organizationId),
				sql`${r.runtimeEnvironment} = ${input.runtimeEnvironment}`,
				eq(r.executionEpoch, input.executionEpoch),
			),
		)
		.limit(1);
	return row ?? null;
}

/**
 * Tombstone the run and record its retirement evidence in one atomic batch.
 * The tombstone requires the exact accepted receipt and the absence of any
 * epoch start/outcome or prior retirement artifact; the evidence row is
 * written only when this batch's own UPDATE landed the tombstone.
 */
export async function retireUnstartedSkillRunRestart(
	db: DbClient,
	input: {
		runId: string;
		organizationId: string;
		runtimeEnvironment: string;
		executionEpoch: number;
		restartId: string;
		retiredAt: string;
		acceptedPath: string;
		acceptedContent: string;
		/** Epoch start, completed and failed artifact paths. */
		epochPaths: readonly [string, string, string];
		evidence: { id: string; path: string; content: string; sha256: string };
	},
): Promise<{ retired: boolean; recorded: boolean }> {
	const r = coreTable(db, skillRuns);
	const a = coreTable(db, skillRunArtifacts);
	const runMatches = and(
		eq(r.id, input.runId),
		eq(r.organizationId, input.organizationId),
		sql`${r.runtimeEnvironment} = ${input.runtimeEnvironment}`,
		eq(r.executionEpoch, input.executionEpoch),
		eq(r.restartCommandId, input.restartId),
	);
	const tombstone = db
		.update(r)
		.set({ workflowRetiredAt: input.retiredAt })
		.where(
			and(
				runMatches,
				isNotNull(r.restartRequestedAt),
				runEnterable(db),
				exists(
					db
						.select({ id: a.id })
						.from(a)
						.where(
							and(
								eq(a.runId, input.runId),
								eq(a.path, input.acceptedPath),
								eq(a.contentInline, input.acceptedContent),
								eq(a.outcome, "success"),
							),
						),
				),
				notExists(
					db
						.select({ id: a.id })
						.from(a)
						.where(
							and(
								eq(a.runId, input.runId),
								inArray(a.path, [
									input.epochPaths[0],
									input.epochPaths[1],
									input.epochPaths[2],
									input.evidence.path,
								]),
							),
						),
				),
			),
		)
		.returning({ retired_run_id: r.id });
	// "This batch's UPDATE changed the row": changes() on D1's shared batch
	// connection; on Postgres the row version was written by this transaction.
	const tombstonedHere =
		coreStore(db) === "postgres"
			? sql`${r}.xmin = pg_current_xact_id()::xid`
			: sql`changes() = 1`;
	const evidence = db
		.insert(a)
		.select(
			db
				.select({
					id: sql<string>`${input.evidence.id}`.as("id"),
					runId: sql<string>`${input.runId}`.as("run_id"),
					path: sql<string>`${input.evidence.path}`.as("path"),
					mimeType: sql<string>`'application/json'`.as("mime_type"),
					sizeBytes: bigintValue(db, byteLength(input.evidence.content)).as(
						"size_bytes",
					),
					contentInline: sql<string>`${input.evidence.content}`.as(
						"content_inline",
					),
					sha256: sql<string>`${input.evidence.sha256}`.as("sha256"),
					attempt: sql<number>`1`.as("attempt"),
					outcome: sql<ArtifactOutcome>`'success'`.as("outcome"),
					createdAt: sql<string>`${input.retiredAt}`.as("created_at"),
				})
				.from(r)
				.where(
					and(
						tombstonedHere,
						runMatches,
						eq(r.workflowRetiredAt, input.retiredAt),
					),
				),
		)
		.onConflictDoNothing({ target: [a.runId, a.path] })
		.returning({ retirement_artifact_id: a.id });
	const [retired, recorded] = await db.batch([tombstone, evidence]);
	return { retired: retired.length === 1, recorded: recorded.length === 1 };
}
