import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { skillRunArtifacts, skillRuns } from "@tedix/db/schema/cognitive";
import {
	runtimeSubmissions,
	runtimeSubmissionAttempts,
} from "@tedix/db/schema/runtime-submissions";
import { Hono } from "hono";
import { registerLifecycleRoutes } from "../src/routes/lifecycle";
import type { AppEnv } from "../src/control-requests";
import { encodeWorkflowArtifactPathSegment } from "../src/workflow-path";
import {
	claimWorkflowRestart,
	recordWorkflowExecutionEpochStarted,
	retireUnstartedWorkflowRestart,
} from "../src/workflow-restart";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			skillRuns,
			skillRunArtifacts,
			runtimeSubmissions,
			runtimeSubmissionAttempts,
		),
	);
	const accepted = JSON.stringify({
		restartId: "restart-1",
		request: { from: { name: "finish", count: 1, type: "do" } },
		status: "accepted",
		executionEpoch: 1,
		updatedAt: "2026-07-12T00:00:00.000Z",
	});
	sqlite
		.prepare(`INSERT INTO skill_runs (id,organization_id,skill_id,tedi_id,workflow_instance_id,status,execution_epoch,restart_requested_at,restart_command_id,runtime_environment,started_at,workflow_source,skill_doc,capability_manifest)
	 VALUES ('run-1','org-1','skill-1','tedi-1','run-1','queued',1,'2026-07-12T00:00:00.000Z','restart-1','production','2026-07-12T00:00:00.000Z','export default {}','','{}')`)
		.run();
	sqlite
		.prepare(`INSERT INTO skill_run_artifacts (id,run_id,path,mime_type,size_bytes,content_inline,outcome)
	 VALUES ('accepted','run-1',?1,'application/json',?2,?3,'success')`)
		.run(
			`controls/restarts/${encodeWorkflowArtifactPathSegment("restart-1")}.json`,
			accepted.length,
			accepted,
		);
	const db = createD1Facade(sqlite);
	const input = {
		db,
		runId: "run-1",
		organizationId: "org-1",
		runtimeEnvironment: "production",
		restartId: "restart-1",
		executionEpoch: 1,
		from: { name: "finish", count: 1, type: "do" as const },
		reason: "Retire only; no engine or model execution.",
		engine: { status: "errored", observedAt: new Date().toISOString() },
	};
	const row = () =>
		sqlite.prepare("SELECT * FROM skill_runs WHERE id='run-1'").get()!;
	const seedSubmission = () =>
		sqlite
			.prepare(`INSERT INTO runtime_submissions
	 (id,organization_id,subject_kind,subject_id,source_kind,tedi_id,run_id,status,metadata,created_at,updated_at)
	 VALUES ('sub:run-1','org-1','tedi','tedi-1','skill_workflow','tedi-1','run-1','settled','{"workflowExecutionEpoch":0}','2026-07-12T00:00:00.000Z','2026-07-12T00:00:00.000Z')`)
			.run();
	return { sqlite, db, input, row, accepted, seedSubmission };
}

export async function checkUnstartedRestartRetirement(
	factory: (input: {
		env: unknown;
		metadata: unknown;
		ctx: { exports: unknown };
	}) => Promise<unknown>,
) {
	// Retirement wins the SAME D1 race; the actual factory cannot load tenant code.
	{
		const f = fixture();
		const result = await retireUnstartedWorkflowRestart(f.input);
		assert.equal(result.deduplicated, false);
		assert.ok(f.row().workflow_retired_at);
		assert.equal(
			f.row().status,
			"queued",
			"retirement alone is not cancellation settlement",
		);
		assert.equal(
			f.sqlite
				.prepare(
					"SELECT content_inline FROM skill_run_artifacts WHERE id='accepted'",
				)
				.get()!.content_inline,
			f.accepted,
		);
		let loads = 0;
		await assert.rejects(
			factory({
				env: {
					DB: f.db,
					ENVIRONMENT: "production",
					LOADER: {
						get() {
							loads++;
							throw new Error("tenant loader reached");
						},
					},
				},
				metadata: {
					runId: "run-1",
					skillId: "skill-1",
					tediId: "tedi-1",
					orgId: "org-1",
				},
				ctx: { exports: {} },
			}),
			/missing a pinned workflow snapshot/,
		);
		assert.equal(loads, 0);
		assert.equal(
			(await retireUnstartedWorkflowRestart({ ...f.input, engine: null }))
				.deduplicated,
			true,
		);
		for (const change of [
			{ reason: "different reason" },
			{ from: { name: "other" } },
			{ executionEpoch: 2 },
			{ organizationId: "other-org" },
			{ runtimeEnvironment: "staging" },
		])
			await assert.rejects(
				retireUnstartedWorkflowRestart({ ...f.input, ...change, engine: null }),
			);
		f.sqlite
			.prepare("DELETE FROM skill_run_artifacts WHERE run_id='run-1'")
			.run();
		await assert.rejects(
			recordWorkflowExecutionEpochStarted({
				db: f.db,
				runId: "run-1",
				executionEpoch: 1,
			}),
			/WORKFLOW_INSTANCE_RETIRED/,
		);
		await assert.rejects(
			claimWorkflowRestart({
				db: f.db,
				runId: "run-1",
				restartId: "new-command",
			}),
			/permanently retired/,
		);
		f.sqlite.close();
	}
	// Entry first, or any incomplete/malformed epoch evidence, defeats retirement.
	{
		const f = fixture();
		const batch = f.db.batch.bind(f.db);
		f.db.batch = async (statements) => {
			await recordWorkflowExecutionEpochStarted({
				db: f.db,
				runId: "run-1",
				executionEpoch: 1,
			});
			return batch(statements);
		};
		await assert.rejects(retireUnstartedWorkflowRestart(f.input));
		assert.equal(
			f.row().workflow_retired_at,
			null,
			"entry between receipt read and CAS must win",
		);
		assert.equal(
			f.sqlite
				.prepare(
					"SELECT COUNT(*) AS n FROM skill_run_artifacts WHERE path LIKE 'controls/restart-retirements/%'",
				)
				.get()!.n,
			0,
		);
		f.sqlite.close();
	}
	{
		const f = fixture();
		await recordWorkflowExecutionEpochStarted({
			db: f.db,
			runId: "run-1",
			executionEpoch: 1,
		});
		await assert.rejects(retireUnstartedWorkflowRestart(f.input));
		assert.equal(f.row().workflow_retired_at, null);
		f.sqlite.close();
	}
	for (const marker of ["started", "completed", "failed"])
		for (const outcome of ["success", "pending"]) {
			const f = fixture();
			f.sqlite
				.prepare(
					"INSERT INTO skill_run_artifacts(id,run_id,path,mime_type,size_bytes,content_inline,outcome) VALUES ('entry','run-1',?1,'application/json',1,'?',?2)",
				)
				.run(`epochs/1/${marker}.json`, outcome);
			await assert.rejects(retireUnstartedWorkflowRestart(f.input));
			assert.equal(f.row().workflow_retired_at, null);
			assert.equal(
				f.sqlite
					.prepare(
						"SELECT COUNT(*) AS n FROM skill_run_artifacts WHERE path LIKE 'controls/restart-retirements/%'",
					)
					.get()!.n,
				0,
			);
			f.sqlite.close();
		}
	for (const status of [
		"running",
		"queued",
		"paused",
		"terminated",
		"unknown",
	]) {
		const f = fixture();
		await assert.rejects(
			retireUnstartedWorkflowRestart({
				...f.input,
				engine: { ...f.input.engine, status },
			}),
		);
		assert.equal(f.row().workflow_retired_at, null);
		f.sqlite.close();
	}
	for (const change of [
		{ restartId: "wrong" },
		{ executionEpoch: 2 },
		{ from: { name: "wrong" } },
		{ organizationId: "wrong" },
		{ runtimeEnvironment: "staging" },
	]) {
		const f = fixture();
		await assert.rejects(
			retireUnstartedWorkflowRestart({ ...f.input, ...change }),
		);
		assert.equal(f.row().workflow_retired_at, null);
		f.sqlite.close();
	}
	// An INSERT failure rolls back the preceding tombstone, not just its evidence.
	{
		const f = fixture();
		f.sqlite.exec(
			"CREATE TRIGGER fail_retirement BEFORE INSERT ON skill_run_artifacts WHEN NEW.path LIKE 'controls/restart-retirements/%' BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END",
		);
		await assert.rejects(
			retireUnstartedWorkflowRestart(f.input),
			/injected receipt failure/,
		);
		assert.equal(f.row().workflow_retired_at, null);
		f.sqlite.close();
	}
	// Actual route + submission queries: missing ledger leaves retired/pending,
	// exact retry repairs it without any further engine access or execution.
	{
		const f = fixture();
		const app = new Hono<AppEnv>();
		registerLifecycleRoutes(app);
		let reads = 0;
		const env = {
			DB: f.db,
			ENVIRONMENT: "production",
			WORKFLOWS: {
				async get() {
					reads++;
					return {
						async status() {
							return {
								status: "errored",
								error: { message: "internal workflows error" },
							};
						},
						restart() {
							assert.fail("no restart");
						},
						terminate() {
							assert.fail("no terminate");
						},
					};
				},
			},
		};
		const body = {
			runId: "run-1",
			expectedExecutionEpoch: 1,
			restartId: "restart-1",
			from: f.input.from,
			reason: f.input.reason,
			retireUnstarted: true,
		};
		const call = () =>
			app.request(
				"/retire-unstarted-restart",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				},
				env as never,
			);
		for (const [path, invalid] of [
			["/restart", body],
			["/retire-unstarted-restart", { ...body, retireUnstarted: false }],
			[
				"/retire-unstarted-restart",
				{ ...body, expectedExecutionEpoch: undefined },
			],
			["/retire-unstarted-restart", { ...body, abortUnknown: true }],
		] as const) {
			const rejected = await app.request(
				path,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(invalid),
				},
				env as never,
			);
			assert.equal(rejected.status, 400);
			assert.equal(reads, 0);
			assert.equal(f.row().workflow_retired_at, null);
		}
		const pending = await call();
		assert.equal(pending.status, 503);
		assert.equal(
			((await pending.json()) as { retired: boolean }).retired,
			true,
		);
		assert.equal(f.row().status, "queued");
		assert.ok(f.row().workflow_retired_at);
		f.seedSubmission();
		const prepare = f.db.prepare.bind(f.db);
		f.db.prepare = (sql) => {
			if (sql.includes("runtime_submissions"))
				throw new Error("injected submission storage outage");
			return prepare(sql);
		};
		const outage = await call();
		assert.equal(outage.status, 503);
		assert.equal(((await outage.json()) as { retired: boolean }).retired, true);
		assert.equal(f.row().status, "queued");
		f.db.prepare = prepare;
		const repaired = await call();
		assert.equal(repaired.status, 200);
		assert.equal(
			((await repaired.json()) as { restartRetired: boolean }).restartRetired,
			true,
		);
		assert.equal(f.row().status, "canceled");
		assert.equal(f.row().restart_requested_at, null);
		const again = await call();
		assert.equal(again.status, 200);
		assert.equal(reads, 1);
		assert.equal(
			f.sqlite
				.prepare("SELECT status FROM runtime_submissions WHERE id='sub:run-1'")
				.get()!.status,
			"canceled",
		);
		assert.equal(
			f.sqlite
				.prepare("SELECT COUNT(*) AS n FROM runtime_submission_attempts")
				.get()!.n,
			1,
		);
		f.sqlite.close();
	}
}
