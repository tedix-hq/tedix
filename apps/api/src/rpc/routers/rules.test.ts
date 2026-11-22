import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { memoryFacts } from "@tedix/db/schema/memory-graph";
import {
	memoryFactCitations,
	memoryFactCitationBackfills,
} from "@tedix/db/schema/memory-fact-citations";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { listApprovedAgentLessons } from "@tedix/db/queries/memory-graph/agent-lessons";
import { listRuleMiningGuards } from "@tedix/db/queries/memory-graph/rules";
import {
	organizationMemoryWriter,
	storeOrganizationMemoryReview,
} from "../../services/organization-memory-binding";
import { isReplaceableLesson } from "../../services/learning-feed-miner";
import { selectSessionLessons } from "./agent-session-lessons";
import type { BaseContext } from "../orpc";
import { rulesContractRouter } from "./rules";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			memoryFacts,
			organizationMembers,
			memoryFactCitations,
			memoryFactCitationBackfills,
		),
	);
	sqlite.exec(`INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,role,status,kind) VALUES
 ('m1','org-1','owner-sub','owner','owner@example.test','owner','active','human'),
 ('m2','org-1','member-sub','member','member@example.test','member','active','human'),
 ('m3','org-2','foreign-sub','foreign','foreign@example.test','owner','active','human');`);
	const db = createDbClient(createD1Facade(sqlite));
	const context = (
		sub = "owner-sub",
		extra: Partial<BaseContext> = {},
	): BaseContext =>
		({
			db,
			env: { ENVIRONMENT: "test" } as CloudflareEnv,
			headers: new Headers(),
			url: new URL("https://api.example.test"),
			organizationId: "org-1",
			authType: "user",
			user: { sub, roles: [], permissions: [] },
			...extra,
		}) as BaseContext;
	const client = (sub = "owner-sub", extra: Partial<BaseContext> = {}) =>
		createRouterClient(rulesContractRouter, { context: context(sub, extra) });
	const delivered = async (viewerUserId = "owner") =>
		selectSessionLessons(
			await listApprovedAgentLessons(
				db,
				{ organizationId: "org-1" },
				"learning-feed:",
				{ viewerUserId },
			),
			{ harness: "codex", budgetBytes: 12000 },
		).lessons;
	return { sqlite, db, context, client, delivered };
}

for (const scope of ["organization", "personal"] as const)
	describe(`${scope} rule tools`, () => {
		it("create_rule saves written provenance and delivers through the existing session selector", async () => {
			const f = fixture();
			const rule = await f.client().create({
				scope,
				text: "Use plain language in reports.",
				reason: "Shared understanding",
				source: "conversation://example",
			});
			expect(rule).toMatchObject({
				state: "active",
				origin: "written",
				reason: "Shared understanding",
				source: "conversation://example",
				revision: 1,
			});
			expect((await f.delivered()).map((l) => l.id)).toContain(rule.id);
			expect((await f.delivered("member")).some((l) => l.id === rule.id)).toBe(
				scope === "organization",
			);
		});
		it("list_rules returns state and origins with pagination", async () => {
			const f = fixture();
			const client = f.client();
			const a = await client.create({ scope, text: "Keep reports concise." });
			const b = await client.create({ scope, text: "Name decisions plainly." });
			await client.retire({ ruleId: b.id, expectedRevision: b.revision });
			const first = await client.list({ scope, limit: 1 });
			const next = await client.list({
				scope,
				limit: 1,
				offset: first.nextOffset!,
			});
			expect([...first.rules, ...next.rules].map((r) => r.id).sort()).toEqual(
				[a.id, b.id].sort(),
			);
			expect(
				(await client.list({ scope, state: "retired" })).rules,
			).toMatchObject([{ id: b.id, origin: "written", state: "retired" }]);
		});
		it("get_rule reads the stored rule and its history", async () => {
			const f = fixture();
			const client = f.client();
			const rule = await client.create({
				scope,
				text: "Review changes before shipping.",
			});
			expect(await client.get({ ruleId: rule.id })).toEqual(rule);
			expect(rule.history).toMatchObject([{ revision: 1, text: rule.text }]);
		});
		it("update_rule retains the old text and rejects an outdated revision", async () => {
			const f = fixture();
			const client = f.client();
			const rule = await client.create({ scope, text: "Keep reports short." });
			const updated = await client.update({
				ruleId: rule.id,
				expectedRevision: rule.revision,
				text: "Include evidence in reports.",
			});
			expect(updated.history.map((r) => r.text)).toEqual([
				rule.text,
				updated.text,
			]);
			await expect(
				client.update({
					ruleId: rule.id,
					expectedRevision: 1,
					text: "A stale edit.",
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect((await f.delivered()).find((l) => l.id === rule.id)?.text).toBe(
				updated.text,
			);
		});
		it("retire_rule removes delivery but keeps a mining guard", async () => {
			const f = fixture();
			const client = f.client();
			const rule = await client.create({
				scope,
				text: "Keep source evidence.",
			});
			expect(
				(
					await client.retire({
						ruleId: rule.id,
						expectedRevision: rule.revision,
					})
				).state,
			).toBe("retired");
			expect(await f.delivered()).toEqual([]);
			const [guard] = await listRuleMiningGuards(
				f.db,
				{ organizationId: "org-1" },
				"owner",
			);
			expect(guard?.id).toBe(rule.id);
			expect(isReplaceableLesson(guard!)).toBe(false);
		});
		it("restore_rule delivers the retained text again", async () => {
			const f = fixture();
			const client = f.client();
			const rule = await client.create({
				scope,
				text: "Keep decisions visible.",
			});
			const retired = await client.retire({
				ruleId: rule.id,
				expectedRevision: rule.revision,
			});
			expect(
				(
					await client.restore({
						ruleId: rule.id,
						expectedRevision: retired.revision,
					})
				).state,
			).toBe("active");
			expect((await f.delivered()).map((l) => l.id)).toContain(rule.id);
		});
	});

it("approve_rule allows only a human owner/admin and gates every agent-written team revision", async () => {
	const f = fixture();
	const owner = f.client();
	const agent = f.client("owner-sub", {
		externalAgentPrincipalId: "agent-1",
		externalAgentSessionId: "session-1",
	});
	const rule = await agent.create({
		scope: "organization",
		text: "Keep evidence with each decision.",
	});
	expect(rule.state).toBe("pending");
	expect(await f.delivered()).toEqual([]);
	await expect(
		agent.approve({ ruleId: rule.id, expectedRevision: rule.revision }),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		f
			.client("member-sub")
			.approve({ ruleId: rule.id, expectedRevision: rule.revision }),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	let approved = await owner.approve({
		ruleId: rule.id,
		expectedRevision: rule.revision,
	});
	expect(approved.state).toBe("active");
	expect((await f.delivered()).map((l) => l.id)).toContain(rule.id);
	const changed = await agent.update({
		ruleId: rule.id,
		expectedRevision: approved.revision,
		text: "Keep evidence with every release.",
	});
	expect(changed.state).toBe("pending");
	expect(await f.delivered()).toEqual([]);
	approved = await owner.approve({
		ruleId: rule.id,
		expectedRevision: changed.revision,
	});
	const retired = await agent.retire({
		ruleId: rule.id,
		expectedRevision: approved.revision,
	});
	const restored = await agent.restore({
		ruleId: rule.id,
		expectedRevision: retired.revision,
	});
	expect(restored.state).toBe("pending");
	expect(await f.delivered()).toEqual([]);
	f.sqlite.exec(
		"UPDATE organization_members SET role = 'admin' WHERE id = 'm2'",
	);
	expect(
		(
			await f
				.client("member-sub")
				.approve({ ruleId: rule.id, expectedRevision: restored.revision })
		).state,
	).toBe("active");
});

it("isolates private rules and other organizations, including writes", async () => {
	const f = fixture();
	const rule = await f
		.client()
		.create({ scope: "personal", text: "Prefer concise answers." });
	for (const client of [
		f.client("member-sub"),
		f.client("foreign-sub", { organizationId: "org-2" }),
	]) {
		expect((await client.list({})).rules).toEqual([]);
		await expect(client.get({ ruleId: rule.id })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			client.retire({ ruleId: rule.id, expectedRevision: 1 }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	}
});

it("keeps the evidence of an edited mined rule for retirement and blocks alternate memory writers", async () => {
	const f = fixture();
	const id = crypto.randomUUID();
	await f.db.insert(memoryFacts).values({
		id,
		organizationId: "org-1",
		content: "Earlier mined lesson",
		factType: "preference",
		topicKey: "learning-feed:decision:general:general:reports:user:owner",
		visibility: "private",
		reviewStatus: "confirmed",
		usePolicy: "can_use_as_instruction",
		metadata: {
			learningFeed: {
				ownerUserId: "owner",
				autoConfirmed: true,
				evidenceEventIds: ["history-1"],
				rules: [{ key: "communication.reports", text: "Old keyed text" }],
			},
		},
	});
	const updated = await f.client().update({
		ruleId: id,
		expectedRevision: 1,
		text: "Include evidence in reports.",
	});
	expect(updated.origin).toBe("mined");
	expect(updated.history[0]?.text).toBe("Earlier mined lesson");
	expect((await f.delivered()).find((l) => l.id === id)?.text).toBe(
		updated.text,
	);
	await f.client().retire({ ruleId: id, expectedRevision: updated.revision });
	const [guard] = await listRuleMiningGuards(
		f.db,
		{ organizationId: "org-1" },
		"owner",
	);
	expect(guard?.metadata?.learningFeed).toMatchObject({
		evidenceEventIds: ["history-1"],
		retired: true,
	});
	const [fact] = await f.db.select().from(memoryFacts);
	await expect(
		organizationMemoryWriter(f.context(), "memory_graph_promote").update(
			fact!,
			{ reviewStatus: "confirmed" },
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		storeOrganizationMemoryReview(
			f.db,
			fact!,
			{ reviewStatus: "confirmed" },
			{ id: "agent", kind: "external_agent", organizationId: "org-1" },
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("lets a gateway agent manage only its authenticated person's personal rules", async () => {
	const f = fixture();
	const agent = f.client("owner-sub", {
		externalAgentPrincipalId: "agent",
		gatewayEndUserId: "owner",
	});
	const other = f.client("member-sub", {
		externalAgentPrincipalId: "other-agent",
		gatewayEndUserId: "member",
	});
	const rule = await agent.create({
		scope: "personal",
		text: "Use plain language.",
	});
	expect(rule).toMatchObject({ ownerUserId: "owner", state: "active" });
	await expect(
		other.update({
			ruleId: rule.id,
			expectedRevision: 1,
			text: "An unauthorized edit.",
		}),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	const changed = await agent.update({
		ruleId: rule.id,
		expectedRevision: rule.revision,
		text: "Use plain language in reports.",
	});
	const retired = await agent.retire({
		ruleId: rule.id,
		expectedRevision: changed.revision,
	});
	expect(
		(
			await agent.restore({
				ruleId: rule.id,
				expectedRevision: retired.revision,
			})
		).state,
	).toBe("active");
});

it("includes legacy team lessons whose default private visibility has no personal owner", async () => {
	const f = fixture();
	const id = crypto.randomUUID();
	await f.db.insert(memoryFacts).values({
		id,
		organizationId: "org-1",
		content: "A legacy team lesson.",
		factType: "preference",
		topicKey: "learning-feed:decision:general:general:legacy",
		reviewStatus: "confirmed",
		usePolicy: "can_use_as_instruction",
	});
	expect(
		(await f.client().list({ scope: "organization" })).rules,
	).toMatchObject([{ id, scope: "organization", origin: "mined" }]);
	expect((await f.client().list({ scope: "personal" })).rules).toEqual([]);
});
