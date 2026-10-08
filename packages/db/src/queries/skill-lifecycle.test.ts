import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { createSkillEntry, updateSkillEntry } from "./cognitive/skill-crud";
import {
	assertSkillLifecycleTransition,
	clampLifecycleToTediForceCeiling,
	countConsecutiveRecentFailures,
	exceedsTediForcePromotionCeiling,
	hasUnrecoveredFailure,
	nextSkillLifecycleState,
	paceLayerForLifecycle,
	SkillLifecycleTransitionError,
	SkillPaceLayerOverrideError,
	sweepExpiredDraftSkills,
} from "./skill-lifecycle";

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
			mcp_app_bindings TEXT,
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
		CREATE UNIQUE INDEX uniq_skill_usage_events_run
			ON skill_usage_events (run_id, execution_epoch);
	`);

	const insertSkill = (row: {
		id: string;
		lifecycleState?: string;
		successCount?: number;
		failureCount?: number;
		organizationId?: string;
		updatedAt?: string | null;
		createdAt?: string;
		lastUsedAt?: string | null;
		tags?: string[] | null;
		proposedByTediId?: string | null;
		/** null = org-scoped (authorless unless proposedByTediId is set). */
		tediId?: string | null;
	}) => {
		sqlite
			.prepare(
				`INSERT INTO skill_entries (
					id, organization_id, tedi_id, title, slug, content,
					success_count, failure_count, lifecycle_state, created_at, updated_at,
					last_used_at, tags, proposed_by_tedi_id
				) VALUES (?, ?, ?, 'Deploy reconciler', ?, '# Skill', ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				row.id,
				row.organizationId ?? "org-1",
				row.tediId === undefined ? "tedi-1" : row.tediId,
				`slug-${row.id}`,
				row.successCount ?? 0,
				row.failureCount ?? 0,
				row.lifecycleState ?? "active",
				row.createdAt ?? "2026-07-01T00:00:00.000Z",
				row.updatedAt === undefined
					? "2026-07-01T00:00:00.000Z"
					: row.updatedAt,
				row.lastUsedAt ?? null,
				row.tags ? JSON.stringify(row.tags) : null,
				row.proposedByTediId ?? null,
			);
	};

	let eventSeq = 0;
	const insertEvent = (row: {
		skillId: string;
		outcome: "success" | "failure";
		source?: "workflow_run" | "muscle_memory" | "direct";
		organizationId?: string;
		createdAt?: string;
	}) => {
		eventSeq += 1;
		sqlite
			.prepare(
				`INSERT INTO skill_usage_events (
					id, organization_id, tedi_id, skill_id, run_id, execution_epoch,
					source, outcome, created_at
				) VALUES (?, ?, 'tedi-1', ?, ?, 0, ?, ?, ?)`,
			)
			.run(
				`event-${eventSeq}`,
				row.organizationId ?? "org-1",
				row.skillId,
				`run-${eventSeq}`,
				row.source ?? "workflow_run",
				row.outcome,
				row.createdAt ??
					`2026-07-10T00:00:${String(eventSeq).padStart(2, "0")}.000Z`,
			);
	};

	const skillRow = (id: string) =>
		sqlite
			.prepare(
				`SELECT lifecycle_state as lifecycleState, revision,
					revision_reasoning as revisionReasoning,
					pace_layer as paceLayer
				 FROM skill_entries WHERE id = ?`,
			)
			.get(id) as {
			lifecycleState: string;
			revision: number;
			revisionReasoning: string | null;
			paceLayer: string | null;
		};

	return {
		db: createDbClient(createD1Facade(sqlite)),
		insertSkill,
		insertEvent,
		skillRow,
	};
}

describe("hasUnrecoveredFailure", () => {
	it("returns false for all-success windows", () => {
		expect(hasUnrecoveredFailure(["success", "success", "success"])).toBe(
			false,
		);
		expect(hasUnrecoveredFailure([])).toBe(false);
	});

	it("flags a failure with fewer than 2 consecutive successes after it", () => {
		// newest first: latest event failed
		expect(hasUnrecoveredFailure(["failure", "success", "success"])).toBe(true);
		// one success after the failure is not recovery
		expect(hasUnrecoveredFailure(["success", "failure", "success"])).toBe(true);
	});

	it("treats a failure followed by ≥2 consecutive successes as recovered", () => {
		expect(
			hasUnrecoveredFailure(["success", "success", "failure", "success"]),
		).toBe(false);
	});

	it("recovery must be consecutive — a failure inside the recovery window blocks it", () => {
		expect(
			hasUnrecoveredFailure(["success", "failure", "failure", "success"]),
		).toBe(true);
	});
});

describe("countConsecutiveRecentFailures", () => {
	it("counts the newest-first failure streak", () => {
		expect(countConsecutiveRecentFailures([])).toBe(0);
		expect(countConsecutiveRecentFailures(["success", "failure"])).toBe(0);
		expect(
			countConsecutiveRecentFailures(["failure", "failure", "success"]),
		).toBe(2);
	});
});

describe("nextSkillLifecycleState", () => {
	it("promotes draft → active on the first verified workflow success", () => {
		expect(
			nextSkillLifecycleState({
				current: "draft",
				success: true,
				promotionEligible: true,
				verifiedSuccessCount: 1,
				recentOutcomes: ["success"],
			}),
		).toEqual({ state: "active", flagForReview: false });
	});

	it("keeps direct success telemetry from advancing a draft", () => {
		expect(
			nextSkillLifecycleState({
				current: "draft",
				success: true,
				promotionEligible: false,
				verifiedSuccessCount: 1,
				recentOutcomes: ["success"],
			}),
		).toEqual({ state: "draft", flagForReview: false });
	});

	it("keeps drafts on failure — failures never advance", () => {
		expect(
			nextSkillLifecycleState({
				current: "draft",
				success: false,
				promotionEligible: true,
				verifiedSuccessCount: 0,
				recentOutcomes: ["failure"],
			}),
		).toEqual({ state: "draft", flagForReview: false });
	});

	it("promotes active → proven at 5 ledger successes with a clean window", () => {
		expect(
			nextSkillLifecycleState({
				current: "active",
				success: true,
				promotionEligible: true,
				verifiedSuccessCount: 5,
				recentOutcomes: Array(5).fill("success"),
			}),
		).toEqual({ state: "proven", flagForReview: false });
	});

	it("blocks active → proven below 5 successes (old 3-success bar is gone)", () => {
		expect(
			nextSkillLifecycleState({
				current: "active",
				success: true,
				promotionEligible: true,
				verifiedSuccessCount: 4,
				recentOutcomes: Array(4).fill("success"),
			}),
		).toEqual({ state: "active", flagForReview: false });
	});

	it("blocks active → proven while an unrecovered failure sits in the window", () => {
		expect(
			nextSkillLifecycleState({
				current: "active",
				success: true,
				promotionEligible: true,
				verifiedSuccessCount: 5,
				recentOutcomes: [
					"success",
					"failure",
					"success",
					"success",
					"success",
					"success",
				],
			}),
		).toEqual({ state: "active", flagForReview: false });
	});

	it("allows active → proven once the failure is recovered by 2 consecutive successes", () => {
		expect(
			nextSkillLifecycleState({
				current: "active",
				success: true,
				promotionEligible: true,
				verifiedSuccessCount: 6,
				recentOutcomes: [
					"success",
					"success",
					"failure",
					"success",
					"success",
					"success",
					"success",
				],
			}),
		).toEqual({ state: "proven", flagForReview: false });
	});

	it("demotes proven → active after 3 consecutive failures", () => {
		expect(
			nextSkillLifecycleState({
				current: "proven",
				success: false,
				promotionEligible: true,
				verifiedSuccessCount: 7,
				recentOutcomes: ["failure", "failure", "failure", "success"],
			}),
		).toEqual({ state: "active", flagForReview: false });
	});

	it("demotes active → draft after 3 consecutive failures", () => {
		expect(
			nextSkillLifecycleState({
				current: "active",
				success: false,
				promotionEligible: true,
				verifiedSuccessCount: 2,
				recentOutcomes: ["failure", "failure", "failure"],
			}),
		).toEqual({ state: "draft", flagForReview: false });
	});

	it("does not demote below 3 consecutive failures", () => {
		expect(
			nextSkillLifecycleState({
				current: "proven",
				success: false,
				promotionEligible: true,
				verifiedSuccessCount: 7,
				recentOutcomes: ["failure", "failure", "success"],
			}),
		).toEqual({ state: "proven", flagForReview: false });
	});

	it("crystallized skills never auto-demote — failures flag for review instead", () => {
		expect(
			nextSkillLifecycleState({
				current: "crystallized",
				success: false,
				promotionEligible: false,
				verifiedSuccessCount: 7091,
				recentOutcomes: ["failure", "failure", "failure", "failure"],
			}),
		).toEqual({ state: "crystallized", flagForReview: true });
		expect(
			nextSkillLifecycleState({
				current: "crystallized",
				success: true,
				promotionEligible: false,
				verifiedSuccessCount: 7092,
				recentOutcomes: ["success"],
			}),
		).toEqual({ state: "crystallized", flagForReview: false });
	});

	it("archived skills never transition", () => {
		expect(
			nextSkillLifecycleState({
				current: "archived",
				success: true,
				promotionEligible: true,
				verifiedSuccessCount: 10,
				recentOutcomes: ["success"],
			}),
		).toEqual({ state: "archived", flagForReview: false });
	});
});

describe("assertSkillLifecycleTransition via updateSkillEntry", () => {
	it("forces every newly created skill to start as draft", async () => {
		const { db } = fixture();
		await expect(
			createSkillEntry(db, {
				id: "skill-new-active",
				organizationId: "org-1",
				tediId: "tedi-1",
				title: "Unverified active skill",
				content: "# Skill",
				lifecycleState: "active",
			}),
		).rejects.toMatchObject({
			details: { rule: "new_skills_start_draft" },
		});
		const created = await createSkillEntry(db, {
			id: "skill-new-draft",
			organizationId: "org-1",
			tediId: "tedi-1",
			title: "Draft skill",
			content: "# Skill",
		});
		expect(created.lifecycleState).toBe("draft");
	});

	it("blocks draft → active with zero recorded usage events", async () => {
		const { db, insertSkill, skillRow } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "draft" });
		await expect(
			updateSkillEntry(db, "skill-1", { lifecycleState: "active" }),
		).rejects.toBeInstanceOf(SkillLifecycleTransitionError);
		expect(skillRow("skill-1").lifecycleState).toBe("draft");
	});

	it("allows draft → active once a success event is recorded", async () => {
		const { db, insertSkill, insertEvent, skillRow } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "draft" });
		insertEvent({ skillId: "skill-1", outcome: "success" });
		await updateSkillEntry(db, "skill-1", { lifecycleState: "active" });
		expect(skillRow("skill-1").lifecycleState).toBe("active");
	});

	it("does not accept a direct self-report as promotion evidence", async () => {
		const { db, insertSkill, insertEvent } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "draft" });
		insertEvent({
			skillId: "skill-1",
			outcome: "success",
			source: "direct",
		});
		await expect(
			updateSkillEntry(db, "skill-1", { lifecycleState: "active" }),
		).rejects.toMatchObject({ details: { rule: "active_requires_success" } });
	});

	it("a failure event alone does not satisfy the active gate", async () => {
		const { db, insertSkill, insertEvent } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "draft" });
		insertEvent({ skillId: "skill-1", outcome: "failure" });
		await expect(
			updateSkillEntry(db, "skill-1", { lifecycleState: "active" }),
		).rejects.toBeInstanceOf(SkillLifecycleTransitionError);
	});

	it("force with operator authority bypasses the execution gate", async () => {
		const { db, insertSkill, skillRow } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "draft" });
		await updateSkillEntry(
			db,
			"skill-1",
			{ lifecycleState: "active" },
			{ force: true, forceAuthority: { kind: "operator" } },
		);
		expect(skillRow("skill-1").lifecycleState).toBe("active");
	});

	it("force promotion without a named authority fails closed", async () => {
		const { db, insertSkill } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "draft" });
		await expect(
			updateSkillEntry(
				db,
				"skill-1",
				{ lifecycleState: "active" },
				{ force: true },
			),
		).rejects.toMatchObject({ details: { rule: "force_requires_authority" } });
	});

	it("force promotion by the authoring tedi is rejected (proposer≠approver)", async () => {
		const { db, insertSkill } = fixture();
		insertSkill({
			id: "skill-1",
			lifecycleState: "draft",
			proposedByTediId: "tedi-author",
		});
		await expect(
			updateSkillEntry(
				db,
				"skill-1",
				{ lifecycleState: "active" },
				{
					force: true,
					forceAuthority: { kind: "tedi", tediId: "tedi-author" },
				},
			),
		).rejects.toMatchObject({
			details: { rule: "proposer_cannot_self_approve" },
		});
	});

	it("force promotion by the scoped tedi is rejected when authorship is unrecorded (pre-authorship fallback)", async () => {
		const { db, insertSkill } = fixture();
		// insertSkill scopes every row to 'tedi-1'; proposed_by_tedi_id stays null.
		insertSkill({ id: "skill-1", lifecycleState: "draft" });
		await expect(
			updateSkillEntry(
				db,
				"skill-1",
				{ lifecycleState: "active" },
				{ force: true, forceAuthority: { kind: "tedi", tediId: "tedi-1" } },
			),
		).rejects.toMatchObject({
			details: { rule: "proposer_cannot_self_approve" },
		});
	});

	it("force promotion by a DIFFERENT tedi passes (cross-tedi disposer)", async () => {
		const { db, insertSkill, skillRow } = fixture();
		insertSkill({
			id: "skill-1",
			lifecycleState: "draft",
			proposedByTediId: "tedi-author",
		});
		await updateSkillEntry(
			db,
			"skill-1",
			{ lifecycleState: "active" },
			{
				force: true,
				forceAuthority: { kind: "tedi", tediId: "tedi-reviewer" },
			},
		);
		expect(skillRow("skill-1").lifecycleState).toBe("active");
	});

	it("force demotion/archival needs no authority (only promotions are gated)", async () => {
		const { db, insertSkill, skillRow } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "active" });
		await updateSkillEntry(
			db,
			"skill-1",
			{ lifecycleState: "archived" },
			{ force: true },
		);
		expect(skillRow("skill-1").lifecycleState).toBe("archived");
	});

	it("tedi force to proven is rejected — the force ceiling is active", async () => {
		const { db, insertSkill } = fixture();
		insertSkill({
			id: "skill-1",
			lifecycleState: "active",
			proposedByTediId: "tedi-author",
		});
		await expect(
			updateSkillEntry(
				db,
				"skill-1",
				{ lifecycleState: "proven" },
				{
					force: true,
					forceAuthority: { kind: "tedi", tediId: "tedi-reviewer" },
				},
			),
		).rejects.toMatchObject({ details: { rule: "tedi_force_ceiling" } });
	});

	it("tedi force to crystallized is rejected (only the evidence-verified muscle path may)", async () => {
		const { db, insertSkill } = fixture();
		insertSkill({
			id: "skill-1",
			lifecycleState: "proven",
			proposedByTediId: "tedi-author",
		});
		await expect(
			updateSkillEntry(
				db,
				"skill-1",
				{ lifecycleState: "crystallized" },
				{
					force: true,
					forceAuthority: { kind: "tedi", tediId: "tedi-reviewer" },
				},
			),
		).rejects.toMatchObject({ details: { rule: "tedi_force_ceiling" } });
	});

	it("operator force to crystallized is unaffected by the tedi ceiling", async () => {
		const { db, insertSkill, skillRow } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "proven" });
		await updateSkillEntry(
			db,
			"skill-1",
			{ lifecycleState: "crystallized" },
			{ force: true, forceAuthority: { kind: "operator" } },
		);
		expect(skillRow("skill-1").lifecycleState).toBe("crystallized");
		expect(skillRow("skill-1").paceLayer).toBe("record");
	});

	it("tedi force on an AUTHORLESS entry fails closed (no proposer≠approver proof)", async () => {
		const { db, insertSkill } = fixture();
		// Both authoring identities null: org-scoped row, no recorded proposer.
		insertSkill({
			id: "skill-1",
			lifecycleState: "draft",
			tediId: null,
			proposedByTediId: null,
		});
		await expect(
			updateSkillEntry(
				db,
				"skill-1",
				{ lifecycleState: "active" },
				{
					force: true,
					forceAuthority: { kind: "tedi", tediId: "tedi-reviewer" },
				},
			),
		).rejects.toMatchObject({
			details: { rule: "tedi_force_requires_recorded_author" },
		});
	});

	it("operator force on an authorless entry still passes", async () => {
		const { db, insertSkill, skillRow } = fixture();
		insertSkill({
			id: "skill-1",
			lifecycleState: "draft",
			tediId: null,
			proposedByTediId: null,
		});
		await updateSkillEntry(
			db,
			"skill-1",
			{ lifecycleState: "active" },
			{ force: true, forceAuthority: { kind: "operator" } },
		);
		expect(skillRow("skill-1").lifecycleState).toBe("active");
	});

	it("blocks active → proven below 5 ledger successes", async () => {
		const { db, insertSkill, insertEvent } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "active" });
		for (let i = 0; i < 4; i++) {
			insertEvent({ skillId: "skill-1", outcome: "success" });
		}
		await expect(
			updateSkillEntry(db, "skill-1", { lifecycleState: "proven" }),
		).rejects.toMatchObject({ details: { rule: "proven_requires_successes" } });
	});

	it("blocks active → proven with an unrecovered failure in the last 10 events", async () => {
		const { db, insertSkill, insertEvent } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "active" });
		for (let i = 0; i < 5; i++) {
			insertEvent({ skillId: "skill-1", outcome: "success" });
		}
		insertEvent({ skillId: "skill-1", outcome: "failure" });
		insertEvent({ skillId: "skill-1", outcome: "success" });
		await expect(
			updateSkillEntry(db, "skill-1", { lifecycleState: "proven" }),
		).rejects.toMatchObject({ details: { rule: "proven_requires_recovery" } });
	});

	it("direct success telemetry cannot push an unrecovered failure out of the promotion window", async () => {
		const { db, insertSkill, insertEvent } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "active" });
		for (let i = 0; i < 5; i++) {
			insertEvent({ skillId: "skill-1", outcome: "success" });
		}
		insertEvent({ skillId: "skill-1", outcome: "failure" });
		for (let i = 0; i < 20; i++) {
			insertEvent({
				skillId: "skill-1",
				outcome: "success",
				source: "direct",
			});
		}
		await expect(
			updateSkillEntry(db, "skill-1", { lifecycleState: "proven" }),
		).rejects.toMatchObject({ details: { rule: "proven_requires_recovery" } });
	});

	it("allows active → proven with 5 successes and recovered failures", async () => {
		const { db, insertSkill, insertEvent, skillRow } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "active" });
		insertEvent({ skillId: "skill-1", outcome: "failure" });
		for (let i = 0; i < 5; i++) {
			insertEvent({ skillId: "skill-1", outcome: "success" });
		}
		await updateSkillEntry(db, "skill-1", { lifecycleState: "proven" });
		expect(skillRow("skill-1").lifecycleState).toBe("proven");
	});

	it("blocks direct transitions to crystallized — muscle crystallization owns that write", async () => {
		const { db, insertSkill, insertEvent, skillRow } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "proven" });
		for (let i = 0; i < 10; i++) {
			insertEvent({ skillId: "skill-1", outcome: "success" });
		}
		await expect(
			updateSkillEntry(db, "skill-1", { lifecycleState: "crystallized" }),
		).rejects.toMatchObject({ details: { rule: "crystallize_via_muscle" } });
		await updateSkillEntry(
			db,
			"skill-1",
			{ lifecycleState: "crystallized" },
			{ via: "crystallize" },
		);
		expect(skillRow("skill-1").lifecycleState).toBe("crystallized");
	});

	it("always allows demotion and archival", async () => {
		const { db, insertSkill, skillRow } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "proven" });
		await updateSkillEntry(db, "skill-1", { lifecycleState: "active" });
		expect(skillRow("skill-1").lifecycleState).toBe("active");
		await updateSkillEntry(db, "skill-1", { lifecycleState: "archived" });
		expect(skillRow("skill-1").lifecycleState).toBe("archived");
	});

	it("reviving stale/archived upward re-enters through the execution gate", async () => {
		const { db, insertSkill } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "stale" });
		await expect(
			updateSkillEntry(db, "skill-1", { lifecycleState: "active" }),
		).rejects.toBeInstanceOf(SkillLifecycleTransitionError);
	});

	it("assertSkillLifecycleTransition is a no-op for same-state writes", async () => {
		const { db, insertSkill } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "draft" });
		await expect(
			assertSkillLifecycleTransition(
				db,
				{ id: "skill-1", organizationId: "org-1", lifecycleState: "draft" },
				"draft",
			),
		).resolves.toBeUndefined();
	});
});

describe("tedi force ceiling helpers", () => {
	it("only proven and crystallized exceed the ceiling", () => {
		expect(exceedsTediForcePromotionCeiling("draft")).toBe(false);
		expect(exceedsTediForcePromotionCeiling("active")).toBe(false);
		expect(exceedsTediForcePromotionCeiling("stale")).toBe(false);
		expect(exceedsTediForcePromotionCeiling("archived")).toBe(false);
		expect(exceedsTediForcePromotionCeiling("proven")).toBe(true);
		expect(exceedsTediForcePromotionCeiling("crystallized")).toBe(true);
	});

	it("clamps above-ceiling requests to active", () => {
		expect(clampLifecycleToTediForceCeiling("draft", "crystallized")).toBe(
			"active",
		);
		expect(clampLifecycleToTediForceCeiling("active", "proven")).toBe("active");
		expect(clampLifecycleToTediForceCeiling(null, "crystallized")).toBe(
			"active",
		);
	});

	it("passes through at-or-below-ceiling requests untouched", () => {
		expect(clampLifecycleToTediForceCeiling("draft", "active")).toBe("active");
		expect(clampLifecycleToTediForceCeiling("proven", "active")).toBe("active");
		expect(clampLifecycleToTediForceCeiling("draft", "archived")).toBe(
			"archived",
		);
	});

	it("never demotes: an entry already above the ceiling keeps its state", () => {
		expect(clampLifecycleToTediForceCeiling("proven", "crystallized")).toBe(
			"proven",
		);
		expect(
			clampLifecycleToTediForceCeiling("crystallized", "crystallized"),
		).toBe("crystallized");
	});
});

describe("pace-layer auto-classification (WS6)", () => {
	it("derives the layer from lifecycle", () => {
		expect(paceLayerForLifecycle("draft")).toBe("innovation");
		expect(paceLayerForLifecycle("stale")).toBe("innovation");
		expect(paceLayerForLifecycle("archived")).toBe("innovation");
		expect(paceLayerForLifecycle(undefined)).toBe("innovation");
		expect(paceLayerForLifecycle(null)).toBe("innovation");
		expect(paceLayerForLifecycle("active")).toBe("differentiation");
		expect(paceLayerForLifecycle("proven")).toBe("differentiation");
		expect(paceLayerForLifecycle("crystallized")).toBe("record");
	});

	it("stamps innovation on newly created draft skills", async () => {
		const { db, skillRow } = fixture();
		const created = await createSkillEntry(db, {
			id: "skill-new",
			organizationId: "org-1",
			tediId: "tedi-1",
			title: "Fresh draft",
			content: "# Skill",
		});
		expect(created.paceLayer).toBe("innovation");
		expect(skillRow("skill-new").paceLayer).toBe("innovation");
	});

	it("re-derives the layer on every lifecycle transition through updateSkillEntry", async () => {
		const { db, insertSkill, insertEvent, skillRow } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "draft" });
		expect(skillRow("skill-1").paceLayer).toBe("innovation");
		insertEvent({ skillId: "skill-1", outcome: "success" });
		await updateSkillEntry(db, "skill-1", { lifecycleState: "active" });
		expect(skillRow("skill-1").paceLayer).toBe("differentiation");
		await updateSkillEntry(
			db,
			"skill-1",
			{ lifecycleState: "crystallized" },
			{ force: true, forceAuthority: { kind: "operator" } },
		);
		expect(skillRow("skill-1").paceLayer).toBe("record");
	});

	it("blocks a manual paceLayer override without the force-authority path", async () => {
		const { db, insertSkill, skillRow } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "active" });
		await expect(
			updateSkillEntry(db, "skill-1", { paceLayer: "record" }),
		).rejects.toBeInstanceOf(SkillPaceLayerOverrideError);
		expect(skillRow("skill-1").paceLayer).toBe("innovation");
		await updateSkillEntry(
			db,
			"skill-1",
			{ paceLayer: "record" },
			{ force: true },
		);
		expect(skillRow("skill-1").paceLayer).toBe("record");
	});

	it("an explicit forced override wins over auto-derivation in the same write", async () => {
		const { db, insertSkill, insertEvent, skillRow } = fixture();
		insertSkill({ id: "skill-1", lifecycleState: "draft" });
		insertEvent({ skillId: "skill-1", outcome: "success" });
		await updateSkillEntry(
			db,
			"skill-1",
			{ lifecycleState: "active", paceLayer: "record" },
			{ force: true, forceAuthority: { kind: "operator" } },
		);
		expect(skillRow("skill-1").lifecycleState).toBe("active");
		expect(skillRow("skill-1").paceLayer).toBe("record");
	});

	it("draft-TTL sweep reclassifies archived drafts as innovation", async () => {
		const { db, insertSkill, skillRow } = fixture();
		insertSkill({
			id: "skill-old",
			lifecycleState: "draft",
			updatedAt: "2026-06-01T00:00:00.000Z",
		});
		await sweepExpiredDraftSkills(db, {
			now: new Date("2026-07-16T00:00:00.000Z"),
		});
		expect(skillRow("skill-old").lifecycleState).toBe("archived");
		expect(skillRow("skill-old").paceLayer).toBe("innovation");
	});
});

describe("sweepExpiredDraftSkills", () => {
	it("archives zero-use drafts older than the TTL and appends revision reasoning", async () => {
		const { db, insertSkill, skillRow } = fixture();
		insertSkill({
			id: "skill-old",
			lifecycleState: "draft",
			updatedAt: "2026-06-01T00:00:00.000Z",
		});
		const result = await sweepExpiredDraftSkills(db, {
			now: new Date("2026-07-16T00:00:00.000Z"),
		});
		expect(result.archived).toBe(1);
		expect(result.entries[0]?.id).toBe("skill-old");
		const row = skillRow("skill-old");
		expect(row.lifecycleState).toBe("archived");
		expect(row.revision).toBe(2);
		expect(row.revisionReasoning).toContain("draft-TTL sweep");
	});

	it("skips drafts inside the TTL window, drafts with usage, and non-drafts", async () => {
		const { db, insertSkill, insertEvent, skillRow } = fixture();
		insertSkill({
			id: "skill-fresh",
			lifecycleState: "draft",
			updatedAt: "2026-07-10T00:00:00.000Z",
		});
		insertSkill({
			id: "skill-used",
			lifecycleState: "draft",
			updatedAt: "2026-06-01T00:00:00.000Z",
		});
		insertEvent({ skillId: "skill-used", outcome: "failure" });
		insertSkill({
			id: "skill-counted",
			lifecycleState: "draft",
			successCount: 2,
			updatedAt: "2026-06-01T00:00:00.000Z",
		});
		insertSkill({
			id: "skill-active",
			lifecycleState: "active",
			updatedAt: "2026-06-01T00:00:00.000Z",
		});
		const result = await sweepExpiredDraftSkills(db, {
			now: new Date("2026-07-16T00:00:00.000Z"),
		});
		expect(result.archived).toBe(0);
		expect(skillRow("skill-fresh").lifecycleState).toBe("draft");
		expect(skillRow("skill-used").lifecycleState).toBe("draft");
		expect(skillRow("skill-counted").lifecycleState).toBe("draft");
		expect(skillRow("skill-active").lifecycleState).toBe("active");
	});

	it("archives used ephemeral flow drafts after inactivity", async () => {
		const { db, insertSkill, insertEvent, skillRow } = fixture();
		insertSkill({
			id: "flow-old",
			lifecycleState: "draft",
			successCount: 1,
			lastUsedAt: "2026-06-30T00:00:00.000Z",
			tags: ["flow-ephemeral"],
		});
		insertEvent({ skillId: "flow-old", outcome: "success" });

		const result = await sweepExpiredDraftSkills(db, {
			now: new Date("2026-07-16T00:00:00.000Z"),
		});

		expect(result.entries.map((entry) => entry.id)).toContain("flow-old");
		expect(skillRow("flow-old").lifecycleState).toBe("archived");
	});

	it("keeps recently used or promoted ephemeral flows", async () => {
		const { db, insertSkill, insertEvent, skillRow } = fixture();
		insertSkill({
			id: "flow-recent",
			lifecycleState: "draft",
			failureCount: 1,
			lastUsedAt: "2026-07-15T00:00:00.000Z",
			tags: ["flow-ephemeral"],
		});
		insertEvent({ skillId: "flow-recent", outcome: "failure" });
		insertSkill({
			id: "flow-promoted",
			lifecycleState: "active",
			successCount: 1,
			lastUsedAt: "2026-06-01T00:00:00.000Z",
			tags: ["flow-ephemeral"],
		});
		insertEvent({ skillId: "flow-promoted", outcome: "success" });

		const result = await sweepExpiredDraftSkills(db, {
			now: new Date("2026-07-16T00:00:00.000Z"),
		});

		expect(result.entries).toEqual([]);
		expect(skillRow("flow-recent").lifecycleState).toBe("draft");
		expect(skillRow("flow-promoted").lifecycleState).toBe("active");
	});

	it("olderThanDays 0 purges every current zero-use draft (the one-shot)", async () => {
		const { db, insertSkill, skillRow } = fixture();
		insertSkill({
			id: "skill-recent",
			lifecycleState: "draft",
			updatedAt: "2026-07-15T23:00:00.000Z",
		});
		const result = await sweepExpiredDraftSkills(db, {
			olderThanDays: 0,
			now: new Date("2026-07-16T00:00:00.000Z"),
		});
		expect(result.archived).toBe(1);
		expect(skillRow("skill-recent").lifecycleState).toBe("archived");
	});

	it("dryRun lists candidates without archiving", async () => {
		const { db, insertSkill, skillRow } = fixture();
		insertSkill({
			id: "skill-old",
			lifecycleState: "draft",
			updatedAt: "2026-06-01T00:00:00.000Z",
		});
		const result = await sweepExpiredDraftSkills(db, {
			dryRun: true,
			now: new Date("2026-07-16T00:00:00.000Z"),
		});
		expect(result).toMatchObject({ archived: 1, dryRun: true });
		expect(skillRow("skill-old").lifecycleState).toBe("draft");
	});

	it("respects the organizationId scope", async () => {
		const { db, insertSkill, skillRow } = fixture();
		insertSkill({
			id: "skill-a",
			lifecycleState: "draft",
			organizationId: "org-1",
			updatedAt: "2026-06-01T00:00:00.000Z",
		});
		insertSkill({
			id: "skill-b",
			lifecycleState: "draft",
			organizationId: "org-2",
			updatedAt: "2026-06-01T00:00:00.000Z",
		});
		const result = await sweepExpiredDraftSkills(db, {
			organizationId: "org-2",
			now: new Date("2026-07-16T00:00:00.000Z"),
		});
		expect(result.archived).toBe(1);
		expect(skillRow("skill-a").lifecycleState).toBe("draft");
		expect(skillRow("skill-b").lifecycleState).toBe("archived");
	});
});
