import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { CompetencyCareerLadder } from "@tedix/api-contract/schemas/earned-delegation";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { respondToWorkInteraction } from "../work-items/interactions";
import {
	insertReplyDraft,
	listUnrecordedReplyDraftOutcomes,
} from "../work-items/reply-drafts";
import {
	applyReplyDraftCareerChange,
	ensureReplyDraftingActivity,
	ensureReplyDraftRole,
	evaluateCareerLadder,
	loadReplyDraftCareers,
	readReplyDraftingConfig,
	recordReplyDraftObservations,
	stoodStreakDays,
} from "./reply-draft-career";

const migrationRoot = new URL("../../../drizzle/", import.meta.url);
const migrations = readdirSync(migrationRoot)
	.sort()
	.map((name) =>
		readFileSync(new URL(`${name}/migration.sql`, migrationRoot), "utf8"),
	);

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
const QUIET = {
	schema: "tedix.decision-capture.v1",
	triage: { status: "ok", urgency: "later", labels: {}, urgentLabels: [] },
};
const NOW = "2026-08-21T12:00:00.000Z";

function seed() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=ON");
	for (const sqlText of migrations) sqlite.exec(sqlText);
	sqlite.exec(`
		INSERT INTO organizations(id,name,slug) VALUES('org','Org','org');
		INSERT INTO users(id,email) VALUES('user','user@example.com');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status) VALUES('member','org','user','user','user@example.com','active');
		INSERT INTO work_items(id,org_id,title,disposition,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES('work','org','Work','completed','hygiene','2026-09-01T00:00:00.000Z','revision-1','2026-08-20T00:00:00.000Z');
		INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('drafter','org','Drafter','drafter','active');
	`);
	return { sqlite, db: createDbClient(createD1Facade(sqlite)) };
}

/** A review draft on its own question, answered with `outcome`. */
async function answeredDraft(
	sqlite: DatabaseSync,
	db: ReturnType<typeof seed>["db"],
	index: number,
	outcome: "accepted" | "edited",
) {
	const at = new Date(
		Date.parse("2026-08-20T00:00:00.000Z") + index * 60_000,
	).toISOString();
	sqlite
		.prepare(
			"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,metadata) VALUES(?,'org','work','question','Question','Answer?','system','tedix','user','user',?,?)",
		)
		.run(`q${index}`, at, JSON.stringify(QUIET));
	await insertReplyDraft(db, {
		id: `d${index}`,
		orgId: "org",
		interactionId: `q${index}`,
		drafterId: "drafter",
		body: "Ship it.",
		rationale: "Matches the plan.",
		now: at,
	});
	await respondToWorkInteraction(db, {
		id: `r${index}`,
		orgId: "org",
		interactionId: `q${index}`,
		expectedVersion: 1,
		responder: { type: "user", id: "user" },
		responseKind: "answer",
		body: "Answer",
		resolvesRequest: true,
		metadata: { draftId: `d${index}`, draftOutcome: outcome, editRatio: 0 },
		now: at,
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

	it("records settled drafts once and promotes through an applied decision", async () => {
		const { sqlite, db } = seed();
		for (let index = 0; index < 26; index++)
			await answeredDraft(
				sqlite,
				db,
				index,
				index === 0 ? "edited" : "accepted",
			);
		const listParams = {
			since: "2026-08-01T00:00:00.000Z",
			settledBefore: "2026-08-21T11:00:00.000Z",
			limit: 500,
		};
		const outcomes = await listUnrecordedReplyDraftOutcomes(db, listParams);
		expect(outcomes).toHaveLength(26);
		expect(outcomes[0]).toMatchObject({
			draftId: "d0",
			drafterId: "drafter",
			targetUserId: "user",
			verdict: "corrected",
		});

		const activity = await ensureReplyDraftingActivity(db, "org", SEED, NOW);
		expect(activity.organizationId).toBeNull();
		expect(readReplyDraftingConfig(activity)).toEqual(SEED);
		await recordReplyDraftObservations(db, { activity, outcomes, now: NOW });
		await recordReplyDraftObservations(db, { activity, outcomes, now: NOW });
		expect(await listUnrecordedReplyDraftOutcomes(db, listParams)).toEqual([]);

		await ensureReplyDraftRole(db, {
			organizationId: "org",
			tediId: "drafter",
			role: SEED.initialRole,
			now: NOW,
		});
		const load = () =>
			loadReplyDraftCareers(db, {
				organizationId: "org",
				activityId: activity.id,
				tediIds: ["drafter"],
				windowDays: 7,
				now: NOW,
			});
		const state = (await load()).get("drafter")!;
		expect(state.assignment?.careerStage).toBe("shadow");
		expect(state.stoodIds).toHaveLength(25);
		expect(state.correctedIds).toHaveLength(1);
		expect(stoodStreakDays(state.stoodDays, NOW)).toBe(1);

		const evaluation = evaluateCareerLadder(LADDER, "shadow", {
			stood: 25,
			corrected: 1,
			windowStood: 25,
			windowCorrected: 1,
		});
		expect(evaluation.change).toEqual({ kind: "promote", to: "apprentice" });
		expect(
			await applyReplyDraftCareerChange(db, {
				assignment: state.assignment!,
				kind: "promote",
				to: "apprentice",
				evidenceObservationIds: state.stoodIds,
				snapshot: { stood: 25 },
				now: NOW,
			}),
		).toBe(true);
		// The stale assignment no longer matches: nothing changes twice.
		expect(
			await applyReplyDraftCareerChange(db, {
				assignment: state.assignment!,
				kind: "promote",
				to: "apprentice",
				evidenceObservationIds: state.stoodIds,
				snapshot: { stood: 25 },
				now: NOW,
			}),
		).toBe(false);

		const promoted = (await load()).get("drafter")!;
		expect(promoted.assignment).toMatchObject({
			careerStage: "apprentice",
			revision: 2,
		});
		// Progress restarts at the new stage.
		expect(promoted.stoodIds).toEqual([]);
		const decisions = sqlite
			.prepare(
				"SELECT kind, status, from_career_stage, to_career_stage FROM promotion_decisions ORDER BY created_at, status",
			)
			.all();
		expect(decisions).toEqual([
			{
				kind: "promote",
				status: "applied",
				from_career_stage: "shadow",
				to_career_stage: "apprentice",
			},
		]);
	});
});
