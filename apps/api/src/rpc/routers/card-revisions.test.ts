import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { workInteractionsContractRouter } from "./work-interactions";

const styleModel = vi.hoisted(() => ({
	run: vi
		.fn<(...args: [unknown, string, unknown]) => Promise<string | null>>()
		.mockResolvedValue("Prefer short sentences without a sign-off."),
}));
vi.mock("../../services/lesson-distiller", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../services/lesson-distiller")>()),
	runDistillModel: styleModel.run,
}));

// Build the shared migration template during collection, before timing router
// behavior. Each fixture below still receives an independent writable copy.
createMigratedSqlite().close();

const org = "11111111-1111-4111-8111-111111111111";
const work = "22222222-2222-4222-8222-222222222222";
const agent = "33333333-3333-4333-8333-333333333333";
const card = "44444444-4444-4444-8444-444444444444";
function fixture() {
	const sqlite = createMigratedSqlite();
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
		db,
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
			chips: ["Shorter"],
			anchors: [
				{
					quote: "Original",
					prefix: "",
					suffix: " text",
					field: "draft",
					note: "Keep the facts",
				},
			],
		});
		expect(asked).toMatchObject({ id: card, state: "open", version: 2 });
		expect(sent).toHaveLength(1);
		expect(JSON.stringify(sent)).toContain("Keep the facts");
		expect(JSON.stringify(sent)).toContain(
			"facts, recipients, dates, amounts or the ASK",
		);
		const responseMetadata = sqlite
			.prepare(
				"SELECT metadata FROM work_interaction_responses WHERE interaction_id=?",
			)
			.get(card)!;
		expect(JSON.parse(String(responseMetadata.metadata))).toMatchObject({
			chips: ["Shorter"],
			anchors: [{ quote: "Original", note: "Keep the facts" }],
		});
		const retried = sqlite
			.prepare(
				"SELECT event_kind,metadata FROM learning_interaction_events WHERE event_kind='retried'",
			)
			.all();
		expect(retried).toHaveLength(1);
		expect(JSON.parse(String(retried[0]!.metadata))).toMatchObject({
			fromRevision: 1,
			instruction: "Shorter please",
			chips: ["Shorter"],
			anchors: [{ quote: "Original" }],
		});
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
			summary: "Shortened the draft.",
			anchorsResolved: [{ index: 0, status: "done" }],
		});
		expect(rewritten).toMatchObject({
			revision: 2,
			cause: "agent_rewrite",
			instruction: "Shorter please",
		});
		expect((await target.cardHistory({ requestId: card })).pending).toBeNull();
		const listed = await target.listCardVersions({ requestId: card });
		expect(listed.markdown).toContain("What changed: Shortened the draft.");
		expect(listed.markdown).toContain("-Original text");
		expect(listed.markdown).toContain("+Short text");
		await expect(
			other.listCardVersions({ requestId: card }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			(await owner.listCardVersions({ requestId: card })).revisions,
		).toHaveLength(2);
		expect(rewritten.summary).toBe("Shortened the draft.");
		expect(rewritten.anchorsResolved).toEqual([{ index: 0, status: "done" }]);
		expect(rewritten.parentRevision).toBe(1);
		expect(rewritten.learningEventId).toBeTruthy();
		expect(
			(await target.cardHistory({ requestId: card, beforeRevision: 2 }))
				.pending,
		).toBeNull();
		const paired = sqlite
			.prepare("SELECT metadata FROM learning_interaction_events WHERE id=?")
			.get(rewritten.learningEventId!)!;
		expect(JSON.parse(String(paired.metadata))).toMatchObject({
			revision: 2,
			fromRevision: 1,
			parentRevision: 1,
			summary: "Shortened the draft.",
			anchors: [{ quote: "Original" }],
		});
		const kept = await target.reviseCard({
			requestId: card,
			expectedRequestVersion: 3,
			expectedRevision: 2,
			body: "Original text",
			keptHunks: [
				{
					fromRevision: 2,
					index: 0,
					original: "Original",
					replacement: "Short",
				},
			],
		});
		expect(
			sqlite
				.prepare(
					"SELECT event_kind FROM learning_interaction_events WHERE id=?",
				)
				.get(kept.learningEventId!)?.event_kind,
		).toBe("edited");
		expect(kept).toMatchObject({
			revision: 3,
			cause: "human_edit",
			keptHunks: [{ fromRevision: 2, index: 0 }],
			parentRevision: 2,
		});
		const restored = await target.reviseCard({
			requestId: card,
			expectedRequestVersion: 4,
			expectedRevision: 3,
			restoreRevision: 1,
		});
		expect(
			sqlite
				.prepare(
					"SELECT event_kind FROM learning_interaction_events WHERE id=?",
				)
				.get(restored.learningEventId!)?.event_kind,
		).toBe("undone");
		expect(restored).toMatchObject({
			revision: 4,
			body: "Original text",
			cause: "restore",
			parentRevision: 1,
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
		).toBe(3);
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

it("releases a card whose owner never applies the change request", async () => {
	const { sqlite, target } = fixture();
	try {
		await target.requestCardChanges({
			requestId: card,
			expectedRequestVersion: 1,
			instruction: "Shorter please",
		});
		await expect(
			target.requestCardChanges({
				requestId: card,
				expectedRequestVersion: 2,
				instruction: "Shorter still",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 16 * 60_000 });
		const history = await target.cardHistory({ requestId: card });
		expect(history.pending).toBeNull();
		expect(history.stalled?.instruction).toBe("Shorter please");
		await expect(
			target.requestCardChanges({
				requestId: card,
				expectedRequestVersion: 2,
				instruction: "Shorter still",
			}),
		).resolves.toMatchObject({ version: 3 });
	} finally {
		vi.useRealTimers();
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
		await expect(
			target.respond({
				requestId: planCard,
				expectedRequestVersion: 2,
				responseKind: "handoff_accepted",
				body: "Start this plan",
				resolvesRequest: true,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(
			sqlite.prepare("SELECT COUNT(*) AS count FROM work_items").get()?.count,
		).toBe(1);
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

it("remembers only an explicit personal style directive and removes it from future prompts on Not true", async () => {
	const { sqlite, db, target, other, owner } = fixture();
	try {
		await target.requestCardChanges({
			requestId: card,
			expectedRequestVersion: 1,
			instruction: "Use short sentences without a sign-off",
		});
		const history = await target.cardHistory({ requestId: card });
		await owner.reviseCard({
			requestId: card,
			expectedRequestVersion: 2,
			expectedRevision: 1,
			responseId: history.pending!.responseId,
			body: "Short draft.",
			summary: "Shortened the sentences and removed the sign-off.",
		});
		const input = {
			requestId: card,
			expectedRevision: 2,
			contentKind: "email" as const,
		};
		expect((await target.cardHistory({ requestId: card })).styleRules).toEqual(
			[],
		);
		await expect(owner.rememberCardStyle(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(other.rememberCardStyle(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		styleModel.run.mockClear();
		const rule = await target.rememberCardStyle(input);
		expect(styleModel.run.mock.calls[0]?.[1]).toContain("Short draft.");
		expect(styleModel.run.mock.calls[0]?.[1]).toContain("Original text");
		expect(rule).toMatchObject({
			contentKind: "email",
			status: "active",
			sourceRevision: 2,
		});
		expect((await target.rememberCardStyle(input)).id).toBe(rule.id);
		expect(styleModel.run).toHaveBeenCalledTimes(1);
		expect(
			(await target.cardHistory({ requestId: card })).styleRules,
		).toHaveLength(1);
		expect((await owner.cardHistory({ requestId: card })).styleRules).toEqual(
			[],
		);
		const proposal = sqlite
			.prepare(
				"SELECT scope_kind,scope_id,subject_kind,promotion_route,status FROM learning_improvement_proposals WHERE id=?",
			)
			.get(rule.proposalId);
		expect(proposal).toMatchObject({
			scope_kind: "personal",
			scope_id: "person-sub",
			subject_kind: "directive",
			promotion_route: "directive_governance",
			status: "approved_for_handoff",
		});
		const { readDraftPreferences } =
			await import("../../services/decision-learning");
		expect(await readDraftPreferences(db, org, "person", "email")).toContain(
			"without a sign-off",
		);
		expect(await readDraftPreferences(db, org, "other", "email")).not.toContain(
			"without a sign-off",
		);
		expect(
			(
				await target.reviewCardStyleRule({
					requestId: card,
					ruleId: rule.id,
					decision: "keep",
				})
			).status,
		).toBe("active");
		await expect(
			other.reviewCardStyleRule({
				requestId: card,
				ruleId: rule.id,
				decision: "not_true",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			(
				await target.reviewCardStyleRule({
					requestId: card,
					ruleId: rule.id,
					decision: "not_true",
				})
			).status,
		).toBe("rejected");
		expect(
			sqlite
				.prepare("SELECT status FROM learning_improvement_proposals WHERE id=?")
				.get(rule.proposalId)?.status,
		).toBe("rejected");
		expect((await target.cardHistory({ requestId: card })).styleRules).toEqual(
			[],
		);
		expect(
			await readDraftPreferences(db, org, "person", "email"),
		).not.toContain("without a sign-off");
		expect(
			sqlite
				.prepare("SELECT version FROM work_interactions WHERE id=?")
				.get(card)?.version,
		).toBe(3);
		await target.reviseCard({
			requestId: card,
			expectedRequestVersion: 3,
			expectedRevision: 2,
			body: "Original text",
			keptHunks: [
				{
					fromRevision: 2,
					index: 0,
					original: "Original text",
					replacement: "Short draft.",
				},
			],
		});
		await expect(
			target.rememberCardStyle({ ...input, expectedRevision: 3 }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(styleModel.run).toHaveBeenCalledTimes(1);
		await target.reviseCard({
			requestId: card,
			expectedRequestVersion: 4,
			expectedRevision: 3,
			body: "A new short draft.",
		});
		styleModel.run.mockResolvedValueOnce("NONE");
		await expect(
			target.rememberCardStyle({ ...input, expectedRevision: 4 }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		styleModel.run.mockResolvedValueOnce("Prefer contact jamie@example.test.");
		await expect(
			target.rememberCardStyle({ ...input, expectedRevision: 4 }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect((await target.cardHistory({ requestId: card })).styleRules).toEqual(
			[],
		);
		styleModel.run.mockResolvedValueOnce("Prefer short paragraphs.");
		expect(
			(await target.rememberCardStyle({ ...input, expectedRevision: 4 })).text,
		).toContain("Prefer short paragraphs.");
	} finally {
		sqlite.close();
	}
});
