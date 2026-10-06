import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { respondToWorkInteraction } from "./interactions";
import {
	getLatestReplyDraft,
	getReplyDraftAcceptance,
	insertReplyDraft,
} from "./reply-drafts";

const migrationRoot = new URL("../../../drizzle/", import.meta.url);
const migrations = readdirSync(migrationRoot)
	.sort()
	.map((name) =>
		readFileSync(new URL(`${name}/migration.sql`, migrationRoot), "utf8"),
	);
function migrated() {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys=ON");
	for (const sqlText of migrations) db.exec(sqlText);
	return db;
}

const CREATED = "2026-08-20T00:00:00.000Z";
const NOW = "2026-08-20T01:00:00.000Z";
const QUIET = {
	schema: "tedix.decision-capture.v1",
	triage: { status: "ok", urgency: "later", labels: {}, urgentLabels: [] },
};

function seed() {
	const sqlite = migrated();
	sqlite.exec(`
		INSERT INTO organizations(id,name,slug) VALUES('org','Org','org');
		INSERT INTO organizations(id,name,slug) VALUES('foreign','Foreign','foreign');
		INSERT INTO users(id,email) VALUES('user','user@example.com');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status) VALUES('member','org','user','user','user@example.com','active');
		INSERT INTO work_items(id,org_id,title,disposition,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES('work','org','Work','completed','hygiene','2026-09-01T00:00:00.000Z','revision-1','${CREATED}');
		INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('drafter','org','Drafter','drafter','active');
		INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('retired','org','Retired','retired','active');
		UPDATE tedis SET retired_at='${CREATED}' WHERE id='retired';
		INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('alien','foreign','Alien','alien','active');
	`);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

function question(
	sqlite: DatabaseSync,
	id: string,
	{
		metadata = QUIET as Record<string, unknown>,
		kind = "question",
		targetType = "user",
		targetId = "user",
		expiresAt = null as string | null,
	} = {},
) {
	sqlite
		.prepare(
			"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,expires_at,metadata) VALUES(?,'org','work',?,'Question','Answer?','system','tedix',?,?,?,?,?)",
		)
		.run(
			id,
			kind,
			targetType,
			targetId,
			CREATED,
			expiresAt,
			JSON.stringify(metadata),
		);
}

const draft = (
	overrides: Partial<Parameters<typeof insertReplyDraft>[1]> = {},
) => ({
	id: "draft-1",
	orgId: "org",
	interactionId: "q1",
	drafterId: "drafter",
	body: "Ship it after the migration check passes.",
	rationale: "Matches the board priority and earlier approvals.",
	turnType: "approval",
	now: NOW,
	...overrides,
});

describe("work interaction reply drafts (migrated D1 triggers)", () => {
	it("appends drafts and reads the latest one", async () => {
		const { sqlite, db } = seed();
		question(sqlite, "q1");
		await insertReplyDraft(db, draft());
		await insertReplyDraft(
			db,
			draft({ id: "draft-2", body: "Second", now: "2026-08-20T01:05:00.000Z" }),
		);
		expect(
			await getLatestReplyDraft(db, { orgId: "org", interactionId: "q1" }),
		).toMatchObject({ id: "draft-2", body: "Second", drafterType: "tedi" });
		expect(
			await getLatestReplyDraft(db, { orgId: "foreign", interactionId: "q1" }),
		).toBeNull();
	});

	it.each([
		[
			"urgent now",
			{ metadata: { ...QUIET, triage: { ...QUIET.triage, urgency: "now" } } },
		],
		[
			"urgent labels",
			{
				metadata: {
					...QUIET,
					triage: { ...QUIET.triage, urgentLabels: ["risky_action"] },
				},
			},
		],
		[
			"triage unavailable",
			{
				metadata: {
					...QUIET,
					triage: { ...QUIET.triage, status: "unavailable" },
				},
			},
		],
		["untriaged", { metadata: { schema: QUIET.schema } }],
		["other schema", { metadata: { ...QUIET, schema: "other" } }],
		["not a question", { kind: "input" }],
		["tedi target", { targetType: "tedi", targetId: "drafter" }],
		["expired", { expiresAt: "2026-08-20T00:30:00.000Z" }],
	])("never drafts for a %s interaction", async (_label, shape) => {
		const { sqlite, db } = seed();
		question(sqlite, "q1", shape as Parameters<typeof question>[2]);
		await expect(insertReplyDraft(db, draft())).rejects.toThrow(/NOT_ELIGIBLE/);
	});

	it("never drafts for a resolved or missing question", async () => {
		const { sqlite, db } = seed();
		question(sqlite, "q1");
		await respondToWorkInteraction(db, {
			id: "reply",
			orgId: "org",
			interactionId: "q1",
			expectedVersion: 1,
			responder: { type: "user", id: "user" },
			responseKind: "answer",
			body: "Done",
			resolvesRequest: true,
			now: NOW,
		});
		await expect(insertReplyDraft(db, draft())).rejects.toThrow(/NOT_ELIGIBLE/);
		await expect(
			insertReplyDraft(db, draft({ interactionId: "missing" })),
		).rejects.toThrow();
	});

	it.each(["retired", "alien", "missing"])(
		"rejects drafter %s",
		async (drafterId) => {
			const { sqlite, db } = seed();
			question(sqlite, "q1");
			await expect(insertReplyDraft(db, draft({ drafterId }))).rejects.toThrow(
				/INVALID_PRINCIPAL/,
			);
		},
	);

	it("rejects oversized bodies and keeps drafts immutable", async () => {
		const { sqlite, db } = seed();
		question(sqlite, "q1");
		await expect(
			insertReplyDraft(db, draft({ body: "x".repeat(6001) })),
		).rejects.toThrow();
		await insertReplyDraft(db, draft());
		expect(() =>
			sqlite.exec("UPDATE work_interaction_reply_drafts SET body='changed'"),
		).toThrow(/reply drafts are immutable/);
		expect(() =>
			sqlite.exec("DELETE FROM work_interaction_reply_drafts"),
		).toThrow(/reply drafts are immutable/);
	});

	it("measures acceptance per turn type from cited responses", async () => {
		const { sqlite, db } = seed();
		const outcomes: Array<[string, string | null, string | null]> = [
			["q1", "approval", "accepted"],
			["q2", "approval", "accepted"],
			["q3", "approval", "edited"],
			["q4", "status", "replaced"],
			["q5", "status", null],
			["q6", null, "accepted"],
		];
		for (const [id, turnType, outcome] of outcomes) {
			question(sqlite, id);
			await insertReplyDraft(
				db,
				draft({ id: `d-${id}`, interactionId: id, turnType }),
			);
			if (outcome)
				await respondToWorkInteraction(db, {
					id: `r-${id}`,
					orgId: "org",
					interactionId: id,
					expectedVersion: 1,
					responder: { type: "user", id: "user" },
					responseKind: "answer",
					body: "Answer",
					resolvesRequest: true,
					metadata: { draftId: `d-${id}`, draftOutcome: outcome, editRatio: 0 },
					now: "2026-08-20T02:00:00.000Z",
				});
		}
		const rows = await getReplyDraftAcceptance(
			db,
			{ orgId: "org", targetUserId: "user" },
			{ minRate: 0.6, minDrafts: 3 },
		);
		expect(rows).toEqual([
			{
				turnType: "approval",
				drafts: 3,
				decided: 3,
				accepted: 2,
				edited: 1,
				replaced: 0,
				rate: 2 / 3,
				eligible: true,
			},
			{
				turnType: "status",
				drafts: 2,
				decided: 1,
				accepted: 0,
				edited: 0,
				replaced: 1,
				rate: 0,
				eligible: false,
			},
			{
				turnType: null,
				drafts: 1,
				decided: 1,
				accepted: 1,
				edited: 0,
				replaced: 0,
				rate: 1,
				eligible: false,
			},
		]);
		expect(
			await getReplyDraftAcceptance(
				db,
				{
					orgId: "org",
					targetUserId: "user",
					since: "2026-08-20T03:00:00.000Z",
				},
				{ minRate: 0.6, minDrafts: 3 },
			),
		).toEqual([]);
		expect(
			await getReplyDraftAcceptance(
				db,
				{ orgId: "org", targetUserId: "someone-else" },
				{ minRate: 0.6, minDrafts: 3 },
			),
		).toEqual([]);
	});
});
