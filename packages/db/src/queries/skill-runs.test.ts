import { DatabaseSync } from "node:sqlite";
import type { SkillRunCostSummary } from "@tedix/api-contract/contracts/cognitive";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	cancelSkillRun,
	createSkillRun,
	getSkillRun,
	listLatestSkillRunsForSkills,
	listSkillRunSnapshotsForSkill,
	listSkillRunsForOrg,
	listSkillRunsForSkill,
	listSkillRunsForTedi,
	listSkillWorkflowRetryCandidateRuns,
	retireSkillRunForRevocation,
	setSkillRunCostSummary,
} from "./skill-runs";

interface RunFixture {
	id: string;
	organizationId?: string;
	skillId?: string;
	tediId?: string;
	workflowInstanceId?: string;
	executionEpoch?: number;
	restartRequestedAt?: string | null;
	workflowRetiredAt?: string | null;
	runtimeEnvironment?: "development" | "staging" | "production";
	status?:
		| "queued"
		| "running"
		| "paused"
		| "completed"
		| "failed"
		| "canceled";
	result?: string | null;
	error?: string | null;
	costSummary?: SkillRunCostSummary | null;
	skillRevision?: number | null;
	skillSlug?: string | null;
	startedAt?: string;
}

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE skill_entries (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			tags TEXT,
			lifecycle_state TEXT NOT NULL DEFAULT 'draft'
		);
		CREATE TABLE skill_runs (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			skill_id TEXT NOT NULL,
			tedi_id TEXT NOT NULL,
			workflow_instance_id TEXT NOT NULL UNIQUE,
			execution_epoch INTEGER NOT NULL DEFAULT 0,
			restart_requested_at TEXT,
			restart_command_id TEXT,
			workflow_retired_at TEXT,
			runtime_environment TEXT NOT NULL,
			last_reconciled_at TEXT,
			status TEXT NOT NULL DEFAULT 'queued',
			params TEXT,
			result TEXT,
			error TEXT,
			capability_manifest TEXT,
			resource_access_envelope TEXT,
			cost_summary TEXT,
			workflow_source TEXT,
			skill_doc TEXT,
			skill_revision INTEGER,
			skill_slug TEXT,
			started_at TEXT DEFAULT CURRENT_TIMESTAMP,
			completed_at TEXT,
			paused_at TEXT,
			created_by TEXT,
			work_item_id TEXT,
			origin_tedi_run_id TEXT
		);
	`);
	const insertSkill = (
		id: string,
		tags: string[],
		organizationId = "org-1",
		lifecycleState = "active",
	) => {
		sqlite
			.prepare(
				"INSERT INTO skill_entries (id, organization_id, tags, lifecycle_state) VALUES (?, ?, ?, ?)",
			)
			.run(id, organizationId, JSON.stringify(tags), lifecycleState);
	};
	const insertStatement = sqlite.prepare(`
		INSERT INTO skill_runs (
			id, organization_id, skill_id, tedi_id, workflow_instance_id,
			execution_epoch, restart_requested_at, workflow_retired_at,
			runtime_environment, status,
			result, error, cost_summary, workflow_source, skill_doc,
			skill_revision, skill_slug, started_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	const insert = (row: RunFixture) => {
		insertStatement.run(
			row.id,
			row.organizationId ?? "org-1",
			row.skillId ?? "skill-1",
			row.tediId ?? "tedi-1",
			row.workflowInstanceId ?? `workflow-${row.id}`,
			row.executionEpoch ?? 0,
			row.restartRequestedAt ?? null,
			row.workflowRetiredAt ?? null,
			row.runtimeEnvironment ?? "development",
			row.status ?? "running",
			row.result ?? null,
			row.error ?? null,
			row.costSummary ? JSON.stringify(row.costSummary) : null,
			"export default {}",
			"# Fixture skill",
			row.skillRevision ?? 1,
			row.skillSlug ?? "skill-one",
			row.startedAt ?? "2026-07-12T00:00:00.000Z",
		);
	};
	return {
		db: createDbClient(createD1Facade(sqlite)),
		insert,
		insertSkill,
		sqlite,
	};
}

const summary: SkillRunCostSummary = {
	schemaVersion: 1,
	steps: 2,
	attempts: 3,
	retries: 1,
	toolCalls: 4,
	toolCallsByNamespace: { firecrawl: 4 },
	stepDurationMs: 123,
	wallMs: 456,
};

describe("skill run environment fencing", () => {
	it("pages read-only capture inventory without selecting private run inputs", async () => {
		const { db, insert, sqlite } = fixture();
		insert({ id: "candidate-a", skillId: "skill-1", status: "completed" });
		insert({ id: "candidate-b", skillId: "skill-1", status: "completed" });
		sqlite
			.prepare(
				"UPDATE skill_runs SET params = ?, capability_manifest = ? WHERE id = ?",
			)
			.run('{"secret":"private"}', '{"secret":"private"}', "candidate-a");
		const first = await listSkillRunsForSkill(
			db,
			"org-1",
			"skill-1",
			"development",
			{
				limit: 1,
				offset: 0,
				metadataOnly: true,
			},
		);
		const second = await listSkillRunsForSkill(
			db,
			"org-1",
			"skill-1",
			"development",
			{
				limit: 1,
				offset: 1,
				metadataOnly: true,
			},
		);
		expect(first).toHaveLength(1);
		expect(second).toHaveLength(1);
		expect(first[0]?.id).not.toBe(second[0]?.id);
		expect(first[0]?.params).toBeNull();
		expect(second[0]?.params).toBeNull();
		expect(first[0]?.capabilityManifest).toBeNull();
		expect(second[0]?.capabilityManifest).toBeNull();
	});
	it("projects durable business outcomes into compact run summaries", async () => {
		const { db, insert } = fixture();
		insert({
			id: "delivered",
			runtimeEnvironment: "production",
			status: "completed",
			result: JSON.stringify({
				status: "delivered",
				workItemId: "work-item-1",
			}),
		});
		insert({
			id: "legacy-ok",
			runtimeEnvironment: "production",
			status: "completed",
			result: JSON.stringify({ status: "ok", workItemId: 42 }),
		});
		insert({
			id: "legacy-numeric-status",
			runtimeEnvironment: "production",
			status: "completed",
			result: JSON.stringify({ status: 200, workItemId: "work-item-2" }),
		});

		const runs = await listSkillRunsForTedi(
			db,
			"org-1",
			"tedi-1",
			"production",
		);
		expect(runs.find((run) => run.id === "delivered")).toMatchObject({
			id: "delivered",
			outcome: "delivered",
			workItemId: "work-item-1",
		});
		expect(runs.find((run) => run.id === "legacy-ok")).toMatchObject({
			outcome: null,
			workItemId: null,
		});
		expect(
			runs.find((run) => run.id === "legacy-numeric-status"),
		).toMatchObject({
			outcome: null,
			workItemId: "work-item-2",
		});
	});

	it("keeps every read surface inside its workflow runtime environment", async () => {
		const { db, insert } = fixture();
		insert({ id: "dev-a", runtimeEnvironment: "development" });
		insert({
			id: "dev-b",
			runtimeEnvironment: "development",
			skillId: "skill-2",
			tediId: "tedi-2",
			startedAt: "2026-07-12T00:00:01.000Z",
		});
		insert({ id: "staging", runtimeEnvironment: "staging" });
		insert({ id: "production", runtimeEnvironment: "production" });
		insert({
			id: "other-org",
			organizationId: "org-2",
			runtimeEnvironment: "development",
		});

		expect(
			await getSkillRun(db, "dev-a", "org-1", "development"),
		).toMatchObject({
			id: "dev-a",
			runtimeEnvironment: "development",
		});
		expect(await getSkillRun(db, "dev-a", "org-1", "staging")).toBeUndefined();
		expect(
			(await listSkillRunsForOrg(db, "org-1", "development")).map(
				(row) => row.id,
			),
		).toEqual(["dev-b", "dev-a"]);
		expect(
			(await listSkillRunsForTedi(db, "org-1", "tedi-1", "development")).map(
				(row) => row.id,
			),
		).toEqual(["dev-a"]);
		expect(
			(await listSkillRunsForSkill(db, "org-1", "skill-1", "staging")).map(
				(row) => row.id,
			),
		).toEqual(["staging"]);
		expect(
			(
				await listSkillRunSnapshotsForSkill(
					db,
					"org-1",
					"skill-1",
					"production",
				)
			).map((row) => row.id),
		).toEqual(["production"]);
	});

	it("filters run history by an exact skill tag", async () => {
		const { db, insert, insertSkill } = fixture();
		insertSkill("flow-skill", ["flow-ephemeral", "audit"]);
		insertSkill("scheduled-skill", ["scheduled"]);
		insert({
			id: "flow-run",
			skillId: "flow-skill",
			runtimeEnvironment: "development",
		});
		insert({
			id: "scheduled-run",
			skillId: "scheduled-skill",
			runtimeEnvironment: "development",
			startedAt: "2026-07-12T00:00:01.000Z",
		});

		await expect(
			listSkillRunsForTedi(db, "org-1", "tedi-1", "development", {
				skillTag: "flow-ephemeral",
			}),
		).resolves.toMatchObject([{ id: "flow-run" }]);
		await expect(
			listSkillRunsForOrg(db, "org-1", "development", {
				skillTag: "flow-ephemeral",
			}),
		).resolves.toMatchObject([{ id: "flow-run" }]);
	});

	it("returns one exact latest run per requested tenant skill", async () => {
		const { db, insert } = fixture();
		insert({
			id: "skill-1-old",
			skillId: "skill-1",
			runtimeEnvironment: "production",
			startedAt: "2026-07-12T00:00:00.000Z",
		});
		insert({
			id: "skill-1-new",
			skillId: "skill-1",
			runtimeEnvironment: "production",
			startedAt: "2026-07-12T00:00:02.000Z",
			skillRevision: 2,
		});
		insert({
			id: "skill-2-only",
			skillId: "skill-2",
			runtimeEnvironment: "production",
			startedAt: "2026-07-12T00:00:01.000Z",
		});
		insert({
			id: "skill-2-staging",
			skillId: "skill-2",
			runtimeEnvironment: "staging",
			startedAt: "2026-07-12T00:00:03.000Z",
		});
		insert({
			id: "other-org-latest",
			organizationId: "org-2",
			skillId: "skill-1",
			runtimeEnvironment: "production",
			startedAt: "2026-07-12T00:00:04.000Z",
		});

		const rows = await listLatestSkillRunsForSkills(
			db,
			"org-1",
			["skill-1", "skill-2"],
			"production",
		);

		expect(rows.map((row) => row.id).sort()).toEqual([
			"skill-1-new",
			"skill-2-only",
		]);
		expect(rows.find((row) => row.id === "skill-1-new")).toMatchObject({
			skillRevision: 2,
			runtimeEnvironment: "production",
		});
	});

	it("fences cancellation mutations by environment", async () => {
		const { db, insert, sqlite } = fixture();
		insert({ id: "staging", runtimeEnvironment: "staging" });

		expect(await cancelSkillRun(db, "staging", "org-1", "production")).toBe(
			false,
		);
		expect(
			sqlite
				.prepare("SELECT status FROM skill_runs WHERE id = ?")
				.get("staging"),
		).toEqual({
			status: "running",
		});
		expect(await cancelSkillRun(db, "staging", "org-1", "staging")).toBe(true);
		expect(
			sqlite
				.prepare("SELECT status FROM skill_runs WHERE id = ?")
				.get("staging"),
		).toEqual({
			status: "canceled",
		});
	});
});

describe("org-wide skill run history", () => {
	it("returns a bounded fleet view across skills and tedis with status filtering", async () => {
		const { db, insert } = fixture();
		insert({
			id: "skill-a-success",
			runtimeEnvironment: "development",
			status: "completed",
			result: "{}",
		});
		insert({
			id: "skill-b-failure",
			runtimeEnvironment: "development",
			status: "failed",
			error: "boom",
			skillId: "skill-2",
			skillRevision: 7,
			skillSlug: "skill-two",
			tediId: "tedi-2",
			startedAt: "2026-07-12T00:00:01.000Z",
		});
		insert({
			id: "wrong-environment",
			runtimeEnvironment: "staging",
			status: "failed",
		});

		const all = await listSkillRunsForOrg(db, "org-1", "development", {
			limit: -10,
		});
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({
			id: "skill-b-failure",
			skillId: "skill-2",
			tediId: "tedi-2",
			skillRevision: 7,
			skillSlug: "skill-two",
			hasError: 1,
			hasResult: 0,
		});

		const failed = await listSkillRunsForOrg(db, "org-1", "development", {
			status: "failed",
			limit: 200,
		});
		expect(failed.map((row) => row.id)).toEqual(["skill-b-failure"]);

		for (let index = 0; index < 205; index++) {
			insert({
				id: `bulk-${index}`,
				runtimeEnvironment: "development",
				status: "completed",
				startedAt: `2026-07-11T00:${String(index).padStart(4, "0")}`,
			});
		}
		expect(
			await listSkillRunsForOrg(db, "org-1", "development", { limit: 1_000 }),
		).toHaveLength(200);
	});
});

describe("skill workflow retry candidates", () => {
	it("excludes archived skills and failures superseded by a newer successful revision", async () => {
		const { db, insert, insertSkill } = fixture();
		insertSkill("current-skill", []);
		insertSkill("archived-skill", [], "org-1", "archived");
		insert({
			id: "current-failure",
			skillId: "current-skill",
			status: "failed",
		});
		insert({
			id: "superseded-failure",
			skillId: "current-skill",
			status: "failed",
			skillSlug: "daily-loop",
			skillRevision: 2,
			startedAt: "2026-07-12T00:01:00.000Z",
		});
		insert({
			id: "newer-success",
			skillId: "current-skill",
			status: "completed",
			skillSlug: "daily-loop",
			skillRevision: 2,
			startedAt: "2026-07-12T00:02:00.000Z",
		});
		insert({
			id: "archived-failure",
			skillId: "archived-skill",
			status: "failed",
			startedAt: "2026-07-12T00:03:00.000Z",
		});

		const rows = await listSkillWorkflowRetryCandidateRuns(
			db,
			"org-1",
			"development",
			50,
		);

		expect(rows.map((row) => row.id)).toEqual(["current-failure"]);
	});

	it("keeps the current unsuperseded failed revision eligible", async () => {
		const { db, insert, insertSkill } = fixture();
		insertSkill("current-skill", []);
		insert({
			id: "current-failure",
			skillId: "current-skill",
			status: "failed",
			skillSlug: "daily-loop",
			skillRevision: 4,
		});

		await expect(
			listSkillWorkflowRetryCandidateRuns(db, "org-1", "development", 50),
		).resolves.toMatchObject([{ id: "current-failure", executionEpoch: 0 }]);
	});
});

describe("skill run cost summary compare-and-set", () => {
	it("accepts only the matching environment and terminal execution epoch", async () => {
		const { db, insert } = fixture();
		insert({
			id: "terminal",
			executionEpoch: 2,
			runtimeEnvironment: "development",
			status: "completed",
		});

		expect(
			await setSkillRunCostSummary(
				db,
				"terminal",
				"org-1",
				"staging",
				2,
				summary,
			),
		).toBe(false);
		expect(
			await setSkillRunCostSummary(
				db,
				"terminal",
				"org-1",
				"development",
				1,
				summary,
			),
		).toBe(false);
		expect(
			await setSkillRunCostSummary(
				db,
				"terminal",
				"org-1",
				"development",
				2,
				summary,
			),
		).toBe(true);
		expect(
			await setSkillRunCostSummary(db, "terminal", "org-1", "development", 2, {
				...summary,
				retries: 99,
			}),
		).toBe(false);

		const run = await getSkillRun(db, "terminal", "org-1", "development");
		expect(run?.costSummary).toEqual(summary);
	});

	it("rejects active, restarting, retired, and revoked runs", async () => {
		const { db, insert } = fixture();
		insert({
			id: "active",
			executionEpoch: 2,
			runtimeEnvironment: "development",
			status: "running",
		});
		insert({
			id: "restarting",
			executionEpoch: 2,
			restartRequestedAt: "2026-07-12T00:00:02.000Z",
			runtimeEnvironment: "development",
			status: "completed",
		});
		insert({
			id: "retired",
			executionEpoch: 2,
			workflowRetiredAt: "2026-07-12T00:00:03.000Z",
			runtimeEnvironment: "development",
			status: "completed",
		});
		insert({
			id: "revoked",
			executionEpoch: 2,
			runtimeEnvironment: "development",
			status: "completed",
			error: "REVOKED: invalid evidence",
		});

		for (const runId of ["active", "restarting", "retired", "revoked"]) {
			expect(
				await setSkillRunCostSummary(
					db,
					runId,
					"org-1",
					"development",
					2,
					summary,
				),
			).toBe(false);
		}
	});
});

describe("skill run revocation retirement compare-and-set", () => {
	it("treats a REVOKED_TOKEN failure as ordinary terminal failure", async () => {
		const { db, insert } = fixture();
		insert({
			id: "marker-collision",
			executionEpoch: 2,
			runtimeEnvironment: "development",
			status: "failed",
			error: "REVOKED_TOKEN_REFRESH_FAILED",
		});

		expect(
			await setSkillRunCostSummary(
				db,
				"marker-collision",
				"org-1",
				"development",
				2,
				summary,
			),
		).toBe(true);
		expect(
			await retireSkillRunForRevocation(db, {
				runId: "marker-collision",
				organizationId: "org-1",
				runtimeEnvironment: "development",
				expectedExecutionEpoch: 2,
				reason: "operator cleanup",
			}),
		).toBe(true);
	});

	it("retires a terminal run and clears output before cleanup starts", async () => {
		const { db, insert, sqlite } = fixture();
		insert({
			id: "terminal",
			executionEpoch: 3,
			runtimeEnvironment: "development",
			status: "completed",
			result: JSON.stringify({ secret: "must disappear" }),
			costSummary: summary,
		});

		expect(
			await retireSkillRunForRevocation(db, {
				runId: "terminal",
				organizationId: "org-1",
				runtimeEnvironment: "development",
				expectedExecutionEpoch: 3,
				reason: "invalid evidence",
			}),
		).toBe(true);

		expect(
			sqlite
				.prepare(
					`SELECT status, result, error, cost_summary,
					        workflow_retired_at IS NOT NULL AS retired
					   FROM skill_runs WHERE id = ?`,
				)
				.get("terminal"),
		).toEqual({
			status: "completed",
			result: null,
			error: "REVOKED: invalid evidence",
			cost_summary: null,
			retired: 1,
		});
	});

	it("preserves an operator-abort retirement timestamp while claiming revoke", async () => {
		const { db, insert, sqlite } = fixture();
		const retiredAt = "2026-07-12T00:00:03.000Z";
		insert({
			id: "operator-aborted",
			executionEpoch: 4,
			workflowRetiredAt: retiredAt,
			runtimeEnvironment: "development",
			status: "canceled",
			result: JSON.stringify({ stale: true }),
			costSummary: summary,
		});

		expect(
			await retireSkillRunForRevocation(db, {
				runId: "operator-aborted",
				organizationId: "org-1",
				runtimeEnvironment: "development",
				expectedExecutionEpoch: 4,
			}),
		).toBe(true);
		expect(
			sqlite
				.prepare(
					`SELECT workflow_retired_at, result, cost_summary, error
					   FROM skill_runs WHERE id = ?`,
				)
				.get("operator-aborted"),
		).toEqual({
			workflow_retired_at: retiredAt,
			result: null,
			cost_summary: null,
			error: "REVOKED",
		});
	});

	it("rejects active, ambiguous, stale-epoch, wrong-environment, and already revoked rows", async () => {
		const { db, insert } = fixture();
		insert({
			id: "active",
			executionEpoch: 2,
			runtimeEnvironment: "development",
			status: "running",
		});
		insert({
			id: "restarting",
			executionEpoch: 2,
			restartRequestedAt: "2026-07-12T00:00:02.000Z",
			runtimeEnvironment: "development",
			status: "completed",
		});
		insert({
			id: "admission",
			executionEpoch: 2,
			runtimeEnvironment: "development",
			status: "failed",
			error: "WORKFLOW_ADMISSION_PENDING: create result unknown",
		});
		insert({
			id: "revoked",
			executionEpoch: 2,
			runtimeEnvironment: "development",
			status: "completed",
			error: "REVOKED: already done",
		});
		insert({
			id: "staging",
			executionEpoch: 2,
			runtimeEnvironment: "staging",
			status: "completed",
		});

		for (const [runId, environment, epoch] of [
			["active", "development", 2],
			["restarting", "development", 2],
			["admission", "development", 2],
			["revoked", "development", 2],
			["staging", "development", 2],
			["staging", "staging", 1],
		] as const) {
			expect(
				await retireSkillRunForRevocation(db, {
					runId,
					organizationId: "org-1",
					runtimeEnvironment: environment,
					expectedExecutionEpoch: epoch,
					reason: "cleanup",
				}),
			).toBe(false);
		}
	});
});

it("preserves an admitted personal source envelope through canonical D1 query reads", async () => {
	const { db } = fixture();
	const id = "10000000-0000-4000-8000-000000000001";
	const envelope = {
		version: 1 as const,
		sources: [
			{
				workspaceResourceId: id,
				workspaceId: id,
				providerId: "google",
				resourceType: "calendar",
				providerResourceId: "calendar-a",
				connectionScope: "user" as const,
				personalOwnerUserId: "owner",
				connectionInstanceId: id,
				delegationId: id,
				requiredScopes: ["read"],
				operations: ["read"],
				toolIds: ["list_events"],
			},
		],
	};
	const created = await createSkillRun(db, {
		id,
		organizationId: "org-1",
		skillId: id,
		tediId: id,
		workflowInstanceId: id,
		runtimeEnvironment: "production",
		params: { _tedixContext: { fake: true } },
		resourceAccessEnvelope: envelope,
	});
	expect(created.resourceAccessEnvelope).toEqual(envelope);
	expect(
		(await getSkillRun(db, id, "org-1", "production"))?.resourceAccessEnvelope,
	).toEqual(envelope);
	expect(await getSkillRun(db, id, "other-org", "production")).toBeUndefined();
});
