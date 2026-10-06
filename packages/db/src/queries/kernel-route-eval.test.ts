import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import {
	kernelRuntimeEvents,
	kernelRuntimeRuns,
} from "../schema/cognitive-runtime";
import { harnessSubjectEvalResults } from "../schema/harness-versions";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getKernelCorrectionEvalRevision,
	listCorrectedKernelRunIds,
	listKernelEvalResultsForPriorRun,
	listKernelRouteCorrectionEvents,
	listKernelRunsForCorrection,
} from "./kernel-route-eval";
import {
	listTediSelectionCapabilityEvidence,
	summarizeTediSelectionPriors,
} from "./harness-version/subjects";
import {
	listSubjectEvalResults,
	recordSubjectEvalResult,
} from "./harness-version/evaluations";
import { effectiveKernelEvalRows } from "./harness-version/effective-kernel-evals";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			kernelRuntimeEvents,
			kernelRuntimeRuns,
			harnessSubjectEvalResults,
		),
	);
	return { sqlite, db: createDbClient(createD1Facade(sqlite)) };
}

describe("kernel route correction query boundary", () => {
	it("finds corrected prior runs in a bounded org-scoped batch", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(`
			INSERT INTO harness_subject_eval_results (id,subject_kind,subject_id,org_id,harness_version_id,score,gates,passed,lane,task_set_id,metadata,created_at) VALUES
			('corrected-1','kernel','kernel:org-1','org-1','v1',0,'{}',0,'production','kernel-route-v1','{"runId":"old","source":"kernel-route-correction"}','2026-09-24T00:00:00.000Z'),
			('corrected-2','kernel','kernel:org-1','org-1','v1',0,'{}',0,'production','kernel-route-v1','{"runId":"old","source":"kernel-route-correction"}','2026-09-24T00:00:01.000Z'),
			('other-org','kernel','kernel:org-2','org-2','v1',0,'{}',0,'production','kernel-route-v1','{"runId":"other","source":"kernel-route-correction"}','2026-09-24T00:00:01.000Z'),
			('wrong-subject','kernel','tedi-selection:org-1','org-1','v1',0,'{}',0,'production','tedi-selection-v1','{"runId":"selection-only","source":"kernel-route-correction"}','2026-09-24T00:00:01.000Z');
		`);
		expect(
			await listCorrectedKernelRunIds(db, {
				organizationId: "org-1",
				runIds: ["old", "other", "selection-only"],
			}),
		).toEqual(["old"]);
	});

	it("keeps a correction effective when a delayed base sorts first at the same timestamp", () => {
		const corrected = {
			id: "kser-correction:event",
			metadata: { runId: "old", source: "kernel-route-correction" },
			passed: false,
		};
		const delayedBase = {
			id: "kser:z:old",
			metadata: { runId: "old" },
			passed: true,
		};
		expect(
			effectiveKernelEvalRows([delayedBase, corrected], 10).map(
				(row) => row.id,
			),
		).toEqual([corrected.id]);
	});

	it("pages new-run correction events by event time and id while fencing org and malformed JSON", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(`
			INSERT INTO kernel_runtime_events (id,organization_id,kind,conversation_id,run_id,payload,created_at) VALUES
			('a','org-1','decision.recorded','home','new-a','{"action":"kernel.route_corrected","priorRunId":"old"}','2026-09-24T10:00:00.000Z'),
			('b','org-1','decision.recorded','home','new-b','{"action":"kernel.route_corrected","priorRunId":"old"}','2026-09-24T10:00:00.000Z'),
			('c','org-2','decision.recorded','home','new-c','{"action":"kernel.route_corrected","priorRunId":"old"}','2026-09-24T10:00:01.000Z'),
			('d','org-1','decision.recorded','home','new-d','not-json','2026-09-24T10:00:02.000Z'),
			('e','org-1','decision.recorded','home','new-e','{"action":"other"}','2026-09-24T10:00:03.000Z');
		`);
		const first = await listKernelRouteCorrectionEvents(db, {
			organizationId: "org-1",
			cutoff: "2026-09-24T00:00:00.000Z",
			limit: 1,
		});
		expect(first.map((row) => row.id)).toEqual(["a"]);
		const second = await listKernelRouteCorrectionEvents(db, {
			organizationId: "org-1",
			cutoff: "2026-09-24T00:00:00.000Z",
			limit: 10,
			after: { createdAt: first[0]!.createdAt, id: first[0]!.id },
		});
		expect(second.map((row) => row.id)).toEqual(["b"]);
	});

	it("resolves an old prior run by exact org and leaves the original grade immutable", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(`
			INSERT INTO kernel_runtime_runs (id,organization_id,conversation_id,status,metadata,created_at,updated_at) VALUES
			('old','org-1','home','completed','{"kernelRoute":{"routeKind":"delegate_tedi"}}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
			('other','org-2','home','completed','{}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
			INSERT INTO harness_subject_eval_results (id,subject_kind,subject_id,org_id,harness_version_id,score,gates,passed,lane,task_set_id,metadata,created_at) VALUES
			('kser:v1:old','kernel','kernel:org-1','org-1','v1',1,'{}',1,'production','kernel-route-v1','{"runId":"old"}','2026-01-02T00:00:00.000Z');
		`);
		expect(
			(
				await listKernelRunsForCorrection(db, {
					organizationId: "org-1",
					runIds: ["old", "other"],
				})
			).map((row) => row.id),
		).toEqual(["old"]);
		expect(
			(
				await listKernelEvalResultsForPriorRun(db, {
					organizationId: "org-1",
					runId: "old",
				})
			).map((row) => row.id),
		).toEqual(["kser:v1:old"]);
		expect(
			await getKernelCorrectionEvalRevision(db, {
				organizationId: "org-2",
				id: "kser:v1:old",
			}),
		).toBeUndefined();
	});

	it("counts one effective negative after an append-only route and selection correction", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(`
			INSERT INTO harness_subject_eval_results (id,subject_kind,subject_id,tedi_id,org_id,harness_version_id,score,gates,passed,lane,task_set_id,metadata,created_at) VALUES
			('kser:v1:old','kernel','kernel:org-1',NULL,'org-1','v1',1,'{}',1,'production','kernel-route-v1','{"runId":"old"}','2026-09-23T00:00:00.000Z'),
			('kser-correction:ev','kernel','kernel:org-1',NULL,'org-1','v1',0.66,'{"notCorrected":false}',0,'production','kernel-route-v1','{"runId":"old","correctionEventId":"ev"}','2026-09-24T00:00:00.000Z'),
			('tsel:v1:old','kernel','tedi-selection:org-1','tedi-1','org-1','v1',1,'{}',1,'production','tedi-selection-v1','{"runId":"old","delegatedTediId":"tedi-1"}','2026-09-23T00:00:00.000Z'),
			('tsel-correction:ev','kernel','tedi-selection:org-1','tedi-1','org-1','v1',0.66,'{"notCorrected":false}',0,'production','tedi-selection-v1','{"runId":"old","delegatedTediId":"tedi-1","correctionEventId":"ev"}','2026-09-24T00:00:00.000Z');
		`);
		const route = await listSubjectEvalResults(db, {
			subjectKind: "kernel",
			subjectId: "kernel:org-1",
			harnessVersionId: "v1",
		});
		expect(route.map((row) => [row.id, row.passed])).toEqual([
			["kser-correction:ev", false],
		]);
		expect(await summarizeTediSelectionPriors(db, { orgId: "org-1" })).toEqual(
			new Map([["tedi-1", { passed: 0, total: 1, successRate: 0 }]]),
		);
		const cap = await listTediSelectionCapabilityEvidence(db, {
			organizationId: "org-1",
			createdSince: "2026-09-01T00:00:00.000Z",
			limit: 10,
		});
		expect(cap.map((row) => row.passed)).toEqual([false]);
	});

	it("keeps the original grade and one correction revision across retries", async () => {
		const { db, sqlite } = fixture();
		const common = {
			subjectKind: "kernel" as const,
			subjectId: "kernel:org-1",
			tediId: null,
			orgId: "org-1",
			harnessVersionId: "v1",
			lane: "production",
			taskSetId: "kernel-route-v1",
		};
		await recordSubjectEvalResult(db, {
			...common,
			id: "kser:v1:old",
			score: 1,
			gates: { notCorrected: true },
			passed: true,
			createdAt: "2026-09-23T00:00:00.000Z",
			metadata: { runId: "old" },
		});
		const revision = {
			...common,
			id: "kser-correction:event-1",
			score: 0,
			gates: { notCorrected: false },
			passed: false,
			createdAt: "2026-09-24T00:00:00.000Z",
			metadata: { runId: "old", correctionEventId: "event-1" },
		};
		await recordSubjectEvalResult(db, revision);
		await recordSubjectEvalResult(db, revision);
		expect(
			sqlite
				.prepare("SELECT COUNT(*) AS n FROM harness_subject_eval_results")
				.get(),
		).toMatchObject({ n: 2 });
		expect(
			(
				await listSubjectEvalResults(db, {
					subjectKind: "kernel",
					subjectId: "kernel:org-1",
					harnessVersionId: "v1",
				})
			).map((row) => row.id),
		).toEqual(["kser-correction:event-1"]);
	});
});
