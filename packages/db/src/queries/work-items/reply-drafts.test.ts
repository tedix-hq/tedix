import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { listUndeliveredWorkInteractionResponses } from "./interaction-deliveries";
import { respondToWorkInteraction } from "./interactions";
import {
	countConsecutiveAutoReplies,
	getLatestReplyDraft,
	getReplyDraftAcceptance,
	getReplyDraftLeaderboard,
	insertReplyDraft,
	recordAutoReplyDelivery,
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
		createdAt = CREATED,
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
			createdAt,
			expiresAt,
			JSON.stringify(metadata),
		);
}

const NO_AUTO = {
	autoSent: 0,
	autoFollowedUp: 0,
	overridden: 0,
	overrideRate: 0,
};

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

	it("stores the delivery-gate audit without disturbing the draft triggers", async () => {
		const { sqlite, db } = seed();
		question(sqlite, "q1");
		const gate = {
			status: "fail",
			model: "@cf/cloudflare/clef-flash",
			checks: [{ id: "needs_human", p: 0.9, pass: false }],
			latencyMs: 12,
		};
		await insertReplyDraft(db, draft({ gate }));
		await insertReplyDraft(
			db,
			draft({ id: "draft-0", now: "2026-08-20T00:59:00.000Z" }),
		);
		expect(
			await getLatestReplyDraft(db, { orgId: "org", interactionId: "q1" }),
		).toMatchObject({ id: "draft-1", gate });
		expect(
			sqlite
				.prepare(
					"SELECT gate FROM work_interaction_reply_drafts WHERE id='draft-0'",
				)
				.get(),
		).toEqual({ gate: null });
		// The ADD COLUMN kept the insert guard and immutability triggers.
		expect(() =>
			sqlite.exec("UPDATE work_interaction_reply_drafts SET gate=NULL"),
		).toThrow(/reply drafts are immutable/);
		question(sqlite, "q2", {
			metadata: { ...QUIET, triage: { ...QUIET.triage, urgency: "now" } },
		});
		await expect(
			insertReplyDraft(db, draft({ id: "draft-x", interactionId: "q2", gate })),
		).rejects.toThrow(/NOT_ELIGIBLE/);
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
				...NO_AUTO,
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
				...NO_AUTO,
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
				...NO_AUTO,
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

	it("defaults delivery to review and rejects unknown deliveries", async () => {
		const { sqlite, db } = seed();
		question(sqlite, "q1");
		expect(await insertReplyDraft(db, draft())).toMatchObject({
			delivery: "review",
		});
		expect(
			await insertReplyDraft(
				db,
				draft({
					id: "draft-2",
					delivery: "auto",
					now: "2026-08-20T01:01:00.000Z",
				}),
			),
		).toMatchObject({ delivery: "auto" });
		expect(() =>
			sqlite.exec(
				`INSERT INTO work_interaction_reply_drafts(id,org_id,interaction_id,drafter_type,drafter_id,body,rationale,delivery,created_at) VALUES('draft-3','org','q1','tedi','drafter','b','r','send','${NOW}')`,
			),
		).toThrow(/CHECK constraint failed/);
		// The insert guard survives the additive column: urgent questions still
		// refuse an auto draft.
		question(sqlite, "q2", {
			metadata: { ...QUIET, triage: { ...QUIET.triage, urgency: "now" } },
		});
		await expect(
			insertReplyDraft(
				db,
				draft({ id: "draft-4", interactionId: "q2", delivery: "auto" }),
			),
		).rejects.toThrow(/NOT_ELIGIBLE/);
		expect(() =>
			sqlite.exec(
				"UPDATE work_interaction_reply_drafts SET delivery='auto' WHERE id='draft-1'",
			),
		).toThrow(/reply drafts are immutable/);
	});
});

describe("consecutive auto replies per session", () => {
	const SESSION = { ...QUIET, sessionId: "session-a" };
	const at = (minute: number) =>
		`2026-08-20T00:${String(minute).padStart(2, "0")}:00.000Z`;

	async function turn(
		sqlite: DatabaseSync,
		db: ReturnType<typeof seed>["db"],
		index: number,
		{
			delivery = "auto" as "auto" | "review" | null,
			userReply = false,
			metadata = SESSION as Record<string, unknown>,
		} = {},
	) {
		const id = `q${index}`;
		question(sqlite, id, { metadata, createdAt: at(index) });
		if (delivery)
			await insertReplyDraft(
				db,
				draft({ id: `d${index}`, interactionId: id, delivery, now: at(index) }),
			);
		if (userReply)
			await respondToWorkInteraction(db, {
				id: `r${index}`,
				orgId: "org",
				interactionId: id,
				expectedVersion: 1,
				responder: { type: "user", id: "user" },
				responseKind: "answer",
				body: "Keep going",
				resolvesRequest: true,
				metadata: { source: "user-reply", sessionId: "session-a" },
				now: at(index),
			});
	}

	const count = (db: ReturnType<typeof seed>["db"], index: number, limit = 3) =>
		countConsecutiveAutoReplies(db, {
			orgId: "org",
			interactionId: `q${index}`,
			targetUserId: "user",
			sessionId: "session-a",
			createdAt: at(index),
			limit,
		});

	it("counts auto drafts back to the last user reply or review draft", async () => {
		const { sqlite, db } = seed();
		await turn(sqlite, db, 1, { delivery: "review" });
		await turn(sqlite, db, 2);
		await turn(sqlite, db, 3);
		await turn(sqlite, db, 4);
		await turn(sqlite, db, 5, { delivery: null });
		expect(await count(db, 2)).toBe(0);
		expect(await count(db, 4)).toBe(2);
		expect(await count(db, 5, 10)).toBe(3);
		expect(await count(db, 5, 2)).toBe(2);
		expect(await count(db, 5, 0)).toBe(0);
	});

	it("resets after a user reply and ignores other sessions and users", async () => {
		const { sqlite, db } = seed();
		await turn(sqlite, db, 1);
		await turn(sqlite, db, 2);
		await turn(sqlite, db, 3, { userReply: true });
		await turn(sqlite, db, 4, {
			metadata: { ...QUIET, sessionId: "session-b" },
		});
		await turn(sqlite, db, 5);
		await turn(sqlite, db, 6, { delivery: null });
		// q3 had an auto draft but the user answered it: the walk stops there.
		expect(await count(db, 6)).toBe(1);
		expect(
			await countConsecutiveAutoReplies(db, {
				orgId: "org",
				interactionId: "q6",
				targetUserId: "someone-else",
				sessionId: "session-a",
				createdAt: at(6),
				limit: 3,
			}),
		).toBe(0);
	});
});

describe("auto-send acceptance metrics", () => {
	const SESSION = { ...QUIET, sessionId: "session-a" };
	const at = (minute: number) =>
		`2026-08-20T00:${String(minute).padStart(2, "0")}:00.000Z`;

	it("reports auto sends, follow-ups and overrides on the same or next question", async () => {
		const { sqlite, db } = seed();
		const reply = (index: number, replyClass: string | null) =>
			respondToWorkInteraction(db, {
				id: `r${index}`,
				orgId: "org",
				interactionId: `q${index}`,
				expectedVersion: 1,
				responder: { type: "user", id: "user" },
				responseKind: "answer",
				body: "Reply",
				resolvesRequest: true,
				metadata: {
					source: "user-reply",
					sessionId: "session-a",
					...(replyClass ? { replyClass } : {}),
				},
				now: at(index + 1),
			});
		for (const index of [1, 2, 3, 4, 5, 6])
			question(sqlite, `q${index}`, {
				metadata: SESSION,
				createdAt: at(index),
			});
		// q1 auto, user follows up on the next question (q2) with "continue".
		await insertReplyDraft(
			db,
			draft({
				id: "d1",
				interactionId: "q1",
				delivery: "auto",
				turnType: "continue",
			}),
		);
		await reply(2, "continue");
		// q3 auto, user overrides on the same question with a correction.
		await insertReplyDraft(
			db,
			draft({
				id: "d3",
				interactionId: "q3",
				delivery: "auto",
				turnType: "continue",
			}),
		);
		await reply(3, "correction");
		// q4 auto, no follow-up on q4 or q5 (q6 is two questions later).
		await insertReplyDraft(
			db,
			draft({
				id: "d4",
				interactionId: "q4",
				delivery: "auto",
				turnType: "continue",
			}),
		);
		await reply(6, "challenge");
		// A review draft never counts as auto.
		await insertReplyDraft(
			db,
			draft({ id: "d5", interactionId: "q5", turnType: "continue" }),
		);
		const [row] = await getReplyDraftAcceptance(
			db,
			{ orgId: "org", targetUserId: "user" },
			{ minRate: 0.9, minDrafts: 50 },
		);
		expect(row).toMatchObject({
			turnType: "continue",
			drafts: 4,
			autoSent: 3,
			autoFollowedUp: 2,
			overridden: 1,
			overrideRate: 1 / 3,
		});
	});

	it("counts an agent decline as an override and a question as neither", async () => {
		const { sqlite, db } = seed();
		question(sqlite, "q1", { metadata: SESSION, createdAt: at(1) });
		question(sqlite, "q2", {
			metadata: {
				...SESSION,
				priorDraft: {
					draftId: "d1",
					draftOutcome: "rejected",
					reason: "already shipped",
				},
			},
			createdAt: at(2),
		});
		question(sqlite, "q3", { metadata: SESSION, createdAt: at(3) });
		for (const [id, interactionId] of [
			["d1", "q1"],
			["d3", "q3"],
		])
			await insertReplyDraft(
				db,
				draft({ id, interactionId, delivery: "auto", turnType: "continue" }),
			);
		await respondToWorkInteraction(db, {
			id: "r3",
			orgId: "org",
			interactionId: "q3",
			expectedVersion: 1,
			responder: { type: "user", id: "user" },
			responseKind: "answer",
			body: "What did the tedi suggest?",
			resolvesRequest: true,
			metadata: {
				source: "user-reply",
				sessionId: "session-a",
				replyClass: "question",
			},
			now: at(4),
		});
		const [row] = await getReplyDraftAcceptance(
			db,
			{ orgId: "org", targetUserId: "user" },
			{ minRate: 0.9, minDrafts: 50 },
		);
		expect(row).toMatchObject({
			autoSent: 2,
			autoFollowedUp: 1,
			overridden: 1,
		});
	});
});

describe("reply draft leaderboard", () => {
	it("ranks tedis by replies that stood, this week and today", async () => {
		const { sqlite, db } = seed();
		sqlite.exec(
			"INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('cto','org','CTO','cto','active')",
		);
		const answer = (id: string, outcome: string) =>
			respondToWorkInteraction(db, {
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
		// Drafter: one accepted, one edited, both 60 s after the question.
		for (const [id, outcome] of [
			["q1", "accepted"],
			["q2", "edited"],
		] as const) {
			question(sqlite, id);
			await insertReplyDraft(
				db,
				draft({
					id: `d-${id}`,
					interactionId: id,
					now: "2026-08-20T00:01:00.000Z",
				}),
			);
			await answer(id, outcome);
		}
		// CTO: two auto replies nobody overrode, the newer one today.
		for (const [id, now] of [
			["q3", "2026-08-20T00:02:00.000Z"],
			["q4", "2026-08-21T00:02:00.000Z"],
		] as const) {
			question(sqlite, id);
			await insertReplyDraft(
				db,
				draft({
					id: `d-${id}`,
					interactionId: id,
					drafterId: "cto",
					delivery: "auto",
					now,
				}),
			);
		}
		const rows = await getReplyDraftLeaderboard(db, {
			orgId: "org",
			targetUserId: "user",
			since: "2026-08-19T00:00:00.000Z",
			todaySince: "2026-08-21T00:00:00.000Z",
		});
		expect(rows.map((row) => row.name)).toEqual(["CTO", "Drafter"]);
		expect(rows[0]).toMatchObject({
			week: { answered: 2, autoSent: 2, stood: 2, corrected: 0 },
			today: { answered: 1, autoSent: 1, stood: 1, corrected: 0 },
		});
		expect(rows[1]).toMatchObject({
			tediId: "drafter",
			week: { answered: 2, stood: 1, corrected: 1, avgReplySeconds: 60 },
			today: { answered: 0, stood: 0, avgReplySeconds: null },
		});
	});
});

describe("auto reply delivery (migrated D1 triggers)", () => {
	const SESSION = "11111111-1111-4111-8111-111111111111";
	const row = (sqlite: DatabaseSync, id: string) =>
		sqlite
			.prepare(
				"SELECT status, version, resolved_at FROM work_interactions WHERE id=?",
			)
			.get(id) as { status: string; version: number; resolved_at: string };
	const delivery = {
		orgId: "org",
		interactionId: "q1",
		draftId: "draft-1",
		actor: { type: "user" as const, id: "user" },
		via: "hook" as const,
		responseId: "auto-1",
		now: "2026-08-20T01:05:00.000Z",
	};

	it("answers in the tedi's name once delivered, idempotently, and keeps the delivery", async () => {
		const { sqlite, db } = seed();
		question(sqlite, "q1", {
			metadata: { ...QUIET, sessionId: SESSION, host: "claude-code" },
		});
		await insertReplyDraft(db, draft({ delivery: "auto" }));
		const first = await recordAutoReplyDelivery(db, delivery);
		expect(first).toMatchObject({
			created: true,
			deliveredAt: delivery.now,
			deliveredVia: "hook",
			response: {
				id: "auto-1",
				responderType: "tedi",
				responderId: "drafter",
				resolvesRequest: true,
				body: draft().body,
				metadata: {
					source: "auto-reply",
					draftId: "draft-1",
					draftOutcome: "auto",
					sessionId: SESSION,
					host: "claude-code",
				},
			},
		});
		expect(row(sqlite, "q1")).toMatchObject({
			status: "resolved",
			version: 2,
			resolved_at: delivery.now,
		});
		// A second report returns the stored answer and the first delivery.
		const again = await recordAutoReplyDelivery(db, {
			...delivery,
			responseId: "auto-2",
			via: "codex_queue",
			now: "2026-08-20T01:06:00.000Z",
		});
		expect(again).toMatchObject({
			created: false,
			deliveredAt: delivery.now,
			deliveredVia: "hook",
			response: { id: "auto-1" },
		});
		expect(
			sqlite
				.prepare(
					"SELECT count(*) AS n FROM work_interaction_responses WHERE interaction_id='q1'",
				)
				.get(),
		).toEqual({ n: 1 });
		// The tedi's answer is never listed as the user's undelivered answer.
		expect(
			await listUndeliveredWorkInteractionResponses(db, {
				orgId: "org",
				actor: { type: "user", id: "user" },
				respondedAfter: CREATED,
			}),
		).toEqual([]);
		// Only the question's own user or asker may record it.
		sqlite.exec(
			"INSERT INTO users(id,email) VALUES('other','other@example.com'); INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status) VALUES('member-2','org','other','other','other@example.com','active')",
		);
		await expect(
			recordAutoReplyDelivery(db, {
				...delivery,
				actor: { type: "user", id: "other" },
				responseId: "auto-3",
			}),
		).rejects.toMatchObject({ code: "INVALID_PRINCIPAL" });
	});

	it("rejects a review draft and a tedi answer the trigger cannot trace to an auto draft", async () => {
		const { sqlite, db } = seed();
		question(sqlite, "q1", { metadata: { ...QUIET, sessionId: SESSION } });
		await insertReplyDraft(db, draft());
		await expect(recordAutoReplyDelivery(db, delivery)).rejects.toMatchObject({
			code: "NOT_ELIGIBLE",
		});
		expect(() =>
			sqlite
				.prepare(
					"INSERT INTO work_interaction_responses(id,org_id,interaction_id,resolved_request_version,resolution_fence,responder_type,responder_id,body,response_kind,resolves_request,metadata,responded_at) VALUES('forged','org','q1',2,'fence','tedi','drafter','Mine','answer',1,?,?)",
				)
				.run(JSON.stringify({ draftId: "draft-1", draftOutcome: "auto" }), NOW),
		).toThrow(/stale or unauthorized/);
		expect(row(sqlite, "q1")).toMatchObject({ status: "open", version: 1 });
	});

	it("takes the user's later correction, delivers it, and counts the auto reply as corrected", async () => {
		const { sqlite, db } = seed();
		question(sqlite, "q1", { metadata: { ...QUIET, sessionId: SESSION } });
		await insertReplyDraft(db, draft({ delivery: "auto" }));
		await recordAutoReplyDelivery(db, delivery);
		const board = () =>
			getReplyDraftLeaderboard(db, {
				orgId: "org",
				targetUserId: "user",
				since: CREATED,
				todaySince: CREATED,
			});
		expect((await board())[0]?.week).toMatchObject({
			answered: 1,
			autoSent: 1,
			stood: 1,
			corrected: 0,
		});
		// From Tedix OS, after the tedi answered: a non-resolving correction.
		const correction = await respondToWorkInteraction(db, {
			id: "fix-1",
			orgId: "org",
			interactionId: "q1",
			expectedVersion: 2,
			responder: { type: "user", id: "user" },
			responseKind: "answer",
			body: "No, hold the release.",
			resolvesRequest: true,
			metadata: { source: "tedix-os" },
			now: "2026-08-20T02:00:00.000Z",
		});
		expect(correction).toMatchObject({
			resolvesRequest: false,
			metadata: { source: "tedix-os", corrects: "auto-1" },
			resolvedRequestVersion: 3,
		});
		expect(row(sqlite, "q1")).toMatchObject({ status: "resolved", version: 3 });
		// It reaches the session through the delivery ledger.
		const pending = await listUndeliveredWorkInteractionResponses(db, {
			orgId: "org",
			actor: { type: "user", id: "user" },
			respondedAfter: CREATED,
		});
		expect(pending.map((entry) => entry.responseId)).toEqual(["fix-1"]);
		expect((await board())[0]?.week).toMatchObject({ stood: 0, corrected: 1 });
		// A correction is fenced like any answer; nobody else may add one.
		await expect(
			respondToWorkInteraction(db, {
				id: "fix-2",
				orgId: "org",
				interactionId: "q1",
				expectedVersion: 2,
				responder: { type: "user", id: "user" },
				responseKind: "answer",
				body: "Stale",
				resolvesRequest: true,
				now: "2026-08-20T02:01:00.000Z",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(() =>
			sqlite
				.prepare(
					"INSERT INTO work_interaction_responses(id,org_id,interaction_id,resolved_request_version,resolution_fence,responder_type,responder_id,body,response_kind,resolves_request,metadata,responded_at) VALUES('forged','org','q1',4,'fence','tedi','drafter','Mine','answer',0,?,?)",
				)
				.run(JSON.stringify({ corrects: "auto-1" }), NOW),
		).toThrow(/stale or unauthorized/);
		// A question the user answered themselves takes no correction.
		question(sqlite, "q2", { metadata: { ...QUIET, sessionId: SESSION } });
		await respondToWorkInteraction(db, {
			id: "own",
			orgId: "org",
			interactionId: "q2",
			expectedVersion: 1,
			responder: { type: "user", id: "user" },
			responseKind: "answer",
			body: "Mine",
			resolvesRequest: true,
			now: "2026-08-20T02:02:00.000Z",
		});
		await expect(
			respondToWorkInteraction(db, {
				id: "fix-3",
				orgId: "org",
				interactionId: "q2",
				expectedVersion: 2,
				responder: { type: "user", id: "user" },
				responseKind: "answer",
				body: "Again",
				resolvesRequest: true,
				now: "2026-08-20T02:03:00.000Z",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});
