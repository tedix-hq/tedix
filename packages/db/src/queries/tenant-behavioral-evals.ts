import type {
	TenantBehavioralEvalRevisionSpec,
	TenantBehavioralEvalRunManifest,
} from "@tedix/api-contract/schemas/tenant-behavioral-evals";
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	tenantBehavioralEvalAssertionResults as results,
	tenantBehavioralEvalCaseAttempts as attempts,
	tenantBehavioralEvalCaseRuns as caseRuns,
	tenantBehavioralEvalDefinitions as definitions,
	tenantBehavioralEvalRevisions as revisions,
	tenantBehavioralEvalRuns as runs,
} from "../schema/tenant-behavioral-evals";

export async function createTenantBehavioralEval(
	db: DbClient,
	input: {
		id: string;
		revisionId: string;
		organizationId: string;
		tediId: string;
		name: string;
		spec: TenantBehavioralEvalRevisionSpec;
	},
) {
	const now = new Date().toISOString();
	await db.batch([
		db.insert(definitions).values({
			id: input.id,
			organizationId: input.organizationId,
			tediId: input.tediId,
			name: input.name,
			latestRevision: 1,
			createdAt: now,
		}),
		db.insert(revisions).values({
			id: input.revisionId,
			organizationId: input.organizationId,
			definitionId: input.id,
			revision: 1,
			spec: input.spec,
			createdAt: now,
		}),
	]);
	return {
		definition: {
			id: input.id,
			organizationId: input.organizationId,
			tediId: input.tediId,
			name: input.name,
			latestRevision: 1,
			createdAt: now,
		},
		revision: {
			id: input.revisionId,
			definitionId: input.id,
			organizationId: input.organizationId,
			revision: 1,
			spec: input.spec,
			createdAt: now,
		},
	};
}
export async function reviseTenantBehavioralEval(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		definitionId: string;
		expectedVersion: number;
		spec: TenantBehavioralEvalRevisionSpec;
	},
) {
	const now = new Date().toISOString();
	const next = input.expectedVersion + 1;
	const updated = db
		.update(definitions)
		.set({ latestRevision: next })
		.where(
			and(
				eq(definitions.id, input.definitionId),
				eq(definitions.organizationId, input.organizationId),
				eq(definitions.latestRevision, input.expectedVersion),
			),
		);
	const inserted = db.insert(revisions).select(
		db
			.select({
				id: sql`${input.id}`.as("id"),
				organizationId: definitions.organizationId,
				definitionId: definitions.id,
				revision: sql<number>`${next}`.as("revision"),
				spec: sql<TenantBehavioralEvalRevisionSpec>`${JSON.stringify(input.spec)}`.as(
					"spec",
				),
				createdAt: sql`${now}`.as("created_at"),
			})
			.from(definitions)
			.where(
				and(
					eq(definitions.id, input.definitionId),
					eq(definitions.organizationId, input.organizationId),
					eq(definitions.latestRevision, input.expectedVersion),
				),
			),
	);
	await db.batch([inserted, updated]);
	const [readback] = await db
		.select({ id: revisions.id })
		.from(revisions)
		.where(
			and(
				eq(revisions.id, input.id),
				eq(revisions.organizationId, input.organizationId),
				eq(revisions.definitionId, input.definitionId),
				eq(revisions.revision, next),
			),
		)
		.limit(1);
	if (!readback) return undefined;
	return {
		id: input.id,
		organizationId: input.organizationId,
		definitionId: input.definitionId,
		revision: next,
		spec: input.spec,
		createdAt: now,
	};
}
export async function getTenantBehavioralEval(
	db: DbClient,
	organizationId: string,
	definitionId: string,
) {
	const [definition] = await db
		.select()
		.from(definitions)
		.where(
			and(
				eq(definitions.organizationId, organizationId),
				eq(definitions.id, definitionId),
			),
		)
		.limit(1);
	if (!definition) return undefined;
	return {
		...definition,
		revisions: await db
			.select()
			.from(revisions)
			.where(
				and(
					eq(revisions.organizationId, organizationId),
					eq(revisions.definitionId, definitionId),
				),
			)
			.orderBy(desc(revisions.revision)),
	};
}
export async function listTenantBehavioralEvals(
	db: DbClient,
	organizationId: string,
	limit: number,
) {
	return db
		.select()
		.from(definitions)
		.where(eq(definitions.organizationId, organizationId))
		.orderBy(desc(definitions.createdAt))
		.limit(Math.min(100, limit));
}
export async function getTenantBehavioralEvalRevision(
	db: DbClient,
	organizationId: string,
	definitionId: string,
	revisionId: string,
) {
	const [row] = await db
		.select({ revision: revisions, tediId: definitions.tediId })
		.from(revisions)
		.innerJoin(
			definitions,
			and(
				eq(definitions.id, revisions.definitionId),
				eq(definitions.organizationId, revisions.organizationId),
			),
		)
		.where(
			and(
				eq(revisions.organizationId, organizationId),
				eq(revisions.definitionId, definitionId),
				eq(revisions.id, revisionId),
			),
		)
		.limit(1);
	return row;
}
export async function getRunByIdempotency(
	db: DbClient,
	organizationId: string,
	key: string,
) {
	const [row] = await db
		.select()
		.from(runs)
		.where(
			and(
				eq(runs.organizationId, organizationId),
				eq(runs.idempotencyKey, key),
			),
		)
		.limit(1);
	return row;
}
export class TenantBehavioralEvalRunConflictError extends Error {
	constructor() {
		super("Tenant behavioral eval run idempotency conflict");
		this.name = "TenantBehavioralEvalRunConflictError";
	}
}
export async function startTenantBehavioralEvalRun(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		definitionId: string;
		revisionId: string;
		tediId: string;
		idempotencyKey: string;
		payloadDigest: string;
		manifest: TenantBehavioralEvalRunManifest;
		manifestDigest: string;
		cases: readonly { id: string }[];
	},
) {
	const assertSameRunRequest = (row: typeof runs.$inferSelect) => {
		if (
			row.organizationId !== input.organizationId ||
			row.idempotencyKey !== input.idempotencyKey ||
			row.payloadDigest !== input.payloadDigest ||
			row.definitionId !== input.definitionId ||
			row.revisionId !== input.revisionId ||
			row.tediId !== input.tediId
		)
			throw new TenantBehavioralEvalRunConflictError();
		return { run: row, created: false as const };
	};
	const existing = await getRunByIdempotency(
		db,
		input.organizationId,
		input.idempotencyKey,
	);
	if (existing) return assertSameRunRequest(existing);
	const pinnedRevision = await getTenantBehavioralEvalRevision(
		db,
		input.organizationId,
		input.definitionId,
		input.revisionId,
	);
	if (!pinnedRevision || pinnedRevision.tediId !== input.tediId)
		throw new Error("Tenant behavioral eval run ownership mismatch");
	const pinnedCaseIds = pinnedRevision.revision.spec.cases.map(
		(item) => item.id,
	);
	if (
		pinnedCaseIds.length !== input.cases.length ||
		pinnedCaseIds.some((id, index) => input.cases[index]?.id !== id)
	)
		throw new Error("Tenant behavioral eval run cases mismatch revision");
	const now = new Date().toISOString();
	const insertRun = db.insert(runs).select(
		db
			.select({
				id: sql`${input.id}`.as("id"),
				organizationId: definitions.organizationId,
				definitionId: sql<string>`${definitions.id}`.as("definition_id"),
				revisionId: sql<string>`${revisions.id}`.as("revision_id"),
				tediId: definitions.tediId,
				status: sql<"pending">`'pending'`.as("status"),
				version: sql<number>`0`.as("version"),
				idempotencyKey: sql`${input.idempotencyKey}`.as("idempotency_key"),
				payloadDigest: sql`${input.payloadDigest}`.as("payload_digest"),
				manifest: sql<string>`${JSON.stringify(input.manifest)}`.as("manifest"),
				manifestDigest: sql<string>`${input.manifestDigest}`.as(
					"manifest_digest",
				),
				leaseToken: sql<null>`NULL`.as("lease_token"),
				leaseUntil: sql<null>`NULL`.as("lease_until"),
				passed: sql<null>`NULL`.as("passed"),
				createdAt: sql`${now}`.as("created_at"),
				updatedAt: sql`${now}`.as("updated_at"),
			})
			.from(revisions)
			.innerJoin(
				definitions,
				and(
					eq(definitions.id, revisions.definitionId),
					eq(definitions.organizationId, revisions.organizationId),
				),
			)
			.where(
				and(
					eq(revisions.id, input.revisionId),
					eq(revisions.definitionId, input.definitionId),
					eq(revisions.organizationId, input.organizationId),
					eq(definitions.tediId, input.tediId),
				),
			),
	);
	try {
		await db.batch([
			insertRun,
			...pinnedCaseIds.map((caseId) =>
				db.insert(caseRuns).values({
					id: crypto.randomUUID(),
					runId: input.id,
					caseId,
					homeRunId: `eval-${input.id}-${caseId}`,
					createdAt: now,
					updatedAt: now,
				}),
			),
		] as any);
		const created = await getRunByIdempotency(
			db,
			input.organizationId,
			input.idempotencyKey,
		);
		if (!created)
			throw new Error("Tenant behavioral eval run ownership mismatch");
		assertSameRunRequest(created);
		return { run: created, created: true as const };
	} catch (error) {
		const raced = await getRunByIdempotency(
			db,
			input.organizationId,
			input.idempotencyKey,
		);
		if (raced) return assertSameRunRequest(raced);
		throw error;
	}
}
export async function getTenantBehavioralEvalRunDetail(
	db: DbClient,
	organizationId: string,
	runId: string,
) {
	const [run] = await db
		.select()
		.from(runs)
		.where(and(eq(runs.id, runId), eq(runs.organizationId, organizationId)))
		.limit(1);
	if (!run) return undefined;
	const cases = await db
		.select()
		.from(caseRuns)
		.where(eq(caseRuns.runId, runId));
	const assertions = cases.length
		? await db
				.select()
				.from(results)
				.where(or(...cases.map((c) => eq(results.caseRunId, c.id)))!)
		: [];
	const attemptRows = cases.length
		? await db
				.select()
				.from(attempts)
				.where(
					// bound-params: a pinned eval revision has at most 20 cases.
					inArray(
						attempts.caseRunId,
						cases.map((c) => c.id),
					),
				)
				.orderBy(attempts.caseRunId, attempts.attemptNumber)
		: [];
	return {
		run,
		caseRuns: cases,
		caseAttempts: attemptRows,
		assertionResults: assertions,
	};
}
export async function listTenantBehavioralEvalRuns(
	db: DbClient,
	organizationId: string,
	definitionId: string | undefined,
	limit: number,
) {
	return db
		.select()
		.from(runs)
		.where(
			and(
				eq(runs.organizationId, organizationId),
				definitionId ? eq(runs.definitionId, definitionId) : undefined,
			),
		)
		.orderBy(desc(runs.createdAt))
		.limit(Math.min(100, limit));
}
export async function acquireTenantBehavioralEvalRunLease(
	db: DbClient,
	organizationId: string,
	runId: string,
	token: string,
	expectedVersion: number,
	now = new Date(),
	leaseMs = 60_000,
) {
	const iso = now.toISOString(),
		until = new Date(
			now.getTime() + Math.min(60_000, Math.max(1, leaseMs)),
		).toISOString();
	const rows = await db
		.update(runs)
		.set({
			leaseToken: token,
			leaseUntil: until,
			status: "running",
			version: sql`${runs.version} + 1`,
			updatedAt: iso,
		})
		.where(
			and(
				eq(runs.id, runId),
				eq(runs.organizationId, organizationId),
				eq(runs.version, expectedVersion),
				inArray(runs.status, ["pending", "running"]),
				or(
					isNull(runs.leaseUntil),
					lte(runs.leaseUntil, iso),
					eq(runs.leaseToken, token),
				),
			),
		)
		.returning({ version: runs.version });
	return rows[0]?.version;
}
export async function releaseTenantBehavioralEvalRunLease(
	db: DbClient,
	runId: string,
	token: string,
) {
	await db
		.update(runs)
		.set({ leaseToken: null, leaseUntil: null })
		.where(and(eq(runs.id, runId), eq(runs.leaseToken, token)));
}
export async function recordTenantBehavioralEvalAdvanceError(
	db: DbClient,
	input: {
		runId: string;
		organizationId: string;
		token: string;
		leaseVersion: number;
		phase: "dispatch" | "evidence" | "assertion";
		category: "timeout" | "unavailable" | "conflict" | "incomplete" | "unknown";
		retryable: boolean;
	},
) {
	const now = new Date().toISOString();
	const rows = await db
		.update(runs)
		.set({
			lastAdvanceError: input.category,
			lastAdvanceErrorPhase: input.phase,
			lastAdvanceErrorRetryable: input.retryable,
			updatedAt: now,
		})
		.where(
			and(
				eq(runs.id, input.runId),
				eq(runs.organizationId, input.organizationId),
				eq(runs.leaseToken, input.token),
				eq(runs.version, input.leaseVersion),
				gt(runs.leaseUntil, now),
			),
		)
		.returning({ id: runs.id });
	return rows.length === 1;
}
const liveLease = (
	runId: string,
	token: string,
	version: number,
	nowIso: string,
) =>
	sql`EXISTS (SELECT 1 FROM ${runs} WHERE ${runs.id} = ${runId} AND ${runs.leaseToken} = ${token} AND ${runs.version} = ${version} AND ${runs.leaseUntil} > ${nowIso})`;
export async function updateTenantBehavioralEvalCaseRun(
	db: DbClient,
	input: {
		id: string;
		runId: string;
		leaseToken: string;
		leaseVersion: number;
		patch: Partial<typeof caseRuns.$inferInsert>;
	},
) {
	const nowIso = new Date().toISOString();
	const rows = await db
		.update(caseRuns)
		.set({ ...input.patch, updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(caseRuns.id, input.id),
				eq(caseRuns.runId, input.runId),
				liveLease(input.runId, input.leaseToken, input.leaseVersion, nowIso),
			),
		)
		.returning({ id: caseRuns.id });
	return rows.length === 1;
}
/** A transient advance error must never downgrade a terminal, sealed case. */
export async function markTenantBehavioralEvalCaseAdvanceError(
	db: DbClient,
	input: {
		caseRunId: string;
		runId: string;
		leaseToken: string;
		leaseVersion: number;
		category: string;
	},
) {
	const now = new Date().toISOString();
	const rows = await db
		.update(caseRuns)
		.set({
			disposition: "unresolved",
			error: input.category,
			updatedAt: now,
		})
		.where(
			and(
				eq(caseRuns.id, input.caseRunId),
				eq(caseRuns.runId, input.runId),
				inArray(caseRuns.status, ["pending", "enqueued", "streaming"]),
				liveLease(input.runId, input.leaseToken, input.leaseVersion, now),
				sql`NOT EXISTS (SELECT 1 FROM ${attempts} WHERE ${attempts.caseRunId} = ${input.caseRunId} AND ${attempts.attemptNumber} = ${caseRuns.attemptNumber})`,
			),
		)
		.returning({ id: caseRuns.id });
	return rows.length === 1;
}
/** Seal one terminal attempt from the fenced logical case row. Never updates a seal. */
export async function appendTenantBehavioralEvalCaseAttempt(
	db: DbClient,
	input: {
		caseRunId: string;
		runId: string;
		attemptNumber: number;
		leaseToken: string;
		leaseVersion: number;
	},
) {
	const now = new Date().toISOString();
	const id = `${input.caseRunId}:${input.attemptNumber}`;
	const inserted = await db
		.insert(attempts)
		.select(
			db
				.select({
					id: sql<string>`${id}`.as("id"),
					caseRunId: caseRuns.id,
					attemptNumber: caseRuns.attemptNumber,
					homeRunId: caseRuns.homeRunId,
					status: sql<"completed" | "failed">`${caseRuns.status}`.as("status"),
					disposition: sql<
						"passed" | "failed" | "unresolved" | "void"
					>`${caseRuns.disposition}`.as("disposition"),
					error: caseRuns.error,
					eventCursor: caseRuns.eventCursor,
					terminalStatus: caseRuns.terminalStatus,
					selectedRoute: caseRuns.selectedRoute,
					effectsSuppressed: caseRuns.effectsSuppressed,
					executionReceipt: caseRuns.executionReceipt,
					recordedAt: sql<string>`${now}`.as("recorded_at"),
				})
				.from(caseRuns)
				.where(
					and(
						eq(caseRuns.id, input.caseRunId),
						eq(caseRuns.runId, input.runId),
						eq(caseRuns.attemptNumber, input.attemptNumber),
						inArray(caseRuns.status, ["completed", "failed"]),
						eq(caseRuns.drained, true),
						sql`${caseRuns.disposition} IS NOT NULL`,
						liveLease(input.runId, input.leaseToken, input.leaseVersion, now),
					),
				),
		)
		.onConflictDoNothing()
		.returning({ id: attempts.id });
	if (inserted.length === 1) return true;
	const [existing] = await db
		.select({ id: attempts.id })
		.from(attempts)
		.where(
			and(
				eq(attempts.id, id),
				eq(attempts.caseRunId, input.caseRunId),
				eq(attempts.attemptNumber, input.attemptNumber),
			),
		)
		.limit(1);
	return existing !== undefined;
}

/** Reserve a new Home identity before dispatch, only for a sealed stalled attempt. */
export async function reserveTenantBehavioralEvalRetry(
	db: DbClient,
	input: {
		caseRunId: string;
		runId: string;
		expectedAttemptNumber: number;
		expectedHomeRunId: string;
		newHomeRunId: string;
		leaseToken: string;
		leaseVersion: number;
	},
) {
	if (input.expectedAttemptNumber >= 3) return false;
	const now = new Date().toISOString();
	const rows = await db
		.update(caseRuns)
		.set({
			attemptNumber: input.expectedAttemptNumber + 1,
			homeRunId: input.newHomeRunId,
			status: "pending",
			eventCursor: 0,
			sawClosed: false,
			drained: false,
			terminalStatus: null,
			selectedRoute: null,
			effectsSuppressed: null,
			error: null,
			disposition: null,
			executionReceipt: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(caseRuns.id, input.caseRunId),
				eq(caseRuns.runId, input.runId),
				eq(caseRuns.attemptNumber, input.expectedAttemptNumber),
				sql`${caseRuns.attemptNumber} < 3`,
				eq(caseRuns.homeRunId, input.expectedHomeRunId),
				eq(caseRuns.status, "failed"),
				eq(caseRuns.drained, true),
				eq(caseRuns.disposition, "unresolved"),
				inArray(caseRuns.error, ["mark_stalled", "model_unavailable"]),
				liveLease(input.runId, input.leaseToken, input.leaseVersion, now),
				sql`EXISTS (SELECT 1 FROM ${attempts} WHERE ${attempts.caseRunId} = ${input.caseRunId} AND ${attempts.attemptNumber} = ${input.expectedAttemptNumber} AND ${attempts.homeRunId} = ${input.expectedHomeRunId})`,
				sql`NOT EXISTS (SELECT 1 FROM ${results} WHERE ${results.caseRunId} = ${input.caseRunId})`,
			),
		)
		.returning({ id: caseRuns.id });
	return rows.length === 1;
}
export async function writeTenantBehavioralEvalAssertionResults(
	db: DbClient,
	input: {
		runId: string;
		token: string;
		leaseVersion: number;
		values: (typeof results.$inferInsert)[];
	},
) {
	const nowIso = new Date().toISOString();
	for (const value of input.values) {
		const inserted = await db
			.insert(results)
			.select(
				db
					.select({
						id: sql`${value.id}`.as("id"),
						caseRunId: sql`${value.caseRunId}`.as("case_run_id"),
						assertionIndex: sql`${value.assertionIndex}`.as("assertion_index"),
						type: sql`${value.type}`.as("type"),
						passed: sql`${value.passed ? 1 : 0}`.as("passed"),
						severity: sql`${value.severity ?? "gate"}`.as("severity"),
						disposition:
							sql`${value.disposition ?? (value.passed ? "passed" : "failed")}`.as(
								"disposition",
							),
						detail: sql`${value.detail}`.as("detail"),
						createdAt: sql`${value.createdAt ?? new Date().toISOString()}`.as(
							"created_at",
						),
					})
					.from(runs)
					.innerJoin(
						caseRuns,
						and(eq(caseRuns.id, value.caseRunId), eq(caseRuns.runId, runs.id)),
					)
					.where(
						and(
							eq(runs.id, input.runId),
							eq(runs.leaseToken, input.token),
							eq(runs.version, input.leaseVersion),
							gt(runs.leaseUntil, nowIso),
						),
					),
			)
			.onConflictDoNothing()
			.returning({ id: results.id });
		if (inserted.length === 0) {
			const [existing] = await db
				.select({
					id: results.id,
					type: results.type,
					passed: results.passed,
					severity: results.severity,
					disposition: results.disposition,
					detail: results.detail,
				})
				.from(results)
				.innerJoin(caseRuns, eq(caseRuns.id, results.caseRunId))
				.innerJoin(runs, eq(runs.id, caseRuns.runId))
				.where(
					and(
						eq(results.caseRunId, value.caseRunId),
						eq(results.assertionIndex, value.assertionIndex),
						eq(caseRuns.runId, input.runId),
						eq(runs.leaseToken, input.token),
						eq(runs.version, input.leaseVersion),
						gt(runs.leaseUntil, nowIso),
					),
				)
				.limit(1);
			if (
				!existing ||
				existing.type !== value.type ||
				existing.passed !== value.passed ||
				existing.severity !== (value.severity ?? "gate") ||
				(existing.disposition ?? (existing.passed ? "passed" : "failed")) !==
					(value.disposition ?? (value.passed ? "passed" : "failed")) ||
				existing.detail !== value.detail
			)
				return false;
		}
	}
	return true;
}
export async function finishTenantBehavioralEvalRun(
	db: DbClient,
	runId: string,
	token: string,
	version: number,
	passed: boolean,
) {
	const nowIso = new Date().toISOString();
	const rows = await db
		.update(runs)
		.set({
			status: "completed",
			passed,
			leaseToken: null,
			leaseUntil: null,
			version: sql`${runs.version} + 1`,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(runs.id, runId),
				eq(runs.leaseToken, token),
				eq(runs.version, version),
				gt(runs.leaseUntil, nowIso),
			),
		)
		.returning({ id: runs.id });
	return rows.length === 1;
}
