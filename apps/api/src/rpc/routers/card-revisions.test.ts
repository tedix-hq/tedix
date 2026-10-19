import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { workInteractionsContractRouter } from "./work-interactions";

const org = "11111111-1111-4111-8111-111111111111";
const work = "22222222-2222-4222-8222-222222222222";
const agent = "33333333-3333-4333-8333-333333333333";
const card = "44444444-4444-4444-8444-444444444444";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=ON");
	const migrations = new URL(
		"../../../../../packages/db/drizzle/",
		import.meta.url,
	);
	for (const name of readdirSync(migrations).sort())
		sqlite.exec(
			readFileSync(new URL(`${name}/migration.sql`, migrations), "utf8"),
		);
	sqlite.exec(
		`INSERT INTO organizations(id,name,slug) VALUES('${org}','Fictional','fictional'); INSERT INTO users(id,email) VALUES('person','person@example.test'),('other','other@example.test'); INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status,role) VALUES('member','${org}','person-sub','person','person@example.test','active','owner'),('other-member','${org}','other-sub','other','other@example.test','active','member'); INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('${agent}','${org}','Draft author','draft-author','active'); INSERT INTO work_items(id,org_id,title,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES('${work}','${org}','Draft','hygiene','2027-01-01T00:00:00.000Z','fixture','2026-10-19T00:00:00.000Z'); INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at) VALUES('${card}','${org}','${work}','question','Review this draft?','Original text','tedi','${agent}','user','person','2026-10-19T00:00:00.000Z');`,
	);
	const db = createDbClient(createD1Facade(sqlite));
	const sent: unknown[] = [];
	const base = {
		db,
		env: {
			AUTOMATION_EVENTS: {
				send: async (event: unknown) => {
					sent.push(event);
				},
			},
		},
		headers: new Headers(),
		organizationId: org,
		url: new URL("https://api.example.test/rpc"),
	};
	const human = (id: string) =>
		createRouterClient(workInteractionsContractRouter, {
			context: {
				...base,
				authType: "user",
				userId: id,
				userRole: "owner",
				user: { sub: `${id}-sub` },
			} as BaseContext,
		});
	const owner = createRouterClient(workInteractionsContractRouter, {
		context: {
			...base,
			headers: new Headers({ "X-Service-Binding": "true" }),
			authType: "service-binding",
			tediId: agent,
			tediScopes: ["mcp:messaging.read", "mcp:messaging.write"],
		} as BaseContext,
	});
	return {
		sqlite,
		target: human("person"),
		other: human("other"),
		owner,
		sent,
	};
}
it("delivers feedback without deciding, accepts only the owning rewrite, preserves history and restores as a new version", async () => {
	const { sqlite, target, other, owner, sent } = fixture();
	try {
		await expect(
			other.requestCardChanges({
				requestId: card,
				expectedRequestVersion: 1,
				instruction: "Shorter please",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const asked = await target.requestCardChanges({
			requestId: card,
			expectedRequestVersion: 1,
			instruction: "Shorter please",
		});
		expect(asked).toMatchObject({ id: card, state: "open", version: 2 });
		expect(sent).toHaveLength(1);
		const history = await target.cardHistory({ requestId: card });
		expect(history.pending?.instruction).toBe("Shorter please");
		await expect(
			owner.reviseCard({
				requestId: card,
				expectedRequestVersion: 2,
				expectedRevision: 1,
				body: "Short text",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const rewritten = await owner.reviseCard({
			requestId: card,
			expectedRequestVersion: 2,
			expectedRevision: 1,
			responseId: history.pending!.responseId,
			body: "Short text",
		});
		expect(rewritten).toMatchObject({
			revision: 2,
			cause: "agent_rewrite",
			instruction: "Shorter please",
		});
		expect((await target.cardHistory({ requestId: card })).pending).toBeNull();
		const restored = await target.reviseCard({
			requestId: card,
			expectedRequestVersion: 3,
			expectedRevision: 2,
			restoreRevision: 1,
		});
		expect(restored).toMatchObject({
			revision: 3,
			body: "Original text",
			cause: "restore",
		});
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM work_interactions").get()?.n,
		).toBe(1);
		expect(
			sqlite
				.prepare(
					"SELECT count(*) AS n FROM learning_interaction_events WHERE client_event_id LIKE 'card-revision:%'",
				)
				.get()?.n,
		).toBe(2);
		expect(
			sqlite
				.prepare(
					"SELECT DISTINCT scope_id FROM learning_interaction_events WHERE client_event_id LIKE 'card-revision:%'",
				)
				.get()?.scope_id,
		).toBe("person-sub");
		expect(() =>
			sqlite.exec(
				"UPDATE work_interaction_card_revisions SET body='changed' WHERE revision=1",
			),
		).toThrow("append-only");
		expect(() =>
			sqlite.exec(
				"DELETE FROM work_interaction_card_revisions WHERE revision=1",
			),
		).toThrow("append-only");
	} finally {
		sqlite.close();
	}
});

it("versions a structured plan together with its visible text and restores both", async () => {
	const { sqlite, target, owner } = fixture();
	const planCard = "55555555-5555-4555-8555-555555555555";
	const original = {
		key: "fictional-plan",
		item: { title: "First task", sourceIntentId: "fictional-plan:first" },
		children: [],
	};
	const revised = {
		...original,
		item: { ...original.item, title: "Revised task" },
	};
	try {
		sqlite
			.prepare(
				"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,metadata) VALUES(?,?,?,'handoff','Start this plan?','Create the first task.','tedi',?,'user','person','2026-10-19T00:00:00.000Z',?)",
			)
			.run(
				planCard,
				org,
				work,
				agent,
				JSON.stringify({
					schema: "tedix.work-proposal.v1",
					proposal: original,
				}),
			);
		const asked = await target.requestCardChanges({
			requestId: planCard,
			expectedRequestVersion: 1,
			instruction: "Change the task title",
		});
		expect(asked.state).toBe("open");
		const history = await target.cardHistory({ requestId: planCard });
		const input = {
			requestId: planCard,
			expectedRequestVersion: 2,
			expectedRevision: 1,
			responseId: history.pending!.responseId,
			body: "Create the revised task.",
		};
		await expect(owner.reviseCard(input)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		const version = await owner.reviseCard({ ...input, proposal: revised });
		expect(version.proposal?.item.title).toBe("Revised task");
		const current = await target.get({ requestId: planCard });
		expect(current.request.metadata.proposal).toMatchObject({
			item: { title: "Revised task" },
		});
		await target.reviseCard({
			requestId: planCard,
			expectedRequestVersion: 3,
			expectedRevision: 2,
			restoreRevision: 1,
		});
		const restored = await target.get({ requestId: planCard });
		expect(restored.request.metadata).toMatchObject({
			cardContent: "Create the first task.",
			proposal: original,
		});
		expect(() =>
			sqlite
				.prepare(
					"UPDATE work_interactions SET metadata=json_set(metadata,'$.proposal.item.title','Unversioned task') WHERE id=?",
				)
				.run(planCard),
		).toThrow();
	} finally {
		sqlite.close();
	}
});
