import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { respondToWorkInteraction } from "./interactions";
import { insertReplyDraft } from "./reply-drafts";
import { listReplyExamples } from "./reply-examples";

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
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status) VALUES('member-foreign','foreign','user','user','user@example.com','active');
		INSERT INTO work_items(id,org_id,title,disposition,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES('work','org','Work','completed','hygiene','2026-09-01T00:00:00.000Z','revision-1','2026-08-20T00:00:00.000Z');
		INSERT INTO work_items(id,org_id,title,disposition,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES('work-foreign','foreign','Work','completed','hygiene','2026-09-01T00:00:00.000Z','revision-1','2026-08-20T00:00:00.000Z');
		INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('drafter','org','Drafter','drafter','active');
	`);
	const db = createDbQueryClient(createD1Facade(sqlite));

	function question(
		id: string,
		minute: number,
		{
			org = "org",
			repository = "api" as string | null,
			metadata = {} as Record<string, unknown>,
			prompt = `Agent message ${id}`,
			targetId = "user",
		} = {},
	) {
		sqlite
			.prepare(
				"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,metadata) VALUES(?,?,?,'question','Question',?,'system','tedix','user',?,?,?)",
			)
			.run(
				id,
				org,
				org === "org" ? "work" : "work-foreign",
				prompt,
				targetId,
				`2026-08-20T00:${String(minute).padStart(2, "0")}:00.000Z`,
				JSON.stringify({
					...QUIET,
					...(repository ? { repository } : {}),
					...metadata,
				}),
			);
	}

	async function answer(
		id: string,
		body: string,
		metadata: Record<string, JsonValue>,
		{ org = "org" } = {},
	) {
		await respondToWorkInteraction(db, {
			id: `answer-${id}`,
			orgId: org,
			interactionId: id,
			expectedVersion: 1,
			responder: { type: "user", id: "user" },
			responseKind: "answer",
			body,
			resolvesRequest: true,
			metadata,
			now: "2026-08-20T01:00:00.000Z",
		});
	}

	return { sqlite, db, question, answer };
}

const list = (
	db: ReturnType<typeof seed>["db"],
	overrides: Partial<Parameters<typeof listReplyExamples>[1]> = {},
) =>
	listReplyExamples(db, {
		orgId: "org",
		targetUserId: "user",
		excludeInteractionId: "current",
		limit: 50,
		...overrides,
	});

describe("listReplyExamples (migrated D1 triggers)", () => {
	it("turns typed replies and OS overrides into examples, overrides first", async () => {
		const { db, question, answer } = seed();
		question("typed", 1);
		await answer("typed", "Keep going, then run the live check.", {
			schema: QUIET.schema,
			source: "user-reply",
			replyClass: "verify",
		});
		// An auto-sent draft the user overrode in Tedix OS.
		question("override", 2);
		await insertReplyDraft(db, {
			id: "draft-override",
			orgId: "org",
			interactionId: "override",
			drafterId: "drafter",
			body: "Ship it.",
			rationale: "Tests pass.",
			delivery: "auto",
			now: "2026-08-20T00:30:00.000Z",
		});
		await answer("override", "No. Prove it live first.", {
			draftId: "draft-override",
			draftOutcome: "replaced",
			editRatio: 0.9,
			source: "os-inbox",
		});
		question("edited", 3);
		await answer("edited", "Ship it after the smoke test.", {
			draftId: "draft-edited",
			draftOutcome: "edited",
			editRatio: 0.2,
			source: "os-inbox",
		});
		question("accepted", 4);
		await answer("accepted", "Ship it.", {
			draftId: "draft-accepted",
			draftOutcome: "accepted",
			editRatio: 0,
			source: "os-inbox",
		});

		const examples = await list(db);
		expect(examples.map((example) => example.interactionId)).toEqual([
			"edited",
			"override",
			"accepted",
			"typed",
		]);
		expect(examples[1]).toEqual({
			interactionId: "override",
			createdAt: "2026-08-20T00:02:00.000Z",
			repository: "api",
			agentTail: "Agent message override",
			replyBody: "No. Prove it live first.",
			replyClass: null,
			draftOutcome: "replaced",
			source: "os-inbox",
		});
		expect(examples[3]).toMatchObject({
			replyClass: "verify",
			source: "user-reply",
			draftOutcome: null,
		});
	});

	it("excludes auto-sent bodies, unsourced answers, other schemas, open, foreign and the current question", async () => {
		const { db, question, answer } = seed();
		question("auto", 1);
		await answer("auto", "Ship it.", {
			source: "user-reply",
			draftId: "d",
			draftOutcome: "auto-sent",
		});
		question("unsourced", 3);
		await answer("unsourced", "No source", {});
		question("other-schema", 4, { metadata: { schema: "other.v1" } });
		await answer("other-schema", "Other", { source: "user-reply" });
		question("open", 5);
		question("current", 6);
		await answer("current", "Current", { source: "user-reply" });
		question("foreign", 7, { org: "foreign" });
		await answer(
			"foreign",
			"Foreign",
			{ source: "user-reply" },
			{ org: "foreign" },
		);
		question("kept", 8);
		await answer("kept", "Kept", { source: "user-reply" });

		expect((await list(db)).map((example) => example.interactionId)).toEqual([
			"kept",
		]);
	});

	it("prefers the repository, bounds texts and clamps the limit", async () => {
		const { db, question, answer } = seed();
		question("web", 9, { repository: "web" });
		await answer("web", "Web", { source: "user-reply" });
		question("long", 1, {
			repository: "api",
			prompt: `${"a".repeat(1000)}TAIL`,
		});
		await answer("long", `HEAD${"b".repeat(1000)}`, { source: "user-reply" });
		question("bare", 2, { repository: null });
		await answer("bare", "Bare", { source: "user-reply" });

		const examples = await list(db, { repository: "api" });
		expect(examples.map((example) => example.interactionId)).toEqual([
			"long",
			"web",
			"bare",
		]);
		expect(examples[0]?.agentTail).toHaveLength(600);
		expect(examples[0]?.agentTail.endsWith("TAIL")).toBe(true);
		expect(examples[0]?.replyBody).toHaveLength(400);
		expect(examples[0]?.replyBody.startsWith("HEAD")).toBe(true);
		expect(examples[2]?.repository).toBeNull();
		expect(await list(db, { limit: 0 })).toEqual([]);
		expect(await list(db, { limit: 1 })).toHaveLength(1);
	});
});
