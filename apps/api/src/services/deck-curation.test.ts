import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { expect, it } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import {
	curateDeckCard,
	curationInbox,
	rankCurationInbox,
} from "./deck-curation";
import { reviseCardContent } from "./card-revisions";

const org = "11111111-1111-4111-8111-111111111111";
const work = "22222222-2222-4222-8222-222222222222";
const agent = "33333333-3333-4333-8333-333333333333";
const card = "44444444-4444-4444-8444-444444444444";
function fixture(metadata: Record<string, unknown> = {}) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=ON");
	const migrations = new URL(
		"../../../../packages/db/drizzle/",
		import.meta.url,
	);
	for (const name of readdirSync(migrations).sort())
		sqlite.exec(
			readFileSync(new URL(`${name}/migration.sql`, migrations), "utf8"),
		);
	sqlite.exec(
		`INSERT INTO organizations(id,name,slug) VALUES('${org}','Fictional','fictional'); INSERT INTO users(id,email) VALUES('person','person@example.test'),('other','other@example.test'); INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status,role) VALUES('member','${org}','person-sub','person','person@example.test','active','owner'),('other-member','${org}','other-sub','other','other@example.test','active','member'); INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('${agent}','${org}','Draft author','draft-author','active'); INSERT INTO work_items(id,org_id,title,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES('${work}','${org}','Draft','hygiene','2027-01-01T00:00:00.000Z','fixture','2026-10-19T00:00:00.000Z'); INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at) VALUES('${card}','${org}','${work}','question','Review this draft?','Original text','tedi','${agent}','user','person','2026-10-19T00:00:00.000Z');`,
	);
	sqlite.prepare("UPDATE organizations SET metadata=? WHERE id=?").run(
		JSON.stringify({
			decisionLearning: {
				deckCurators: [
					{
						tediId: agent,
						recipientId: "person",
						gadgetId: work,
						enabled: true,
					},
				],
			},
		}),
		org,
	);
	if (Object.keys(metadata).length) {
		sqlite
			.prepare(
				"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
			)
			.run(
				successor,
				org,
				work,
				"question",
				"Critical decision?",
				"Money requires you",
				"tedi",
				agent,
				"user",
				"person",
				"2026-10-19T00:00:00.000Z",
				JSON.stringify(metadata),
			);
	}
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
	return {
		sqlite,
		context: {
			...base,
			authType: "service-binding",
			tediId: agent,
			tediScopes: ["mcp:messaging.read", "mcp:messaging.write"],
			headers: new Headers({ "X-Service-Binding": "true" }),
		} as BaseContext,
		humanContext: {
			...base,
			authType: "user",
			userId: "person",
			userRole: "owner",
			user: { sub: "person-sub" },
		} as BaseContext,
		sent,
	};
}
const scope = { recipientId: "person", gadgetId: work };
const input = {
	...scope,
	requestId: card,
	expectedRequestVersion: 1,
	expectedRevision: 0,
	reason: "A newer template replaces this draft",
	evidenceRefs: ["https://example.test/new-template"],
};
const successor = "55555555-5555-4555-8555-555555555555";
it("skips recently revised cards during writes and ranking", async () => {
	const { sqlite, context } = fixture();
	try {
		await curateDeckCard(context, { ...input, body: "Reviewed story." });
		const cutoff = new Date(Date.now() - 3600000).toISOString();
		await expect(
			curateDeckCard(context, {
				...input,
				expectedRequestVersion: 2,
				expectedRevision: 2,
				skipRevisedSince: cutoff,
				body: "Do not overwrite the morning review.",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const result = await rankCurationInbox(context, {
			...scope,
			skipRevisedSince: cutoff,
		});
		expect(result.signals).toEqual([
			{
				cardId: card,
				label: null,
				penalty: 0,
				reason: "recently_revised",
				exampleIds: [],
			},
		]);
		expect(result.reservedMicros).toBe(0);
	} finally {
		sqlite.close();
	}
});
it("enforces the active recipient and gadget grant, and withholds decision actions", async () => {
	const { sqlite, context } = fixture();
	try {
		const inbox = await curationInbox(context, scope);
		expect(inbox.complete).toBe(true);
		expect(inbox.items).toHaveLength(1);
		expect(inbox.items[0]).toMatchObject({
			canRespond: false,
			canCancel: false,
		});
		await expect(
			curateDeckCard(context, {
				...input,
				gadgetId: successor,
				body: "Short story.",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			curateDeckCard(context, {
				...input,
				recipientId: "other",
				body: "Short story.",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		sqlite
			.prepare("UPDATE organizations SET metadata='{}' WHERE id=?")
			.run(org);
		await expect(
			curateDeckCard(context, { ...input, body: "Short story." }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	} finally {
		sqlite.close();
	}
});
it("supersedes without responding and restores through immutable card history", async () => {
	const { sqlite, context, humanContext } = fixture();
	try {
		sqlite
			.prepare(
				"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at) SELECT ?,org_id,work_item_id,kind,'Newer template','The replacement template',creator_type,creator_id,target_type,target_id,created_at FROM work_interactions WHERE id=?",
			)
			.run(successor, card);
		const revision = await curateDeckCard(context, {
			...input,
			body: "The team needs one current template. Recommend the linked replacement because it supersedes this draft today.",
			successorId: successor,
		});
		expect(revision.revision).toBe(2);
		expect(JSON.parse(revision.instruction!).successorId).toBe(successor);
		expect(
			sqlite
				.prepare("SELECT status,version FROM work_interactions WHERE id=?")
				.get(card),
		).toMatchObject({ status: "cancelled", version: 2 });
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM work_interaction_responses")
				.get(),
		).toMatchObject({ n: 0 });
		await expect(
			curateDeckCard(context, { ...input, body: "Stale write." }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const restored = await reviseCardContent(humanContext, {
			requestId: card,
			expectedRequestVersion: 2,
			expectedRevision: 2,
			restoreRevision: 1,
		});
		expect(restored).toMatchObject({
			revision: 3,
			body: "Original text",
			cause: "restore",
		});
		expect(
			sqlite
				.prepare("SELECT status,version FROM work_interactions WHERE id=?")
				.get(card),
		).toMatchObject({ status: "open", version: 3 });
		expect((await curationInbox(context, scope)).items).toHaveLength(2);
	} finally {
		sqlite.close();
	}
});
it("refuses critical supersession and long stories", async () => {
	const { sqlite, context } = fixture({ protectedEffects: ["money"] });
	try {
		await expect(
			curateDeckCard(context, {
				...input,
				body: Array(61).fill("word").join(" "),
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			curateDeckCard(context, {
				...input,
				requestId: successor,
				successorId: card,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	} finally {
		sqlite.close();
	}
});
