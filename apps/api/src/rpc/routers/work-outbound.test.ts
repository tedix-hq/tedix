import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { organizations } from "@tedix/db/schema/organizations";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { tedis } from "@tedix/db/schema/tedis";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
import { workItems, workEvents } from "@tedix/db/schema/work-items";
import {
	workInteractions,
	workInteractionResponses,
} from "@tedix/db/schema/work-factory";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, vi, beforeEach } from "vite-plus/test";
import { type OutboundState } from "@tedix/api-contract/schemas/outbound";
import type { BaseContext } from "../orpc";
import { outboundRouter } from "./work-outbound";

const gmail = vi.hoisted(() => ({
	credential: vi.fn(async () => "fictional-token"),
	send: vi.fn(async () => "sent-fictional-message"),
}));
vi.mock("../../services/outbound-gmail", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../services/outbound-gmail")>()),
	outboundGmailCredential: gmail.credential,
	sendOutboundGmail: gmail.send,
}));
const ORG = "11111111-1111-4111-8111-111111111111";
const WORK = "22222222-2222-4222-8222-222222222222";
const REVIEWER = "33333333-3333-4333-8333-333333333333";
const QUESTION = "44444444-4444-4444-8444-444444444444";
const ACCOUNT = "55555555-5555-4555-8555-555555555555";
const state: OutboundState = {
	schema: "tedix.outbound.v1",
	draft: {
		channel: "email",
		topic: "partners",
		recipient: "lina@example.test",
		subject: "Thanks",
		body: "Hi Lina, thank you for the conversation. Rosa",
		reasoning: "Requested follow-up",
		sources: [{ uri: "work://fictional", fact: "Lina asked for a summary" }],
		risks: [],
	},
	draftRevision: 1,
	author: { type: "external_agent", id: "fictional-author" },
	ownerUserId: "rosa",
	reviewerTediId: REVIEWER,
	interactionId: QUESTION,
	status: "waiting_on_you",
	review: {
		draftRevision: 1,
		verdict: "ready",
		notes: "Ready for Rosa",
		voice: "Matches Rosa's examples",
		grounding: "Fictional meeting checked",
		risks: "No prices or promises",
		reviewerTediId: REVIEWER,
		reviewedAt: "2026-10-17T10:00:00Z",
	},
};

function fixture(overrides: Partial<OutboundState> = {}) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			organizations,
			organizationMembers,
			tedis,
			userConfigs,
			learningInteractionEvents,
			workItems,
			workEvents,
			workInteractions,
			workInteractionResponses,
		),
	);
	sqlite
		.prepare("INSERT INTO organizations(id,name,slug,metadata) VALUES(?,?,?,?)")
		.run(
			ORG,
			"Harbor",
			"harbor",
			JSON.stringify({
				outboundReview: {
					routes: [{ channel: "email", reviewerTediId: REVIEWER }],
					gmailProviderId: "fictional-gmail",
				},
			}),
		);
	for (const user of ["rosa", "lina"])
		sqlite
			.prepare(
				"INSERT INTO organization_members(id,organization_id,user_id,descope_user_id,email,status,role) VALUES(?,?,?,?,?,'active','owner')",
			)
			.run(`member-${user}`, ORG, user, `${user}-sub`, `${user}@example.test`);
	sqlite
		.prepare(
			"INSERT INTO tedis(id,organization_id,name,slug,status) VALUES(?,?,?,?,'active')",
		)
		.run(REVIEWER, ORG, "Partner reviewer", "partner-reviewer");
	sqlite
		.prepare(
			"INSERT INTO work_items(id,org_id,title,work_kind,created_at,metadata) VALUES(?,?,?,'outbound',?,?)",
		)
		.run(
			WORK,
			ORG,
			"Reply to Lina",
			"2026-10-17T10:00:00Z",
			JSON.stringify({ outbound: { ...state, ...overrides } }),
		);
	sqlite
		.prepare(
			"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at) VALUES(?,?,?,'question','Review reply','Draft','user','rosa','user','rosa',?)",
		)
		.run(QUESTION, ORG, WORK, "2026-10-17T10:00:00Z");
	const queue = vi.fn(
		async (_event: { idempotencyKey: string; conversationId: string }) => {},
	);
	const db = createDbClient(createD1Facade(sqlite));
	const client = (who = "rosa", organizationId = ORG, tedi = false) =>
		createRouterClient(outboundRouter, {
			context: {
				db,
				authType: tedi ? "tedi" : "user",
				...(tedi
					? {}
					: { userId: who, user: { sub: `${who}-sub` }, userRole: "owner" }),
				organizationId,
				headers: new Headers(
					tedi
						? {
								"X-Service-Binding": "true",
								"X-Tedix-Mcp-Tool-Id": "work:review_outbound_draft",
								"X-Tedix-Tedi-Id": who,
								"X-Tedix-Tedi-Scopes": "mcp:work.write mcp:messaging.read",
							}
						: {},
				),
				url: new URL("https://api.example.test/rpc"),
				env: {
					AUTOMATION_EVENTS: { send: queue },
					MEMORY_REFLECTION_WORKFLOW: {
						create: async () => ({ id: "fictional-reflection" }),
					},
				},
			} as unknown as BaseContext,
		});
	return { sqlite, client, queue };
}

beforeEach(() => {
	gmail.send.mockReset().mockResolvedValue("sent-fictional-message");
	gmail.credential.mockClear();
});

describe("outbound authorization and delivery", () => {
	it("gives an authorized review retry a fresh execution and conversation without changing the draft", async () => {
		const { client, queue } = fixture({ status: "reviewing", review: null });
		await expect(
			client("lina").requestReview({ workItemId: WORK, expectedVersion: 1 }),
		).rejects.toThrow(/author, owner or reviewer/);
		expect(queue).not.toHaveBeenCalled();
		const first = await client().requestReview({
			workItemId: WORK,
			expectedVersion: 1,
		});
		expect(first.version).toBe(2);
		expect(first.outbound).toEqual({
			...state,
			status: "reviewing",
			review: null,
		});
		await expect(
			client().requestReview({ workItemId: WORK, expectedVersion: 1 }),
		).rejects.toThrow(/current pending draft/);
		const second = await client().requestReview({
			workItemId: WORK,
			expectedVersion: first.version,
		});
		expect(second.version).toBe(3);
		expect(second.outbound).toEqual(first.outbound);
		expect(queue.mock.calls.map(([event]) => event.idempotencyKey)).toEqual([
			`outbound:${WORK}:2`,
			`outbound:${WORK}:3`,
		]);
		expect(queue.mock.calls.map(([event]) => event.conversationId)).toEqual([
			`outbound:${WORK}:2`,
			`outbound:${WORK}:3`,
		]);
		expect(gmail.send).not.toHaveBeenCalled();
	});
	it.each(["ready", "changes_required"] as const)(
		"can refresh a %s review when new evidence arrives, without reusing its send authority",
		async (verdict) => {
			const review = {
				...state.review!,
				verdict,
				notes: "Check the new source receipt",
			};
			const { client, queue } = fixture({ review });
			const refreshed = await client().requestReview({
				workItemId: WORK,
				expectedVersion: 1,
			});
			expect(refreshed.version).toBe(2);
			expect(refreshed.outbound).toEqual({
				...state,
				review,
				status: "reviewing",
			});
			expect(queue.mock.calls[0]?.[0]).toMatchObject({
				idempotencyKey: `outbound:${WORK}:2`,
				conversationId: `outbound:${WORK}:2`,
			});
			expect(queue.mock.calls[0]?.[0].content).toContain(review.notes);
			await expect(
				client().act({
					workItemId: WORK,
					expectedVersion: refreshed.version,
					action: "approve_send",
					connectionInstanceId: ACCOUNT,
				}),
			).rejects.toThrow(/exact draft the reviewer marked ready/);
			expect(gmail.send).not.toHaveBeenCalled();
		},
	);
	it("can retry a queue failure without reusing its failed execution identity", async () => {
		const { client, queue } = fixture({ status: "reviewing", review: null });
		queue.mockRejectedValueOnce(new Error("Temporary queue failure"));
		await expect(
			client().requestReview({ workItemId: WORK, expectedVersion: 1 }),
		).rejects.toThrow(/Temporary queue failure/);
		const saved = await client().get({ workItemId: WORK });
		expect(saved.version).toBe(2);
		expect(saved.outbound.draft).toEqual(state.draft);
		const retried = await client().requestReview({
			workItemId: WORK,
			expectedVersion: saved.version,
		});
		expect(retried.version).toBe(3);
		expect(queue.mock.calls.map(([event]) => event.idempotencyKey)).toEqual([
			`outbound:${WORK}:2`,
			`outbound:${WORK}:3`,
		]);
		expect(retried.outbound.review).toBeNull();
		expect(queue.mock.calls.map(([event]) => event.conversationId)).toEqual([
			`outbound:${WORK}:2`,
			`outbound:${WORK}:3`,
		]);
		expect(gmail.send).not.toHaveBeenCalled();
	});
	it("accepts only the addressed human and never sends on manual approval", async () => {
		const { client, sqlite } = fixture();
		await expect(
			client("lina").act({
				workItemId: WORK,
				expectedVersion: 1,
				action: "approve_manual",
			}),
		).rejects.toThrow(/another person/);
		await expect(
			client(REVIEWER, ORG, true).act({
				workItemId: WORK,
				expectedVersion: 1,
				action: "approve_send",
				connectionInstanceId: ACCOUNT,
			}),
		).rejects.toThrow(/human/);
		const result = await client().act({
			workItemId: WORK,
			expectedVersion: 1,
			action: "approve_manual",
		});
		expect(result.outbound.status).toBe("approved_manual");
		expect(gmail.send).not.toHaveBeenCalled();
		expect(
			sqlite
				.prepare("SELECT event_kind AS kind FROM learning_interaction_events")
				.get()?.kind,
		).toBe("accepted");
		expect((await client().profile({})).approvals).toHaveLength(1);
	});
	it("locks the reviewed revision before sending; repeat clicks cannot send again", async () => {
		const { client } = fixture();
		const result = await client().act({
			workItemId: WORK,
			expectedVersion: 1,
			action: "approve_send",
			connectionInstanceId: ACCOUNT,
		});
		expect(result.outbound).toMatchObject({
			status: "sent",
			providerReceipt: "sent-fictional-message",
		});
		await expect(
			client().act({
				workItemId: WORK,
				expectedVersion: 1,
				action: "approve_send",
				connectionInstanceId: ACCOUNT,
			}),
		).rejects.toThrow(/changed/);
		expect(gmail.send).toHaveBeenCalledTimes(1);
	});
	it("keeps uncertain sends locked for reconciliation", async () => {
		const { client } = fixture();
		gmail.send.mockRejectedValueOnce(
			new Error("timeout after provider accepted"),
		);
		const result = await client().act({
			workItemId: WORK,
			expectedVersion: 1,
			action: "approve_send",
			connectionInstanceId: ACCOUNT,
		});
		expect(result.outbound.status).toBe("send_unknown");
		await expect(
			client().act({
				workItemId: WORK,
				expectedVersion: result.version,
				action: "approve_send",
				connectionInstanceId: ACCOUNT,
			}),
		).rejects.toThrow(/changed/);
		expect(gmail.send).toHaveBeenCalledTimes(1);
	});
	it("invalidates review after editing and captures the old and final wording", async () => {
		const { client, queue } = fixture();
		const edited = await client().act({
			workItemId: WORK,
			expectedVersion: 1,
			action: "edit",
			body: "Hi Lina, here is the short summary you asked for. Rosa",
		});
		expect(edited.outbound).toMatchObject({
			status: "reviewing",
			draftRevision: 2,
			review: null,
			styleBefore: state.draft.body,
		});
		expect(queue).toHaveBeenCalledWith(
			expect.objectContaining({ tediId: REVIEWER, source: "outbound-review" }),
		);
		await expect(
			client().act({
				workItemId: WORK,
				expectedVersion: edited.version,
				action: "approve_manual",
			}),
		).rejects.toThrow(/exact draft/);
		await expect(
			client().review({
				workItemId: WORK,
				expectedVersion: edited.version,
				review: { ...state.review!, draftRevision: 2 },
			}),
		).rejects.toThrow();
	});
	it("enforces tenant boundaries and reviewer identity", async () => {
		const { client } = fixture({ status: "reviewing", review: null });
		await expect(
			client("rosa", "66666666-6666-4666-8666-666666666666").get({
				workItemId: WORK,
			}),
		).rejects.toThrow(/not found/);
		const reviewed = await client(REVIEWER, ORG, true).review({
			workItemId: WORK,
			expectedVersion: 1,
			review: {
				draftRevision: 1,
				verdict: "ready",
				notes: "Ready",
				voice: "Examples match",
				grounding: "Sources checked",
				risks: "No new promises",
			},
		});
		expect(reviewed.outbound.status).toBe("waiting_on_you");
	});
});
