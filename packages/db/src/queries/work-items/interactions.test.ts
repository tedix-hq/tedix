import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "../../schema/control-plane";
import { organizationMembers } from "../../schema/organization-members";
import { tedis } from "../../schema/tedis";
import {
	workInteractionResponses,
	workInteractions,
} from "../../schema/work-factory";
import { createD1Facade } from "../../test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "../../test/schema-ddl";
import {
	createWorkInteraction,
	delegateWorkInteraction,
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

	it("partitions the inbox by triage urgency, treating untriaged rows as later", async () => {
		const { sqlite, db } = fixture();
		const setMetadata = sqlite.prepare(
			"UPDATE work_interactions SET metadata=? WHERE id=?",
		);
		setMetadata.run(
			JSON.stringify({
				schema: "tedix.decision-capture.v1",
				triage: {
					status: "ok",
					urgency: "now",
					urgentLabels: ["blocker_or_failure"],
				},
			}),
			"mine",
		);
		setMetadata.run(
			JSON.stringify({ triage: { status: "ok", urgency: "later" } }),
			"other-target",
		);
		setMetadata.run(
			JSON.stringify({ triage: { status: "unavailable" } }),
			"other-type",
		);
		const ids = async (
			urgency: "now" | "later" | undefined,
			cursor?: { at: string; id: string },
		) =>
			(
				await listWorkInteractionInbox(db, {
					orgId: "org",
					urgency,
					cursor,
					observedAt: NOW,
				})
			).data.map((row) => row.request.id);

		expect(await ids("now")).toEqual(["mine"]);
		expect(await ids("later")).toEqual([
			"other-target",
			"other-type",
			"untargeted",
		]);
		expect(await ids(undefined)).toHaveLength(4);
		expect(
			await ids("later", {
				at: "2026-08-21T11:03:00.000Z",
				id: "other-target",
			}),
		).toEqual(["other-type", "untargeted"]);
		const page = await listWorkInteractionInbox(db, {
			orgId: "org",
			urgency: "later",
			limit: 1,
			observedAt: NOW,
		});
		expect(page.nextCursor).toEqual({
			at: "2026-08-21T11:03:00.000Z",
			id: "other-target",
		});
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

describe("question delegation", () => {
	function question() {
		const f = fixture();
		f.sqlite.exec(
			schemaDdl(
				organizationMembers,
				policyPacks,
				runtimeProfiles,
				workspaceTemplateSets,
				tedis,
			),
		);
		f.sqlite.exec(
			"INSERT INTO organization_members (id,organization_id,user_id,descope_user_id,email,status) VALUES ('member','org','human','human','human@example.test','active'); INSERT INTO tedis (id,organization_id,name,slug,status) VALUES ('worker','org','Worker','worker','active'); UPDATE work_interactions SET target_type='user',target_id='human' WHERE id='mine';",
		);
		return f;
	}
	const input = {
		orgId: "org",
		interactionId: "mine",
		expectedVersion: 1,
		actor: { type: "user" as const, id: "human" },
		tediId: "worker",
		now: NOW,
	};
	it("keeps the question identity and attributes the actual tedi reply", async () => {
		const { db } = question();
		const delegated = await delegateWorkInteraction(db, input);
		expect(delegated).toMatchObject({
			id: "mine",
			targetType: "tedi",
			targetId: "worker",
			version: 2,
			metadata: { delegation: { fromId: "human", toTediId: "worker" } },
		});
		await expect(
			respondToWorkInteraction(db, {
				id: "wrong",
				orgId: "org",
				interactionId: "mine",
				expectedVersion: 2,
				responder: input.actor,
				responseKind: "answer",
				body: "A",
				resolvesRequest: true,
				now: NOW,
			}),
		).rejects.toThrow("Responder is not the request target");
		const response = await respondToWorkInteraction(db, {
			id: "reply",
			orgId: "org",
			interactionId: "mine",
			expectedVersion: 2,
			responder: { type: "tedi", id: "worker" },
			responseKind: "answer",
			body: "A",
			resolvesRequest: true,
			now: NOW,
		});
		expect(response).toMatchObject({
			responderType: "tedi",
			responderId: "worker",
			interactionId: "mine",
		});
	});
	it.each([
		"stale",
		"expired",
		"resolved",
		"input",
		"foreign-worker",
		"wrong-target",
		"machine",
		"paused",
		"retired",
	])("rejects %s without changing the target", async (condition) => {
		const { sqlite, db } = question();
		if (condition === "expired")
			sqlite.exec(
				"UPDATE work_interactions SET expires_at='2026-08-20T00:00:00Z' WHERE id='mine'",
			);
		if (condition === "resolved")
			sqlite.exec(
				"UPDATE work_interactions SET status='resolved' WHERE id='mine'",
			);
		if (condition === "input")
			sqlite.exec("UPDATE work_interactions SET kind='input' WHERE id='mine'");
		if (condition === "foreign-worker")
			sqlite.exec(
				"INSERT INTO organizations (id,name,slug) VALUES ('other','Other','other'); UPDATE tedis SET organization_id='other' WHERE id='worker'",
			);
		if (condition === "paused")
			sqlite.exec("UPDATE tedis SET status='paused' WHERE id='worker'");
		if (condition === "retired")
			sqlite.exec(
				"UPDATE tedis SET retired_at='2026-08-20T00:00:00Z' WHERE id='worker'",
			);
		if (condition === "wrong-target")
			sqlite.exec(
				"UPDATE work_interactions SET target_id='other' WHERE id='mine'",
			);
		await expect(
			delegateWorkInteraction(db, {
				...input,
				expectedVersion: condition === "stale" ? 9 : 1,
				actor:
					condition === "machine"
						? { type: "tedi", id: "worker" }
						: input.actor,
			}),
		).rejects.toThrow();
		expect(
			sqlite
				.prepare(
					"SELECT target_type,target_id,version FROM work_interactions WHERE id='mine'",
				)
				.get(),
		).toMatchObject({ target_type: "user", version: 1 });
	});
});
