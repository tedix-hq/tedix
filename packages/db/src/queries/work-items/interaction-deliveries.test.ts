import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	workInteractionAttention,
	workInteractionDeliveries,
	workInteractionResponses,
	workInteractions,
} from "../../schema/work-factory";
import { createD1Facade } from "../../test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "../../test/schema-ddl";
import {
	listUndeliveredWorkInteractionResponses,
	listWorkInteractionDeliveries,
	recordWorkInteractionDeliveries,
} from "./interaction-deliveries";
import { listWorkInteractionInbox } from "./interactions";

const USER = { type: "user" as const, id: "user-a" };
const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		`${canonicalWorkFactoryDdl()}\n${schemaDdl(workInteractions, workInteractionResponses, workInteractionAttention, workInteractionDeliveries)}`,
	);
	sqlite
		.prepare(
			"INSERT INTO organizations (id,name,slug) VALUES ('org','Org','org')",
		)
		.run();
	sqlite
		.prepare(
			"INSERT INTO work_items (id,org_id,title,created_at) VALUES ('work','org','Work',?)",
		)
		.run("2026-10-09T08:00:00.000Z");
	const question = sqlite.prepare(`INSERT INTO work_interactions
		(id,org_id,work_item_id,kind,status,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,metadata)
		VALUES (?,'org','work','question','resolved',?,'?','user',?,'user',?,'2026-10-09T09:00:00.000Z',?)`);
	const answer = sqlite.prepare(`INSERT INTO work_interaction_responses
		(id,org_id,interaction_id,resolved_request_version,resolution_fence,responder_type,responder_id,body,response_kind,resolves_request,metadata,responded_at)
		VALUES (?,'org',?,2,'fence',?,?,?,'answer',?,?,?)`);
	const meta = (sessionId: string | null, host = "claude-code") =>
		JSON.stringify(sessionId ? { sessionId, host } : {});
	question.run("q-os", "Ship it?", USER.id, USER.id, meta(SESSION));
	answer.run(
		"r-os",
		"q-os",
		"user",
		USER.id,
		"Yes, ship",
		1,
		JSON.stringify({ source: "tedix-os" }),
		"2026-10-09T10:00:00.000Z",
	);
	question.run("q-older", "Which branch?", USER.id, USER.id, meta(SESSION));
	answer.run(
		"r-older",
		"q-older",
		"user",
		USER.id,
		"main",
		1,
		"{}",
		"2026-10-09T09:30:00.000Z",
	);
	// Typed in the same chat: already there.
	question.run("q-chat", "Continue?", USER.id, USER.id, meta(SESSION));
	answer.run(
		"r-chat",
		"q-chat",
		"user",
		USER.id,
		"go",
		1,
		JSON.stringify({ source: "user-reply", sessionId: SESSION }),
		"2026-10-09T10:05:00.000Z",
	);
	// Typed in another chat: news to this one.
	question.run(
		"q-codex",
		"Retry?",
		USER.id,
		USER.id,
		meta(OTHER_SESSION, "codex"),
	);
	answer.run(
		"r-codex",
		"q-codex",
		"user",
		USER.id,
		"retry",
		1,
		JSON.stringify({ source: "user-reply", sessionId: SESSION }),
		"2026-10-09T10:10:00.000Z",
	);
	// Not a session question, someone else's, and too old.
	question.run("q-plain", "Plain", USER.id, USER.id, meta(null));
	answer.run(
		"r-plain",
		"q-plain",
		"user",
		USER.id,
		"x",
		1,
		"{}",
		"2026-10-09T10:00:00.000Z",
	);
	question.run("q-other", "Theirs", "user-b", "user-b", meta(SESSION));
	answer.run(
		"r-other",
		"q-other",
		"user",
		"user-b",
		"x",
		1,
		"{}",
		"2026-10-09T10:00:00.000Z",
	);
	question.run("q-old", "Old", USER.id, USER.id, meta(SESSION));
	answer.run(
		"r-old",
		"q-old",
		"user",
		USER.id,
		"x",
		1,
		"{}",
		"2026-10-07T10:00:00.000Z",
	);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

const AFTER = "2026-10-08T12:00:00.000Z";

describe("Work interaction delivery ledger", () => {
	it("lists the caller's undelivered session answers oldest first", async () => {
		const { db } = fixture();
		const rows = await listUndeliveredWorkInteractionResponses(db, {
			orgId: "org",
			actor: USER,
			respondedAfter: AFTER,
		});
		expect(rows.map((row) => row.responseId)).toEqual([
			"r-older",
			"r-os",
			"r-codex",
		]);
		expect(rows[1]).toMatchObject({
			interactionId: "q-os",
			subject: "Ship it?",
			body: "Yes, ship",
			sessionId: SESSION,
			host: "claude-code",
		});
		const forSession = await listUndeliveredWorkInteractionResponses(db, {
			orgId: "org",
			actor: USER,
			respondedAfter: AFTER,
			sessionId: OTHER_SESSION,
			host: "codex",
		});
		expect(forSession.map((row) => row.responseId)).toEqual(["r-codex"]);
	});

	it("records delivery once, then acknowledgement, and drops it from the list", async () => {
		const { db } = fixture();
		const delivered = await recordWorkInteractionDeliveries(db, {
			orgId: "org",
			actor: USER,
			responseIds: ["r-os", "r-older", "r-other", "missing"],
			via: "hook",
			acknowledged: false,
			now: "2026-10-09T11:00:00.000Z",
		});
		// Someone else's answer and an unknown id are ignored.
		expect(delivered.map((row) => row.responseId).sort()).toEqual([
			"r-older",
			"r-os",
		]);
		const again = await recordWorkInteractionDeliveries(db, {
			orgId: "org",
			actor: USER,
			responseIds: ["r-os"],
			via: "supervisor_resume",
			acknowledged: true,
			now: "2026-10-09T11:05:00.000Z",
		});
		expect(again[0]).toMatchObject({
			deliveredAt: "2026-10-09T11:00:00.000Z",
			deliveredVia: "hook",
			acknowledgedAt: "2026-10-09T11:05:00.000Z",
		});
		const rows = await listUndeliveredWorkInteractionResponses(db, {
			orgId: "org",
			actor: USER,
			respondedAfter: AFTER,
		});
		expect(rows.map((row) => row.responseId)).toEqual(["r-codex"]);
		expect(
			await listWorkInteractionDeliveries(db, {
				orgId: "org",
				interactionId: "q-os",
			}),
		).toHaveLength(1);
	});

	it("records a hand-off with its target and Work Item", async () => {
		const { db } = fixture();
		const [row] = await recordWorkInteractionDeliveries(db, {
			orgId: "org",
			actor: USER,
			responseIds: ["r-codex"],
			via: "handoff",
			acknowledged: false,
			handoffTo: "LEARN",
			handoffRef: "work-2",
			now: "2026-10-09T12:10:00.000Z",
		});
		expect(row).toMatchObject({
			deliveredVia: "handoff",
			handoffTo: "LEARN",
			handoffRef: "work-2",
		});
	});

	it("shows the resolving answer's delivery on inbox rows", async () => {
		const { db } = fixture();
		await recordWorkInteractionDeliveries(db, {
			orgId: "org",
			actor: USER,
			responseIds: ["r-os"],
			via: "hook",
			acknowledged: false,
			now: "2026-10-09T11:00:00.000Z",
		});
		const page = await listWorkInteractionInbox(db, {
			orgId: "org",
			targetType: "user",
			targetId: USER.id,
			observedAt: "2026-10-09T12:00:00.000Z",
		});
		const byId = new Map(page.data.map((row) => [row.request.id, row]));
		expect(byId.get("q-os")?.resolution).toMatchObject({
			id: "r-os",
			responderType: "user",
			source: "tedix-os",
			deliveredAt: "2026-10-09T11:00:00.000Z",
			deliveredVia: "hook",
			acknowledgedAt: null,
		});
		expect(byId.get("q-chat")?.resolution).toMatchObject({
			source: "user-reply",
			sessionId: SESSION,
			deliveredAt: null,
		});
	});
});
