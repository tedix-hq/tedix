import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { tedis } from "@tedix/db/schema/tedis";
import {
	workInteractionAttention,
	workInteractionDeliveries,
	workInteractionReplyDrafts,
	workInteractionResponses,
	workInteractions,
} from "@tedix/db/schema/work-factory";
import { workEvents, workItems } from "@tedix/db/schema/work-items";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { workInteractionsContractRouter } from "./work-interactions";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const WORK_ITEM_ID = "00000000-0000-4000-8000-000000000002";

function fixture(publish?: (request: Request) => Promise<Response>) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			workItems,
			workEvents,
			workInteractions,
			workInteractionResponses,
			workInteractionAttention,
			workInteractionReplyDrafts,
			workInteractionDeliveries,
			organizationMembers,
			tedis,
		),
	);
	sqlite
		.prepare(
			"INSERT INTO work_items (id,org_id,title,created_at) VALUES (?,?,?,?)",
		)
		.run(
			WORK_ITEM_ID,
			ORG_ID,
			"Targeted interaction",
			"2026-08-21T00:00:00.000Z",
		);
	const insertMember = sqlite.prepare(`INSERT INTO organization_members
		(id,organization_id,user_id,descope_user_id,email,role,status)
		VALUES (?,?,?,?,?,?,'active')`);
	insertMember.run(
		"membership-owner",
		ORG_ID,
		"owner-id",
		"owner-sub",
		"owner@tedix.test",
		"owner",
	);
	insertMember.run(
		"membership-target",
		ORG_ID,
		"target-id",
		"target-sub",
		"target@tedix.test",
		"admin",
	);
	insertMember.run(
		"membership-other",
		ORG_ID,
		"other-id",
		"other-sub",
		"other@tedix.test",
		"member",
	);
	const facade = createD1Facade(sqlite);
	const clientFor = (identity: {
		userId: string;
		sub: string;
		role: "owner" | "admin" | "member";
	}) =>
		createRouterClient(workInteractionsContractRouter, {
			context: {
				authType: "user",
				db: createDbClient(facade),
				env: {
					ENVIRONMENT: "test",
					DB: facade,
					...(publish ? { MCP_SERVICE: { fetch: publish } } : {}),
				} as CloudflareEnv,
				headers: new Headers(),
				organizationId: ORG_ID,
				url: new URL("https://api.tedix.test/rpc/work-interactions"),
				userId: identity.userId,
				userRole: identity.role,
				user: {
					aud: "test",
					dct: "tenant-1",
					exp: 2,
					iat: 1,
					iss: "https://auth.tedix.test",
					permissions: [],
					roles: [],
					sub: identity.sub,
				},
			} as BaseContext,
		});
	return {
		sqlite,
		owner: clientFor({ userId: "owner-id", sub: "owner-sub", role: "owner" }),
		target: clientFor({
			userId: "target-id",
			sub: "target-sub",
			role: "admin",
		}),
		other: clientFor({ userId: "other-id", sub: "other-sub", role: "member" }),
	};
}

async function createTargetedInteraction(
	owner: ReturnType<typeof fixture>["owner"],
) {
	return owner.create({
		workItemId: WORK_ITEM_ID,
		kind: "question",
		subject: "Need an exact answer",
		prompt: "Review the admission evidence.",
		requestedFrom: { type: "user", id: "target-id" },
	});
}

describe("Work interactions router", () => {
	it("mounts the complete structured interaction lifecycle", () => {
		expect(Object.keys(workInteractionsContractRouter)).toEqual([
			"create",
			"respond",
			"delegate",
			"cancel",
			"get",
			"listInbox",
			"listCliInboxProjection",
			"listOutbox",
			"listAudit",
			"listUndelivered",
			"ackDelivery",
			"recordDraftDelivery",
		]);
	});
});

it("lists a session question's undelivered answer, records its delivery, and shows the state", async () => {
	const { owner, target, other, sqlite } = fixture();
	const session = "11111111-1111-4111-8111-111111111111";
	// Decision capture: the user asks themselves on behalf of their session.
	const question = await target.create({
		workItemId: WORK_ITEM_ID,
		kind: "question",
		subject: "repo · claude-code waiting: Ship it?",
		prompt: "Ship it?",
		metadata: { sessionId: session, host: "claude-code" },
		requestedFrom: { type: "user", id: "target-id" },
	});
	const responseId = "00000000-0000-4000-8000-0000000000aa";
	sqlite
		.prepare(
			`INSERT INTO work_interaction_responses (id,org_id,interaction_id,resolved_request_version,resolution_fence,responder_type,responder_id,body,response_kind,resolves_request,metadata,responded_at)
			VALUES (?,?,?,2,'fence','user','target-id','Yes, ship','answer',1,'{}',?)`,
		)
		.run(responseId, ORG_ID, question.id, new Date().toISOString());
	sqlite
		.prepare(
			"UPDATE work_interactions SET status='resolved', version=2 WHERE id=?",
		)
		.run(question.id);

	const pending = await target.listUndelivered({ sessionId: session });
	expect(pending.data).toEqual([
		expect.objectContaining({
			responseId,
			requestId: question.id,
			subject: "repo · claude-code waiting: Ship it?",
			body: "Yes, ship",
			sessionId: session,
			host: "claude-code",
		}),
	]);
	expect((await other.listUndelivered({})).data).toEqual([]);
	expect(
		(await target.get({ requestId: question.id })).request.metadata?.delivery,
	).toMatchObject({ state: "saved", deliveredAt: null });

	// Someone else cannot record it.
	expect(
		(await other.ackDelivery({ responseIds: [responseId], via: "hook" })).data,
	).toEqual([]);
	await expect(
		target.ackDelivery({
			responseIds: [responseId],
			via: "hook",
			handoffTo: "LEARN",
		}),
	).rejects.toThrow(/only valid with via=handoff/);
	const acked = await target.ackDelivery({
		responseIds: [responseId],
		via: "hook",
	});
	expect(acked.data[0]).toMatchObject({ responseId, via: "hook" });
	expect((await target.listUndelivered({})).data).toEqual([]);
	const inbox = await target.listInbox({});
	expect(
		inbox.data.find((row) => row.request.id === question.id)?.request.metadata
			?.delivery,
	).toMatchObject({ state: "delivered", via: "hook" });
	await target.ackDelivery({
		responseIds: [responseId],
		via: "hook",
		acknowledged: true,
	});
	expect(
		(await owner.listAudit({})).data.find(
			(row) => row.request.id === question.id,
		)?.request.metadata?.delivery,
	).toMatchObject({ state: "acknowledged" });
});

it("records an auto draft's delivery as the tedi's answer, once, for the asked user only", async () => {
	const { target, other, sqlite } = fixture();
	const session = "11111111-1111-4111-8111-111111111111";
	sqlite
		.prepare(
			"INSERT INTO tedis (id,organization_id,name,slug,status) VALUES (?,?,?,?,'active')",
		)
		.run("00000000-0000-4000-8000-00000000c0c0", ORG_ID, "CTO", "cto");
	const question = await target.create({
		workItemId: WORK_ITEM_ID,
		kind: "question",
		subject: "repo · claude-code waiting: Deploy?",
		prompt: "Deploy?",
		metadata: { sessionId: session, host: "claude-code" },
		requestedFrom: { type: "user", id: "target-id" },
	});
	const draftId = "00000000-0000-4000-8000-0000000000dd";
	sqlite
		.prepare(
			`INSERT INTO work_interaction_reply_drafts (id,org_id,interaction_id,drafter_type,drafter_id,body,rationale,turn_type,delivery,created_at)
			VALUES (?,?,?,'tedi','00000000-0000-4000-8000-00000000c0c0','Deploy at noon.','Quiet window.','continue','auto',?)`,
		)
		.run(draftId, ORG_ID, question.id, new Date().toISOString());
	await expect(
		other.recordDraftDelivery({
			requestId: question.id,
			draftId,
			via: "hook",
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	const first = await target.recordDraftDelivery({
		requestId: question.id,
		draftId,
		via: "hook",
	});
	expect(first).toMatchObject({
		created: true,
		via: "hook",
		response: {
			requestId: question.id,
			respondedByType: "tedi",
			respondedById: "00000000-0000-4000-8000-00000000c0c0",
			resolvesRequest: true,
			body: "Deploy at noon.",
			metadata: { draftId, draftOutcome: "auto", sessionId: session },
		},
	});
	expect(first.deliveredAt).not.toBeNull();
	const again = await target.recordDraftDelivery({
		requestId: question.id,
		draftId,
		via: "codex_queue",
	});
	expect(again).toMatchObject({
		created: false,
		via: "hook",
		response: { id: first.response.id },
	});
	// The tedi's answer is never the user's own undelivered answer.
	expect((await target.listUndelivered({ sessionId: session })).data).toEqual(
		[],
	);
});

it("projects targeted open inbox prompts and strips metadata/drafts with truthful continuation", async () => {
	const { owner, target, other, sqlite } = fixture();
	for (let i = 0; i < 6; i++)
		await owner.create({
			workItemId: WORK_ITEM_ID,
			kind: "question",
			subject: "Bounded",
			prompt: "p".repeat(i === 0 ? 800 : 801),
			metadata: { policy: "x".repeat(20000) },
			requestedFrom: { type: "user", id: "target-id" },
		});
	const page = await target.listCliInboxProjection({
		workItemId: WORK_ITEM_ID,
	});
	expect(page.data).toHaveLength(5);
	expect(page.hasMore).toBe(true);
	expect(page.nextCursor).not.toBeNull();
	for (const row of page.data) {
		expect(row.request.prompt.length).toBeLessThanOrEqual(800);
		expect(row.request).not.toHaveProperty("metadata");
		expect(row).not.toHaveProperty("latestDraft");
		expect(row.canRespond).toBe(true);
	}
	const last = await target.listCliInboxProjection({
		workItemId: WORK_ITEM_ID,
		cursor: page.nextCursor!,
	});
	expect(last.data).toHaveLength(1);
	expect(last.hasMore).toBe(false);
	expect(last.nextCursor).toBeNull();
	expect(
		[...page.data, ...last.data].filter((row) => row.request.promptComplete),
	).toHaveLength(1);
	expect(
		(await other.listCliInboxProjection({ workItemId: WORK_ITEM_ID })).data,
	).toEqual([]);
	const request = await createTargetedInteraction(owner);
	sqlite
		.prepare(
			"INSERT INTO work_interaction_reply_drafts(id,org_id,interaction_id,drafter_type,drafter_id,body,rationale,turn_type,delivery,created_at) VALUES (?,?,?,'tedi','drafter','Reply','Reason','approval',?,?)",
		)
		.run(
			"00000000-0000-4000-8000-000000000099",
			ORG_ID,
			request.id,
			"auto",
			"2026-10-07T00:00:00.000Z",
		);
	expect(
		(await target.get({ requestId: request.id })).latestDraft,
	).toMatchObject({
		body: "Reply",
		delivery: "auto",
		drafterName: null,
		gate: null,
	});
	sqlite
		.prepare("UPDATE work_interaction_reply_drafts SET delivery='review'")
		.run();
	expect(
		(await target.get({ requestId: request.id })).latestDraft?.delivery,
	).toBe("review");
});

it("shows stored attention as metadata.attention and keeps fyi turns out of urgent", async () => {
	const { owner, target, sqlite } = fixture();
	const urgent = {
		schema: "tedix.decision-capture.v1",
		triage: { status: "ok", urgency: "now", urgentLabels: ["risky_action"] },
	};
	const ask = await owner.create({
		workItemId: WORK_ITEM_ID,
		kind: "question",
		subject: "Ask",
		prompt: "Deploy now?",
		metadata: urgent,
		requestedFrom: { type: "user", id: "target-id" },
	});
	const update = await owner.create({
		workItemId: WORK_ITEM_ID,
		kind: "question",
		subject: "Update",
		prompt: "Deployed; checks green.",
		metadata: urgent,
		requestedFrom: { type: "user", id: "target-id" },
	});
	const insert = sqlite.prepare(
		"INSERT INTO work_interaction_attention (org_id,interaction_id,kind,need,asks,decided_at) VALUES (?,?,?,?,?,?)",
	);
	insert.run(ORG_ID, ask.id, "needs_you", "Approve the deploy.", 0.9, "t");
	insert.run(ORG_ID, update.id, "fyi", null, 0.1, "t");
	const now = await target.listInbox({ urgency: "now" });
	expect(now.data.map((row) => row.request.id)).toEqual([ask.id]);
	expect(now.data[0]?.request.metadata?.attention).toEqual({
		kind: "needs_you",
		need: "Approve the deploy.",
	});
	expect(now.data[0]?.request.metadata?.neededFromYou).toBe(
		"Approve the deploy.",
	);
	expect(
		(await target.get({ requestId: update.id })).request.metadata?.attention,
	).toEqual({ kind: "fyi", need: null });
});

it("requires messaging scope and a verified active actor for compact inbox", async () => {
	const { sqlite } = fixture();
	const facade = createD1Facade(sqlite);
	function keyClient(scopes: string[]) {
		return createRouterClient(workInteractionsContractRouter, {
			context: {
				authType: "apikey",
				apiKey: {
					id: "fictional-key",
					name: "projection",
					organizationId: ORG_ID,
					scopes,
				},
				db: createDbClient(facade),
				env: { DB: facade },
				organizationId: ORG_ID,
				headers: new Headers(),
				url: new URL("https://api.test/rpc"),
			} as BaseContext,
		});
	}
	await expect(
		keyClient(["mcp:work.read"]).listCliInboxProjection({}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		keyClient(["mcp:messaging.read"]).listCliInboxProjection({}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});
