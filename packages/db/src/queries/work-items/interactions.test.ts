import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
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
	workInteractionCardRevisions,
	workInteractionDeliveries,
	workInteractionResponses,
	workInteractions,
} from "../../schema/work-factory";
import { createD1Facade } from "../../test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "../../test/schema-ddl";
import { settleRecoveredRepositoryCiObservations } from "../repository-observer";
import {
	createWorkInteraction,
	createRepositoryCiAlert,
	refreshRepositoryCiAlerts,
	delegateWorkInteraction,
	listWorkInteractionInbox,
	respondToWorkInteraction,
	sweepObsoleteWorkInteractions,
} from "./interactions";

const NOW = "2026-08-21T12:00:00.000Z";

/** The deployed BEFORE UPDATE guards on work_interactions, latest definition each. */
function deployedInteractionGuards() {
	const migrations = new URL("../../../drizzle/", import.meta.url);
	const guards = new Map<string, string>();
	for (const name of readdirSync(migrations).sort()) {
		if (!/^\d+_/.test(name)) continue;
		const text = readFileSync(
			new URL(`${name}/migration.sql`, migrations),
			"utf8",
		);
		for (const statement of text.split("--> statement-breakpoint")) {
			const drop = statement.match(
				/DROP TRIGGER(?: IF EXISTS)?\s+[`"]?([\w]+)[`"]?/i,
			);
			if (drop) guards.delete(drop[1]!);
			const create = statement.match(
				/CREATE TRIGGER\s+[`"]?([\w]+)[`"]?[\s\S]*?\bEND;/i,
			);
			if (
				create &&
				/BEFORE UPDATE ON\s+[`"]?work_interactions[`"]?(?:\s|$)/i.test(
					create[0],
				)
			)
				guards.set(create[1]!, create[0]);
		}
	}
	return [...guards.values()];
}
const armed = new WeakSet<DatabaseSync>();
/** Install the deployed update guards once, after a test's setup writes. */
function armInteractionGuards(sqlite: DatabaseSync) {
	if (armed.has(sqlite)) return;
	for (const guard of deployedInteractionGuards()) sqlite.exec(guard);
	armed.add(sqlite);
}

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

	it("includes Work-parented asks in their project without crossing recipients or organizations", async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(schemaDdl(tedis));
		sqlite
			.prepare(
				"INSERT INTO organizations (id,name,slug) VALUES ('foreign','Foreign','foreign')",
			)
			.run();
		const project = sqlite.prepare(
			"INSERT INTO projects (id,org_id,key,name,created_at) VALUES (?,?,?,?,?)",
		);
		project.run("project", "org", "ONE", "First", NOW);
		project.run("other-project", "org", "TWO", "Second", NOW);
		project.run("foreign-project", "foreign", "THREE", "Third", NOW);
		const work = sqlite.prepare(
			"INSERT INTO work_items (id,org_id,project_id,title,created_at) VALUES (?,?,?,?,?)",
		);
		work.run("project-work", "org", "project", "First Work", NOW);
		work.run("other-work", "org", "other-project", "Second Work", NOW);
		work.run("foreign-work", "foreign", "foreign-project", "Third Work", NOW);
		const interaction = sqlite.prepare(`INSERT INTO work_interactions
			(id,org_id,work_item_id,project_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at)
			VALUES (?,?,?,?,'question','Review','?','system','tedix','user',?,?)`);
		interaction.run("work-parent", "org", "project-work", null, "reader", NOW);
		interaction.run("project-parent", "org", null, "project", "reader", NOW);
		interaction.run(
			"other-project-ask",
			"org",
			"other-work",
			null,
			"reader",
			NOW,
		);
		interaction.run(
			"other-recipient",
			"org",
			"project-work",
			null,
			"someone-else",
			NOW,
		);
		interaction.run(
			"foreign-ask",
			"foreign",
			"foreign-work",
			null,
			"reader",
			NOW,
		);
		const ids = async (projectId: string) =>
			(
				await listWorkInteractionInbox(db, {
					orgId: "org",
					projectId,
					targetType: "user",
					targetId: "reader",
					observedAt: NOW,
				})
			).data
				.map((row) => row.request.id)
				.sort();
		expect(await ids("project")).toEqual(["project-parent", "work-parent"]);
		expect(await ids("other-project")).toEqual(["other-project-ask"]);
		expect(await ids("foreign-project")).toEqual([]);
		sqlite.close();
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
	it.each(["open", "resolved", "cancelled", "expired"])(
		"keeps a reminder only while its original ask is open: %s",
		async (status) => {
			const f = sweepFixture();
			f.sqlite
				.prepare("UPDATE work_interactions SET status=? WHERE id='mine'")
				.run(status);
			f.sqlite
				.prepare(`INSERT INTO work_interactions
			(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,metadata,created_at,expires_at)
			VALUES ('reminder','org','work','coordination','Needs you: Mine','Open original ask','system','tedix','tedi','cto',?,?,'2026-08-22T12:00:00.000Z')`)
				.run(JSON.stringify({ laneNudge: { requestId: "mine" } }), NOW);
			const inbox = await listWorkInteractionInbox(f.db, {
				orgId: "org",
				targetType: "tedi",
				targetId: "cto",
				states: ["open"],
				observedAt: NOW,
			});
			expect(inbox.data.some((row) => row.request.id === "reminder")).toBe(
				status === "open",
			);
			expect((await sweep(f)).expired).toBe(status === "open" ? 0 : 1);
			expect(statusOf(f.sqlite, "reminder")).toBe(
				status === "open" ? "open" : "expired",
			);
			const history = await listWorkInteractionInbox(f.db, {
				orgId: "org",
				targetType: "tedi",
				targetId: "cto",
				states: ["expired"],
				observedAt: NOW,
			});
			expect(history.data.some((row) => row.request.id === "reminder")).toBe(
				status !== "open",
			);
			f.sqlite.close();
		},
	);
	function sweepFixture() {
		const f = fixture();
		f.sqlite.exec(
			schemaDdl(
				policyPacks,
				organizationMembers,
				tedis,
				workInteractionCardRevisions,
			),
		);
		return f;
	}
	/** Sweep under the deployed update guards, armed after the test's setup writes. */
	const sweep = (f: ReturnType<typeof fixture>, now = NOW) => {
		armInteractionGuards(f.sqlite);
		return sweepObsoleteWorkInteractions(f.db, { now, limit: 100 });
	};
	const noteFor = (sqlite: DatabaseSync, id: string) =>
		sqlite
			.prepare(
				"SELECT author_type, body, json_extract(metadata,'$.cause') AS cause FROM work_item_comments WHERE json_extract(metadata,'$.requestId')=?",
			)
			.get(id);
	const statusOf = (sqlite: DatabaseSync, id: string) =>
		sqlite.prepare("SELECT status FROM work_interactions WHERE id=?").get(id)
			?.status;

	it("closes question, input and handoff requests on terminal Work at any age, recording the reason", async () => {
		for (const disposition of ["completed", "cancelled"]) {
			const f = sweepFixture();
			const { sqlite } = f;
			sqlite
				.prepare("UPDATE work_items SET disposition=? WHERE id='work'")
				.run(disposition);
			sqlite
				.prepare(
					"UPDATE work_interactions SET kind='input' WHERE id='other-target'",
				)
				.run();
			sqlite
				.prepare(
					"UPDATE work_interactions SET kind='handoff' WHERE id='other-type'",
				)
				.run();
			sqlite
				.prepare(
					"UPDATE work_interactions SET kind='coordination', target_type='tedi', target_id='cto' WHERE id='untargeted'",
				)
				.run();
			expect(await sweep(f)).toEqual({ observed: 3, expired: 3 });
			for (const id of ["mine", "other-target", "other-type"]) {
				expect(statusOf(sqlite, id)).toBe("expired");
				expect(noteFor(sqlite, id)).toMatchObject({
					author_type: "system",
					cause: "work_closed",
				});
			}
			expect(statusOf(sqlite, "untargeted")).toBe("open");
			expect(String(noteFor(sqlite, "mine")?.body)).toContain(
				"Its Work is completed or cancelled.",
			);
			expect(
				sqlite
					.prepare("SELECT COUNT(*) AS n FROM work_interaction_responses")
					.get()?.n,
			).toBe(0);
			expect(await sweep(f)).toEqual({ observed: 0, expired: 0 });
		}
	});
	it("keeps old requests on active Work and resolved requests", async () => {
		for (const finished of [false, true]) {
			const f = sweepFixture();
			f.sqlite
				.prepare(
					"UPDATE work_interactions SET created_at='2026-08-01T00:00:00.000Z'",
				)
				.run();
			if (finished) {
				f.sqlite.prepare("UPDATE work_items SET disposition='completed'").run();
				f.sqlite
					.prepare("UPDATE work_interactions SET status='resolved'")
					.run();
			}
			expect((await sweep(f)).expired).toBe(0);
		}
	});
	it("expires a status update to a person once its coordination window passes since creation or refresh", async () => {
		const f = sweepFixture();
		const { sqlite } = f;
		sqlite
			.prepare(
				"UPDATE work_interactions SET kind='coordination', target_type='user', target_id='aaron'",
			)
			.run();
		const at = (id: string, createdAt: string, metadata = "{}") =>
			sqlite
				.prepare(
					"UPDATE work_interactions SET created_at=?, metadata=? WHERE id=?",
				)
				.run(createdAt, metadata, id);
		at("mine", "2026-08-20T12:00:00.000Z"); // exactly 24 h old
		at("other-target", "2026-08-20T12:00:00.001Z"); // just inside 24 h
		at(
			"other-type",
			"2026-08-19T00:00:00.000Z",
			JSON.stringify({ refreshedAt: "2026-08-21T06:00:00.000Z" }),
		);
		sqlite
			.prepare(
				"UPDATE work_interactions SET created_at='2026-08-01T00:00:00.000Z', target_type='tedi' WHERE id='untargeted'",
			)
			.run();
		expect(await sweep(f)).toEqual({ observed: 1, expired: 1 });
		expect(statusOf(sqlite, "mine")).toBe("expired");
		expect(noteFor(sqlite, "mine")?.cause).toBe("coordination_stale");
		for (const id of ["other-target", "other-type", "untargeted"])
			expect(statusOf(sqlite, id)).toBe("open");
	});
	it("reads the coordination window from the organization's active policy pack", async () => {
		const f = sweepFixture();
		const { sqlite } = f;
		sqlite
			.prepare(
				"UPDATE work_interactions SET kind='coordination', target_type='user', target_id='aaron', created_at='2026-08-21T05:00:00.000Z'",
			)
			.run();
		const pack = sqlite.prepare(
			"INSERT INTO policy_packs (id,organization_id,name,slug,scope,status,version,definition) VALUES (?,?,?,?,?,?,?,?)",
		);
		pack.run(
			"old",
			"org",
			"Org",
			"org",
			"organization",
			"active",
			1,
			JSON.stringify({ governancePolicy: { coordinationTtlHours: 100 } }),
		);
		expect((await sweep(f)).expired).toBe(0);
		pack.run(
			"new",
			"org",
			"Org",
			"org-2",
			"organization",
			"active",
			2,
			JSON.stringify({ governancePolicy: { coordinationTtlHours: 6 } }),
		);
		expect((await sweep(f)).expired).toBe(4);
	});
	it("expires due proposals and legacy unanswered proposals after fourteen days", async () => {
		const f = sweepFixture();
		const { sqlite } = f;
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
		expect((await sweep(f)).expired).toBe(2);
		const open = await listWorkInteractionInbox(f.db, {
			orgId: "org",
			states: ["open"],
			observedAt: NOW,
		});
		expect(open.data.map((r) => r.request.id)).not.toContain("mine");
	});
	it("retires legacy unavailable captures but preserves classified requests", async () => {
		const f = sweepFixture();
		const { sqlite } = f;
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
		expect((await sweep(f)).expired).toBe(1);
		expect(
			sqlite.prepare("SELECT COUNT(*) AS n FROM work_item_comments").get()?.n,
		).toBe(0);
	});
});

it("reads old typed approvals before LIMIT while preserving the recipient fence", async () => {
	const { db, sqlite } = fixture();
	const insert = sqlite.prepare(
		`INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,metadata) VALUES (?,'org','work','question','Review','?','system','tedix','tedi',?,?,?)`,
	);
	for (let i = 0; i < 60; i++) insert.run(`new-${i}`, "cto", NOW, "{}");
	insert.run(
		"approval",
		"cto",
		"2026-08-20T10:00:00.000Z",
		JSON.stringify({
			approvalOperation: "tests_write.CreateTestLink",
			approvalTarget: "viewer@example.com",
		}),
	);
	insert.run(
		"wrong-recipient",
		"cfo",
		NOW,
		JSON.stringify({
			approvalOperation: "write.Send",
			approvalTarget: "other",
		}),
	);
	insert.run(
		"incomplete",
		"cto",
		NOW,
		JSON.stringify({ approvalOperation: "write.Send" }),
	);
	const input = {
		orgId: "org",
		targetType: "tedi" as const,
		targetId: "cto",
		states: ["open" as const],
		limit: 1,
		observedAt: NOW,
	};
	expect(
		(await listWorkInteractionInbox(db, input)).data[0]?.request.id,
	).not.toBe("approval");
	const page = await listWorkInteractionInbox(db, {
		...input,
		decisionKind: "approval",
	});
	expect(page.data.map((row) => row.request.id)).toEqual(["approval"]);
	expect(page.hasMore).toBe(false);
});

it("refreshes CI alerts in their workflow scope and closes them on recovery", async () => {
	const { sqlite, db } = fixture();
	sqlite.exec(
		schemaDdl(
			organizationMembers,
			policyPacks,
			runtimeProfiles,
			workspaceTemplateSets,
			tedis,
			workInteractionCardRevisions,
		),
	);
	const event = {
		kind: "ci_red",
		repository: "example/repo",
		branch: "main",
		surface: "full-suite-hourly",
		sha: "a".repeat(40),
		occurredAt: "2026-08-21T11:00:00.000Z",
	};
	sqlite
		.prepare(
			"INSERT INTO projects (id,org_id,key,name,created_at) VALUES ('project','org','ci','Project','2026-08-21T12:00:00.000Z')",
		)
		.run();
	sqlite
		.prepare(
			"UPDATE work_items SET project_id='project', metadata=? WHERE id='work'",
		)
		.run(JSON.stringify({ repositoryObserver: 1, event }));
	sqlite
		.prepare(
			"INSERT INTO work_interactions (id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at) VALUES ('alert','org','work','coordination','Red CI','Failed','tedi','owner','user','human',?)",
		)
		.run(NOW);
	sqlite.exec(`UPDATE work_interactions SET metadata='{"reason":"Failing checks need a decision after diagnosis","notification":{"state":"deferred","reason":"quiet_batch","deliverAt":"2026-08-21T17:00:00.000Z"}}' WHERE id='alert';
		INSERT INTO work_interactions (id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,metadata)
		SELECT 'real-question',org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,'{"reason":"Please check the diagnosis","refreshedAt":"2026-08-22T12:00:00.000Z"}' FROM work_interactions WHERE id='alert';`);
	// Production's update guards: an edit they reject fails here too.
	armInteractionGuards(sqlite);
	const input = {
		...event,
		orgId: "org",
		projectId: "project",
		ownerTediId: "owner",
		escalationUserId: "human",
		sha: "b".repeat(40),
		occurredAt: NOW,
		green: false,
		now: NOW,
	};
	for (const other of [
		{ orgId: "other" },
		{ projectId: "other" },
		{ repository: "other/repo" },
		{ branch: "other" },
		{ surface: "other" },
		{ escalationUserId: "other" },
		{ ownerTediId: "other" },
	]) {
		expect(await refreshRepositoryCiAlerts(db, { ...input, ...other })).toEqual(
			[],
		);
	}
	// Every red run of the period refreshes the same alert, so the coordination
	// expiry window restarts; subject, reason and version stay as created.
	for (const [sha, now] of [
		["b", "2026-08-21T14:00:00.000Z"],
		["c", "2026-08-21T15:00:00.000Z"],
		["c", "2026-08-21T16:00:00.000Z"],
	] as const) {
		const alerts = await refreshRepositoryCiAlerts(db, {
			...input,
			sha: sha.repeat(40),
			occurredAt: now,
			now,
		});
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({
			id: "alert",
			status: "open",
			version: 1,
			subject: "Red CI",
			metadata: {
				reason: "Failing checks need a decision after diagnosis",
				notification: { state: "deferred", refreshedAt: now },
			},
		});
	}
	// 25 h after creation but 21 h after the last red: the alert stays open.
	expect(
		await sweepObsoleteWorkInteractions(db, {
			now: "2026-08-22T13:00:00.000Z",
			limit: 100,
		}),
	).toEqual({ observed: 0, expired: 0 });
	const [recovered] = await refreshRepositoryCiAlerts(db, {
		...input,
		green: true,
	});
	expect(recovered).toMatchObject({
		id: "alert",
		status: "cancelled",
		cancelledAt: NOW,
		version: 2,
		metadata: {
			reason: "Failing checks need a decision after diagnosis",
			notification: { refreshedAt: "2026-08-21T16:00:00.000Z" },
		},
	});
	expect(await refreshRepositoryCiAlerts(db, input)).toEqual([]);
	expect(
		sqlite
			.prepare("SELECT status FROM work_interactions WHERE id='real-question'")
			.get()?.status,
	).toBe("open");
	sqlite.close();
});

it.each([false, true])(
	"guards concurrent first CI alerts and ignores a late still-red report after green (active attempt: %s)",
	async (active) => {
		const { sqlite, db } = fixture();
		sqlite.exec(
			schemaDdl(
				organizationMembers,
				policyPacks,
				runtimeProfiles,
				workspaceTemplateSets,
				tedis,
				workInteractionCardRevisions,
			),
		);
		sqlite.exec(
			"INSERT INTO organization_members (id,organization_id,user_id,descope_user_id,email,status) VALUES ('member','org','human','human','human@example.test','active'); INSERT INTO tedis (id,organization_id,name,slug,status) VALUES ('owner','org','Worker','worker','active'); INSERT INTO projects (id,org_id,key,name,created_at) VALUES ('project','org','ci','Project','2026-08-21T12:00:00.000Z');",
		);
		const p = {
			orgId: "org",
			projectId: "project",
			repository: "example/repo",
			branch: "main",
			surface: "hourly",
			sha: "a".repeat(40),
			occurredAt: NOW,
			now: NOW,
			ownerTediId: "owner",
			escalationUserId: "human",
			subject: "Red CI",
			prompt: "Tests failed",
		};
		const metadata = JSON.stringify({
			repositoryObserver: 1,
			event: { ...p, kind: "ci_red" },
		});
		sqlite
			.prepare(
				"UPDATE work_items SET project_id='project',metadata=? WHERE id='work'",
			)
			.run(metadata);
		sqlite
			.prepare(
				"INSERT INTO work_items (id,org_id,project_id,title,created_at,metadata) VALUES ('work-2','org','project','Red CI',?,?)",
			)
			.run(
				NOW,
				JSON.stringify({
					repositoryObserver: 1,
					event: { ...p, sha: "b".repeat(40), kind: "ci_red" },
				}),
			);
		armInteractionGuards(sqlite);
		await Promise.all([
			createRepositoryCiAlert(db, { ...p, id: "first", workItemId: "work" }),
			createRepositoryCiAlert(db, {
				...p,
				sha: "b".repeat(40),
				id: "second",
				workItemId: "work-2",
			}),
		]);
		expect(
			sqlite
				.prepare(
					"SELECT count(*) AS n FROM work_interactions WHERE status='open' AND id IN ('first','second')",
				)
				.get()?.n,
		).toBe(1);
		if (active)
			sqlite
				.prepare(
					"INSERT INTO work_attempts (id,org_id,work_item_id,attempt_number,runtime_state,started_at,heartbeat_at,executor_type,executor_id) VALUES ('attempt','org','work-2',1,'running',?,?,'tedi','owner')",
				)
				.run(NOW, NOW);
		const later = "2026-08-21T13:00:00.000Z";
		const [refreshed] = await refreshRepositoryCiAlerts(db, {
			...p,
			sha: "c".repeat(40),
			green: false,
			now: later,
		});
		expect(refreshed?.metadata).toMatchObject({
			notification: { refreshedAt: later },
		});
		await settleRecoveredRepositoryCiObservations(db, p);
		expect(
			await refreshRepositoryCiAlerts(db, { ...p, green: true }),
		).toMatchObject([{ id: refreshed?.id, status: "cancelled" }]);
		await createRepositoryCiAlert(db, {
			...p,
			id: "late",
			workItemId: "work-2",
		});
		expect(
			sqlite
				.prepare(
					"SELECT count(*) AS n FROM work_interactions WHERE status='open' AND creator_id='owner'",
				)
				.get()?.n,
		).toBe(0);
		expect(
			sqlite
				.prepare("SELECT disposition FROM work_items WHERE id='work-2'")
				.get()?.disposition,
		).toBe(active ? "proposed" : "cancelled");
		sqlite.close();
	},
);
