import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	workInteractionResponses,
	workInteractions,
} from "../../schema/work-factory";
import { createD1Facade } from "../../test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "../../test/schema-ddl";
import {
	createWorkInteraction,
	listWorkInteractionInbox,
	respondToWorkInteraction,
} from "./interactions";

const NOW = "2026-08-21T12:00:00.000Z";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		`${canonicalWorkFactoryDdl()}\n${schemaDdl(workInteractions, workInteractionResponses)}`,
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
		.run(NOW);
	const insert = sqlite.prepare(`INSERT INTO work_interactions
		(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
	insert.run(
		"mine",
		"org",
		"work",
		"question",
		"Mine",
		"?",
		"user",
		"author-a",
		"tedi",
		"cto",
		"2026-08-21T11:04:00.000Z",
	);
	insert.run(
		"other-target",
		"org",
		"work",
		"question",
		"Other",
		"?",
		"user",
		"author-a",
		"tedi",
		"cfo",
		"2026-08-21T11:03:00.000Z",
	);
	insert.run(
		"other-type",
		"org",
		"work",
		"question",
		"Type",
		"?",
		"user",
		"author-b",
		"user",
		"cto",
		"2026-08-21T11:02:00.000Z",
	);
	insert.run(
		"untargeted",
		"org",
		"work",
		"question",
		"Legacy",
		"?",
		"system",
		"tedix",
		null,
		null,
		"2026-08-21T11:01:00.000Z",
	);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

describe("Work interaction inbox", () => {
	it("uses D1-safe joined projections and scopes an inbox to the exact target", async () => {
		const { db } = fixture();
		const result = await listWorkInteractionInbox(db, {
			orgId: "org",
			targetType: "tedi",
			targetId: "cto",
			observedAt: NOW,
		});

		expect(result.data.map((row) => row.request.id)).toEqual(["mine"]);
		expect(result.data[0]?.workItem).toMatchObject({
			id: "work",
			title: "Work",
		});
	});

	it("scopes an outbox to the exact creator and keeps omitted actor filters audit-wide", async () => {
		const { db } = fixture();
		const outbox = await listWorkInteractionInbox(db, {
			orgId: "org",
			creatorType: "user",
			creatorId: "author-a",
			observedAt: NOW,
		});
		const audit = await listWorkInteractionInbox(db, {
			orgId: "org",
			observedAt: NOW,
		});

		expect(outbox.data.map((row) => row.request.id)).toEqual([
			"mine",
			"other-target",
		]);
		expect(audit.data.map((row) => row.request.id)).toEqual([
			"mine",
			"other-target",
			"other-type",
			"untargeted",
		]);
	});

	it("rejects creating or responding to an untargeted interaction", async () => {
		const { sqlite, db } = fixture();
		await expect(
			createWorkInteraction(db, {
				id: "new-untargeted",
				orgId: "org",
				workItemId: "work",
				kind: "question",
				subject: "Unsafe",
				prompt: "?",
				creator: { type: "system", id: "tedix" },
				targetType: null,
				targetId: null,
				now: NOW,
			} as never),
		).rejects.toThrow("Interaction requires an exact target type and id");
		expect(
			sqlite
				.prepare("SELECT id FROM work_interactions WHERE id='new-untargeted'")
				.get(),
		).toBeUndefined();

		await expect(
			respondToWorkInteraction(db, {
				id: "response",
				orgId: "org",
				interactionId: "untargeted",
				expectedVersion: 1,
				responder: { type: "system", id: "tedix" },
				responseKind: "answer",
				body: "unsafe",
				resolvesRequest: false,
				now: NOW,
			} as never),
		).rejects.toThrow("Responder is not the request target");
	});
});
