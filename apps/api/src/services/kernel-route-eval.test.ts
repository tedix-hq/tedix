/**
 * Tests for kernel-route-eval.ts — gradeKernelRoute unit coverage.
 *
 * Pure function, no I/O, no D1 dependency — runs in plain Vitest/bun.
 */

import { DatabaseSync } from "node:sqlite";
import { createDbClient, type DbClient } from "@tedix/db/client";
import {
	getTediLearnedCapabilities,
	upsertTediLearnedCapability,
} from "@tedix/db/queries/cognitive/learned-capabilities";
import { listSubjectEvalResults } from "@tedix/db/queries/harness-version/evaluations";
import {
	summarizeTediSelectionPriors,
	tediSelectionSubjectId,
} from "@tedix/db/queries/harness-version/subjects";
import {
	harnessSubjectEvalResults,
	harnessSubjectEvalRuns,
	harnessSubjectVersions,
	knowledgeEntries,
	kernelRuntimeEvents,
	kernelRuntimeRuns,
} from "@tedix/db/schema";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import type { KernelRunGradeInput } from "./kernel-route-eval";
import {
	gradeKernelRoute,
	gradeRecentKernelRoutes,
	resolveDelegatedTediId,
} from "./kernel-route-eval";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRun(
	overrides: Partial<KernelRunGradeInput> = {},
): KernelRunGradeInput {
	return {
		runId: "run-test-01",
		status: "completed",
		metadata: null,
		events: [],
		...overrides,
	};
}

function routeMeta(
	routeKind: string,
	extras: Record<string, unknown> = {},
): Record<string, unknown> {
	return { kernelRoute: { routeKind, ...extras } };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("gradeKernelRoute", () => {
	describe("routeProduced gate", () => {
		it("fails when metadata is null (no kernelRoute)", () => {
			const grade = gradeKernelRoute(makeRun({ metadata: null }));
			expect(grade.gates.routeProduced).toBe(false);
			expect(grade.passed).toBe(false);
		});

		it("fails when kernelRoute has no routeKind", () => {
			const grade = gradeKernelRoute(
				makeRun({ metadata: { kernelRoute: { someOtherKey: "x" } } }),
			);
			expect(grade.gates.routeProduced).toBe(false);
			expect(grade.passed).toBe(false);
		});

		it("passes when kernelRoute.routeKind is a non-empty string", () => {
			const grade = gradeKernelRoute(
				makeRun({
					metadata: routeMeta("answer_in_home"),
					events: [
						{ kind: "run.completed", payload: null, runId: "run-test-01" },
					],
				}),
			);
			expect(grade.gates.routeProduced).toBe(true);
		});
	});

	describe("notCorrected gate", () => {
		it("fails when a decision.recorded event references this run as priorRunId with action=kernel.route_corrected", () => {
			const grade = gradeKernelRoute(
				makeRun({
					runId: "run-abc",
					metadata: routeMeta("answer_in_home"),
					events: [
						{ kind: "run.completed", payload: null, runId: "run-abc" },
						{
							kind: "decision.recorded",
							payload: {
								action: "kernel.route_corrected",
								priorRunId: "run-abc",
							},
							runId: "run-abc",
						},
					],
				}),
			);
			expect(grade.gates.notCorrected).toBe(false);
			expect(grade.passed).toBe(false);
		});

		it("passes when a correction event exists for a DIFFERENT runId", () => {
			const grade = gradeKernelRoute(
				makeRun({
					runId: "run-abc",
					metadata: routeMeta("answer_in_home"),
					events: [
						{ kind: "run.completed", payload: null, runId: "run-abc" },
						{
							kind: "decision.recorded",
							payload: {
								action: "kernel.route_corrected",
								priorRunId: "run-OTHER",
							},
							runId: "run-abc",
						},
					],
				}),
			);
			expect(grade.gates.notCorrected).toBe(true);
		});
	});

	describe("answer_in_home route", () => {
		it("passes when run.completed event exists", () => {
			const grade = gradeKernelRoute(
				makeRun({
					metadata: routeMeta("answer_in_home"),
					events: [
						{ kind: "run.completed", payload: null, runId: "run-test-01" },
					],
				}),
			);
			expect(grade.gates.outcomeSucceeded).toBe(true);
			expect(grade.passed).toBe(true);
			expect(grade.score).toBe(1);
		});

		it("fails when no run.completed event", () => {
			const grade = gradeKernelRoute(
				makeRun({
					metadata: routeMeta("answer_in_home"),
					events: [],
				}),
			);
			expect(grade.gates.outcomeSucceeded).toBe(false);
			expect(grade.passed).toBe(false);
		});
	});

	describe("delegate_tedi route", () => {
		it("passes when subagent.completed event exists", () => {
			const grade = gradeKernelRoute(
				makeRun({
					metadata: routeMeta("delegate_tedi"),
					events: [
						{
							kind: "subagent.completed",
							payload: null,
							runId: "run-test-01",
						},
					],
				}),
			);
			expect(grade.gates.outcomeSucceeded).toBe(true);
			expect(grade.passed).toBe(true);
		});

		it("fails when subagent.failed event exists", () => {
			const grade = gradeKernelRoute(
				makeRun({
					metadata: routeMeta("delegate_tedi"),
					events: [
						{ kind: "subagent.failed", payload: null, runId: "run-test-01" },
					],
				}),
			);
			expect(grade.gates.outcomeSucceeded).toBe(false);
			expect(grade.passed).toBe(false);
		});

		it("fails when no terminal child event (incomplete delegation)", () => {
			const grade = gradeKernelRoute(
				makeRun({
					metadata: routeMeta("delegate_tedi"),
					events: [],
				}),
			);
			expect(grade.gates.outcomeSucceeded).toBe(false);
			expect(grade.passed).toBe(false);
		});
	});

	describe("propose_tool_write route", () => {
		it("passes when approval.resolved with approved=true", () => {
			const grade = gradeKernelRoute(
				makeRun({
					metadata: routeMeta("propose_tool_write"),
					events: [
						{
							kind: "approval.resolved",
							payload: { approved: true },
							runId: "run-test-01",
						},
					],
				}),
			);
			expect(grade.gates.outcomeSucceeded).toBe(true);
			expect(grade.passed).toBe(true);
		});

		it("fails when approval.resolved with approved=false", () => {
			const grade = gradeKernelRoute(
				makeRun({
					metadata: routeMeta("propose_tool_write"),
					events: [
						{
							kind: "approval.resolved",
							payload: { approved: false },
							runId: "run-test-01",
						},
					],
				}),
			);
			expect(grade.gates.outcomeSucceeded).toBe(false);
			expect(grade.passed).toBe(false);
		});

		it("fails when no approval.resolved event", () => {
			const grade = gradeKernelRoute(
				makeRun({
					metadata: routeMeta("propose_tool_write"),
					events: [],
				}),
			);
			expect(grade.gates.outcomeSucceeded).toBe(false);
			expect(grade.passed).toBe(false);
		});
	});

	describe("delegate_tedi via plan decision", () => {
		it("passes when decision.recorded with action=home.plan.approved", () => {
			const grade = gradeKernelRoute(
				makeRun({
					metadata: routeMeta("delegate_tedi"),
					events: [
						{
							kind: "decision.recorded",
							payload: { action: "home.plan.approved" },
							runId: "run-test-01",
						},
					],
				}),
			);
			expect(grade.gates.outcomeSucceeded).toBe(true);
			expect(grade.passed).toBe(true);
		});

		it("fails when decision.recorded with action=home.plan.rejected", () => {
			const grade = gradeKernelRoute(
				makeRun({
					metadata: routeMeta("delegate_tedi"),
					events: [
						{
							kind: "decision.recorded",
							payload: { action: "home.plan.rejected" },
							runId: "run-test-01",
						},
					],
				}),
			);
			expect(grade.gates.outcomeSucceeded).toBe(false);
			expect(grade.passed).toBe(false);
		});

		it("passes when subagent.completed coexists with no plan decision", () => {
			const grade = gradeKernelRoute(
				makeRun({
					metadata: routeMeta("delegate_tedi"),
					events: [
						{
							kind: "subagent.completed",
							payload: null,
							runId: "run-test-01",
						},
					],
				}),
			);
			expect(grade.gates.outcomeSucceeded).toBe(true);
			expect(grade.passed).toBe(true);
		});
	});

	describe("in-home settling routes (run_workflow / ask_human / suggest_handoff)", () => {
		for (const routeKind of [
			"run_workflow",
			"ask_human",
			"suggest_handoff",
		] as const) {
			it(`${routeKind} passes when run.completed event exists`, () => {
				const grade = gradeKernelRoute(
					makeRun({
						metadata: routeMeta(routeKind),
						events: [
							{ kind: "run.completed", payload: null, runId: "run-test-01" },
						],
					}),
				);
				expect(grade.gates.outcomeSucceeded).toBe(true);
				expect(grade.passed).toBe(true);
			});
		}

		it("run_workflow fails when no run.completed event", () => {
			const grade = gradeKernelRoute(
				makeRun({
					metadata: routeMeta("run_workflow"),
					events: [],
				}),
			);
			expect(grade.gates.outcomeSucceeded).toBe(false);
			expect(grade.passed).toBe(false);
		});
	});

	describe("edge cases", () => {
		it("fails for unknown routeKind", () => {
			const grade = gradeKernelRoute(
				makeRun({
					metadata: routeMeta("totally_made_up_route"),
					events: [
						{ kind: "run.completed", payload: null, runId: "run-test-01" },
					],
				}),
			);
			expect(grade.gates.outcomeSucceeded).toBe(false);
			expect(grade.passed).toBe(false);
		});

		it("fails when run.status is failed even if events suggest success", () => {
			const grade = gradeKernelRoute(
				makeRun({
					status: "failed",
					metadata: routeMeta("answer_in_home"),
					events: [
						{ kind: "run.completed", payload: null, runId: "run-test-01" },
					],
				}),
			);
			expect(grade.gates.outcomeSucceeded).toBe(false);
			expect(grade.passed).toBe(false);
		});

		it("score is 1/3 when two of three gates fail (null metadata)", () => {
			const grade = gradeKernelRoute(makeRun({ metadata: null }));
			// routeProduced=false, notCorrected=true (no events), outcomeSucceeded=false
			expect(grade.gates.routeProduced).toBe(false);
			expect(grade.gates.notCorrected).toBe(true);
			expect(grade.gates.outcomeSucceeded).toBe(false);
			expect(grade.score).toBeCloseTo(1 / 3);
			expect(grade.passed).toBe(false);
		});

		it("score is 1 when all gates pass", () => {
			const grade = gradeKernelRoute(
				makeRun({
					metadata: routeMeta("answer_in_home"),
					events: [
						{ kind: "run.completed", payload: null, runId: "run-test-01" },
					],
				}),
			);
			expect(grade.score).toBe(1);
		});

		it("score is 2/3 when one of three gates fails", () => {
			const grade = gradeKernelRoute(
				makeRun({
					runId: "run-abc",
					metadata: routeMeta("answer_in_home"),
					events: [
						{ kind: "run.completed", payload: null, runId: "run-abc" },
						// correction event for THIS run => notCorrected=false
						{
							kind: "decision.recorded",
							payload: {
								action: "kernel.route_corrected",
								priorRunId: "run-abc",
							},
							runId: "run-abc",
						},
					],
				}),
			);
			expect(grade.gates.routeProduced).toBe(true);
			expect(grade.gates.notCorrected).toBe(false);
			expect(grade.gates.outcomeSucceeded).toBe(true);
			expect(grade.score).toBeCloseTo(2 / 3);
			expect(grade.passed).toBe(false);
		});
	});
});

// ─── resolveDelegatedTediId (pure) ────────────────────────────────────────────

describe("resolveDelegatedTediId", () => {
	it("prefers the top-level delegatedTediId stamp", () => {
		expect(
			resolveDelegatedTediId({
				delegatedTediId: "tedi-top",
				homeDelegation: { workOrder: { targetTediId: "tedi-wo" } },
				kernelRoute: { targetTediId: "tedi-route" },
			}),
		).toBe("tedi-top");
	});

	it("falls back to homeDelegation.workOrder.targetTediId", () => {
		expect(
			resolveDelegatedTediId({
				homeDelegation: { workOrder: { targetTediId: "tedi-wo" } },
				kernelRoute: { targetTediId: "tedi-route" },
			}),
		).toBe("tedi-wo");
	});

	it("falls back to kernelRoute.targetTediId", () => {
		expect(
			resolveDelegatedTediId({ kernelRoute: { targetTediId: "tedi-route" } }),
		).toBe("tedi-route");
	});

	it("returns null when no target resolves", () => {
		expect(
			resolveDelegatedTediId({ kernelRoute: { routeKind: "delegate_tedi" } }),
		).toBe(null);
		expect(resolveDelegatedTediId(null)).toBe(null);
	});
});

// ─── gradeRecentKernelRoutes — dual-write persistence path ─────────────────────
//
// A focused table-routing fake DB exercises the real persistence pass: it serves
// the settled-runs read, the events read, and an empty existing-results read, and
// CAPTURES every harnessSubjectEvalResults insert. We assert that a delegate_tedi
// run emits BOTH a `kser:` route result AND a `tsel:` tedi-selection result keyed
// by the delegated tedi, while a non-delegate run emits ONLY the route result.

interface CapturedInsert {
	table: unknown;
	values: Record<string, unknown>;
}

interface SettledRunRow {
	id: string;
	organizationId: string;
	status: string;
	metadata: Record<string, unknown> | null;
	createdAt: string;
}

interface EventRow {
	id?: string;
	createdAt?: string;
	runId: string | null;
	kind: string;
	payload: Record<string, unknown> | null;
	organizationId: string;
}

function createPersistenceDb(input: {
	runs: SettledRunRow[];
	events: EventRow[];
	subjectRunConflict?: boolean;
}): {
	db: DbClient;
	inserts: CapturedInsert[];
} {
	const inserts: CapturedInsert[] = [];

	const db = {
		select(_columns?: unknown) {
			let table: unknown;
			const correctionProjection = Boolean(
				_columns &&
				typeof _columns === "object" &&
				"id" in _columns &&
				"payload" in _columns,
			);
			const builder = {
				from(t: unknown) {
					table = t;
					return builder;
				},
				where() {
					return builder;
				},
				orderBy() {
					return builder;
				},
				groupBy() {
					return builder;
				},
				async limit() {
					if (table === kernelRuntimeRuns) return input.runs;
					if (table === harnessSubjectEvalRuns) {
						const latest = inserts.findLast(
							(entry) => entry.table === harnessSubjectEvalRuns,
						)?.values;
						if (!latest) return [];
						return [
							input.subjectRunConflict
								? { ...latest, total: Number(latest.total) + 1 }
								: latest,
						];
					}
					if (table === kernelRuntimeEvents) {
						const events = correctionProjection
							? input.events.filter(
									(e) => e.payload?.action === "kernel.route_corrected",
								)
							: input.events;
						return events.map((e) => ({
							id: e.id ?? "test-event",
							createdAt: e.createdAt ?? "2026-09-24T00:00:00.000Z",
							runId: e.runId,
							kind: e.kind,
							payload: e.payload,
						}));
					}
					// harnessSubjectVersions (getActive): no active version yet.
					// harnessSubjectEvalResults (existing ids): none graded yet.
					return [];
				},
				// kernelRuntimeEvents read uses .where() then awaits directly (no limit).
				// Drizzle query builders are awaitable; the persistence pass awaits this fake.
				then<T>(
					onfulfilled?: (value: unknown[]) => T | PromiseLike<T>,
				): Promise<T> {
					let rows: unknown[] = [];
					if (table === kernelRuntimeRuns) rows = input.runs;
					if (table === kernelRuntimeEvents) {
						rows = input.events.map((e) => ({
							runId: e.runId,
							kind: e.kind,
							payload: e.payload,
						}));
					}
					return Promise.resolve(rows).then(onfulfilled as never);
				},
			};
			return builder;
		},
		insert(table: unknown) {
			return {
				values(values: Record<string, unknown>) {
					return {
						onConflictDoNothing() {
							inserts.push({ table, values });
							return Promise.resolve();
						},
					};
				},
			};
		},
		delete() {
			return { where: () => Promise.resolve() };
		},
		update() {
			return {
				set() {
					return {
						where() {
							return Promise.resolve();
						},
					};
				},
			};
		},
	} as unknown as DbClient;

	return { db, inserts };
}

const ORG = "org-tsel-test";

function delegateRun(
	id: string,
	delegatedTediId: string,
	createdAt: string,
): SettledRunRow {
	return {
		id,
		organizationId: ORG,
		status: "completed",
		createdAt,
		metadata: {
			kernelRoute: { routeKind: "delegate_tedi", routerVersion: "rv1" },
			delegatedTediId,
		},
	};
}

describe("gradeRecentKernelRoutes — tedi-selection dual write", () => {
	it("records a late correction on a new run as append-only negative route and selection revisions", async () => {
		const prior = delegateRun(
			"prior-old",
			"tedi-cto",
			"2026-01-01T00:00:00.000Z",
		);
		prior.metadata = {
			...prior.metadata,
			bodyExecutionResult: { harnessVersionId: "historical-version" },
		};
		const { db, inserts } = createPersistenceDb({
			runs: [prior],
			events: [
				{
					runId: "prior-old",
					kind: "subagent.completed",
					payload: null,
					organizationId: ORG,
				},
				{
					id: "correction-event-1",
					createdAt: "2026-09-24T10:00:00.000Z",
					runId: "new-correction-run",
					kind: "decision.recorded",
					payload: {
						action: "kernel.route_corrected",
						priorRunId: "prior-old",
					},
					organizationId: ORG,
				},
			],
		});

		await gradeRecentKernelRoutes(db, { orgId: ORG, lookbackHours: 1 });
		const revisions = inserts.filter((row) =>
			String(row.values.id).endsWith("correction:correction-event-1"),
		);
		expect(revisions.map((row) => row.values.id)).toEqual([
			"kser-correction:correction-event-1",
			"tsel-correction:correction-event-1",
		]);
		expect(revisions.every((row) => row.values.passed === false)).toBe(true);
		expect(
			revisions.every(
				(row) =>
					(row.values.gates as Record<string, boolean>).notCorrected === false,
			),
		).toBe(true);
		expect(
			revisions.every(
				(row) => row.values.harnessVersionId === "historical-version",
			),
		).toBe(true);
	});

	it("persists a failed route result when a settled run has no kernel route", async () => {
		const { db, inserts } = createPersistenceDb({
			runs: [
				{
					id: "run-null-route",
					organizationId: ORG,
					status: "completed",
					createdAt: "2026-06-22T10:00:00.000Z",
					metadata: { kernelRoute: null },
				},
			],
			events: [
				{
					runId: "run-null-route",
					kind: "run.completed",
					payload: null,
					organizationId: ORG,
				},
			],
		});

		const summary = await gradeRecentKernelRoutes(db, { orgId: ORG });
		const result = inserts.find(
			(i) =>
				i.table === harnessSubjectEvalResults &&
				String(i.values.id).includes("run-null-route"),
		);
		expect(summary.runsGraded).toBe(1);
		expect(summary.runsFailed).toBe(1);
		expect(result?.values.passed).toBe(false);
		expect(result?.values.gates).toMatchObject({ routeProduced: false });
	});

	it("emits BOTH a kser: route result and a tsel: selection result for a completed delegate_tedi run", async () => {
		const { db, inserts } = createPersistenceDb({
			runs: [delegateRun("run-d1", "tedi-cto", "2026-06-22T10:00:00.000Z")],
			events: [
				{
					runId: "run-d1",
					kind: "subagent.completed",
					payload: null,
					organizationId: ORG,
				},
			],
		});

		await gradeRecentKernelRoutes(db, { orgId: ORG });

		const subjectInserts = inserts.filter(
			(i) => i.table === harnessSubjectEvalResults,
		);
		const routeResult = subjectInserts.find((i) =>
			String(i.values.id).startsWith("kser:"),
		);
		const selectionResult = subjectInserts.find((i) =>
			String(i.values.id).startsWith("tsel:"),
		);

		expect(routeResult).toBeDefined();
		expect(selectionResult).toBeDefined();
		// Selection result is keyed by the delegated tedi + tedi-selection subject.
		expect(selectionResult?.values.tediId).toBe("tedi-cto");
		expect(selectionResult?.values.subjectId).toBe(`tedi-selection:${ORG}`);
		expect(selectionResult?.values.taskSetId).toBe("tedi-selection-v1");
		expect(selectionResult?.values.passed).toBe(true);
		expect(
			(selectionResult?.values.metadata as Record<string, unknown>)
				?.delegatedTediId,
		).toBe("tedi-cto");
	});

	it("emits ONLY a route result (no tsel:) for a non-delegate run", async () => {
		const { db, inserts } = createPersistenceDb({
			runs: [
				{
					id: "run-a1",
					organizationId: ORG,
					status: "completed",
					createdAt: "2026-06-22T10:00:00.000Z",
					metadata: {
						kernelRoute: { routeKind: "answer_in_home", routerVersion: "rv1" },
					},
				},
			],
			events: [
				{
					runId: "run-a1",
					kind: "run.completed",
					payload: null,
					organizationId: ORG,
				},
			],
		});

		await gradeRecentKernelRoutes(db, { orgId: ORG });

		const subjectInserts = inserts.filter(
			(i) => i.table === harnessSubjectEvalResults,
		);
		expect(
			subjectInserts.some((i) => String(i.values.id).startsWith("kser:")),
		).toBe(true);
		expect(
			subjectInserts.some((i) => String(i.values.id).startsWith("tsel:")),
		).toBe(false);
	});

	it("skips the tsel: write when a delegate_tedi run has no resolvable target", async () => {
		const { db, inserts } = createPersistenceDb({
			runs: [
				{
					id: "run-d2",
					organizationId: ORG,
					status: "completed",
					createdAt: "2026-06-22T10:00:00.000Z",
					metadata: {
						// plan-only delegation: no single target id anywhere.
						kernelRoute: { routeKind: "delegate_tedi", routerVersion: "rv1" },
					},
				},
			],
			events: [
				{
					runId: "run-d2",
					kind: "decision.recorded",
					payload: { action: "home.plan.approved" },
					organizationId: ORG,
				},
			],
		});

		await gradeRecentKernelRoutes(db, { orgId: ORG });

		const subjectInserts = inserts.filter(
			(i) => i.table === harnessSubjectEvalResults,
		);
		expect(
			subjectInserts.some((i) => String(i.values.id).startsWith("kser:")),
		).toBe(true);
		expect(
			subjectInserts.some((i) => String(i.values.id).startsWith("tsel:")),
		).toBe(false);
	});

	it("surfaces an immutable subject-run persistence conflict", async () => {
		const { db } = createPersistenceDb({
			runs: [
				delegateRun("run-conflict", "tedi-cto", "2026-06-22T10:00:00.000Z"),
			],
			events: [
				{
					runId: "run-conflict",
					kind: "subagent.completed",
					payload: null,
					organizationId: ORG,
				},
			],
			subjectRunConflict: true,
		});

		await expect(gradeRecentKernelRoutes(db, { orgId: ORG })).rejects.toThrow(
			/conflicts with its persisted immutable payload/,
		);
	});
});

// keep `harnessSubjectEvalRuns` / `harnessSubjectVersions` imported (read path
// routing relies on table identity) — referenced here to avoid unused-import lint.
void harnessSubjectEvalRuns;
void harnessSubjectVersions;

describe("late correction persistence against D1-parity SQLite", () => {
	it("does not backfill a newer positive base after a correction falls outside the reader window", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF;");
		sqlite.exec(
			schemaDdl(
				kernelRuntimeRuns,
				kernelRuntimeEvents,
				harnessSubjectVersions,
				harnessSubjectEvalResults,
				knowledgeEntries,
			),
		);
		const db = createDbClient(createD1Facade(sqlite));
		sqlite.exec(`
			INSERT INTO kernel_runtime_runs (id,organization_id,conversation_id,status,metadata,created_at,updated_at) VALUES
			('corrected-recent','org-tsel-test','home','completed','{"kernelRoute":{"routeKind":"delegate_tedi"},"delegatedTediId":"tedi-cto","bodyExecutionResult":{"harnessVersionId":"v1"}}','2026-09-24T10:00:00.000Z','2026-09-24T10:00:00.000Z');
			INSERT INTO kernel_runtime_events (id,organization_id,kind,conversation_id,run_id,payload,created_at) VALUES
			('correction-event','org-tsel-test','decision.recorded','home','new-correction-run','{"action":"kernel.route_corrected","priorRunId":"corrected-recent"}','2026-09-24T10:00:01.000Z');
			INSERT INTO harness_subject_eval_results (id,subject_kind,subject_id,tedi_id,org_id,harness_version_id,score,gates,passed,lane,task_set_id,metadata,created_at) VALUES
			('kser-correction:correction-event','kernel','kernel:org-tsel-test',NULL,'org-tsel-test','v1',0,'{"notCorrected":false}',0,'production','kernel-route-v1','{"runId":"corrected-recent","source":"kernel-route-correction","correctionEventId":"correction-event"}','2026-09-24T10:00:02.000Z'),
			('tsel-correction:correction-event','kernel','tedi-selection:org-tsel-test','tedi-cto','org-tsel-test','v1',0,'{"notCorrected":false}',0,'production','tedi-selection-v1','{"runId":"corrected-recent","source":"kernel-route-correction","correctionEventId":"correction-event"}','2026-09-24T10:00:02.000Z');
			WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 801)
			INSERT INTO harness_subject_eval_results (id,subject_kind,subject_id,org_id,harness_version_id,score,gates,passed,lane,task_set_id,metadata,created_at)
			SELECT 'unrelated-' || printf('%04d', n),'kernel','kernel:org-tsel-test','org-tsel-test','v1',1,'{}',1,'production','kernel-route-v1','{"runId":"unrelated-' || n || '"}','2026-09-24T10:00:03.000Z' FROM numbers;
		`);
		const result = await gradeRecentKernelRoutes(db, {
			orgId: ORG,
			lookbackHours: 100_000,
		});
		expect(result.runsGraded).toBe(0);
		expect(
			sqlite
				.prepare(
					"SELECT id FROM harness_subject_eval_results WHERE id LIKE 'kser:%corrected-recent' OR id LIKE 'tsel:%corrected-recent'",
				)
				.all(),
		).toEqual([]);
		expect(
			sqlite
				.prepare(
					"SELECT COUNT(*) AS n FROM harness_subject_eval_results WHERE id LIKE '%correction:correction-event'",
				)
				.get(),
		).toMatchObject({ n: 2 });
	});

	it("repairs a partial correction write on the next all-history scan", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF;");
		sqlite.exec(
			schemaDdl(
				kernelRuntimeRuns,
				kernelRuntimeEvents,
				harnessSubjectEvalResults,
				knowledgeEntries,
			),
		);
		const db = createDbClient(createD1Facade(sqlite));
		sqlite.exec(`
			INSERT INTO kernel_runtime_runs (id,organization_id,conversation_id,status,metadata,created_at,updated_at) VALUES
			('old','org-tsel-test','home','completed','{"kernelRoute":{"routeKind":"delegate_tedi"},"delegatedTediId":"tedi-cto","bodyExecutionResult":{"harnessVersionId":"v1"}}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
			INSERT INTO kernel_runtime_events (id,organization_id,kind,conversation_id,run_id,payload,created_at) VALUES
			('old-terminal','org-tsel-test','subagent.completed','home','old','{}','2026-01-01T00:01:00.000Z'),
			('correction-event','org-tsel-test','decision.recorded','home','new-correction-run','{"action":"kernel.route_corrected","priorRunId":"old"}','2026-09-24T10:00:00.000Z');
			INSERT INTO harness_subject_eval_results (id,subject_kind,subject_id,tedi_id,org_id,harness_version_id,score,gates,passed,lane,task_set_id,metadata,created_at) VALUES
			('kser:v1:old','kernel','kernel:org-tsel-test',NULL,'org-tsel-test','v1',1,'{"notCorrected":true}',1,'production','kernel-route-v1','{"runId":"old"}','2026-01-02T00:00:00.000Z'),
			('tsel:v1:old','kernel','tedi-selection:org-tsel-test','tedi-cto','org-tsel-test','v1',1,'{"notCorrected":true}',1,'production','tedi-selection-v1','{"runId":"old"}','2026-01-02T00:00:00.000Z'),
			('kser-correction:correction-event','kernel','kernel:org-tsel-test',NULL,'org-tsel-test','v1',0,'{"notCorrected":false}',0,'production','kernel-route-v1','{"runId":"old","source":"kernel-route-correction","correctionEventId":"correction-event"}','2026-09-24T10:00:01.000Z');
		`);
		await gradeRecentKernelRoutes(db, { orgId: ORG, lookbackHours: 1 });
		expect(
			sqlite
				.prepare("SELECT id FROM harness_subject_eval_results ORDER BY id")
				.all()
				.map((row) => row.id),
		).toEqual([
			"kser-correction:correction-event",
			"kser:v1:old",
			"tsel-correction:correction-event",
			"tsel:v1:old",
		]);
		await gradeRecentKernelRoutes(db, { orgId: ORG, lookbackHours: 1 });
		expect(
			sqlite
				.prepare("SELECT COUNT(*) AS n FROM harness_subject_eval_results")
				.get(),
		).toMatchObject({ n: 4 });
		expect(await summarizeTediSelectionPriors(db, { orgId: ORG })).toEqual(
			new Map([["tedi-cto", { passed: 0, total: 1, successRate: 0 }]]),
		);
	});

	it("revises an old positive once, removes stale tcap, and preserves refreshed tcap on retry", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF;");
		sqlite.exec(
			schemaDdl(
				kernelRuntimeRuns,
				kernelRuntimeEvents,
				harnessSubjectEvalResults,
				knowledgeEntries,
			),
		);
		const db = createDbClient(createD1Facade(sqlite));
		sqlite.exec(`
			INSERT INTO kernel_runtime_runs (id,organization_id,conversation_id,status,metadata,created_at,updated_at) VALUES
			('old','org-tsel-test','home','completed','{"kernelRoute":{"routeKind":"delegate_tedi"},"delegatedTediId":"tedi-cto","bodyExecutionResult":{"harnessVersionId":"v1"}}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
			INSERT INTO kernel_runtime_events (id,organization_id,kind,conversation_id,run_id,payload,created_at) VALUES
			('old-terminal','org-tsel-test','subagent.completed','home','old','{}','2026-01-01T00:01:00.000Z'),
			('correction-event','org-tsel-test','decision.recorded','home','new-correction-run','{"action":"kernel.route_corrected","priorRunId":"old"}','2026-09-24T10:00:00.000Z');
			INSERT INTO harness_subject_eval_results (id,subject_kind,subject_id,tedi_id,org_id,harness_version_id,score,gates,passed,lane,task_set_id,metadata,created_at) VALUES
			('kser:v1:old','kernel','kernel:org-tsel-test',NULL,'org-tsel-test','v1',1,'{"routeProduced":true,"notCorrected":true,"outcomeSucceeded":true}',1,'production','kernel-route-v1','{"runId":"old"}','2026-01-02T00:00:00.000Z'),
			('tsel:v1:old','kernel','tedi-selection:org-tsel-test','tedi-cto','org-tsel-test','v1',1,'{"routeProduced":true,"notCorrected":true,"outcomeSucceeded":true}',1,'production','tedi-selection-v1','{"runId":"old","delegatedTediId":"tedi-cto"}','2026-01-02T00:00:00.000Z');
		`);
		await upsertTediLearnedCapability(db, {
			organizationId: ORG,
			tediId: "tedi-cto",
			learnedDescription: "stale",
			evidenceCount: 1,
			successRate: 1,
			updatedAt: "2026-09-23T00:00:00.000Z",
		});
		await gradeRecentKernelRoutes(db, { orgId: ORG, lookbackHours: 1 });
		expect(
			(
				await listSubjectEvalResults(db, {
					subjectKind: "kernel",
					subjectId: `kernel:${ORG}`,
					harnessVersionId: "v1",
				})
			).map((row) => [row.id, row.passed]),
		).toEqual([["kser-correction:correction-event", false]]);
		expect(await summarizeTediSelectionPriors(db, { orgId: ORG })).toEqual(
			new Map([["tedi-cto", { passed: 0, total: 1, successRate: 0 }]]),
		);
		expect((await getTediLearnedCapabilities(db, ORG, ["tedi-cto"])).size).toBe(
			0,
		);
		await upsertTediLearnedCapability(db, {
			organizationId: ORG,
			tediId: "tedi-cto",
			learnedDescription: "refreshed",
			evidenceCount: 1,
			successRate: 0,
			updatedAt: "2099-01-01T00:00:00.000Z",
		});
		await gradeRecentKernelRoutes(db, { orgId: ORG, lookbackHours: 1 });
		expect(
			sqlite
				.prepare("SELECT COUNT(*) AS n FROM harness_subject_eval_results")
				.get(),
		).toMatchObject({ n: 4 });
		expect(
			(await getTediLearnedCapabilities(db, ORG, ["tedi-cto"])).get("tedi-cto")
				?.learnedDescription,
		).toBe("refreshed");
	});
});

// ─── summarizeTediSelectionPriors — grouping + successRate ─────────────────────
//
// Unit-tests the bounded aggregation that derives per-tedi delegation priors the
// roster reads. Lives here (not the unowned packages/db harness-version.test.ts)
// but exercises the real exported db query via a fake DB that serves the
// harnessSubjectEvalResults select chain.

interface PriorRow {
	passed: boolean;
	metadata: Record<string, unknown> | null;
	tediId: string | null;
}

function createPriorsDb(
	rows: PriorRow[],
	opts?: { throwOnRead?: boolean },
): DbClient {
	return {
		select() {
			const builder = {
				from() {
					return builder;
				},
				where() {
					return builder;
				},
				orderBy() {
					return builder;
				},
				async limit(n: number) {
					if (opts?.throwOnRead) throw new Error("D1_ERROR: simulated");
					return rows.slice(0, n);
				},
			};
			return builder;
		},
	} as unknown as DbClient;
}

describe("summarizeTediSelectionPriors", () => {
	it("groups by metadata.delegatedTediId and computes successRate", async () => {
		const db = createPriorsDb([
			{
				passed: true,
				metadata: { delegatedTediId: "tedi-a" },
				tediId: "tedi-a",
			},
			{
				passed: true,
				metadata: { delegatedTediId: "tedi-a" },
				tediId: "tedi-a",
			},
			{
				passed: false,
				metadata: { delegatedTediId: "tedi-a" },
				tediId: "tedi-a",
			},
			{
				passed: true,
				metadata: { delegatedTediId: "tedi-b" },
				tediId: "tedi-b",
			},
		]);

		const priors = await summarizeTediSelectionPriors(db, { orgId: "org-x" });

		expect(priors.get("tedi-a")).toEqual({
			passed: 2,
			total: 3,
			successRate: 2 / 3,
		});
		expect(priors.get("tedi-b")).toEqual({
			passed: 1,
			total: 1,
			successRate: 1,
		});
	});

	it("falls back to the row tediId when metadata lacks delegatedTediId", async () => {
		const db = createPriorsDb([
			{ passed: true, metadata: null, tediId: "tedi-c" },
			{ passed: false, metadata: {}, tediId: "tedi-c" },
		]);
		const priors = await summarizeTediSelectionPriors(db, { orgId: "org-x" });
		expect(priors.get("tedi-c")).toEqual({
			passed: 1,
			total: 2,
			successRate: 0.5,
		});
	});

	it("fail-soft → empty Map on a read error", async () => {
		const db = createPriorsDb([], { throwOnRead: true });
		const priors = await summarizeTediSelectionPriors(db, { orgId: "org-x" });
		expect(priors.size).toBe(0);
	});

	it("derives a stable subject id prefix per org", () => {
		expect(tediSelectionSubjectId("org-42")).toBe("tedi-selection:org-42");
	});
});

// ─── claimVsEvidence gate (delegate_tedi + child evidence) ───────────────────

describe("gradeKernelRoute — claimVsEvidence gate", () => {
	const delegatedMeta = {
		kernelRoute: { routeKind: "delegate_tedi", targetTediId: "tedi-cto" },
		delegatedTediId: "tedi-cto",
	};
	const completedDelegation = [
		{ kind: "subagent.completed", payload: null, runId: "run-test-01" },
	];

	it("fails a completed delegation whose child overclaimed (the live 2026-07-05 case)", () => {
		const grade = gradeKernelRoute(
			makeRun({
				metadata: delegatedMeta,
				events: completedDelegation,
				childEvidence: {
					finalAssistantMessage:
						"Confirmed. I'll create a weekly Monday cron job. Setting it up now.",
					toolCalls: [
						{
							name: "tedix_mcp_code",
							codeArgument: 'async () => await discover.search("globex")',
						},
					],
				},
			}),
		);
		expect(grade.gates.claimVsEvidence).toBe(false);
		expect(grade.gates.outcomeSucceeded).toBe(true);
		// The same discover-only run ALSO trips the execution-evidence gate — it
		// overclaimed AND produced no execution evidence — so two of five gates fail.
		expect(grade.gates.executionEvidence).toBe(false);
		expect(grade.passed).toBe(false);
		expect(grade.score).toBe(3 / 5);
		expect(grade.claimVsEvidence?.overclaim).toBe(true);
		expect(grade.claimVsEvidence?.claimExcerpt).toContain("Setting it up now");
	});

	it("passes a delegation whose claim is backed by a mutating call", () => {
		const grade = gradeKernelRoute(
			makeRun({
				metadata: delegatedMeta,
				events: completedDelegation,
				childEvidence: {
					finalAssistantMessage: "I have created the weekly cron job.",
					toolCalls: [{ name: "cron" }],
				},
			}),
		);
		expect(grade.gates.claimVsEvidence).toBe(true);
		expect(grade.passed).toBe(true);
		expect(grade.score).toBe(1);
	});

	it("passes a claim-free delegated read turn", () => {
		const grade = gradeKernelRoute(
			makeRun({
				metadata: delegatedMeta,
				events: completedDelegation,
				childEvidence: {
					finalAssistantMessage: "I found 24 globex tools; top three below.",
					toolCalls: [{ name: "list_skills" }],
				},
			}),
		);
		expect(grade.gates.claimVsEvidence).toBe(true);
		expect(grade.passed).toBe(true);
	});

	it("does NOT add the gate when child evidence is absent (grades unchanged)", () => {
		const grade = gradeKernelRoute(
			makeRun({ metadata: delegatedMeta, events: completedDelegation }),
		);
		expect(grade.gates.claimVsEvidence).toBeUndefined();
		expect(Object.keys(grade.gates)).toHaveLength(3);
		expect(grade.passed).toBe(true);
		expect(grade.claimVsEvidence).toBeUndefined();
	});

	it("does NOT add the gate for non-delegated routes even with evidence", () => {
		const grade = gradeKernelRoute(
			makeRun({
				metadata: { kernelRoute: { routeKind: "answer_in_home" } },
				events: [
					{ kind: "run.completed", payload: null, runId: "run-test-01" },
				],
				childEvidence: {
					finalAssistantMessage: "I have created something.",
					toolCalls: [],
				},
			}),
		);
		expect(grade.gates.claimVsEvidence).toBeUndefined();
		expect(grade.passed).toBe(true);
	});
});

// ─── executionEvidence gate (delegate_tedi read-fabrication) ─────────────────

describe("gradeKernelRoute — executionEvidence gate", () => {
	const delegatedMeta = {
		kernelRoute: { routeKind: "delegate_tedi", targetTediId: "tedi-cto" },
		delegatedTediId: "tedi-cto",
	};
	const completedDelegation = [
		{ kind: "subagent.completed", payload: null, runId: "run-test-01" },
	];

	it("fails a completed delegation that answered a READ from discovery only (the web-scrape fabrication)", () => {
		// The live CTO case: discovered tavily/firecrawl, never called them, then
		// presented an invented article. No side-effect verb, so claimVsEvidence
		// passes — but the run has NO execution evidence, so this gate catches it.
		const grade = gradeKernelRoute(
			makeRun({
				metadata: delegatedMeta,
				events: completedDelegation,
				childEvidence: {
					finalAssistantMessage:
						"Here's the article summary: the vendor announced a Q3 pricing change affecting mid-market tiers…",
					toolCalls: [
						{ name: "tedix_mcp_search_tools", codeArgument: null },
						{
							name: "tedix_mcp_code",
							codeArgument: 'async () => await discover.search("firecrawl")',
						},
					],
				},
			}),
		);
		expect(grade.gates.executionEvidence).toBe(false);
		// claimVsEvidence has no side-effect verb to flag → it PASSES; only the new
		// gate catches this read-fabrication.
		expect(grade.gates.claimVsEvidence).toBe(true);
		expect(grade.gates.outcomeSucceeded).toBe(true);
		expect(grade.passed).toBe(false);
		expect(grade.score).toBe(4 / 5);
	});

	it("passes a delegated read backed by a real execution call (tavily returned results)", () => {
		const grade = gradeKernelRoute(
			makeRun({
				metadata: delegatedMeta,
				events: completedDelegation,
				childEvidence: {
					finalAssistantMessage: "Here are 5 real results from the search…",
					toolCalls: [
						{ name: "tedix_mcp_search_tools", codeArgument: null },
						{
							name: "tedix_mcp_code",
							codeArgument:
								'async () => await tavily_tedix.search({ query: "vendor pricing" })',
						},
					],
				},
			}),
		);
		expect(grade.gates.executionEvidence).toBe(true);
		expect(grade.passed).toBe(true);
		expect(grade.score).toBe(1);
	});

	it("does NOT add the gate for an answer-only delegation (zero tool calls)", () => {
		const grade = gradeKernelRoute(
			makeRun({
				metadata: delegatedMeta,
				events: completedDelegation,
				childEvidence: {
					finalAssistantMessage: "From what I know, the pipeline is green.",
					toolCalls: [],
				},
			}),
		);
		// Answer-only is legitimate — no tool calls means no fabrication signal.
		expect(grade.gates.executionEvidence).toBeUndefined();
		expect(grade.passed).toBe(true);
	});

	it("counts a direct bespoke tool (tedix_mcp_call_tool) as execution evidence", () => {
		const grade = gradeKernelRoute(
			makeRun({
				metadata: delegatedMeta,
				events: completedDelegation,
				childEvidence: {
					finalAssistantMessage: "Fetched the 5 latest commits, listed below.",
					toolCalls: [{ name: "tedix_mcp_call_tool" }],
				},
			}),
		);
		expect(grade.gates.executionEvidence).toBe(true);
		expect(grade.passed).toBe(true);
	});
});

// ─── Contract soft signal + typed failure (delegate_tedi) ────────────────────

describe("gradeKernelRoute — contract soft signal", () => {
	const contractMeta = {
		kernelRoute: { routeKind: "delegate_tedi", targetTediId: "tedi-cto" },
		delegatedTediId: "tedi-cto",
		homeDelegation: {
			workOrder: {
				targetTediId: "tedi-cto",
				contract: {
					successCriteria: [
						"the answer states the specific facts read, citing the tool calls that produced them",
					],
					failurePolicy: "fail_closed — …",
				},
			},
		},
	};
	const completedDelegation = [
		{ kind: "subagent.completed", payload: null, runId: "run-test-01" },
	];

	it("reports criteriaMet=true for a completed delegation with cited tool evidence", () => {
		const grade = gradeKernelRoute(
			makeRun({
				metadata: contractMeta,
				events: completedDelegation,
				childEvidence: {
					finalAssistantMessage: "I found 3 overdue invoices; list below.",
					toolCalls: [{ name: "list_invoices" }],
				},
			}),
		);
		expect(grade.contract).toEqual({ criteriaMet: true });
		expect(grade.passed).toBe(true);
	});

	it("reports criteriaMet=null when child evidence is absent (indeterminable, fail-soft)", () => {
		const grade = gradeKernelRoute(
			makeRun({ metadata: contractMeta, events: completedDelegation }),
		);
		expect(grade.contract).toEqual({ criteriaMet: null });
		// The soft signal must not alter the gate set or the verdict.
		expect(Object.keys(grade.gates)).toHaveLength(3);
		expect(grade.passed).toBe(true);
	});

	it("reports criteriaMet=false when the turn produced zero tool calls (nothing to cite) — WITHOUT failing any gate", () => {
		const grade = gradeKernelRoute(
			makeRun({
				metadata: contractMeta,
				events: completedDelegation,
				childEvidence: {
					finalAssistantMessage: "There are 3 overdue invoices.",
					toolCalls: [],
				},
			}),
		);
		expect(grade.contract).toEqual({ criteriaMet: false });
		// Soft: no claim was made, so the claimVsEvidence gate passes and the
		// grade is unchanged by the contract verdict.
		expect(grade.gates.claimVsEvidence).toBe(true);
		expect(grade.passed).toBe(true);
	});

	it("reports criteriaMet=false when the child overclaimed", () => {
		const grade = gradeKernelRoute(
			makeRun({
				metadata: contractMeta,
				events: completedDelegation,
				childEvidence: {
					finalAssistantMessage: "Setting it up now.",
					toolCalls: [{ name: "list_skills" }],
				},
			}),
		);
		expect(grade.contract).toEqual({ criteriaMet: false });
		expect(grade.gates.claimVsEvidence).toBe(false);
	});

	it("reports criteriaMet=false when the delegation outcome failed", () => {
		const grade = gradeKernelRoute(
			makeRun({
				metadata: contractMeta,
				events: [
					{ kind: "subagent.failed", payload: null, runId: "run-test-01" },
				],
				childEvidence: {
					finalAssistantMessage: "I could not finish the audit.",
					toolCalls: [{ name: "list_invoices" }],
				},
			}),
		);
		expect(grade.contract).toEqual({ criteriaMet: false });
	});

	it("omits the contract field entirely for a pre-contract work order (grades unchanged)", () => {
		const grade = gradeKernelRoute(
			makeRun({
				metadata: {
					kernelRoute: { routeKind: "delegate_tedi" },
					homeDelegation: { workOrder: { targetTediId: "tedi-cto" } },
				},
				events: completedDelegation,
				childEvidence: {
					finalAssistantMessage: "Done reading; facts below.",
					toolCalls: [{ name: "list_invoices" }],
				},
			}),
		);
		expect(grade.contract).toBeUndefined();
		expect(grade.passed).toBe(true);
	});
});

describe("gradeKernelRoute — typed delegation failure", () => {
	it("classifies a recorded dispatch-timeout envelope as transport/retryable", () => {
		const grade = gradeKernelRoute(
			makeRun({
				metadata: {
					kernelRoute: { routeKind: "delegate_tedi" },
					delegationFailure: {
						ok: false,
						status: "failed",
						reason: "dispatch_failed",
						error:
							"dispatch_timeout: Delegated child dispatch timed out before the child runtime published events",
						retryable: true,
						childStillRunning: false,
					},
				},
				events: [
					{ kind: "subagent.failed", payload: null, runId: "run-test-01" },
				],
			}),
		);
		expect(grade.delegationFailure).toEqual({
			category: "transport",
			retryable: true,
		});
	});

	it("classifies an overclaim on a completed run as a quality failure", () => {
		const grade = gradeKernelRoute(
			makeRun({
				metadata: {
					kernelRoute: { routeKind: "delegate_tedi" },
				},
				events: [
					{ kind: "subagent.completed", payload: null, runId: "run-test-01" },
				],
				childEvidence: {
					finalAssistantMessage: "Setting it up now.",
					toolCalls: [{ name: "list_skills" }],
				},
			}),
		);
		expect(grade.delegationFailure).toEqual({
			category: "quality",
			retryable: true,
		});
	});

	it("emits no delegationFailure when there is nothing to classify", () => {
		const grade = gradeKernelRoute(
			makeRun({
				metadata: { kernelRoute: { routeKind: "delegate_tedi" } },
				events: [
					{ kind: "subagent.completed", payload: null, runId: "run-test-01" },
				],
			}),
		);
		expect(grade.delegationFailure).toBeUndefined();
	});

	it("emits no delegationFailure for non-delegated routes even with an envelope", () => {
		const grade = gradeKernelRoute(
			makeRun({
				metadata: {
					kernelRoute: { routeKind: "answer_in_home" },
					delegationFailure: {
						ok: false,
						status: "failed",
						reason: "dispatch_failed",
						error: "fetch failed",
						retryable: true,
						childStillRunning: false,
					},
				},
				events: [
					{ kind: "run.completed", payload: null, runId: "run-test-01" },
				],
			}),
		);
		expect(grade.delegationFailure).toBeUndefined();
	});
});
