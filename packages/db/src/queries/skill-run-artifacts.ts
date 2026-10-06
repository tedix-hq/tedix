/**
 * Skill workflow run artifacts — per-step outputs, errors, and timeline
 * entries produced by executable skill workflows.
 *
 * Served via MCP at `skill://{slug}/runs/{runId}/{path}`. Memory facts
 * keyed off the same URIs let brain feedback trace each fact back to the
 * exact step output that produced it; revoking a run cascades cleanly via
 * `DELETE FROM memory_facts WHERE source LIKE 'skill://.../{runId}/%'`.
 *
 * Inline payloads ≤ INLINE_THRESHOLD_BYTES (16 KiB) live in `content_inline`.
 * Larger payloads spill to R2 with `content_r2_key`; `content_inline` is null.
 * Path is canonical within a run. Stable summary artifacts (for example
 * `timeline.json`) upsert in place, while durable execution evidence encodes
 * the native Cloudflare attempt in
 * `epochs/{epoch}/steps/{name}/{count}/attempts/{attempt}.json` so retries and
 * operator restarts remain individually inspectable. The `attempt` column
 * stays available for bounded filtering and legacy artifacts.
 */

import { and, asc, eq, inArray, like, notLike, or, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type NewSkillRunArtifact,
	type SkillRunArtifact,
	skillRunArtifacts,
} from "../schema/cognitive";
import { chunkForBoundParams } from "../utils/batch";
import { sha256Hex } from "@tedix/worker-kit/crypto";

/**
 * D1 caps bound parameters at 100 per statement. The batch readers below
 * combine the run-id IN() list with a handful of path predicates, so 50 ids
 * per chunk leaves comfortable headroom.
 */
const RUN_ID_CHUNK = 50;

/**
 * Merge chunked batch-read results back into the single-statement contract:
 * global `created_at ASC` (path as a deterministic tiebreak) with the caller's
 * limit applied across the whole merged set, not per chunk.
 */
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

/** Anything bigger than this lives in R2, not D1. */
export const INLINE_THRESHOLD_BYTES = 16 * 1024;

/**
 * Fail-soft digest. Artifact persistence must never fail a workflow, so a
 * digest failure degrades to an unhashed row (the pre-content-addressing shape)
 * rather than discarding the evidence itself.
 */
export async function sha256HexSafe(
	input: string | BufferSource,
): Promise<string | null> {
	try {
		return await sha256Hex(input);
	} catch {
		return null;
	}
}

export interface RecordArtifactInput {
	runId: string;
	path: string;
	value: unknown;
	mimeType?: string;
	outcome?: "pending" | "success" | "failure";
	attempt?: number;
	/**
	 * Hex SHA-256 of the stored bytes. Required for `r2Key` writes and raw-byte
	 * blobs — this layer never sees those bytes. Omit it for inline writes and
	 * the digest is computed here from the serialized payload.
	 */
	sha256?: string;
	r2Key?: string;
	/**
	 * Required when `r2Key` is supplied — caller must report the actual byte
	 * size of the R2 object so metrics + future UI are correct. Inline
	 * payloads compute this from the serialized string.
	 */
	sizeBytes?: number;
}

/**
 * Reject paths that would corrupt provenance keys, escape the run's
 * namespace, or shadow special files. Same rules apply to inline writes
 * and R2 spill — paths become `source = skill://.../runs/{id}/{path}`
 * URIs and stay there forever, so they must be canonical.
 */
export function validateArtifactPath(path: string): void {
	if (!path || path.length === 0) {
		throw new Error("SKILL_RUN_ARTIFACT_INVALID_PATH: path is empty");
	}
	if (path.length > 512) {
		throw new Error(
			`SKILL_RUN_ARTIFACT_INVALID_PATH: path exceeds 512 chars (${path.length})`,
		);
	}
	if (path.startsWith("/")) {
		throw new Error("SKILL_RUN_ARTIFACT_INVALID_PATH: leading slash");
	}
	if (path.includes("..")) {
		throw new Error("SKILL_RUN_ARTIFACT_INVALID_PATH: contains '..'");
	}
	if (path.includes("\\")) {
		throw new Error("SKILL_RUN_ARTIFACT_INVALID_PATH: contains backslash");
	}
	if (path.includes("://")) {
		throw new Error("SKILL_RUN_ARTIFACT_INVALID_PATH: contains URI scheme");
	}
	// Disallow nested SKILL.md (the skill's static SKILL.md lives at the
	// folder root and is served from skill_entries.files; runs/ subtree must
	// not shadow it at any depth).
	if (/(^|\/)SKILL\.md$/i.test(path)) {
		throw new Error("SKILL_RUN_ARTIFACT_INVALID_PATH: SKILL.md is reserved");
	}
	// Path-only — no query strings, no fragments.
	if (path.includes("?") || path.includes("#")) {
		throw new Error("SKILL_RUN_ARTIFACT_INVALID_PATH: contains '?' or '#'");
	}
}

/**
 * Persist a single artifact (pending, success, or failure). Idempotent on
 * (runId, path).
 * Whether a retry overwrites or remains distinct is an explicit path decision:
 * summaries reuse a path; per-attempt evidence includes its attempt in the path.
 *
 * Caller is responsible for choosing inline vs R2: pass `r2Key` when the
 * payload was uploaded to R2; otherwise the value is JSON-serialised inline.
 * If the inline payload exceeds INLINE_THRESHOLD_BYTES and no r2Key was
 * provided, this throws — callers must split large payloads upstream.
 *
 * Every row is content-addressed: `sha256` is the digest of the exact stored
 * bytes. Inline writes are hashed here; R2/blob writes must supply the digest
 * because only the caller ever holds those bytes. A re-write of the same
 * (runId, path) replaces the row *and* its digest — the hash always describes
 * the bytes currently stored, which is what makes a mutable summary path
 * (`timeline.json`) verifiable and an immutable path
 * (`recordArtifactOnceForRun`) tamper-evident.
 */
export async function recordRunArtifact(
	db: DbClient,
	input: RecordArtifactInput,
): Promise<SkillRunArtifact> {
	validateArtifactPath(input.path);
	const mimeType = input.mimeType ?? "application/json";
	const id = crypto.randomUUID();
	const attempt = input.attempt ?? 1;
	const outcome = input.outcome ?? "success";

	let contentInline: string | null = null;
	const contentR2Key: string | null = input.r2Key ?? null;
	let sizeBytes = 0;
	let sha256: string | null = input.sha256 ?? null;

	if (contentR2Key) {
		// Caller-reported size is mandatory when spilling to R2. Without it,
		// metrics ("how big is this run's output?"), context-budget hints
		// for tenants, and future UI all silently report 0.
		if (typeof input.sizeBytes !== "number" || input.sizeBytes < 0) {
			throw new Error(
				"SKILL_RUN_ARTIFACT_MISSING_SIZE: r2Key requires explicit sizeBytes (non-negative integer).",
			);
		}
		sizeBytes = input.sizeBytes;
	} else {
		const serialized =
			mimeType === "application/json"
				? JSON.stringify(input.value)
				: typeof input.value === "string"
					? input.value
					: JSON.stringify(input.value);
		sizeBytes = new TextEncoder().encode(serialized).byteLength;
		if (sizeBytes > INLINE_THRESHOLD_BYTES) {
			throw new Error(
				`SKILL_RUN_ARTIFACT_TOO_LARGE: ${sizeBytes} bytes for ${input.path} exceeds inline cap (${INLINE_THRESHOLD_BYTES}); upload to R2 and pass r2Key.`,
			);
		}
		contentInline = serialized;
		// Content-address the exact bytes about to be stored. Callers that hold
		// the bytes themselves (R2 spill, raw blobs) hash upstream and pass
		// `sha256` in; this is the fallback that makes every inline write
		// verifiable without touching a single call site.
		sha256 ??= await sha256HexSafe(serialized);
	}

	const row: NewSkillRunArtifact = {
		id,
		runId: input.runId,
		path: input.path,
		mimeType,
		sizeBytes,
		contentInline,
		contentR2Key,
		sha256,
		attempt,
		outcome,
	};

	// Upsert on (run_id, path). D1's HTTP API rejects ON CONFLICT in some
	// drizzle paths; do read-then-upsert with a fallback path.
	const existingRows = await db
		.select()
		.from(skillRunArtifacts)
		.where(
			and(
				eq(skillRunArtifacts.runId, input.runId),
				eq(skillRunArtifacts.path, input.path),
			),
		)
		.limit(1);
	const existing = existingRows[0];
	if (existing) {
		const [updated] = await db
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
			.returning();
		return updated!;
	}

	const [created] = await db.insert(skillRunArtifacts).values(row).returning();
	return created!;
}

/** Read one artifact by (runId, path). Returns null if not found. */
export async function getRunArtifact(
	db: DbClient,
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
	db: DbClient,
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
	db: DbClient,
	runId: string,
	options?: { limit?: number; offset?: number },
): Promise<SkillRunArtifact[]> {
	return db
		.select()
		.from(skillRunArtifacts)
		.where(eq(skillRunArtifacts.runId, runId))
		.orderBy(asc(skillRunArtifacts.createdAt), asc(skillRunArtifacts.path))
		.limit(Math.min(Math.max(options?.limit ?? 201, 1), 2_001))
		.offset(Math.max(options?.offset ?? 0, 0));
}

/**
 * Bounded batch read used by reliability inspection across recent, already
 * organization-scoped run rows. Callers must establish run ownership first.
 */
export async function listRunArtifactsForRuns(
	db: DbClient,
	runIds: string[],
	limit = 5_000,
): Promise<SkillRunArtifact[]> {
	if (runIds.length === 0) return [];
	const boundedLimit = Math.min(Math.max(limit, 1), 10_000);
	const rows: SkillRunArtifact[] = [];
	for (const chunk of chunkForBoundParams([...new Set(runIds)], RUN_ID_CHUNK)) {
		rows.push(
			...(await db
				.select()
				.from(skillRunArtifacts)
				.where(inArray(skillRunArtifacts.runId, chunk))
				.orderBy(asc(skillRunArtifacts.createdAt))
				.limit(boundedLimit)),
		);
	}
	return mergeChunkedArtifacts(rows, boundedLimit);
}

/** Bounded batch variant of listRunOperationalArtifacts. */
export async function listRunOperationalArtifactsForRuns(
	db: DbClient,
	runIds: string[],
	limit = 5_000,
): Promise<SkillRunArtifact[]> {
	if (runIds.length === 0) return [];
	const boundedLimit = Math.min(Math.max(limit, 1), 10_000);
	const rows: SkillRunArtifact[] = [];
	for (const chunk of chunkForBoundParams([...new Set(runIds)], RUN_ID_CHUNK)) {
		rows.push(
			...(await db
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
				.limit(boundedLimit)),
		);
	}
	return mergeChunkedArtifacts(rows, boundedLimit);
}

/** Read only the small operational records used by agent run inspection. */
export async function listRunOperationalArtifacts(
	db: DbClient,
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
	db: DbClient,
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
	db: DbClient,
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
	db: DbClient,
	runIds: string[],
	path: string,
): Promise<SkillRunArtifact[]> {
	if (runIds.length === 0) return [];
	validateArtifactPath(path);
	const rows: SkillRunArtifact[] = [];
	for (const chunk of chunkForBoundParams([...new Set(runIds)], RUN_ID_CHUNK)) {
		rows.push(
			...(await db
				.select()
				.from(skillRunArtifacts)
				.where(
					and(
						inArray(skillRunArtifacts.runId, chunk),
						eq(skillRunArtifacts.path, path),
					),
				)
				.orderBy(asc(skillRunArtifacts.createdAt))),
		);
	}
	return mergeChunkedArtifacts(rows);
}

/** Executed, compatible-resume, and fail-closed runtime observations. */
export async function listRunWorkflowRuntimeObservationsForRuns(
	db: DbClient,
	runIds: string[],
	limit = 10_000,
): Promise<SkillRunArtifact[]> {
	if (runIds.length === 0) return [];
	const boundedLimit = Math.min(Math.max(limit, 1), 10_000);
	const rows: SkillRunArtifact[] = [];
	for (const chunk of chunkForBoundParams([...new Set(runIds)], RUN_ID_CHUNK)) {
		rows.push(
			...(await db
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
				.limit(boundedLimit)),
		);
	}
	return mergeChunkedArtifacts(rows, boundedLimit);
}

/**
 * Cascade-delete all artifacts for a run. Called by `revoke_skill_run` after
 * the run is canceled and its derived facts/muscles are torn down.
 */
export async function deleteRunArtifacts(
	db: DbClient,
	runId: string,
): Promise<number> {
	const deleted = await db
		.delete(skillRunArtifacts)
		.where(eq(skillRunArtifacts.runId, runId))
		.returning({ id: skillRunArtifacts.id });
	return deleted.length;
}
