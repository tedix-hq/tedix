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
	workInteractionAttention,
	workInteractionDeliveries,
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
	sweepObsoleteWorkInteractions,
} from "./interactions";

const NOW = "2026-08-21T12:00:00.000Z";

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
	it("ledgers an answer sent with delivery none as needing no delivery", async () => {
		const { db, sqlite } = question();
		const response = await respondToWorkInteraction(db, {
			id: "closure",
			orgId: "org",
			interactionId: "mine",
			expectedVersion: 1,
			responder: input.actor,
			responseKind: "answer",
			body: "Status update, not an ask — closed",
			resolvesRequest: true,
			metadata: { delivery: "none" },
			now: NOW,
		});
		expect(response.metadata).toEqual({ delivery: "none" });
		expect(
			sqlite
				.prepare(
					"SELECT delivered_at, delivered_via, acknowledged_at FROM work_interaction_deliveries WHERE response_id='closure'",
				)
				.get(),
		).toEqual({
			delivered_at: NOW,
			delivered_via: null,
			acknowledged_at: null,
		});
	});
	it("ledgers nothing for an ordinary answer", async () => {
		const { db, sqlite } = question();
		await respondToWorkInteraction(db, {
			id: "plain",
			orgId: "org",
			interactionId: "mine",
			expectedVersion: 1,
			responder: input.actor,
			responseKind: "answer",
			body: "Yes",
			resolvesRequest: true,
			now: NOW,
		});
		expect(
			sqlite
				.prepare(
					"SELECT 1 FROM work_interaction_deliveries WHERE response_id='plain'",
				)
				.get(),
		).toBeUndefined();
	});
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

describe("obsolete Work interactions", () => {
	it("closes only questions older than three days on terminal Work, with one system note", async () => {
		for (const disposition of ["completed", "cancelled"]) {
			const { sqlite, db } = fixture();
			sqlite
				.prepare("UPDATE work_items SET disposition=? WHERE id='work'")
				.run(disposition);
			sqlite
				.prepare(
					"UPDATE work_interactions SET created_at='2026-08-18T11:59:59.000Z' WHERE id='mine'",
				)
				.run();
			sqlite
				.prepare(
					"UPDATE work_interactions SET created_at='2026-08-18T12:00:00.000Z' WHERE id='other-target'",
				)
				.run();
			expect(
				await sweepObsoleteWorkInteractions(db, { now: NOW, limit: 100 }),
			).toEqual({ observed: 1, expired: 1 });
			expect(
				sqlite
					.prepare("SELECT status FROM work_interactions WHERE id='mine'")
					.get()?.status,
			).toBe("expired");
			const note = sqlite
				.prepare("SELECT author_type,body FROM work_item_comments")
				.get();
			expect(note?.author_type).toBe("system");
			expect(note?.body).toContain("older than three days");
			expect(
				sqlite
					.prepare("SELECT COUNT(*) AS n FROM work_interaction_responses")
					.get()?.n,
			).toBe(0);
			expect(
				await sweepObsoleteWorkInteractions(db, { now: NOW, limit: 100 }),
			).toEqual({ observed: 0, expired: 0 });
		}
	});
	it("keeps old questions on active Work, non-questions, and resolved requests", async () => {
		const { sqlite, db } = fixture();
		sqlite
			.prepare(
				"UPDATE work_interactions SET created_at='2026-08-01T00:00:00.000Z'",
			)
			.run();
		expect(
			(await sweepObsoleteWorkInteractions(db, { now: NOW, limit: 100 }))
				.expired,
		).toBe(0);
		sqlite.prepare("UPDATE work_items SET disposition='completed'").run();
		sqlite
			.prepare(
				"UPDATE work_interactions SET kind='handoff' WHERE id IN ('mine','other-target')",
			)
			.run();
		sqlite
			.prepare(
				"UPDATE work_interactions SET status='resolved' WHERE id IN ('other-type','untargeted')",
			)
			.run();
		expect(
			(await sweepObsoleteWorkInteractions(db, { now: NOW, limit: 100 }))
				.expired,
		).toBe(0);
	});
	it("expires due proposals and legacy unanswered proposals after fourteen days", async () => {
		const { sqlite, db } = fixture();
		const metadata = JSON.stringify({ schema: "tedix.work-proposal.v1" });
		sqlite
			.prepare(
				"UPDATE work_interactions SET kind='handoff',metadata=?,expires_at=? WHERE id='mine'",
			)
			.run(metadata, NOW);
		sqlite
			.prepare(
				"UPDATE work_interactions SET kind='handoff',metadata=?,created_at=? WHERE id='other-target'",
			)
			.run(metadata, "2026-08-07T12:00:00.000Z");
		sqlite
			.prepare(
				"UPDATE work_interactions SET kind='handoff',metadata=?,created_at=? WHERE id='other-type'",
			)
			.run(metadata, "2026-08-07T12:00:00.001Z");
		expect(
			(await sweepObsoleteWorkInteractions(db, { now: NOW, limit: 100 }))
				.expired,
		).toBe(2);
		const open = await listWorkInteractionInbox(db, {
			orgId: "org",
			states: ["open"],
			observedAt: NOW,
		});
		expect(open.data.map((r) => r.request.id)).not.toContain("mine");
	});
	it("retires legacy unavailable captures but preserves classified requests", async () => {
		const { sqlite, db } = fixture();
		for (const [id, status] of [
			["mine", "unavailable"],
			["other-target", "ok"],
		])
			sqlite.prepare("UPDATE work_interactions SET metadata=? WHERE id=?").run(
				JSON.stringify({
					schema: "tedix.decision-capture.v1",
					triage: { status },
				}),
				id!,
			);
		expect(
			(await sweepObsoleteWorkInteractions(db, { now: NOW, limit: 100 }))
				.expired,
		).toBe(1);
		expect(
			sqlite.prepare("SELECT COUNT(*) AS n FROM work_item_comments").get()?.n,
		).toBe(0);
	});
});
