import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { countSkillUsagesLast24h } from "./flywheel/pulse";
import { recordSkillRunOutcome, recordSkillUsageEvent } from "./skill-usage";

function fixture(options?: { onPrepare?: (query: string) => void }) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE skill_entries (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			tedi_id TEXT,
			domain_id TEXT,
			title TEXT NOT NULL,
			slug TEXT,
			folder_path TEXT,
			description TEXT,
			content TEXT NOT NULL,
			files TEXT,
			input_schema TEXT,
			success_count INTEGER NOT NULL DEFAULT 0,
			failure_count INTEGER NOT NULL DEFAULT 0,
			last_used_at TEXT,
			avg_duration_ms INTEGER,
			revision INTEGER NOT NULL DEFAULT 1,
			revision_reasoning TEXT,
			supersedes_id TEXT,
			source_skill_id TEXT,
			source_revision INTEGER,
			visibility TEXT NOT NULL DEFAULT 'private',
			agent_skills_format TEXT,
			r2_path TEXT,
			app_id TEXT,
			tool_ids TEXT,
			summary TEXT,
			tags TEXT,
			audience TEXT,
			preconditions TEXT,
			lifecycle_state TEXT DEFAULT 'draft',
			review_flagged_at TEXT,
			review_flag_reason TEXT,
			pace_layer TEXT NOT NULL DEFAULT 'innovation',
			proposed_by_tedi_id TEXT,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT DEFAULT CURRENT_TIMESTAMP
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
			runtime_environment TEXT,
			last_reconciled_at TEXT,
			status TEXT NOT NULL DEFAULT 'queued',
			params TEXT,
			result TEXT,
			error TEXT,
			resource_access_envelope TEXT,
			capability_manifest TEXT,
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
		CREATE TABLE skill_usage_events (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			tedi_id TEXT,
			skill_id TEXT NOT NULL,
			run_id TEXT NOT NULL,
			execution_epoch INTEGER NOT NULL DEFAULT 0,
			source TEXT NOT NULL,
			outcome TEXT NOT NULL,
			error TEXT,
			started_at TEXT,
			finished_at TEXT,
			duration_ms INTEGER,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP
		);
		CREATE UNIQUE INDEX uniq_skill_usage_events_run
			ON skill_usage_events (run_id, execution_epoch);
	`);

	const insertSkill = (row: {
		id: string;
		lifecycleState?: string;
		successCount?: number;
		failureCount?: number;
	}) => {
		sqlite
			.prepare(
				`INSERT INTO skill_entries (
					id, organization_id, tedi_id, title, slug, content,
					success_count, failure_count, lifecycle_state
				) VALUES (?, 'org-1', 'tedi-1', 'Deploy reconciler', ?, '# Skill', ?, ?, ?)`,
			)
			.run(
				row.id,
				`slug-${row.id}`,
				row.successCount ?? 0,
				row.failureCount ?? 0,
				row.lifecycleState ?? "active",
			);
	};

	const insertRun = (row: {
		id: string;
		skillId: string;
		status: string;
		error?: string | null;
		executionEpoch?: number;
		startedAt?: string;
		completedAt?: string | null;
	}) => {
		sqlite
			.prepare(
				`INSERT INTO skill_runs (
					id, organization_id, skill_id, tedi_id, workflow_instance_id,
					execution_epoch, status, error, workflow_source, skill_doc,
					skill_revision, skill_slug, started_at, completed_at
				) VALUES (?, 'org-1', ?, 'tedi-1', ?, ?, ?, ?, 'export default {}', '# Skill', 1, 'slug', ?, ?)`,
			)
			.run(
				row.id,
				row.skillId,
				`workflow-${row.id}`,
				row.executionEpoch ?? 0,
				row.status,
				row.error ?? null,
				row.startedAt ?? "2026-07-16T00:00:00.000Z",
				row.completedAt ?? "2026-07-16T00:05:00.000Z",
			);
	};

	const skillRow = (id: string) =>
		sqlite
			.prepare(
				`SELECT success_count as successCount, failure_count as failureCount,
					last_used_at as lastUsedAt, avg_duration_ms as avgDurationMs,
					lifecycle_state as lifecycleState,
					review_flagged_at as reviewFlaggedAt,
					review_flag_reason as reviewFlagReason,
					pace_layer as paceLayer
				 FROM skill_entries WHERE id = ?`,
			)
			.get(id) as {
			successCount: number;
			failureCount: number;
			lastUsedAt: string | null;
			avgDurationMs: number | null;
			lifecycleState: string;
			reviewFlaggedAt: string | null;
			reviewFlagReason: string | null;
			paceLayer: string | null;
		};

	// Direct ledger readback (the production read path for this ledger is the
	// flywheel/strategy-map aggregates, not a per-skill list query).
	const usageEvents = (skillId: string, outcome?: string) =>
		sqlite
			.prepare(
				`SELECT run_id as runId, execution_epoch as executionEpoch, source,
					outcome, error, tedi_id as tediId
				 FROM skill_usage_events
				 WHERE organization_id = 'org-1' AND skill_id = ?
					${outcome ? "AND outcome = ?" : ""}
				 ORDER BY created_at DESC`,
			)
			.all(...(outcome ? [skillId, outcome] : [skillId])) as Array<{
			runId: string;
			executionEpoch: number;
			source: string;
			outcome: string;
			error: string | null;
			tediId: string | null;
		}>;

	return {
		db: createDbClient(
			createD1Facade(sqlite, { onPrepare: options?.onPrepare }),
		),
		insertSkill,
		insertRun,
		skillRow,
		usageEvents,
		sqlite,
	};
}

describe("recordSkillRunOutcome", () => {
	it("stamps a successful workflow run and increments successCount once", async () => {
		const { db, insertSkill, insertRun, skillRow, usageEvents } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "draft" });
		insertRun({ id: "run-1", skillId: "skill-1", status: "completed" });

		const first = await recordSkillRunOutcome(db, "run-1");
		expect(first).toMatchObject({
			recorded: true,
			runId: "run-1",
			outcome: "success",
			status: "completed",
		});
		expect(skillRow("skill-1")).toMatchObject({
			successCount: 1,
			failureCount: 0,
			lifecycleState: "active",
			// WS6: the draft → active promotion re-derives the pace layer.
			paceLayer: "differentiation",
		});
		expect(skillRow("skill-1").lastUsedAt).toBeTruthy();
		// startedAt→completedAt = 5 minutes
		expect(skillRow("skill-1").avgDurationMs).toBe(5 * 60 * 1000);

		// Idempotent: a concurrent reconciler observing the same terminal run
		// must not double-count.
		const replay = await recordSkillRunOutcome(db, "run-1");
		expect(replay).toMatchObject({ recorded: false, reason: "duplicate" });
		expect(skillRow("skill-1").successCount).toBe(1);

		const events = usageEvents("skill-1");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			runId: "run-1",
			source: "workflow_run",
			outcome: "success",
			tediId: "tedi-1",
		});
	});

	it("stamps a failed workflow run, increments failureCount, and keeps the failing runId retrievable", async () => {
		const { db, insertSkill, insertRun, skillRow, usageEvents } = fixture();
		insertSkill({ id: "skill-1" });
		insertRun({
			id: "run-fail",
			skillId: "skill-1",
			status: "failed",
			error: "step deploy_verify exhausted retries",
		});

		const result = await recordSkillRunOutcome(db, "run-fail");
		expect(result).toMatchObject({
			recorded: true,
			outcome: "failure",
			status: "failed",
		});
		expect(skillRow("skill-1")).toMatchObject({
			successCount: 0,
			failureCount: 1,
		});

		const failures = usageEvents("skill-1", "failure");
		expect(failures).toHaveLength(1);
		expect(failures[0]?.runId).toBe("run-fail");
		expect(failures[0]?.error).toBe("step deploy_verify exhausted retries");
	});

	it("skips admission-marker failures (workflow never executed) and non-terminal runs", async () => {
		const { db, insertSkill, insertRun, skillRow, usageEvents } = fixture();
		insertSkill({ id: "skill-1" });
		insertRun({
			id: "run-admission",
			skillId: "skill-1",
			status: "failed",
			error: "WORKFLOW_ADMISSION_CREATE_FAILED: engine rejected create",
		});
		insertRun({ id: "run-live", skillId: "skill-1", status: "running" });
		insertRun({ id: "run-canceled", skillId: "skill-1", status: "canceled" });

		expect(await recordSkillRunOutcome(db, "run-admission")).toBeNull();
		expect(await recordSkillRunOutcome(db, "run-live")).toBeNull();
		expect(await recordSkillRunOutcome(db, "run-canceled")).toBeNull();
		expect(await recordSkillRunOutcome(db, "run-missing")).toBeNull();
		expect(skillRow("skill-1")).toMatchObject({
			successCount: 0,
			failureCount: 0,
		});
		expect(usageEvents("skill-1")).toHaveLength(0);
	});

	it("pins the stamp to the CAS-captured epoch/status when a restart races between CAS and stamp", async () => {
		const { db, insertSkill, insertRun, skillRow, sqlite, usageEvents } =
			fixture();
		insertSkill({ id: "skill-1" });
		// Simulated interleaving: a terminal CAS moved epoch 0 to failed, then an
		// operator restart reservation bumped the epoch and set the intent BEFORE
		// the usage stamp re-read the row.
		insertRun({
			id: "run-race",
			skillId: "skill-1",
			status: "failed",
			error: "boom",
			executionEpoch: 1,
		});
		sqlite
			.prepare(
				`UPDATE skill_runs SET restart_requested_at = '2026-07-16T00:06:00.000Z' WHERE id = 'run-race'`,
			)
			.run();

		// The pinned stamp carries the CAS-captured identity (failed @ epoch 0),
		// not the re-read row's bumped epoch.
		const pinned = await recordSkillRunOutcome(db, "run-race", {
			expected: { status: "failed", executionEpoch: 0 },
		});
		expect(pinned).toMatchObject({
			recorded: true,
			outcome: "failure",
			status: "failed",
		});
		const events = usageEvents("skill-1");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			runId: "run-race",
			executionEpoch: 0,
			outcome: "failure",
			error: "boom",
		});

		// The restarted epoch later completes and stamps ITS OWN slot — the
		// canonical epoch-1 outcome is never suppressed by the raced stamp.
		sqlite
			.prepare(
				`UPDATE skill_runs
				    SET status = 'completed', error = NULL, restart_requested_at = NULL
				  WHERE id = 'run-race'`,
			)
			.run();
		const restarted = await recordSkillRunOutcome(db, "run-race");
		expect(restarted).toMatchObject({ recorded: true, outcome: "success" });
		expect(usageEvents("skill-1")).toHaveLength(2);
		expect(skillRow("skill-1")).toMatchObject({
			successCount: 1,
			failureCount: 1,
		});
	});

	it("observed-mode stamping skips rows with a pending restart intent (old outcome must not shift epochs)", async () => {
		const { db, insertSkill, insertRun, sqlite, usageEvents } = fixture();
		insertSkill({ id: "skill-1" });
		// Restart already reserved: execution_epoch points at the NEXT epoch
		// while the terminal fields still describe the previous one.
		insertRun({
			id: "run-intent",
			skillId: "skill-1",
			status: "failed",
			error: "boom",
			executionEpoch: 1,
		});
		sqlite
			.prepare(
				`UPDATE skill_runs SET restart_requested_at = '2026-07-16T00:06:00.000Z' WHERE id = 'run-intent'`,
			)
			.run();
		expect(await recordSkillRunOutcome(db, "run-intent")).toBeNull();
		expect(usageEvents("skill-1")).toHaveLength(0);
	});

	it("stamps each execution epoch of a restarted run once", async () => {
		const { db, insertSkill, insertRun, skillRow, sqlite } = fixture();
		insertSkill({ id: "skill-1" });
		insertRun({
			id: "run-restart",
			skillId: "skill-1",
			status: "failed",
			error: "boom",
			executionEpoch: 0,
		});
		expect(await recordSkillRunOutcome(db, "run-restart")).toMatchObject({
			recorded: true,
			outcome: "failure",
		});

		// Operator restart: same run row, next epoch, now completes.
		sqlite
			.prepare(
				`UPDATE skill_runs SET execution_epoch = 1, status = 'completed', error = NULL WHERE id = 'run-restart'`,
			)
			.run();
		expect(await recordSkillRunOutcome(db, "run-restart")).toMatchObject({
			recorded: true,
			outcome: "success",
		});
		expect(skillRow("skill-1")).toMatchObject({
			successCount: 1,
			failureCount: 1,
		});
	});
});

describe("recordSkillUsageEvent", () => {
	it("records direct telemetry without advancing lifecycle and rolls avg duration", async () => {
		const { db, insertSkill, skillRow } = fixture();
		insertSkill({ id: "skill-draft", lifecycleState: "draft" });

		const result = await recordSkillUsageEvent(db, {
			organizationId: "org-1",
			tediId: "tedi-1",
			skillId: "skill-draft",
			source: "direct",
			success: true,
			durationMs: 1200,
		});
		expect(result.recorded).toBe(true);
		expect(result.runId).toBeTruthy();
		expect(skillRow("skill-draft")).toMatchObject({
			successCount: 1,
			lifecycleState: "draft",
			avgDurationMs: 1200,
			paceLayer: "innovation",
		});
	});

	it("records muscle-memory failures against the source skill and flags crystallized skills for review", async () => {
		const { db, insertSkill, skillRow } = fixture();
		insertSkill({ id: "skill-src", lifecycleState: "crystallized" });

		const result = await recordSkillUsageEvent(db, {
			organizationId: "org-1",
			tediId: "tedi-1",
			skillId: "skill-src",
			source: "muscle_memory",
			success: false,
			error: "sandbox threw",
		});
		expect(result).toMatchObject({ recorded: true, outcome: "failure" });
		// Record layer: crystallized never auto-demotes — it flags for review.
		expect(skillRow("skill-src")).toMatchObject({
			failureCount: 1,
			lifecycleState: "crystallized",
		});
		expect(skillRow("skill-src").reviewFlaggedAt).toBeTruthy();
		expect(skillRow("skill-src").reviewFlagReason).toContain("sandbox threw");
	});

	it("does not promote active → proven from 5 direct self-reports", async () => {
		const { db, insertSkill, skillRow } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "active" });
		for (let i = 0; i < 5; i++) {
			await recordSkillUsageEvent(db, {
				organizationId: "org-1",
				tediId: "tedi-1",
				skillId: "skill-1",
				source: "direct",
				success: true,
				runId: `run-${i}`,
			});
		}
		expect(skillRow("skill-1")).toMatchObject({
			successCount: 5,
			lifecycleState: "active",
		});
	});

	it("promotes active → proven only after 5 canonical workflow successes", async () => {
		const { db, insertSkill, insertRun, skillRow } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "active" });
		for (let i = 0; i < 5; i++) {
			insertRun({
				id: `verified-run-${i}`,
				skillId: "skill-1",
				status: "completed",
			});
			await recordSkillRunOutcome(db, `verified-run-${i}`);
		}
		expect(skillRow("skill-1")).toMatchObject({
			successCount: 5,
			lifecycleState: "proven",
		});
	});

	it("demotes one state after 3 consecutive failures (proven → active → draft)", async () => {
		const { db, insertSkill, skillRow } = fixture();
		insertSkill({
			id: "skill-1",
			lifecycleState: "proven",
			successCount: 9,
		});
		for (let i = 0; i < 3; i++) {
			await recordSkillUsageEvent(db, {
				organizationId: "org-1",
				tediId: "tedi-1",
				skillId: "skill-1",
				source: "direct",
				success: false,
				runId: `fail-${i}`,
				error: "boom",
			});
		}
		expect(skillRow("skill-1").lifecycleState).toBe("active");

		// The streak continues: the next failure drops it again.
		await recordSkillUsageEvent(db, {
			organizationId: "org-1",
			tediId: "tedi-1",
			skillId: "skill-1",
			source: "direct",
			success: false,
			runId: "fail-3",
			error: "boom",
		});
		expect(skillRow("skill-1").lifecycleState).toBe("draft");
	});

	it("rejects a direct report whose runId names a skill run, so the canonical stamp is never suppressed", async () => {
		const { db, insertSkill, insertRun, skillRow, usageEvents } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "active" });
		insertRun({
			id: "run-shared",
			skillId: "skill-1",
			status: "failed",
			error: "step deploy_verify exhausted retries",
		});

		// The self-report claims success under the canonical run's id. Without
		// rejection it would pre-claim the (runId, epoch 0) unique slot and the
		// later terminal FAILURE stamp would silently no-op as a duplicate.
		const direct = await recordSkillUsageEvent(db, {
			organizationId: "org-1",
			tediId: "tedi-1",
			skillId: "skill-1",
			source: "direct",
			success: true,
			runId: "run-shared",
		});
		expect(direct).toMatchObject({
			recorded: false,
			runId: "run-shared",
			reason: "run_reserved",
		});

		const canonical = await recordSkillRunOutcome(db, "run-shared");
		expect(canonical).toMatchObject({
			recorded: true,
			outcome: "failure",
			status: "failed",
		});
		const events = usageEvents("skill-1");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			runId: "run-shared",
			source: "workflow_run",
			outcome: "failure",
		});
		expect(skillRow("skill-1")).toMatchObject({
			successCount: 0,
			failureCount: 1,
		});

		// Muscle reports flow through the same guard — no non-workflow source
		// can squat a canonical slot.
		const muscle = await recordSkillUsageEvent(db, {
			organizationId: "org-1",
			tediId: "tedi-1",
			skillId: "skill-1",
			source: "muscle_memory",
			success: true,
			runId: "run-shared",
		});
		expect(muscle).toMatchObject({ recorded: false, reason: "run_reserved" });
	});

	it("keeps raw non-workflow runIds recordable (retrieved→used join preserved)", async () => {
		const { db, insertSkill, usageEvents } = fixture();
		insertSkill({ id: "skill-1" });
		const result = await recordSkillUsageEvent(db, {
			organizationId: "org-1",
			tediId: "tedi-1",
			skillId: "skill-1",
			source: "direct",
			success: true,
			runId: "tedi-1:chat:99",
		});
		expect(result).toMatchObject({ recorded: true, runId: "tedi-1:chat:99" });
		const events = usageEvents("skill-1");
		// Stored raw — run-window joins against context.injected runtime events
		// (which carry the same chat runId) keep working.
		expect(events[0]?.runId).toBe("tedi-1:chat:99");
	});

	it("does not resurrect a concurrently archived skill (lifecycle patch is CAS-guarded)", async () => {
		let armed = true;
		let sqliteRef: DatabaseSync | null = null;
		const { db, insertSkill, insertRun, skillRow, sqlite } = fixture({
			onPrepare: (query) => {
				// Fire once, on the promotion-signals read that runs BETWEEN the
				// counter-update read of lifecycle_state and the lifecycle patch
				// write — the RMW window a concurrent archive can land in.
				if (
					armed &&
					sqliteRef &&
					/^\s*select/i.test(query) &&
					query.includes("skill_usage_events")
				) {
					armed = false;
					sqliteRef
						.prepare(
							`UPDATE skill_entries SET lifecycle_state = 'archived' WHERE id = 'skill-arc'`,
						)
						.run();
				}
			},
		});
		sqliteRef = sqlite;
		insertSkill({ id: "skill-arc", lifecycleState: "draft" });
		insertRun({ id: "run-arc", skillId: "skill-arc", status: "completed" });

		// Without the guard this canonical success would compute draft → active
		// from the pre-archive read and resurrect the archived skill.
		const result = await recordSkillRunOutcome(db, "run-arc");
		expect(result).toMatchObject({ recorded: true, outcome: "success" });
		expect(skillRow("skill-arc").lifecycleState).toBe("archived");
	});

	it("rejects attempts to self-label telemetry as canonical workflow evidence", async () => {
		const { db, insertSkill } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "draft" });
		await expect(
			recordSkillUsageEvent(db, {
				organizationId: "org-1",
				tediId: "tedi-1",
				skillId: "skill-1",
				source: "workflow_run",
				success: true,
				runId: "unresolved-run",
			}),
		).rejects.toThrow("recordSkillRunOutcome");
	});

	it("a direct success cannot reset failures, but a canonical workflow success can", async () => {
		const { db, insertSkill, insertRun, skillRow } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "active" });
		for (let index = 0; index < 2; index++) {
			await recordSkillUsageEvent(db, {
				organizationId: "org-1",
				tediId: "tedi-1",
				skillId: "skill-1",
				source: "direct",
				success: false,
				runId: `mixed-${index}`,
			});
		}
		await recordSkillUsageEvent(db, {
			organizationId: "org-1",
			tediId: "tedi-1",
			skillId: "skill-1",
			source: "direct",
			success: true,
			runId: "direct-recovery-claim",
		});
		await recordSkillUsageEvent(db, {
			organizationId: "org-1",
			tediId: "tedi-1",
			skillId: "skill-1",
			source: "direct",
			success: false,
			runId: "third-direct-failure",
		});
		expect(skillRow("skill-1").lifecycleState).toBe("draft");

		insertSkill({ id: "skill-2", lifecycleState: "active" });
		for (let index = 0; index < 2; index++) {
			await recordSkillUsageEvent(db, {
				organizationId: "org-1",
				tediId: "tedi-1",
				skillId: "skill-2",
				source: "direct",
				success: false,
				runId: `verified-mixed-${index}`,
			});
		}
		insertRun({
			id: "verified-recovery",
			skillId: "skill-2",
			status: "completed",
		});
		await recordSkillRunOutcome(db, "verified-recovery");
		await recordSkillUsageEvent(db, {
			organizationId: "org-1",
			tediId: "tedi-1",
			skillId: "skill-2",
			source: "direct",
			success: false,
			runId: "post-verified-failure",
		});
		expect(skillRow("skill-2").lifecycleState).toBe("active");
	});

	it("returns skill_not_found instead of throwing for unknown or cross-org skills", async () => {
		const { db, insertSkill } = fixture();
		insertSkill({ id: "skill-1" });
		const missing = await recordSkillUsageEvent(db, {
			organizationId: "org-1",
			tediId: "tedi-1",
			skillId: "nope",
			source: "direct",
			success: true,
		});
		expect(missing).toMatchObject({
			recorded: false,
			reason: "skill_not_found",
		});
		const crossOrg = await recordSkillUsageEvent(db, {
			organizationId: "org-2",
			tediId: "tedi-1",
			skillId: "skill-1",
			source: "direct",
			success: true,
		});
		expect(crossOrg).toMatchObject({
			recorded: false,
			reason: "skill_not_found",
		});
	});
});

describe("countSkillUsagesLast24h", () => {
	it("counts ledger events (success and failure) inside the window", async () => {
		const { db, insertSkill, insertRun } = fixture();
		insertSkill({ id: "skill-1" });
		insertRun({ id: "run-ok", skillId: "skill-1", status: "completed" });
		insertRun({
			id: "run-bad",
			skillId: "skill-1",
			status: "failed",
			error: "boom",
		});
		await recordSkillRunOutcome(db, "run-ok");
		await recordSkillRunOutcome(db, "run-bad");

		const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const rows = await countSkillUsagesLast24h(
			db,
			{ tediId: "tedi-1", orgId: "org-1" },
			since,
		);
		expect(rows[0]?.cnt).toBe(2);

		const otherTedi = await countSkillUsagesLast24h(
			db,
			{ tediId: "tedi-2", orgId: "org-1" },
			since,
		);
		expect(otherTedi[0]?.cnt).toBe(0);
	});
});
