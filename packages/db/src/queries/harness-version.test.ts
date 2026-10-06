/**
 * Unit tests for the pure mappers/folders in the harness eval ledger query
 * layer. These exercise the row→contract mapping and the eval-summary fold
 * (`summarizeEvalResults`) without a live D1 — the DB-backed query functions
 * (`recordEvalResult` / `listEvalResults` / `getEvalSummaryForVersion`) are thin
 * Drizzle wrappers around these folds plus a single ordered select.
 */

import type {
	HarnessEvalResult,
	HarnessEvalRun,
	HarnessEvalRunReport,
	HarnessSubjectEvalRun,
	TraceBundle,
} from "@tedix/api-contract/schemas/harness-version";
import {
	DEFAULT_EVAL_LANE,
	summarizeHarnessEvalTrials,
} from "@tedix/api-contract/schemas/harness-version";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "../schema/control-plane";
import { organizations } from "../schema/organizations";
import { tedis } from "../schema/tedis";
import {
	harnessEvalResults,
	harnessEvalRuns,
	harnessSubjectEvalRuns,
	harnessVersions,
	traceBundles,
} from "../schema/harness-versions";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	recordEvalResult,
	recordEvalRun,
	recordSubjectEvalRun,
	summarizeEvalResults,
} from "./harness-version/evaluations";
import { kernelHarnessSubjectId } from "./harness-version/subjects";
import {
	mergeTraceBundleMetadata,
	recordTraceBundle,
	unionTraceBundleIds,
} from "./harness-version/trace-bundles";
import {
	harnessComponentsEqual,
	nextHarnessVersionString,
	serializeHarnessComponents,
} from "./harness-version/versions";

function evalResult(over: Partial<HarnessEvalResult> = {}): HarnessEvalResult {
	return {
		id: "her_1",
		harnessVersionId: "hv_01",
		tediId: "tedi_cto",
		orgId: "org_tedix",
		score: 0.9,
		gates: { task_success: true },
		passed: true,
		lane: "validation",
		taskSetId: "taskset_v1",
		createdAt: "2026-05-31T00:00:00.000Z",
		...over,
	};
}

function ownershipFixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			organizations,
			runtimeProfiles,
			policyPacks,
			workspaceTemplateSets,
			tedis,
			harnessVersions,
			harnessEvalResults,
			harnessEvalRuns,
			harnessSubjectEvalRuns,
			traceBundles,
		),
	);
	sqlite.exec(`
		INSERT INTO organizations (id, name, slug) VALUES
			('org-1', 'One', 'one'), ('org-2', 'Two', 'two');
		INSERT INTO tedis (id, organization_id, name, slug) VALUES
			('tedi-1', 'org-1', 'One', 'one'),
			('tedi-peer', 'org-1', 'Peer', 'peer'),
			('tedi-2', 'org-2', 'Two', 'two');
		INSERT INTO harness_versions (id, tedi_id, org_id, version, created_at) VALUES
			('hv-1', 'tedi-1', 'org-1', '1', '2026-09-22T00:00:00.000Z'),
			('hv-peer', 'tedi-peer', 'org-1', '1', '2026-09-22T00:00:00.000Z'),
			('hv-2', 'tedi-2', 'org-2', '1', '2026-09-22T00:00:00.000Z'),
			('hv-legacy', 'tedi-1', NULL, '0', '2026-09-22T00:00:00.000Z');
	`);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

function evalRun(over: Partial<HarnessEvalRun> = {}): HarnessEvalRun {
	return {
		id: "run-1",
		harnessVersionId: "hv-1",
		tediId: "tedi-1",
		orgId: "org-1",
		lane: "validation",
		taskSetId: "tasks-1",
		total: 1,
		passed: 1,
		failed: 0,
		meanScore: 1,
		eligible: true,
		createdAt: "2026-09-22T00:00:00.000Z",
		...over,
	};
}

function evalReport(costUsdMicros = 100): HarnessEvalRunReport {
	const trials = [1, 2].map((ordinal) => ({
		id: `trial-${ordinal}`,
		ordinal,
		seed: `seed-${ordinal}`,
		inputDigest: `sha256:${"a".repeat(64)}`,
		settingsDigest: `sha256:${"b".repeat(64)}`,
		status: "completed" as const,
		score: 1,
		passed: true,
		steps: [
			{
				sequence: 1,
				inputTokens: 50,
				outputTokens: 10,
				costUsdMicros,
				cacheBoundaries: [
					{
						key: "system:v1",
						opportunityTokens: 40,
						cacheReadTokens: 30,
					},
				],
			},
		],
	}));
	return {
		protocolVersion: 1,
		replayGroupKey: "tasks-1:model-1",
		trials,
		summary: summarizeHarnessEvalTrials(trials),
	};
}

function subjectEvalRun(
	over: Partial<HarnessSubjectEvalRun> = {},
): HarnessSubjectEvalRun {
	return {
		id: "subject-run-1",
		subjectKind: "kernel",
		subjectId: "kernel:org-1",
		tediId: null,
		orgId: "org-1",
		harnessVersionId: "subject-hv-1",
		lane: "validation",
		taskSetId: "tasks-1",
		total: 2,
		passed: 2,
		failed: 0,
		meanScore: 1,
		eligible: true,
		report: evalReport(),
		createdAt: "2026-09-22T00:00:00.000Z",
		...over,
	};
}

function traceBundle(over: Partial<TraceBundle> = {}): TraceBundle {
	return {
		id: "bundle-1",
		tediId: "tedi-1",
		orgId: "org-1",
		runId: "run-1",
		harnessVersionId: "hv-1",
		createdAt: "2026-09-22T00:00:00.000Z",
		...over,
	};
}

describe("harness eval ownership boundary", () => {
	it("accepts exact ownership and legacy null-org versions using canonical tedi org", async () => {
		const { db } = ownershipFixture();
		expect(
			await recordEvalResult(
				db,
				evalResult({
					tediId: "tedi-1",
					orgId: "org-1",
					harnessVersionId: "hv-1",
				}),
			),
		).toBe(true);
		expect(
			await recordEvalRun(db, evalRun({ harnessVersionId: "hv-legacy" })),
		).toBe(true);
	});

	it("rejects mismatched version ownership and conflicting id retries", async () => {
		const { db, sqlite } = ownershipFixture();
		expect(
			await recordEvalResult(db, evalResult({ harnessVersionId: "hv-peer" })),
		).toBe(false);
		expect(await recordEvalRun(db, evalRun({ harnessVersionId: "hv-2" }))).toBe(
			false,
		);
		const ownedResult = {
			harnessVersionId: "hv-1",
			tediId: "tedi-1",
			orgId: "org-1",
		} as const;
		expect(await recordEvalResult(db, evalResult(ownedResult))).toBe(true);
		expect(
			await recordEvalResult(db, evalResult({ ...ownedResult, score: 0.01 })),
		).toBe(false);
		expect(
			await recordEvalResult(
				db,
				evalResult({ ...ownedResult, harnessVersionId: "hv-legacy" }),
			),
		).toBe(false);
		expect(
			sqlite
				.prepare("SELECT COUNT(*) AS count FROM harness_eval_results")
				.get(),
		).toEqual({ count: 1 });
	});

	it("rejects an eval-run retry whose unpersisted score changed", async () => {
		const { db, sqlite } = ownershipFixture();
		expect(await recordEvalRun(db, evalRun())).toBe(true);
		expect(await recordEvalRun(db, evalRun({ meanScore: 0.01 }))).toBe(false);
		expect(
			sqlite
				.prepare("SELECT mean_score FROM harness_eval_runs WHERE id = 'run-1'")
				.get(),
		).toEqual({ mean_score: 1 });
	});

	it("persists replay reports and rejects conflicting telemetry retries", async () => {
		const { db, sqlite } = ownershipFixture();
		expect(await recordEvalRun(db, evalRun({ report: evalReport() }))).toBe(
			true,
		);
		expect(await recordEvalRun(db, evalRun({ report: evalReport(999) }))).toBe(
			false,
		);
		expect(
			JSON.parse(
				(
					sqlite
						.prepare("SELECT report FROM harness_eval_runs WHERE id = 'run-1'")
						.get() as { report: string }
				).report,
			).summary.totalCostUsdMicros,
		).toBe(200);
	});

	it("rejects conflicting subject replay reports", async () => {
		const { db } = ownershipFixture();
		expect(await recordSubjectEvalRun(db, subjectEvalRun())).toBe(true);
		expect(
			await recordSubjectEvalRun(
				db,
				subjectEvalRun({ report: evalReport(999) }),
			),
		).toBe(false);
	});

	it("does not merge a caller-owned trace into a foreign bundle id", async () => {
		const { db, sqlite } = ownershipFixture();
		expect(
			await recordTraceBundle(
				db,
				traceBundle({ id: "shared", artifactIds: ["victim"] }),
			),
		).toBe(true);
		expect(
			await recordTraceBundle(
				db,
				traceBundle({
					id: "shared",
					tediId: "tedi-2",
					orgId: "org-2",
					harnessVersionId: "hv-2",
					artifactIds: ["attacker"],
				}),
			),
		).toBe(false);
		expect(
			sqlite
				.prepare(
					"SELECT tedi_id, artifact_ids FROM trace_bundles WHERE id = 'shared'",
				)
				.get(),
		).toEqual({ tedi_id: "tedi-1", artifact_ids: '["victim"]' });
	});

	it("lets only one ownership tuple claim a concurrently reused trace id", async () => {
		const { db, sqlite } = ownershipFixture();
		const results = await Promise.all([
			recordTraceBundle(db, traceBundle({ id: "race", artifactIds: ["one"] })),
			recordTraceBundle(
				db,
				traceBundle({
					id: "race",
					tediId: "tedi-2",
					orgId: "org-2",
					harnessVersionId: "hv-2",
					artifactIds: ["two"],
				}),
			),
		]);
		expect(results.toSorted()).toEqual([false, true]);
		expect(
			sqlite.prepare("SELECT COUNT(*) AS count FROM trace_bundles").get(),
		).toEqual({ count: 1 });
	});
});

describe("harness subject versions", () => {
	it("uses stable org-scoped kernel subject ids", () => {
		expect(kernelHarnessSubjectId("org_1")).toBe("kernel:org_1");
	});

	it("compares component maps independent of key order", () => {
		expect(serializeHarnessComponents({ b: "2", a: "1" })).toBe(
			JSON.stringify([
				["a", "1"],
				["b", "2"],
			]),
		);
		expect(
			harnessComponentsEqual(
				{ attention_router: "abc", prompt_template: "p1" },
				{ prompt_template: "p1", attention_router: "abc" },
			),
		).toBe(true);
	});

	it("increments numeric subject versions and resets non-numeric strings", () => {
		expect(nextHarnessVersionString(null)).toBe("1");
		expect(nextHarnessVersionString("7")).toBe("8");
		expect(nextHarnessVersionString("v7")).toBe("1");
	});
});

describe("summarizeEvalResults", () => {
	it("returns an empty summary when there are no results", () => {
		const s = summarizeEvalResults("hv_01", []);
		expect(s).toEqual({
			harnessVersionId: "hv_01",
			total: 0,
			passedCount: 0,
			failedCount: 0,
			latestScore: null,
			latestCreatedAt: null,
			lanes: [],
			latestPassByLane: {},
		});
	});

	it("counts pass/fail and surfaces the latest (first) score", () => {
		const s = summarizeEvalResults("hv_01", [
			evalResult({ id: "a", passed: true, score: 0.95 }),
			evalResult({ id: "b", passed: false, score: 0.2 }),
			evalResult({ id: "c", passed: true, score: 0.8 }),
		]);
		expect(s.total).toBe(3);
		expect(s.passedCount).toBe(2);
		expect(s.failedCount).toBe(1);
		expect(s.latestScore).toBe(0.95);
		expect(s.latestCreatedAt).toBe("2026-05-31T00:00:00.000Z");
	});

	it("takes the LATEST eval per lane (input newest-first)", () => {
		// validation: newest is a failure; canary: newest is a pass.
		const s = summarizeEvalResults("hv_01", [
			evalResult({ id: "v2", lane: "validation", passed: false }),
			evalResult({ id: "c2", lane: "canary", passed: true }),
			evalResult({ id: "v1", lane: "validation", passed: true }),
		]);
		expect(s.lanes).toEqual(["validation", "canary"]);
		expect(s.latestPassByLane).toEqual({ validation: false, canary: true });
	});

	it("collapses a null/empty lane to DEFAULT_EVAL_LANE", () => {
		const s = summarizeEvalResults("hv_01", [
			evalResult({ id: "n1", lane: null, passed: true }),
		]);
		expect(s.lanes).toEqual([DEFAULT_EVAL_LANE]);
		expect(s.latestPassByLane).toEqual({ [DEFAULT_EVAL_LANE]: true });
	});
});

// ── unionTraceBundleIds (backfill MERGE-on-conflict) ─────────────────────────
// The isolate emits a per-run TraceBundle from two separate durable queue steps
// (ledger mirror → event ids, bridge → rationale/artifact ids) with no ordering
// guarantee, so recordTraceBundle unions the id arrays instead of conflict-do-
// nothing. Guard the union: order-preserving, de-duped, empty/falsy-safe, idempotent.
describe("unionTraceBundleIds", () => {
	it("unions disjoint id sets preserving first-seen order", () => {
		expect(unionTraceBundleIds(["a", "b"], ["c", "d"])).toEqual([
			"a",
			"b",
			"c",
			"d",
		]);
	});
	it("de-duplicates ids present in both sets (existing wins position)", () => {
		expect(unionTraceBundleIds(["a", "b"], ["b", "c"])).toEqual([
			"a",
			"b",
			"c",
		]);
	});
	it("is idempotent when re-delivering an identical set", () => {
		const ids = ["evt:0", "evt:1", "evt:2"];
		expect(unionTraceBundleIds(ids, ids)).toEqual(ids);
	});
	it("treats null/undefined inputs as empty", () => {
		expect(unionTraceBundleIds(null, ["a"])).toEqual(["a"]);
		expect(unionTraceBundleIds(["a"], undefined)).toEqual(["a"]);
		expect(unionTraceBundleIds(undefined, null)).toEqual([]);
	});
	it("drops empty-string ids", () => {
		expect(unionTraceBundleIds(["a", ""], ["", "b"])).toEqual(["a", "b"]);
	});
	it("merges an empty re-emission without losing existing ids", () => {
		expect(unionTraceBundleIds(["r1", "r2"], [])).toEqual(["r1", "r2"]);
	});
});

describe("mergeTraceBundleMetadata", () => {
	it("unions body execution id arrays while letting incoming metadata fill details", () => {
		expect(
			mergeTraceBundleMetadata(
				{
					bodyExecutionResult: {
						id: "run_1:bundle:body-execution-result",
						bodyKind: "isolate",
						status: "completed",
						artifactIds: [],
						approvalIds: ["approval_1"],
						runtimeServices: ["think"],
						summary: null,
					},
				},
				{
					bodyExecutionResult: {
						id: "run_1:bundle:body-execution-result",
						bodyKind: "isolate",
						status: "completed",
						artifactIds: ["artifact_1"],
						approvalIds: [],
						runtimeServices: ["mcp", "think"],
						summary: "done",
					},
				},
			),
		).toEqual({
			bodyExecutionResult: {
				id: "run_1:bundle:body-execution-result",
				bodyKind: "isolate",
				status: "completed",
				artifactIds: ["artifact_1"],
				approvalIds: ["approval_1"],
				runtimeServices: ["think", "mcp"],
				summary: "done",
			},
		});
	});

	it("preserves an existing execution envelope when a later emitter has no metadata", () => {
		expect(
			mergeTraceBundleMetadata(
				{
					bodyExecutionResult: {
						id: "run_1:bundle:body-execution-result",
						artifactIds: ["artifact_1"],
					},
				},
				undefined,
			),
		).toEqual({
			bodyExecutionResult: {
				id: "run_1:bundle:body-execution-result",
				artifactIds: ["artifact_1"],
			},
		});
	});

	it("merges workstation sessions and participants without erasing earlier evidence", () => {
		expect(
			mergeTraceBundleMetadata(
				{
					workstation: {
						profileId: "general",
						workstationId: "ws_1",
						leaseId: "lease_1",
						sessionIds: ["codemode_session"],
						participantIds: ["participant_cto"],
					},
				},
				{
					workstation: {
						profileId: "general",
						workstationId: "ws_1",
						leaseId: "lease_1",
						sessionIds: ["browser_session", "codemode_session"],
						participantIds: ["participant_cpo"],
					},
				},
			),
		).toEqual({
			workstation: {
				profileId: "general",
				workstationId: "ws_1",
				leaseId: "lease_1",
				sessionIds: ["codemode_session", "browser_session"],
				participantIds: ["participant_cto", "participant_cpo"],
			},
		});
	});
});
