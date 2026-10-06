import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	getMuscleMemoryById,
	recordMuscleUsage,
} from "./cognitive/muscle-memory";
import { crystallizeMuscleFromSkill } from "./cognitive/skill-crystallization";

/**
 * Muscle crystallization is a record-layer promotion of the source skill and
 * is gated at the db layer — org scope, the proven muscle bar from the usage
 * ledger, and disposer separation (via the crystallize carve-out from the tedi force
 * ceiling). recordMuscleUsage is org-scoped in its WHERE.
 */

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE skill_entries (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			tedi_id TEXT,
			domain_id TEXT,
			title TEXT NOT NULL,
			slug TEXT,
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
		CREATE TABLE tedi_muscle_memory (
			id TEXT PRIMARY KEY NOT NULL,
			tedi_id TEXT NOT NULL,
			organization_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT,
			r2_path TEXT,
			usage_count INTEGER NOT NULL DEFAULT 0,
			success_count INTEGER NOT NULL DEFAULT 0,
			failure_count INTEGER NOT NULL DEFAULT 0,
			last_used_at TEXT,
			origin TEXT NOT NULL,
			version INTEGER NOT NULL DEFAULT 1,
			source_skill_id TEXT,
			code_module TEXT,
			allowed_namespaces TEXT,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT DEFAULT CURRENT_TIMESTAMP
		);
	`);

	const insertSkill = (row: {
		id: string;
		organizationId?: string;
		tediId?: string | null;
		proposedByTediId?: string | null;
		lifecycleState?: string;
		revisionReasoning?: string | null;
	}) => {
		sqlite
			.prepare(
				`INSERT INTO skill_entries (
					id, organization_id, tedi_id, proposed_by_tedi_id, title, slug,
					content, lifecycle_state, revision_reasoning
				) VALUES (?, ?, ?, ?, 'Deploy reconciler', ?, '# Skill', ?, ?)`,
			)
			.run(
				row.id,
				row.organizationId ?? "org-1",
				row.tediId === undefined ? "tedi-author" : row.tediId,
				row.proposedByTediId === undefined
					? "tedi-author"
					: row.proposedByTediId,
				`slug-${row.id}`,
				row.lifecycleState ?? "proven",
				row.revisionReasoning ?? null,
			);
	};

	let eventSeq = 0;
	const insertSuccesses = (skillId: string, count: number, orgId = "org-1") => {
		for (let i = 0; i < count; i += 1) {
			eventSeq += 1;
			sqlite
				.prepare(
					`INSERT INTO skill_usage_events (
						id, organization_id, tedi_id, skill_id, run_id, execution_epoch,
						source, outcome, created_at
					) VALUES (?, ?, 'tedi-author', ?, ?, 0, 'workflow_run', 'success', ?)`,
				)
				.run(
					`event-${eventSeq}`,
					orgId,
					skillId,
					`run-${eventSeq}`,
					`2026-07-10T00:00:${String(eventSeq).padStart(2, "0")}.000Z`,
				);
		}
	};
	const insertFailure = (skillId: string, orgId = "org-1") => {
		eventSeq += 1;
		sqlite
			.prepare(
				`INSERT INTO skill_usage_events (
					id, organization_id, tedi_id, skill_id, run_id, execution_epoch,
					source, outcome, created_at
				) VALUES (?, ?, 'tedi-author', ?, ?, 0, 'workflow_run', 'failure', ?)`,
			)
			.run(
				`event-${eventSeq}`,
				orgId,
				skillId,
				`run-${eventSeq}`,
				`2026-07-10T00:00:${String(eventSeq).padStart(2, "0")}.000Z`,
			);
	};

	const insertMuscle = (row: {
		id: string;
		organizationId?: string;
		sourceSkillId?: string | null;
	}) => {
		sqlite
			.prepare(
				`INSERT INTO tedi_muscle_memory (
					id, tedi_id, organization_id, kind, name, origin, source_skill_id
				) VALUES (?, 'tedi-author', ?, 'action_template', ?, 'from_skill', ?)`,
			)
			.run(
				row.id,
				row.organizationId ?? "org-1",
				`muscle-${row.id}`,
				row.sourceSkillId ?? null,
			);
	};

	const skillRow = (id: string) =>
		sqlite
			.prepare(
				`SELECT lifecycle_state as lifecycleState, pace_layer as paceLayer,
					revision_reasoning as revisionReasoning
				 FROM skill_entries WHERE id = ?`,
			)
			.get(id) as {
			lifecycleState: string;
			paceLayer: string | null;
			revisionReasoning: string | null;
		};

	const muscleRows = () =>
		sqlite
			.prepare(
				`SELECT id, organization_id as organizationId, origin,
					source_skill_id as sourceSkillId, usage_count as usageCount,
					success_count as successCount, failure_count as failureCount
				 FROM tedi_muscle_memory`,
			)
			.all() as Array<{
			id: string;
			organizationId: string;
			origin: string;
			sourceSkillId: string | null;
			usageCount: number;
			successCount: number;
			failureCount: number;
		}>;

	return {
		db: createDbClient(createD1Facade(sqlite)),
		insertSkill,
		insertSuccesses,
		insertFailure,
		insertMuscle,
		skillRow,
		muscleRows,
	};
}

const CRYSTALLIZE_BASE = {
	tediId: "tedi-owner",
	organizationId: "org-1",
	skillId: "skill-1",
	kind: "action_template" as const,
	name: "deploy-reconciler",
};

describe("crystallizeMuscleFromSkill (A1 two-layer gate)", () => {
	it("rejects a foreign-org source skill and writes nothing", async () => {
		const { db, insertSkill, insertSuccesses, skillRow, muscleRows } =
			fixture();
		insertSkill({ id: "skill-1", organizationId: "org-2" });
		insertSuccesses("skill-1", 5, "org-2");
		await expect(
			crystallizeMuscleFromSkill(db, {
				...CRYSTALLIZE_BASE,
				authority: { kind: "operator" },
			}),
		).rejects.toMatchObject({
			details: { rule: "crystallize_out_of_scope" },
		});
		expect(muscleRows()).toHaveLength(0);
		expect(skillRow("skill-1").lifecycleState).toBe("proven");
	});

	it("rejects below the proven muscle bar — even for an operator", async () => {
		const { db, insertSkill, insertSuccesses, muscleRows } = fixture();
		insertSkill({ id: "skill-1" });
		insertSuccesses("skill-1", 4);
		await expect(
			crystallizeMuscleFromSkill(db, {
				...CRYSTALLIZE_BASE,
				authority: { kind: "operator" },
			}),
		).rejects.toMatchObject({
			details: { rule: "crystallize_requires_proven_evidence" },
		});
		expect(muscleRows()).toHaveLength(0);
	});

	it("counts only THIS org's ledger evidence toward the bar", async () => {
		const { db, insertSkill, insertSuccesses } = fixture();
		insertSkill({ id: "skill-1" });
		// 5 successes exist, but under a different org id — they cannot prove
		// this org's skill.
		insertSuccesses("skill-1", 5, "org-2");
		await expect(
			crystallizeMuscleFromSkill(db, {
				...CRYSTALLIZE_BASE,
				authority: { kind: "operator" },
			}),
		).rejects.toMatchObject({
			details: { rule: "crystallize_requires_proven_evidence" },
		});
	});

	it("rejects while an unrecovered failure sits in the recent window", async () => {
		const { db, insertSkill, insertSuccesses, insertFailure } = fixture();
		insertSkill({ id: "skill-1" });
		insertSuccesses("skill-1", 5);
		insertFailure("skill-1");
		await expect(
			crystallizeMuscleFromSkill(db, {
				...CRYSTALLIZE_BASE,
				authority: { kind: "operator" },
			}),
		).rejects.toMatchObject({
			details: { rule: "crystallize_requires_recovery" },
		});
	});

	it("rejects the authoring tedi as crystallization authority", async () => {
		const { db, insertSkill, insertSuccesses, muscleRows } = fixture();
		insertSkill({ id: "skill-1", proposedByTediId: "tedi-author" });
		insertSuccesses("skill-1", 5);
		await expect(
			crystallizeMuscleFromSkill(db, {
				...CRYSTALLIZE_BASE,
				authority: { kind: "tedi", tediId: "tedi-author" },
			}),
		).rejects.toMatchObject({
			details: { rule: "proposer_cannot_self_approve" },
		});
		expect(muscleRows()).toHaveLength(0);
	});

	it("rejects a tedi authority on an authorless skill (fails closed)", async () => {
		const { db, insertSkill, insertSuccesses } = fixture();
		insertSkill({ id: "skill-1", tediId: null, proposedByTediId: null });
		insertSuccesses("skill-1", 5);
		await expect(
			crystallizeMuscleFromSkill(db, {
				...CRYSTALLIZE_BASE,
				authority: { kind: "tedi", tediId: "tedi-reviewer" },
			}),
		).rejects.toMatchObject({
			details: { rule: "tedi_force_requires_recorded_author" },
		});
	});

	it("a NON-author tedi with proven evidence crystallizes (the ceiling carve-out)", async () => {
		const { db, insertSkill, insertSuccesses, skillRow, muscleRows } =
			fixture();
		insertSkill({ id: "skill-1", proposedByTediId: "tedi-author" });
		insertSuccesses("skill-1", 5);
		const entry = await crystallizeMuscleFromSkill(db, {
			...CRYSTALLIZE_BASE,
			authority: { kind: "tedi", tediId: "tedi-reviewer" },
			revisionReasoning:
				"Premortem (Klein 2007): failure modes — 1) upstream schema drift 2) credential expiry. Rollback: delete the muscle entry.",
		});
		expect(entry.sourceSkillId).toBe("skill-1");
		expect(entry.origin).toBe("from_skill");
		const skill = skillRow("skill-1");
		expect(skill.lifecycleState).toBe("crystallized");
		expect(skill.paceLayer).toBe("record");
		expect(skill.revisionReasoning).toContain("Premortem (Klein 2007)");
		expect(muscleRows()).toHaveLength(1);
	});

	it("an operator with proven evidence crystallizes", async () => {
		const { db, insertSkill, insertSuccesses, skillRow } = fixture();
		insertSkill({ id: "skill-1" });
		insertSuccesses("skill-1", 5);
		await crystallizeMuscleFromSkill(db, {
			...CRYSTALLIZE_BASE,
			authority: { kind: "operator" },
		});
		expect(skillRow("skill-1").lifecycleState).toBe("crystallized");
	});
});

describe("recordMuscleUsage / getMuscleMemoryById org scoping (A3)", () => {
	it("a foreign-org id is a no-op: returns undefined, counters untouched", async () => {
		const { db, insertMuscle, muscleRows } = fixture();
		insertMuscle({ id: "m-1", organizationId: "org-2" });
		const updated = await recordMuscleUsage(db, "m-1", true, "org-1");
		expect(updated).toBeUndefined();
		const [row] = muscleRows();
		expect(row).toMatchObject({
			usageCount: 0,
			successCount: 0,
			failureCount: 0,
		});
	});

	it("the owning org increments counters and gets the row back", async () => {
		const { db, insertMuscle, muscleRows } = fixture();
		insertMuscle({ id: "m-1", sourceSkillId: "skill-1" });
		const updated = await recordMuscleUsage(db, "m-1", true, "org-1");
		expect(updated?.sourceSkillId).toBe("skill-1");
		expect(muscleRows()[0]).toMatchObject({
			usageCount: 1,
			successCount: 1,
			failureCount: 0,
		});
	});

	it("getMuscleMemoryById is org-scoped", async () => {
		const { db, insertMuscle } = fixture();
		insertMuscle({ id: "m-1", organizationId: "org-2" });
		expect(await getMuscleMemoryById(db, "m-1", "org-1")).toBeUndefined();
		expect((await getMuscleMemoryById(db, "m-1", "org-2"))?.id).toBe("m-1");
	});
});
