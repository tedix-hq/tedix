import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	workInteractionCardRevisions,
	workInteractions,
} from "../../schema/work-factory";
import { learningInteractionEvents } from "../../schema/learning-feedback";
import { tedis } from "../../schema/tedis";
import { organizationMembers } from "../../schema/organization-members";
import { createD1Facade } from "../../test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "../../test/schema-ddl";
import { appendCardRevision, listCardRevisions } from "./card-revisions";
import { addWorkItemComment } from "./comments";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		`${canonicalWorkFactoryDdl()}\n${schemaDdl(organizationMembers, tedis, workInteractions, workInteractionCardRevisions, learningInteractionEvents)}`,
	);
	sqlite.exec(
		"INSERT INTO organizations(id,name,slug) VALUES('org','Fictional','fictional'); INSERT INTO work_items(id,org_id,title,created_at) VALUES('work','org','Draft','2026-01-01T00:00:00.000Z'); INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at) VALUES('card','org','work','question','Draft','Original','tedi','agent','user','person','2026-01-01T00:00:00.000Z');",
	);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}
const base = {
	orgId: "org",
	requestId: "card",
	expectedVersion: 1,
	expectedRevision: 0,
	body: "Original",
	cause: "initial" as const,
	actorType: "tedi",
	actorId: "agent",
};
it("keeps immutable texts, CAS-fences rewrites, updates the same card, and commits one personal training pair", async () => {
	const { db, sqlite } = fixture();
	try {
		await appendCardRevision(db, base);
		const rewrite = {
			...base,
			expectedRevision: 1,
			body: "A warmer draft",
			cause: "agent_rewrite" as const,
			instruction: "Make it warmer",
			responseId: "feedback",
		};
		const writes = await Promise.all([
			appendCardRevision(db, rewrite),
			appendCardRevision(db, { ...rewrite, body: "Concurrent draft" }),
		]);
		expect(writes.filter(Boolean)).toHaveLength(1);
		expect(
			(await listCardRevisions(db, "org", "card")).map((row) => row.body),
		).toEqual(["Original", "A warmer draft"]);
		expect(
			sqlite
				.prepare(
					"SELECT version, json_extract(metadata,'$.cardContent') AS body FROM work_interactions WHERE id='card'",
				)
				.get(),
		).toEqual({ version: 2, body: "A warmer draft" });
		const event = sqlite
			.prepare(
				"SELECT scope_kind,scope_id,metadata FROM learning_interaction_events",
			)
			.get()!;
		expect(event).toMatchObject({ scope_kind: "personal", scope_id: "person" });
		expect(JSON.parse(String(event.metadata))).toMatchObject({
			before: "Original",
			after: "A warmer draft",
			instruction: "Make it warmer",
			responseId: "feedback",
		});
		expect(
			await appendCardRevision(db, {
				...rewrite,
				expectedVersion: 1,
				expectedRevision: 2,
			}),
		).toBeNull();
		expect(
			await appendCardRevision(db, {
				...rewrite,
				expectedVersion: 2,
				expectedRevision: 2,
				body: "Original",
				cause: "restore",
			}),
		).not.toBeNull();
		expect(
			(await listCardRevisions(db, "org", "card")).map((row) => row.revision),
		).toEqual([1, 2, 3]);
	} finally {
		sqlite.close();
	}
});
it("refuses secrets before writing revisions or Work comments", async () => {
	const { db, sqlite } = fixture();
	try {
		const body = "fc-" + "fictional".repeat(5);
		await expect(appendCardRevision(db, { ...base, body })).rejects.toThrow(
			"use connection settings",
		);
		await expect(
			addWorkItemComment(db, {
				id: "comment",
				orgId: "org",
				workItemId: "work",
				authorType: "user",
				authorId: "person",
				body,
				createdAt: new Date().toISOString(),
			}),
		).rejects.toThrow("use connection settings");
		expect(await listCardRevisions(db, "org", "card")).toEqual([]);
	} finally {
		sqlite.close();
	}
});
