import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { workItems } from "../schema/work-items";
import { createD1Facade } from "../test/d1-facade";
import {
	createPurposeCharterRevision,
	getOrganizationOwnerBrief,
	listPurposeCharterRevisions,
} from "./organization-purpose";
import { createObjective } from "./tedi-objectives";
import { createWorkItem } from "./work-items/crud";

const DDL = `
CREATE TABLE organization_purpose_charters (
 id TEXT PRIMARY KEY NOT NULL, org_id TEXT NOT NULL, version INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'active', purpose TEXT NOT NULL,
 principles TEXT NOT NULL DEFAULT '[]', strategic_theses TEXT NOT NULL DEFAULT '[]',
 non_goals TEXT NOT NULL DEFAULT '[]', evidence_refs TEXT NOT NULL DEFAULT '[]',
 review_cadence_days INTEGER NOT NULL DEFAULT 30, revision_reason TEXT NOT NULL,
 created_by_user_id TEXT, created_at TEXT NOT NULL, activated_at TEXT NOT NULL,
 superseded_at TEXT
);
CREATE UNIQUE INDEX uniq_org_purpose_version ON organization_purpose_charters (org_id, version);
CREATE UNIQUE INDEX uniq_org_purpose_active ON organization_purpose_charters (org_id) WHERE status = 'active';
CREATE TABLE tedi_objectives (
 id TEXT PRIMARY KEY NOT NULL, tedi_id TEXT NOT NULL, org_id TEXT NOT NULL,
 purpose_charter_id TEXT, title TEXT NOT NULL, description TEXT, approach TEXT,
 success_criteria TEXT, constraints TEXT, type TEXT NOT NULL DEFAULT 'standing',
 status TEXT NOT NULL DEFAULT 'active', risk_level TEXT NOT NULL DEFAULT 'medium',
 priority INTEGER NOT NULL DEFAULT 0, linked_domains TEXT DEFAULT '[]',
 gate_config TEXT DEFAULT '{}', budget_config TEXT DEFAULT '{}', progress TEXT DEFAULT '{}',
 created_at TEXT NOT NULL, updated_at TEXT, completed_at TEXT
);
CREATE TABLE work_items (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
 disposition TEXT NOT NULL DEFAULT 'proposed', work_kind TEXT NOT NULL DEFAULT 'other', risk_level TEXT NOT NULL DEFAULT 'medium', acceptance_contract TEXT,
 required_capabilities TEXT NOT NULL DEFAULT '[]', required_authorities TEXT NOT NULL DEFAULT '[]', admission_spec_revision TEXT NOT NULL DEFAULT 'test-revision',
 priority TEXT NOT NULL DEFAULT 'medium', accountable_owner_type TEXT, accountable_owner_id TEXT, steward_type TEXT, steward_id TEXT, reviewer_type TEXT, reviewer_id TEXT, reviewer_lease_expires_at TEXT,
 objective_id TEXT, work_class TEXT, purpose_exception_expires_at TEXT, project_id TEXT, parent_work_item_id TEXT, source_session_key TEXT, source_intent_id TEXT, due_date TEXT, deadline TEXT, start_at TEXT, duration_days INTEGER,
 provenance TEXT DEFAULT '{}', metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT, accepted_at TEXT, completed_at TEXT, cancelled_at TEXT, version INTEGER NOT NULL DEFAULT 1, UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX uniq_work_items_org_source_intent ON work_items (org_id, source_intent_id);
`;

function fixture(): DbClient {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	return createDbClient(createD1Facade(sqlite));
}

const ORG = "org-1";
const NOW = "2026-07-19T08:00:00.000Z";
// ACTIVE purpose-exception expiry anchored to the fixture clock (NOW+5d): the
// brief is evaluated with an explicit `now: NOW`, never the wall clock, so the
// active-vs-expired branch stays deterministic (wall-clock-relative class: see
// work-items-selection.test.ts T_BASE note).
const ACTIVE_EXPIRY = new Date(
	Date.parse(NOW) + 5 * 24 * 60 * 60 * 1000,
).toISOString();

async function charter(db: DbClient, id: string, purpose: string) {
	return createPurposeCharterRevision(db, {
		id,
		orgId: ORG,
		purpose,
		revisionReason: `activate ${id}`,
		createdAt: NOW,
	});
}

describe("organization purpose", () => {
	it("surfaces marketing results without turning weak outcomes into owner blockers", async () => {
		const db = fixture();
		await db.insert(workItems).values([
			{
				id: "evaluation-zero",
				orgId: ORG,
				title: "Evaluate durable worker guide after 7 days",
				disposition: "completed",
				priority: "high",
				objectiveId: "objective-marketing",
				metadata: {
					marketingEvaluation: {
						version: 1,
						kind: "checkpoint",
						windowDays: 7,
						notBefore: "2026-07-18T08:00:00.000Z",
						result: {
							status: "zero",
							metrics: { searchClicks: 0, signups: 0 },
							qualifiedDemandCount: 0,
							summary: "No attributable movement yet.",
						},
						review: {
							version: 1,
							accepted: true,
							reviewerType: "tedi",
							reviewerId: "ceo",
						},
					},
				},
				createdAt: "2026-07-18T08:00:00.000Z",
				updatedAt: NOW,
				completedAt: NOW,
			},
			{
				id: "evaluation-pending-review",
				orgId: ORG,
				title: "Review proposed day-90 outcome",
				disposition: "proposed",
				priority: "medium",
				objectiveId: "objective-marketing",
				metadata: {
					marketingEvaluation: {
						version: 1,
						kind: "checkpoint",
						windowDays: 90,
						notBefore: "2026-07-18T08:00:00.000Z",
						result: {
							status: "observed",
							metrics: { signups: 1 },
							qualifiedDemandCount: 0,
							summary: "One attributable signup is pending review.",
						},
					},
				},
				createdAt: "2026-07-18T08:00:00.000Z",
				updatedAt: NOW,
			},
			{
				id: "evaluation-due",
				orgId: ORG,
				title: "Evaluate category page after 28 days",
				disposition: "proposed",
				priority: "medium",
				objectiveId: "objective-marketing",
				metadata: {
					marketingEvaluation: {
						version: 1,
						kind: "checkpoint",
						windowDays: 28,
						notBefore: NOW,
					},
				},
				createdAt: "2026-07-18T08:00:00.000Z",
			},
		]);

		const brief = await getOrganizationOwnerBrief(db, { orgId: ORG, now: NOW });
		expect(brief.needsJudgment).toEqual([]);
		expect(brief.outcomes.map((item) => item.reason)).toEqual(
			expect.arrayContaining([
				expect.stringContaining("Day 7: zero"),
				expect.stringContaining("Day 28: not reviewed"),
				expect.stringContaining(
					"Day 90: proposed observed, awaiting independent review",
				),
			]),
		);
		expect(brief.outcomes.every((item) => item.blocking === false)).toBe(true);
		expect(
			brief.outcomes.find((item) => item.id === "evaluation-zero")?.reason,
		).toContain("Day 7: zero");
	});

	it("counts an exception at the exact expiry boundary only as expired", async () => {
		const db = fixture();
		await db.insert(workItems).values({
			id: "expiry-boundary",
			orgId: ORG,
			title: "expiry-boundary",
			disposition: "accepted",
			workClass: "incident",
			purposeExceptionExpiresAt: NOW,
			createdAt: "2026-07-19T07:00:00.000Z",
		});
		const brief = await getOrganizationOwnerBrief(db, { orgId: ORG, now: NOW });
		expect(brief.drift.activeOperationalExceptionCount).toBe(0);
		expect(brief.drift.expiredOperationalExceptionCount).toBe(1);
	});
	it("preserves revision history and leaves one active charter", async () => {
		const db = fixture();
		await charter(
			db,
			"charter-1",
			"Give teams durable workers they can own and steer.",
		);
		await createPurposeCharterRevision(db, {
			id: "charter-2",
			orgId: ORG,
			purpose:
				"Give organizations governed workers that compound useful outcomes.",
			principles: ["Evidence before claims"],
			revisionReason: "sharpen ownership",
			createdAt: "2026-07-20T08:00:00.000Z",
		});

		const revisions = await listPurposeCharterRevisions(db, ORG);
		expect(revisions.map((row) => [row.id, row.version, row.status])).toEqual([
			["charter-2", 2, "active"],
			["charter-1", 1, "superseded"],
		]);
	});

	it("backfills legacy objectives, links new objectives, and returns a bounded owner brief", async () => {
		const db = fixture();
		const legacyObjective = await createObjective(db, {
			id: "objective-legacy",
			tediId: "tedi-1",
			orgId: ORG,
			title: "Preserve existing direction",
			type: "standing",
			createdAt: NOW,
		});
		expect(legacyObjective.purposeCharterId).toBeNull();
		await charter(
			db,
			"charter-1",
			"Give teams durable workers they can own and steer.",
		);
		const backfilled = await db.query.tediObjectives.findFirst({
			where: (table, { eq }) => eq(table.id, legacyObjective.id),
		});
		expect(backfilled?.purposeCharterId).toBe("charter-1");
		const objective = await createObjective(db, {
			id: "objective-1",
			tediId: "tedi-1",
			orgId: ORG,
			title: "Prove owner value",
			type: "standing",
			createdAt: NOW,
		});
		expect(objective.purposeCharterId).toBe("charter-1");

		await createWorkItem(db, {
			id: "review-1",
			orgId: ORG,
			title: "Choose the category promise",
			priority: "high",
			objectiveId: objective.id,
			sourceIntentId: "review-1",
			metadata: {
				ownerAttention: {
					requiresOwner: true,
					question: "Which category promise best matches your product taste?",
				},
			},
			createdAt: NOW,
		});
		await createWorkItem(db, {
			id: "review-noise",
			orgId: ORG,
			title: "Review routine execution evidence",
			priority: "critical",
			objectiveId: objective.id,
			sourceIntentId: "review-noise",
			createdAt: NOW,
		});
		await createWorkItem(db, {
			id: "blocked-1",
			orgId: ORG,
			title: "Restore owner brief truth",
			priority: "critical",
			workClass: "incident",
			purposeExceptionExpiresAt: ACTIVE_EXPIRY,
			sourceIntentId: "blocked-1",
			createdAt: NOW,
		});
		await createWorkItem(db, {
			id: "done-1",
			orgId: ORG,
			title: "Validate buyer evidence",
			priority: "medium",
			objectiveId: objective.id,
			sourceIntentId: "done-1",
			createdAt: NOW,
		});
		await db
			.update(workItems)
			.set({ disposition: "accepted", acceptedAt: NOW, updatedAt: NOW })
			.where(eq(workItems.id, "review-1"));
		await db
			.update(workItems)
			.set({ disposition: "accepted", acceptedAt: NOW, updatedAt: NOW })
			.where(eq(workItems.id, "review-noise"));
		await db
			.update(workItems)
			.set({ disposition: "accepted", acceptedAt: NOW, updatedAt: NOW })
			.where(eq(workItems.id, "blocked-1"));
		await db
			.update(workItems)
			.set({ disposition: "completed", updatedAt: NOW, completedAt: NOW })
			.where(eq(workItems.id, "done-1"));

		const brief = await getOrganizationOwnerBrief(db, { orgId: ORG, now: NOW });
		expect(brief.needsJudgment.map((item) => item.id)).toEqual(["review-1"]);
		expect(brief.needsJudgment[0]?.reason).toBe(
			"Which category promise best matches your product taste?",
		);
		expect(brief.exceptions.map((item) => item.id)).toEqual(["blocked-1"]);
		expect(brief.outcomes.map((item) => item.id)).toEqual(["done-1"]);
		expect(brief.drift).toMatchObject({
			severity: "watch",
			activeObjectiveCount: 2,
			unlinkedObjectiveCount: 0,
			openWorkCount: 3,
			unlinkedOpenWorkCount: 1,
			activeOperationalExceptionCount: 1,
			expiredOperationalExceptionCount: 0,
			legacyUnclassifiedOpenWorkCount: 0,
		});
	});
});
