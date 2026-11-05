/**
 * Tenant-store variant of `../skill-run-artifacts.ts`.
 *
 * Same `skill_run_artifacts` rows and path grammar; the storage plane changes
 * three things and only those:
 *
 * - Bodies stay in R2, unconditionally. `recordRunArtifact` requires `r2Key`,
 *   `sizeBytes`, and `sha256` — this layer never holds body bytes, so it never
 *   writes `content_inline` and never uploads to a bucket itself.
 * - Atomicity is `db.transaction()` (`transactionSync`) instead of the
 *   read-then-write the D1 module wraps in a retry loop. There is no D1
 *   overload to retry against, so `withArtifactReadRetry` has no twin here.
 * - No log-store reads: a workspace store is one SQLite file; rows past any
 *   retention window are the owning sweep's concern, not this module's.
 */

import { and, asc, eq, inArray, like, notLike, or, sql } from "drizzle-orm";
import {
	type NewSkillRunArtifact,
	type SkillRunArtifact,
	skillRunArtifacts,
} from "../../schema/cognitive";
import { chunkForBoundParams } from "../../utils/batch";
import { validateArtifactPath } from "../skill-run-artifacts";
import type { TenantStoreDb } from "./tenant-store";

/**
 * Keeping the D1 chunk size is deliberate: DO SQLite has no 100-parameter cap,
 * but the parity contract is that a call produces the same statement
 * structure on either plane.
 */
const RUN_ID_CHUNK = 50;

function mergeChunkedArtifacts(
	rows: SkillRunArtifact[],
	limit?: number,
): SkillRunArtifact[] {
	rows.sort(
		(a, b) =>
			(a.createdAt ?? "").localeCompare(b.createdAt ?? "") ||
			a.path.localeCompare(b.path),
	);
	return limit === undefined ? rows : rows.slice(0, limit);
}

export interface RecordArtifactInput {
	runId: string;
	path: string;
	mimeType?: string;
	outcome?: "pending" | "success" | "failure";
	attempt?: number;
	/** R2 object key holding the body — bodies never inline on this plane. */
	r2Key: string;
	/**
	 * Hex SHA-256 of the stored bytes, required: this layer never sees the
	 * bytes, so the uploader must report the digest.
	 */
	sha256: string;
	/** Byte size of the R2 object, required for metrics and budget hints. */
	sizeBytes: number;
}

/**
 * Persist a single artifact's metadata row pointing at its R2 body.
 * Idempotent on (runId, path): a re-write of the same path replaces the row
 * and its digest, which keeps mutable summary paths verifiable and immutable
 * evidence paths tamper-evident. Runs inside one `transactionSync`.
 */
export async function recordRunArtifact(
	db: TenantStoreDb,
	input: RecordArtifactInput,
): Promise<SkillRunArtifact> {
	validateArtifactPath(input.path);
	if (input.sizeBytes < 0) {
		throw new Error(
			"SKILL_RUN_ARTIFACT_MISSING_SIZE: r2Key requires explicit sizeBytes (non-negative integer).",
		);
	}
	const row: NewSkillRunArtifact = {
		id: crypto.randomUUID(),
		runId: input.runId,
		path: input.path,
		mimeType: input.mimeType ?? "application/json",
		sizeBytes: input.sizeBytes,
		contentInline: null,
		contentR2Key: input.r2Key,
		sha256: input.sha256,
		attempt: input.attempt ?? 1,
		outcome: input.outcome ?? "success",
	};
	const upserted = db.transaction((tx) => {
		const [existing] = tx
			.select()
			.from(skillRunArtifacts)
			.where(
				and(
					eq(skillRunArtifacts.runId, input.runId),
					eq(skillRunArtifacts.path, input.path),
				),
			)
			.limit(1)
			.all();
		if (existing) {
			return tx
				.update(skillRunArtifacts)
				.set({
					mimeType: row.mimeType,
					sizeBytes: row.sizeBytes,
					contentInline: row.contentInline,
					contentR2Key: row.contentR2Key,
					sha256: row.sha256,
					attempt: row.attempt,
					outcome: row.outcome,
				})
				.where(eq(skillRunArtifacts.id, existing.id))
				.returning()
				.all();
		}
		return tx.insert(skillRunArtifacts).values(row).returning().all();
	});
	const [created] = upserted;
	if (!created) {
		throw new Error("Skill run artifact upsert returned no row");
	}
	return created;
}

/** Read one artifact by (runId, path). Returns null if not found. */
export async function getRunArtifact(
	db: TenantStoreDb,
	runId: string,
	path: string,
): Promise<SkillRunArtifact | null> {
	const rows = await db
		.select()
		.from(skillRunArtifacts)
		.where(
			and(eq(skillRunArtifacts.runId, runId), eq(skillRunArtifacts.path, path)),
		)
		.limit(1);
	return rows[0] ?? null;
}

/** List all artifacts for a run, ordered by createdAt. */
export async function listRunArtifacts(
	db: TenantStoreDb,
	runId: string,
): Promise<SkillRunArtifact[]> {
	return db
		.select()
		.from(skillRunArtifacts)
		.where(eq(skillRunArtifacts.runId, runId))
		.orderBy(asc(skillRunArtifacts.createdAt));
}

/** Bounded artifact page for agent/API inventory surfaces. */
export async function listRunArtifactsPage(
	db: TenantStoreDb,
	runId: string,
	options?: { limit?: number; offset?: number },
): Promise<SkillRunArtifact[]> {
	const limit = Math.min(Math.max(options?.limit ?? 201, 1), 2_001);
	const offset = Math.max(options?.offset ?? 0, 0);
	return db
		.select()
		.from(skillRunArtifacts)
		.where(eq(skillRunArtifacts.runId, runId))
		.orderBy(asc(skillRunArtifacts.createdAt), asc(skillRunArtifacts.path))
		.limit(limit)
		.offset(offset);
}

function compareArtifactOrder(a: SkillRunArtifact, b: SkillRunArtifact) {
	return (
		(a.createdAt ?? "").localeCompare(b.createdAt ?? "") ||
		a.path.localeCompare(b.path)
	);
}

/**
 * Bounded batch read used by reliability inspection across recent, already
 * organization-scoped run rows. Callers must establish run ownership first.
 */
export async function listRunArtifactsForRuns(
	db: TenantStoreDb,
	runIds: string[],
	limit = 5_000,
): Promise<SkillRunArtifact[]> {
	if (runIds.length === 0) return [];
	const boundedLimit = Math.min(Math.max(limit, 1), 10_000);
	const rows: SkillRunArtifact[] = [];
	for (const chunk of chunkForBoundParams([...new Set(runIds)], RUN_ID_CHUNK)) {
		rows.push(
			...db
				.select()
				.from(skillRunArtifacts)
				.where(inArray(skillRunArtifacts.runId, chunk))
				.orderBy(asc(skillRunArtifacts.createdAt))
				.limit(boundedLimit)
				.all(),
		);
	}
	return mergeChunkedArtifacts(rows, boundedLimit);
}

/** Bounded batch variant of listRunOperationalArtifacts. */
export async function listRunOperationalArtifactsForRuns(
	db: TenantStoreDb,
	runIds: string[],
	limit = 5_000,
): Promise<SkillRunArtifact[]> {
	if (runIds.length === 0) return [];
	const boundedLimit = Math.min(Math.max(limit, 1), 10_000);
	const rows: SkillRunArtifact[] = [];
	for (const chunk of chunkForBoundParams([...new Set(runIds)], RUN_ID_CHUNK)) {
		rows.push(
			...db
				.select()
				.from(skillRunArtifacts)
				.where(
					and(
						inArray(skillRunArtifacts.runId, chunk),
						or(
							like(skillRunArtifacts.path, "steps/%"),
							like(skillRunArtifacts.path, "epochs/%/steps/%"),
							eq(skillRunArtifacts.path, "timeline.json"),
							eq(skillRunArtifacts.path, "manifest.json"),
						),
					),
				)
				.orderBy(asc(skillRunArtifacts.createdAt))
				.limit(boundedLimit)
				.all(),
		);
	}
	return mergeChunkedArtifacts(rows, boundedLimit);
}

/** Read only the small operational records used by agent run inspection. */
export async function listRunOperationalArtifacts(
	db: TenantStoreDb,
	runId: string,
	limit = 2_001,
): Promise<SkillRunArtifact[]> {
	return db
		.select()
		.from(skillRunArtifacts)
		.where(
			and(
				eq(skillRunArtifacts.runId, runId),
				or(
					like(skillRunArtifacts.path, "steps/%"),
					like(skillRunArtifacts.path, "epochs/%/steps/%"),
					like(skillRunArtifacts.path, "controls/%"),
					like(skillRunArtifacts.path, "epochs/%/controls/%"),
					like(skillRunArtifacts.path, "epochs/%/manifest.json"),
					like(skillRunArtifacts.path, "epochs/%/manifests/%"),
					eq(skillRunArtifacts.path, "timeline.json"),
					eq(skillRunArtifacts.path, "manifest.json"),
				),
			),
		)
		.orderBy(asc(skillRunArtifacts.createdAt), asc(skillRunArtifacts.path))
		.limit(Math.min(Math.max(limit, 1), 2_001));
}

function stepPathPredicate() {
	return or(
		like(skillRunArtifacts.path, "steps/%"),
		like(skillRunArtifacts.path, "epochs/%/steps/%"),
	);
}

export type WorkflowStepArtifactKind =
	| "attempt"
	| "rollback"
	| "tool_call"
	| "sleep"
	| "sleep_until"
	| "wait_for_event"
	| "other";

export interface WorkflowArtifactPageOptions {
	limit?: number;
	offset?: number;
	stepName?: string;
	kind?: WorkflowStepArtifactKind;
	attempt?: number;
}

function stepNamePathPredicate(stepName: string | undefined) {
	if (!stepName) return undefined;
	// The runtime escapes dots because the shared artifact path validator rejects
	// every `..` sequence. Keep SQL-first filtering byte-identical to that
	// canonical path component; exact parsed-name filtering remains authoritative.
	const encoded = `x:${encodeURIComponent(stepName).replaceAll(".", "%2E")}`;
	// encodeURIComponent deliberately leaves *, ?, and brackets in a few edge
	// cases. Skip the GLOB optimization for those names; the API's exact parsed
	// record filter remains authoritative.
	if (/[*?[\]]/.test(encoded)) return undefined;
	return or(
		sql`${skillRunArtifacts.path} GLOB ${`steps/${encoded}/*`}`,
		sql`${skillRunArtifacts.path} GLOB ${`epochs/*/steps/${encoded}/*`}`,
	);
}

function stepKindPathPredicate(kind: WorkflowStepArtifactKind | undefined) {
	if (!kind || kind === "other") return undefined;
	if (kind === "tool_call") {
		return like(skillRunArtifacts.path, "%/calls/%");
	}
	if (kind === "attempt") {
		return and(
			like(skillRunArtifacts.path, "%/attempts/%"),
			notLike(skillRunArtifacts.path, "%/calls/%"),
			notLike(skillRunArtifacts.path, "%/rollback.json"),
		);
	}
	if (kind === "rollback") {
		return or(
			like(skillRunArtifacts.path, "%/rollback.json"),
			like(skillRunArtifacts.path, "%/rollbacks/%"),
		);
	}
	const leaf =
		kind === "sleep"
			? "sleep.json"
			: kind === "sleep_until"
				? "sleepUntil.json"
				: "waitForEvent.json";
	return like(skillRunArtifacts.path, `%/${leaf}`);
}

/** Bounded step records excluding nested MCP call receipts. */
export async function listRunWorkflowStepArtifacts(
	db: TenantStoreDb,
	runId: string,
	options: WorkflowArtifactPageOptions = {},
): Promise<SkillRunArtifact[]> {
	const structured = and(
		stepPathPredicate(),
		stepNamePathPredicate(options.stepName),
		stepKindPathPredicate(options.kind),
		options.kind === "tool_call"
			? like(skillRunArtifacts.path, "%/calls/%")
			: notLike(skillRunArtifacts.path, "%/calls/%"),
	);
	return db
		.select()
		.from(skillRunArtifacts)
		.where(and(eq(skillRunArtifacts.runId, runId), structured))
		.orderBy(asc(skillRunArtifacts.createdAt), asc(skillRunArtifacts.path))
		.limit(Math.min(Math.max(options.limit ?? 500, 1), 501))
		.offset(Math.max(options.offset ?? 0, 0));
}

/** Bounded MCP call receipts selected in SQL before any inline/R2 parsing. */
export async function listRunWorkflowCallArtifacts(
	db: TenantStoreDb,
	runId: string,
	options: WorkflowArtifactPageOptions = {},
): Promise<SkillRunArtifact[]> {
	return db
		.select()
		.from(skillRunArtifacts)
		.where(
			and(
				eq(skillRunArtifacts.runId, runId),
				and(
					stepPathPredicate(),
					like(skillRunArtifacts.path, "%/calls/%"),
					stepNamePathPredicate(options.stepName),
					options.attempt
						? eq(skillRunArtifacts.attempt, options.attempt)
						: undefined,
				),
			),
		)
		.orderBy(asc(skillRunArtifacts.createdAt), asc(skillRunArtifacts.path))
		.limit(Math.min(Math.max(options.limit ?? 500, 1), 501))
		.offset(Math.max(options.offset ?? 0, 0));
}

/** Batch-read one canonical artifact path across already-scoped run ids. */
export async function listRunArtifactsForRunsByPath(
	db: TenantStoreDb,
	runIds: string[],
	path: string,
): Promise<SkillRunArtifact[]> {
	if (runIds.length === 0) return [];
	validateArtifactPath(path);
	const rows: SkillRunArtifact[] = [];
	for (const chunk of chunkForBoundParams([...new Set(runIds)], RUN_ID_CHUNK)) {
		rows.push(
			...db
				.select()
				.from(skillRunArtifacts)
				.where(
					and(
						inArray(skillRunArtifacts.runId, chunk),
						eq(skillRunArtifacts.path, path),
					),
				)
				.orderBy(asc(skillRunArtifacts.createdAt))
				.all(),
		);
	}
	return mergeChunkedArtifacts(rows);
}

/** Executed, compatible-resume, and fail-closed runtime observations. */
export async function listRunWorkflowRuntimeObservationsForRuns(
	db: TenantStoreDb,
	runIds: string[],
	limit = 10_000,
): Promise<SkillRunArtifact[]> {
	if (runIds.length === 0) return [];
	const boundedLimit = Math.min(Math.max(limit, 1), 10_000);
	const rows: SkillRunArtifact[] = [];
	for (const chunk of chunkForBoundParams([...new Set(runIds)], RUN_ID_CHUNK)) {
		rows.push(
			...db
				.select()
				.from(skillRunArtifacts)
				.where(
					and(
						inArray(skillRunArtifacts.runId, chunk),
						or(
							like(skillRunArtifacts.path, "epochs/%/manifests/%.json"),
							like(
								skillRunArtifacts.path,
								"epochs/%/runtime-compatible/%.json",
							),
							like(skillRunArtifacts.path, "epochs/%/runtime-drift/%.json"),
						),
					),
				)
				.orderBy(asc(skillRunArtifacts.createdAt), asc(skillRunArtifacts.path))
				.limit(boundedLimit)
				.all(),
		);
	}
	return mergeChunkedArtifacts(rows, boundedLimit);
}

/**
 * Cascade-delete all artifacts for a run. Called by `revoke_skill_run` after
 * the run is canceled and its derived facts/muscles are torn down.
 */
export async function deleteRunArtifacts(
	db: TenantStoreDb,
	runId: string,
): Promise<number> {
	const deleted = db
		.delete(skillRunArtifacts)
		.where(eq(skillRunArtifacts.runId, runId))
		.returning({ id: skillRunArtifacts.id })
		.all();
	return deleted.length;
}

/** Full inline timeline for an already organization/environment-scoped run. */
export async function listRunTimelineArtifacts(
	db: TenantStoreDb,
	runId: string,
	executionEpoch: number,
): Promise<SkillRunArtifact[]> {
	return db
		.select()
		.from(skillRunArtifacts)
		.where(
			and(
				eq(skillRunArtifacts.runId, runId),
				like(skillRunArtifacts.path, `timeline/epochs/${executionEpoch}/%`),
			),
		)
		.orderBy(asc(skillRunArtifacts.createdAt), asc(skillRunArtifacts.path));
}
