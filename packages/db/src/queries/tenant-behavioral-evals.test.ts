import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import type { TenantBehavioralEvalRunManifest } from "@tedix/api-contract/schemas/tenant-behavioral-evals";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	tenantBehavioralEvalAssertionResults,
	tenantBehavioralEvalCaseAttempts,
	tenantBehavioralEvalCaseRuns,
	tenantBehavioralEvalDefinitions,
	tenantBehavioralEvalRevisions,
	tenantBehavioralEvalRuns,
} from "../schema/tenant-behavioral-evals";
import {
	acquireTenantBehavioralEvalRunLease,
	appendTenantBehavioralEvalCaseAttempt,
	createTenantBehavioralEval,
	getTenantBehavioralEval,
	getTenantBehavioralEvalRunDetail,
	markTenantBehavioralEvalCaseAdvanceError,
	reviseTenantBehavioralEval,
	reserveTenantBehavioralEvalRetry,
	startTenantBehavioralEvalRun,
	TenantBehavioralEvalRunConflictError,
	updateTenantBehavioralEvalCaseRun,
	writeTenantBehavioralEvalAssertionResults,
} from "./tenant-behavioral-evals";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		PRAGMA foreign_keys=ON;
		CREATE TABLE organizations (id TEXT PRIMARY KEY);
		CREATE TABLE tedis (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id));
		INSERT INTO organizations VALUES ('org'), ('other-org');
		INSERT INTO tedis VALUES ('tedi', 'org'), ('other-tedi', 'other-org');
	`);
	for (const table of [
		tenantBehavioralEvalDefinitions,
		tenantBehavioralEvalRevisions,
		tenantBehavioralEvalRuns,
		tenantBehavioralEvalCaseRuns,
		tenantBehavioralEvalCaseAttempts,
		tenantBehavioralEvalAssertionResults,
	])
		sqlite.exec(schemaDdl(table));
	return createDbClient(createD1Facade(sqlite));
}
const spec = {
	lane: "kernel_route_observe_v1" as const,
	cases: [
		{
			id: "one",
			input: "hello",
			assertions: [{ type: "no_effects" as const }],
		},
	],
};
const provenance = {
	manifest: {
		schemaVersion: 1,
		definitionId: "def",
		revisionId: "rev",
		revisionNumber: 1,
		specDigest: "spec-sha",
		caseIds: ["one"],
		assetTediId: "tedi",
		lane: "kernel_route_observe_v1",
		executionPolicy: "observe_only",
		modelSelection: "kernel_runtime_default",
		requestedModelRef: null,
		capturedAt: "2026-09-25T00:00:00.000Z",
	} satisfies TenantBehavioralEvalRunManifest,
	manifestDigest: "manifest-sha",
};
describe("tenant behavioral eval persistence", () => {
	it("seals a stalled attempt and reserves exactly one fenced retry", async () => {
		const db = fixture();
		await createTenantBehavioralEval(db, {
			id: "def",
			revisionId: "rev",
			organizationId: "org",
			tediId: "tedi",
			name: "Eval",
			spec,
		});
		await startTenantBehavioralEvalRun(db, {
			id: "run",
			organizationId: "org",
			definitionId: "def",
			revisionId: "rev",
			tediId: "tedi",
			idempotencyKey: "key",
			payloadDigest: "digest",
			...provenance,
			cases: spec.cases,
		});
		const leaseVersion = await acquireTenantBehavioralEvalRunLease(
			db,
			"org",
			"run",
			"owner",
			0,
		);
		expect(leaseVersion).toBe(1);
		const before = (await getTenantBehavioralEvalRunDetail(db, "org", "run"))!
			.caseRuns[0]!;
		expect(
			await updateTenantBehavioralEvalCaseRun(db, {
				id: before.id,
				runId: "run",
				leaseToken: "owner",
				leaseVersion: 1,
				patch: {
					status: "failed",
					drained: true,
					sawClosed: true,
					disposition: "unresolved",
					error: "mark_stalled",
					eventCursor: 2,
					terminalStatus: "failed",
				},
			}),
		).toBe(true);
		const seal = {
			caseRunId: before.id,
			runId: "run",
			attemptNumber: 1,
			leaseToken: "owner",
			leaseVersion: 1,
		};
		expect(await appendTenantBehavioralEvalCaseAttempt(db, seal)).toBe(true);
		expect(await appendTenantBehavioralEvalCaseAttempt(db, seal)).toBe(true);
		const retry = {
			caseRunId: before.id,
			runId: "run",
			expectedAttemptNumber: 1,
			expectedHomeRunId: before.homeRunId,
			newHomeRunId: "eval-run-one-attempt-2",
			leaseToken: "owner",
			leaseVersion: 1,
		};
		expect(await reserveTenantBehavioralEvalRetry(db, retry)).toBe(true);
		expect(await reserveTenantBehavioralEvalRetry(db, retry)).toBe(false);
		const detail = (await getTenantBehavioralEvalRunDetail(db, "org", "run"))!;
		expect(detail.caseAttempts).toHaveLength(1);
		expect(detail.caseAttempts[0]).toMatchObject({
			attemptNumber: 1,
			homeRunId: before.homeRunId,
			status: "failed",
			disposition: "unresolved",
			error: "mark_stalled",
		});
		expect(detail.caseRuns[0]).toMatchObject({
			attemptNumber: 2,
			homeRunId: "eval-run-one-attempt-2",
			status: "pending",
			drained: false,
			eventCursor: 0,
			disposition: null,
		});
		expect(
			await reserveTenantBehavioralEvalRetry(db, {
				...retry,
				leaseToken: "stale",
				expectedAttemptNumber: 2,
				expectedHomeRunId: "eval-run-one-attempt-2",
				newHomeRunId: "eval-run-one-attempt-3",
			}),
		).toBe(false);
		expect(
			await updateTenantBehavioralEvalCaseRun(db, {
				id: before.id,
				runId: "run",
				leaseToken: "owner",
				leaseVersion: 1,
				patch: {
					status: "completed",
					drained: true,
					sawClosed: true,
					disposition: "passed",
					error: null,
					eventCursor: 1,
					terminalStatus: "completed",
				},
			}),
		).toBe(true);
		expect(
			await appendTenantBehavioralEvalCaseAttempt(db, {
				...seal,
				attemptNumber: 2,
			}),
		).toBe(true);
		expect(
			await markTenantBehavioralEvalCaseAdvanceError(db, {
				caseRunId: before.id,
				runId: "run",
				leaseToken: "owner",
				leaseVersion: 1,
				category: "timeout",
			}),
		).toBe(false);
		const after = (await getTenantBehavioralEvalRunDetail(db, "org", "run"))!;
		expect(after.caseRuns[0]).toMatchObject({
			attemptNumber: 2,
			status: "completed",
			disposition: "passed",
			error: null,
		});
		expect(
			after.caseAttempts.map((row) => [row.attemptNumber, row.disposition]),
		).toEqual([
			[1, "unresolved"],
			[2, "passed"],
		]);
	});
	it("enforces parent identity with foreign keys enabled", async () => {
		const db = fixture();
		await expect(
			createTenantBehavioralEval(db, {
				id: "def",
				revisionId: "rev",
				organizationId: "missing-org",
				tediId: "missing-tedi",
				name: "Eval",
				spec,
			}),
		).rejects.toThrow();
	});
	it("appends revisions only at the expected immutable version", async () => {
		const db = fixture();
		await createTenantBehavioralEval(db, {
			id: "def",
			revisionId: "rev-1",
			organizationId: "org",
			tediId: "tedi",
			name: "Eval",
			spec,
		});
		expect(
			await reviseTenantBehavioralEval(db, {
				id: "rev-2",
				organizationId: "org",
				definitionId: "def",
				expectedVersion: 1,
				spec,
			}),
		).toMatchObject({ revision: 2 });
		expect(
			(await getTenantBehavioralEval(db, "org", "def"))?.revisions,
		).toHaveLength(2);
		expect(
			await reviseTenantBehavioralEval(db, {
				id: "stale",
				organizationId: "org",
				definitionId: "def",
				expectedVersion: 1,
				spec,
			}),
		).toBeUndefined();
	});
	it("pins immutable cases and exactly reuses an idempotent run payload", async () => {
		const db = fixture();
		const asset = await createTenantBehavioralEval(db, {
			id: "def",
			revisionId: "rev",
			organizationId: "org",
			tediId: "tedi",
			name: "Eval",
			spec,
		});
		expect(asset.revision.spec).toEqual(spec);
		const manifest = provenance.manifest;
		const first = await startTenantBehavioralEvalRun(db, {
			id: "run",
			organizationId: "org",
			definitionId: "def",
			revisionId: "rev",
			tediId: "tedi",
			idempotencyKey: "key",
			payloadDigest: "digest",
			manifest,
			manifestDigest: "manifest-sha",
			cases: spec.cases,
		});
		const second = await startTenantBehavioralEvalRun(db, {
			id: "other",
			organizationId: "org",
			definitionId: "def",
			revisionId: "rev",
			tediId: "tedi",
			idempotencyKey: "key",
			payloadDigest: "digest",
			manifest: { ...manifest, capturedAt: "later" },
			manifestDigest: "changed",
			cases: spec.cases,
		});
		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.run.id).toBe("run");
		expect(first.run.manifest).toEqual(manifest);
		expect(second.run.manifest).toEqual(manifest);
		expect(second.run.manifestDigest).toBe("manifest-sha");
		expect(
			await getTenantBehavioralEvalRunDetail(db, "other-org", "run"),
		).toBeUndefined();
	});
	it.each([
		{ payloadDigest: "different" },
		{ definitionId: "different" },
		{ revisionId: "different" },
		{ tediId: "different" },
	])("rejects a conflicting idempotent run tuple", async (override) => {
		const db = fixture();
		await createTenantBehavioralEval(db, {
			id: "def",
			revisionId: "rev",
			organizationId: "org",
			tediId: "tedi",
			name: "Eval",
			spec,
		});
		await startTenantBehavioralEvalRun(db, {
			id: "run",
			organizationId: "org",
			definitionId: "def",
			revisionId: "rev",
			tediId: "tedi",
			idempotencyKey: "key",
			payloadDigest: "digest",
			...provenance,
			cases: spec.cases,
		});
		await expect(
			startTenantBehavioralEvalRun(db, {
				id: "other-run",
				organizationId: "org",
				definitionId: "def",
				revisionId: "rev",
				tediId: "tedi",
				idempotencyKey: "key",
				payloadDigest: "digest",
				...provenance,
				cases: spec.cases,
				...override,
			}),
		).rejects.toBeInstanceOf(TenantBehavioralEvalRunConflictError);
	});
	it.each([
		{ cases: [] },
		{ cases: [{ id: "different" }] },
		{ cases: [...spec.cases, { id: "extra" }] },
	])(
		"rejects case rows that diverge from the immutable revision",
		async ({ cases }) => {
			const db = fixture();
			await createTenantBehavioralEval(db, {
				id: "def",
				revisionId: "rev",
				organizationId: "org",
				tediId: "tedi",
				name: "Eval",
				spec,
			});
			await expect(
				startTenantBehavioralEvalRun(db, {
					id: "run",
					organizationId: "org",
					definitionId: "def",
					revisionId: "rev",
					tediId: "tedi",
					idempotencyKey: "key",
					payloadDigest: "digest",
					...provenance,
					cases,
				}),
			).rejects.toThrow("cases mismatch revision");
			expect(
				await getTenantBehavioralEvalRunDetail(db, "org", "run"),
			).toBeUndefined();
		},
	);
	it("rejects a revision owned by another definition", async () => {
		const db = fixture();
		for (const [id, revisionId] of [
			["def-a", "rev-a"],
			["def-b", "rev-b"],
		] as const)
			await createTenantBehavioralEval(db, {
				id,
				revisionId,
				organizationId: "org",
				tediId: "tedi",
				name: id,
				spec,
			});
		await expect(
			startTenantBehavioralEvalRun(db, {
				id: "run",
				organizationId: "org",
				definitionId: "def-a",
				revisionId: "rev-b",
				tediId: "tedi",
				idempotencyKey: "key",
				payloadDigest: "digest",
				...provenance,
				cases: spec.cases,
			}),
		).rejects.toThrow();
		expect(
			await getTenantBehavioralEvalRunDetail(db, "org", "run"),
		).toBeUndefined();
	});
	it("fails a raced idempotency key with a different immutable payload", async () => {
		const db = fixture();
		await createTenantBehavioralEval(db, {
			id: "def",
			revisionId: "rev",
			organizationId: "org",
			tediId: "tedi",
			name: "Eval",
			spec,
		});
		const base = {
			organizationId: "org",
			definitionId: "def",
			revisionId: "rev",
			tediId: "tedi",
			idempotencyKey: "raced-key",
			cases: spec.cases,
		};
		const outcomes = await Promise.allSettled([
			startTenantBehavioralEvalRun(db, {
				...base,
				id: "run-a",
				payloadDigest: "digest-a",
				...provenance,
			}),
			startTenantBehavioralEvalRun(db, {
				...base,
				id: "run-b",
				payloadDigest: "digest-b",
				...provenance,
			}),
		]);
		expect(
			outcomes.filter((outcome) => outcome.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			outcomes.filter((outcome) => outcome.status === "rejected"),
		).toHaveLength(1);
	});
	it("fences a stale advance owner", async () => {
		const db = fixture();
		await createTenantBehavioralEval(db, {
			id: "def",
			revisionId: "rev",
			organizationId: "org",
			tediId: "tedi",
			name: "Eval",
			spec,
		});
		await startTenantBehavioralEvalRun(db, {
			id: "run",
			organizationId: "org",
			definitionId: "def",
			revisionId: "rev",
			tediId: "tedi",
			idempotencyKey: "key",
			payloadDigest: "digest",
			...provenance,
			cases: spec.cases,
		});
		expect(
			await acquireTenantBehavioralEvalRunLease(
				db,
				"org",
				"run",
				"owner-a",
				0,
				new Date("2026-01-01T00:00:00Z"),
			),
		).toBe(1);
		expect(
			await acquireTenantBehavioralEvalRunLease(
				db,
				"org",
				"run",
				"owner-b",
				0,
				new Date("2026-01-01T00:00:01Z"),
			),
		).toBeUndefined();
		const detail = (await getTenantBehavioralEvalRunDetail(db, "org", "run"))!;
		expect(
			await updateTenantBehavioralEvalCaseRun(db, {
				id: detail.caseRuns[0]!.id,
				runId: "run",
				leaseToken: "owner-b",
				leaseVersion: 1,
				patch: { status: "enqueued" },
			}),
		).toBe(false);
		expect(
			await acquireTenantBehavioralEvalRunLease(
				db,
				"org",
				"run",
				"owner-b",
				1,
				new Date("2026-01-01T00:02:00Z"),
			),
		).toBe(2);
		expect(
			await updateTenantBehavioralEvalCaseRun(db, {
				id: detail.caseRuns[0]!.id,
				runId: "run",
				leaseToken: "owner-a",
				leaseVersion: 1,
				patch: { status: "enqueued" },
			}),
		).toBe(false);
	});
	it("rejects assertion rows for a case owned by another run", async () => {
		const db = fixture();
		await createTenantBehavioralEval(db, {
			id: "def",
			revisionId: "rev",
			organizationId: "org",
			tediId: "tedi",
			name: "Eval",
			spec,
		});
		for (const id of ["run-a", "run-b"])
			await startTenantBehavioralEvalRun(db, {
				id,
				organizationId: "org",
				definitionId: "def",
				revisionId: "rev",
				tediId: "tedi",
				idempotencyKey: id,
				payloadDigest: id,
				...provenance,
				cases: spec.cases,
			});
		const runA = (await getTenantBehavioralEvalRunDetail(db, "org", "run-a"))!;
		const runB = (await getTenantBehavioralEvalRunDetail(db, "org", "run-b"))!;
		const now = new Date();
		expect(
			await acquireTenantBehavioralEvalRunLease(
				db,
				"org",
				"run-b",
				"owner-b",
				0,
				now,
			),
		).toBe(1);
		const foreignValue = {
			id: "result-b",
			caseRunId: runB.caseRuns[0]!.id,
			assertionIndex: 0,
			type: "no_effects" as const,
			passed: true,
			detail: "same",
		};
		expect(
			await writeTenantBehavioralEvalAssertionResults(db, {
				runId: "run-b",
				token: "owner-b",
				leaseVersion: 1,
				values: [foreignValue],
			}),
		).toBe(true);
		const leaseVersion = await acquireTenantBehavioralEvalRunLease(
			db,
			"org",
			"run-a",
			"owner",
			0,
			now,
		);
		expect(leaseVersion).toBe(1);
		expect(
			await writeTenantBehavioralEvalAssertionResults(db, {
				runId: "run-a",
				token: "owner",
				leaseVersion: 1,
				values: [{ ...foreignValue, id: "result-a" }],
			}),
		).toBe(false);
		const ownValue = {
			...foreignValue,
			id: "own-result",
			caseRunId: runA.caseRuns[0]!.id,
		};
		expect(
			await writeTenantBehavioralEvalAssertionResults(db, {
				runId: "run-a",
				token: "owner",
				leaseVersion: 1,
				values: [ownValue],
			}),
		).toBe(true);
		await db
			.update(tenantBehavioralEvalRuns)
			.set({ leaseUntil: "2000-01-01T00:00:00.000Z" })
			.where(eq(tenantBehavioralEvalRuns.id, "run-a"));
		expect(
			await acquireTenantBehavioralEvalRunLease(
				db,
				"org",
				"run-a",
				"replacement",
				1,
				new Date(),
			),
		).toBe(2);
		expect(
			await writeTenantBehavioralEvalAssertionResults(db, {
				runId: "run-a",
				token: "owner",
				leaseVersion: 1,
				values: [ownValue],
			}),
		).toBe(false);
	});
});
