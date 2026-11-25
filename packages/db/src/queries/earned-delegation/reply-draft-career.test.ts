import { entrustableActivities } from "../../schema/earned-delegation";
import {
	type CompetencyCareerLadder,
	EvidencePolicySchema,
} from "@tedix/api-contract/schemas/earned-delegation";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { createEntrustableActivity } from "./activities";
import {
	evaluateCareerLadder,
	getReplyDraftingActivity,
	readReplyDraftingConfig,
	stoodStreakDays,
} from "./reply-draft-career";

const LADDER: CompetencyCareerLadder = {
	version: 1,
	promotion: { stood: 25, minStandingRate: 0.9 },
	demotion: { windowDays: 7, minDecided: 5, belowStandingRate: 0.7 },
	maximumStage: "specialist",
	autoSettleMinutes: 60,
};
const SEED = {
	ladder: LADDER,
	initialRole: { key: "reply_drafter", name: "Reply drafter" },
};
const NOW = "2026-08-21T12:00:00.000Z";

function seed() {
	const sqlite = createMigratedSqlite();
	sqlite.exec(`
		INSERT INTO organizations(id,name,slug) VALUES('org','Org','org');
		INSERT INTO users(id,email) VALUES('user','user@example.com');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status) VALUES('member','org','user','user','user@example.com','active');
		INSERT INTO work_items(id,org_id,title,disposition,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES('work','org','Work','completed','hygiene','2026-09-01T00:00:00.000Z','revision-1','2026-08-20T00:00:00.000Z');
		INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('drafter','org','Drafter','drafter','active');
	`);
	return { sqlite, db: createDbClient(createD1Facade(sqlite)) };
}

function seedActivity(db: ReturnType<typeof seed>["db"]) {
	return createEntrustableActivity(db, {
		organizationId: null,
		key: "reply_drafting",
		version: 1,
		name: "Reply drafting",
		taskFamily: "reply_drafting",
		riskLevel: "low",
		maximumLevel: "recommend",
		actionPatterns: ["agentTurnTriage.proposeReplyDraft"],
		toolIds: [],
		rubric: { careerLadder: LADDER, initialRole: SEED.initialRole },
		evidencePolicy: EvidencePolicySchema.parse({}),
		now: NOW,
	});
}

describe("reply-draft career ladder", () => {
	it("promotes one stage after enough replies stand at the required rate", () => {
		const counts = {
			stood: 25,
			corrected: 2,
			windowStood: 0,
			windowCorrected: 0,
		};
		expect(evaluateCareerLadder(LADDER, "shadow", counts)).toEqual({
			stage: "shadow",
			nextStage: "apprentice",
			target: 25,
			change: { kind: "promote", to: "apprentice" },
		});
		expect(
			evaluateCareerLadder(LADDER, "shadow", { ...counts, corrected: 3 })
				.change,
		).toBeNull();
		expect(evaluateCareerLadder(LADDER, "specialist", counts)).toMatchObject({
			nextStage: null,
			target: null,
			change: null,
		});
	});

	it("demotes after a bad window but never below the first stage", () => {
		const bad = { stood: 3, corrected: 3, windowStood: 3, windowCorrected: 3 };
		expect(evaluateCareerLadder(LADDER, "operator", bad).change).toEqual({
			kind: "demote",
			to: "apprentice",
		});
		expect(evaluateCareerLadder(LADDER, "shadow", bad).change).toBeNull();
		expect(
			evaluateCareerLadder(LADDER, "operator", {
				...bad,
				windowStood: 2,
				windowCorrected: 2,
			}).change,
		).toBeNull();
	});

	it("counts a streak ending today or yesterday", () => {
		const days = new Set(["2026-08-19", "2026-08-20", "2026-08-21"]);
		expect(stoodStreakDays(days, NOW)).toBe(3);
		expect(stoodStreakDays(days, "2026-08-22T08:00:00.000Z")).toBe(3);
		expect(stoodStreakDays(days, "2026-08-23T08:00:00.000Z")).toBe(0);
	});
});

it("does not resurrect older or platform policy behind a retired or malformed organization head", async () => {
	const { db, sqlite } = seed();
	const platform = await seedActivity(db);
	await db.insert(entrustableActivities).values({
		...platform,
		id: "tenant-ladder-v1",
		organizationId: "org",
		version: 1,
	});
	await db.insert(entrustableActivities).values({
		...platform,
		id: "tenant-ladder-v2",
		organizationId: "org",
		version: 2,
		status: "retired",
	});
	expect(await getReplyDraftingActivity(db, "org")).toBeNull();
	sqlite.exec(
		"UPDATE entrustable_activities SET status='retired' WHERE id='tenant-ladder-v1'",
	);
	await db.insert(entrustableActivities).values({
		...platform,
		id: "tenant-ladder-v3",
		organizationId: "org",
		version: 3,
		status: "active",
		rubric: {},
	});
	const malformed = await getReplyDraftingActivity(db, "org");
	expect(malformed?.id).toBe("tenant-ladder-v3");
	expect(readReplyDraftingConfig(malformed!)).toBeNull();
	expect((await getReplyDraftingActivity(db, "other-org"))?.id).toBe(
		platform.id,
	);
});
it("does not resurrect an older platform policy behind its retired head", async () => {
	const { db } = seed();
	const platform = await seedActivity(db);
	await db.insert(entrustableActivities).values({
		...platform,
		id: "platform-ladder-v2",
		version: 2,
		status: "retired",
	});
	expect(await getReplyDraftingActivity(db, "org")).toBeNull();
});
