import { externalAgentSessions } from "@tedix/db/schema/external-agent-identity";
import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import * as workCrud from "@tedix/db/queries/work-items/crud";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { tedis } from "@tedix/db/schema/tedis";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
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
import { describe, expect, it, vi } from "vite-plus/test";
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
			workInteractionDeliveries,
			workInteractionReplyDrafts,
			organizationMembers,
			tedis,
			externalAgentSessions,
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
		reason: "Only the asked person can decide this.",
		subject: "Need an exact answer",
		prompt: "Review the admission evidence.",
		requestedFrom: { type: "user", id: "target-id" },
	});
}

describe("Work interaction canonical actor projections", () => {
	it("learns the canonical Work project while keeping the decision personal", async () => {
		const { sqlite, owner, target } = fixture();
		sqlite.exec(schemaDdl(learningInteractionEvents));
		const projectId = "00000000-0000-4000-8000-000000000004";
		sqlite
			.prepare("UPDATE work_items SET project_id=? WHERE id=? AND org_id=?")
			.run(projectId, WORK_ITEM_ID, ORG_ID);
		const request = await owner.create({
			workItemId: WORK_ITEM_ID,
			kind: "question",
			subject: "Keep the pilot priority?",
			prompt: "Review the canonical project context.",
			reason: "Only the pilot owner can set its priority.",
			requestedFrom: { type: "user", id: "target-id" },
			metadata: {
				decisionDeck: {
					version: 1,
					kind: "decision",
					classId: "pilot.priority",
					proposal: "Keep the pilot priority?",
					whyNow: "The pilot is due soon",
					recommendation: "Keep its agreed scope",
					reversibility: "two_way",
					tasteOrStrategy: true,
					protectedEffects: [],
					blastRadius: "The pilot team",
					confidence: 0.9,
					costOfWaiting: "The team cannot plan",
					reasoning: "The scope is already documented",
					lessons: [],
					options: [
						{
							id: "keep",
							label: "Keep",
							intent: "approve",
							consequence: "Keep the priority",
							cost: "None",
						},
						{
							id: "reconsider",
							label: "Reconsider",
							intent: "reject",
							consequence: "Review the priority",
							cost: "Another review",
						},
					],
				},
			},
		});
		expect(request.projectId).toBeNull();
		await target.respond({
			requestId: request.id,
			expectedRequestVersion: request.version,
			responseKind: "answer",
			body: "Keep it",
			resolvesRequest: true,
			metadata: {
				source: "os-decision-card",
				decisionChoice: "approve",
				feedbackSignal: "approve-as-is",
				projectId: "forged-project",
				decisionContext: { projectId: "forged-project" },
			},
		});
		const row = sqlite
			.prepare(
				"SELECT actor_id,scope_kind,scope_id,metadata FROM learning_interaction_events WHERE target_id=?",
			)
			.get(request.id);
		expect(row).toMatchObject({
			actor_id: "target-sub",
			scope_kind: "personal",
			scope_id: "target-sub",
		});
		expect(JSON.parse(String(row?.metadata))).toMatchObject({
			projectId,
			decisionContext: { projectId, workItemId: WORK_ITEM_ID },
		});
		sqlite.close();
	});

	it("keeps the learning signal when optional Work context is unavailable", async () => {
		const { sqlite, owner, target } = fixture();
		sqlite.exec(schemaDdl(learningInteractionEvents));
		const request = await createTargetedInteraction(owner);
		const lookup = vi
			.spyOn(workCrud, "getWorkItemById")
			.mockRejectedValueOnce(new Error("context temporarily unavailable"));
		try {
			const result = await target.respond({
				requestId: request.id,
				expectedRequestVersion: request.version,
				responseKind: "answer",
				body: "Keep it",
				resolvesRequest: true,
				metadata: {
					source: "os-decision-card",
					decisionClass: "pilot.priority",
					feedbackSignal: "approve-as-is",
					decisionChoice: "approve",
				},
			});
			expect(result.response.resolvesRequest).toBe(true);
			expect(lookup).toHaveBeenCalledExactlyOnceWith(
				expect.anything(),
				WORK_ITEM_ID,
				ORG_ID,
			);
			const row = sqlite
				.prepare(
					"SELECT metadata FROM learning_interaction_events WHERE target_id=?",
				)
				.get(request.id);
			expect(JSON.parse(String(row?.metadata))).toMatchObject({
				projectId: null,
				workItemId: WORK_ITEM_ID,
			});
		} finally {
			lookup.mockRestore();
			sqlite.close();
		}
	});

	it("keeps captured messages out of other admins' detail and organization audit", async () => {
		const { owner, target } = fixture();
		const request = await owner.create({
			workItemId: WORK_ITEM_ID,
			kind: "question",
			subject: "Private session question",
			prompt: "Private message text",
			requestedFrom: { type: "user", id: "owner-id" },
			metadata: {
				schema: "tedix.decision-capture.v1",
				triage: { status: "ok" },
			},
		});
		expect((await owner.get({ requestId: request.id })).request.prompt).toBe(
			"Private message text",
		);
		await expect(target.get({ requestId: request.id })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		for (const viewer of [owner, target]) {
			expect(
				(await viewer.listAudit({ limit: 50 })).data.map(
					(row) => row.request.id,
				),
			).not.toContain(request.id);
		}
	});
	it("retains a harness requester under owner login and labels it as the agent", async () => {
		const { owner } = fixture();
		const session = "codex:fixture-session";
		const created = await owner.create({
			workItemId: WORK_ITEM_ID,
			kind: "question",
			subject: "Owner: configure access",
			prompt: "Configure access",
			reason: "The owner must grant access.",
			requestedFrom: { type: "user", id: "owner-id" },
			metadata: { agentSession: session },
		});
		expect(created.creatorSessionId).toBe(session);
		const inbox = await owner.listInbox({ states: ["open"] });
		expect(inbox.data.find((r) => r.request.id === created.id)?.askedBy).toBe(
			"Codex session",
		);
	});
	it("resolves a legacy proposer UUID only from its own tenant and principal", async () => {
		const { sqlite, owner, target } = fixture();
		const request = await createTargetedInteraction(owner);
		const sessionId = "00000000-0000-4000-8000-000000000099";
		sqlite
			.prepare(
				`INSERT INTO external_agent_sessions (id,organization_id,principal_id,external_session_key,harness,harness_version,model_provider,model_id,model_version,identity_source,started_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
			)
			.run(
				sessionId,
				ORG_ID,
				"fictional-principal",
				"codex:proposer",
				"codex",
				"1",
				"openai",
				"fictional",
				"1",
				"native",
				"2026-10-18T00:00:00Z",
				"2026-10-18T00:00:00Z",
			);
		sqlite
			.prepare(
				"UPDATE work_interactions SET creator_type='external_agent',creator_id=?,creator_session_id=? WHERE id=?",
			)
			.run("fictional-principal", sessionId, request.id);
		const proposer = async () =>
			(await target.listInbox({ states: ["open"] })).data.find(
				(row) => row.request.id === request.id,
			);
		expect(await proposer()).toMatchObject({
			askedBy: "Codex session",
			creatorHarness: "codex",
		});
		sqlite
			.prepare(
				"UPDATE external_agent_sessions SET organization_id=? WHERE id=?",
			)
			.run("fictional-other-org", sessionId);
		expect(await proposer()).toMatchObject({
			askedBy: "Your coding assistant",
			creatorHarness: null,
		});
		sqlite
			.prepare(
				"UPDATE external_agent_sessions SET organization_id=?,principal_id=? WHERE id=?",
			)
			.run(ORG_ID, "fictional-other-principal", sessionId);
		expect(await proposer()).toMatchObject({
			askedBy: "Your coding assistant",
			creatorHarness: null,
		});
	});
	it("refuses to address an unclassified captured turn to a human", async () => {
		const { owner } = fixture();
		await expect(
			owner.create({
				workItemId: WORK_ITEM_ID,
				kind: "question",
				subject: "Build passed",
				prompt: "Build passed",
				requestedFrom: { type: "user", id: "owner-id" },
				metadata: {
					schema: "tedix.decision-capture.v1",
					triage: { status: "unavailable" },
				},
			}),
		).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT" });
	});

	it("allows only the target human to delegate the existing question", async () => {
		const { owner, target, other, sqlite } = fixture();
		const tediId = "00000000-0000-4000-8000-000000000003";
		sqlite
			.prepare(
				"INSERT INTO tedis (id,organization_id,name,slug,status) VALUES (?,?,?,'worker','active')",
			)
			.run(tediId, ORG_ID, "Worker");
		const request = await createTargetedInteraction(owner);
		const input = {
			requestId: request.id,
			expectedRequestVersion: request.version,
			tediId,
		};
		await expect(owner.delegate(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(other.delegate(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		const delegated = await target.delegate(input);
		expect(delegated).toMatchObject({
			id: request.id,
			requestedFromType: "tedi",
			requestedFromId: tediId,
			version: request.version + 1,
			metadata: { delegation: { fromId: "target-id", toTediId: tediId } },
		});
		await expect(
			target.respond({
				requestId: request.id,
				expectedRequestVersion: delegated.version,
				responseKind: "answer",
				body: "A",
				resolvesRequest: true,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("returns the saved answer when notification publication fails", async () => {
		const { owner, target } = fixture(async () => {
			throw new Error("binding unavailable");
		});
		const request = await createTargetedInteraction(owner);
		const saved = await target.respond({
			requestId: request.id,
			expectedRequestVersion: request.version,
			responseKind: "answer",
			body: "Keep the canonical answer",
			resolvesRequest: true,
		});
		expect(saved.response.resolvesRequest).toBe(true);
		const readback = await owner.get({ requestId: request.id });
		expect(readback.responses.data).toContainEqual(saved.response);
	});
	it("publishes saved answers only, suppressing coordination and denied writes", async () => {
		const events: unknown[] = [];
		const { owner, target, other, sqlite } = fixture(async (request) => {
			events.push(await request.json());
			return Response.json({ ok: true });
		});
		const request = await createTargetedInteraction(owner);
		await expect(
			other.respond({
				requestId: request.id,
				expectedRequestVersion: request.version,
				responseKind: "answer",
				body: "Unauthorized",
				resolvesRequest: true,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(events).toEqual([]);
		// The insert trigger takes coordination_update only on a coordination request.
		await expect(
			target.respond({
				requestId: request.id,
				expectedRequestVersion: request.version,
				responseKind: "coordination_update",
				body: "Checking",
				resolvesRequest: false,
			}),
		).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT" });
		const coordination = await owner.create({
			workItemId: WORK_ITEM_ID,
			kind: "coordination",
			subject: "Keep me posted",
			prompt: "Report progress on the admission evidence.",
			requestedFrom: { type: "user", id: "target-id" },
		});
		await target.respond({
			requestId: coordination.id,
			expectedRequestVersion: coordination.version,
			responseKind: "coordination_update",
			body: "Checking",
			resolvesRequest: false,
		});
		expect(events).toEqual([]);
		const saved = await target.respond({
			requestId: request.id,
			expectedRequestVersion: request.version,
			responseKind: "answer",
			body: "Private user answer",
			resolvesRequest: true,
		});
		expect(events).toEqual([
			{
				kind: "interaction_response",
				organizationId: ORG_ID,
				requestId: request.id,
				responseId: saved.response.id,
				respondedAt: saved.response.respondedAt,
			},
		]);
		expect(
			sqlite
				.prepare("SELECT body FROM work_interaction_responses WHERE id = ?")
				.get(saved.response.id),
		).toMatchObject({ body: "Private user answer" });
	});
	it("separates target inbox, creator outbox, and owner audit flags", async () => {
		const { owner, target } = fixture();
		const request = await createTargetedInteraction(owner);

		expect((await owner.listInbox({ limit: 50 })).data).toEqual([]);
		expect((await target.listOutbox({ limit: 50 })).data).toEqual([]);
		expect((await target.listInbox({ limit: 50 })).data[0]).toMatchObject({
			request: { id: request.id },
			canRespond: true,
			canCancel: false,
		});
		expect((await owner.listOutbox({ limit: 50 })).data[0]).toMatchObject({
			request: { id: request.id },
			canRespond: false,
			canCancel: true,
		});
		expect((await owner.listAudit({ limit: 50 })).data[0]).toMatchObject({
			request: { id: request.id },
			canRespond: false,
			canCancel: false,
		});
	});

	it("filters the target inbox by triage urgency without hiding untriaged requests", async () => {
		const { owner, target } = fixture();
		const urgent = await owner.create({
			workItemId: WORK_ITEM_ID,
			kind: "question",
			reason: "Only the asked person can decide this.",
			subject: "Blocked on credentials",
			prompt: "The deploy failed; rotate the token.",
			requestedFrom: { type: "user", id: "target-id" },
			metadata: {
				schema: "tedix.decision-capture.v1",
				triage: {
					status: "ok",
					urgency: "now",
					urgentLabels: ["blocker_or_failure"],
				},
			},
		});
		const untriaged = await createTargetedInteraction(owner);
		const ids = async (urgency?: "now" | "later") =>
			(
				await target.listInbox({ limit: 50, ...(urgency ? { urgency } : {}) })
			).data.map((row) => row.request.id);

		expect(await ids("now")).toEqual([urgent.id]);
		expect(await ids("later")).toEqual([untriaged.id]);
		expect(new Set(await ids())).toEqual(new Set([urgent.id, untriaged.id]));
	});

	it("returns null joined Work for project and case requests in every list", async () => {
		const { sqlite, owner, target } = fixture();
		const workRequest = await createTargetedInteraction(owner);
		const insert = sqlite.prepare(`INSERT INTO work_interactions
			(id,org_id,project_id,case_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
		const contexts = [
			{
				id: "00000000-0000-4000-8000-000000000003",
				projectId: "00000000-0000-4000-8000-000000000004",
				caseId: null,
			},
			{
				id: "00000000-0000-4000-8000-000000000005",
				projectId: null,
				caseId: "00000000-0000-4000-8000-000000000006",
			},
		];
		for (const context of contexts)
			insert.run(
				context.id,
				ORG_ID,
				context.projectId,
				context.caseId,
				"question",
				"Context request",
				"Answer this question",
				"user",
				"owner-id",
				"user",
				"target-id",
				"2026-10-03T15:00:00Z",
			);
		const pages = [
			await target.listInbox({ states: ["open"], limit: 50 }),
			await owner.listOutbox({ states: ["open"], limit: 50 }),
			await owner.listAudit({ states: ["open"], limit: 50 }),
		];
		for (const page of pages) {
			for (const context of contexts)
				expect(
					page.data.find((row) => row.request.id === context.id),
				).toMatchObject({
					request: {
						workItemId: null,
						projectId: context.projectId,
						caseId: context.caseId,
					},
					workItem: null,
					effectiveState: "open",
				});
			expect(
				page.data.find((row) => row.request.id === workRequest.id)?.workItem,
			).toMatchObject({ id: WORK_ITEM_ID, title: "Targeted interaction" });
		}
		expect(
			pages[0]?.data.find((row) => row.request.id === contexts[0]?.id),
		).toMatchObject({ canRespond: true, canCancel: false });
		expect(
			pages[1]?.data.find((row) => row.request.id === contexts[0]?.id),
		).toMatchObject({ canRespond: false, canCancel: true });
		expect(
			pages[2]?.data.find((row) => row.request.id === contexts[0]?.id),
		).toMatchObject({ canRespond: false, canCancel: false });
	});

	it("authorizes detail to creator or target and gives audit-only readers no action flags", async () => {
		const { owner, target, other } = fixture();
		const request = await createTargetedInteraction(owner);
		expect(await owner.get({ requestId: request.id })).toMatchObject({
			canRespond: false,
			canCancel: true,
		});
		expect(await target.get({ requestId: request.id })).toMatchObject({
			canRespond: true,
			canCancel: false,
		});
		await expect(other.get({ requestId: request.id })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(other.listAudit({ limit: 50 })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("projects the newest reply draft only to authorized detail readers", async () => {
		const { owner, target, other, sqlite } = fixture();
		const request = await createTargetedInteraction(owner);
		expect(await target.get({ requestId: request.id })).toMatchObject({
			latestDraft: null,
		});
		const insertDraft = sqlite.prepare(
			"INSERT INTO work_interaction_reply_drafts (id,org_id,interaction_id,drafter_type,drafter_id,body,rationale,turn_type,created_at) VALUES (?,?,?,'tedi','drafter',?,'Board priority','approval',?)",
		);
		insertDraft.run(
			"00000000-0000-4000-8000-0000000000d1",
			ORG_ID,
			request.id,
			"First",
			"2026-08-21T01:00:00.000Z",
		);
		insertDraft.run(
			"00000000-0000-4000-8000-0000000000d2",
			ORG_ID,
			request.id,
			"Second",
			"2026-08-21T02:00:00.000Z",
		);
		const latestDraft = {
			id: "00000000-0000-4000-8000-0000000000d2",
			body: "Second",
			rationale: "Board priority",
			drafterId: "drafter",
			drafterName: null as string | null,
			createdAt: "2026-08-21T02:00:00.000Z",
			turnType: "approval",
			delivery: "review",
			gate: null as unknown,
		};
		expect(await target.get({ requestId: request.id })).toMatchObject({
			latestDraft,
		});
		const insertTedi = sqlite.prepare(
			"INSERT INTO tedis (id,organization_id,name,display_name,slug) VALUES (?,?,?,?,?)",
		);
		insertTedi.run("drafter", "other-org", "Foreign", "Foreign", "foreign");
		expect(await target.get({ requestId: request.id })).toMatchObject({
			latestDraft,
		});
		sqlite.exec("DELETE FROM tedis");
		insertTedi.run("drafter", ORG_ID, "cto", null, "cto");
		latestDraft.drafterName = "cto";
		expect(await target.get({ requestId: request.id })).toMatchObject({
			latestDraft,
		});
		expect(await owner.get({ requestId: request.id })).toMatchObject({
			latestDraft,
		});
		// The delivery-gate audit is exposed for review; a malformed row reads null.
		const gate = {
			status: "fail",
			model: "@cf/cloudflare/clef-flash",
			checks: [{ id: "needs_human", p: 0.9, pass: false }],
			latencyMs: 40,
		};
		const insertGated = sqlite.prepare(
			"INSERT INTO work_interaction_reply_drafts (id,org_id,interaction_id,drafter_type,drafter_id,body,rationale,turn_type,gate,created_at) VALUES (?,?,?,'tedi','drafter','Third','Board priority','approval',?,?)",
		);
		insertGated.run(
			"00000000-0000-4000-8000-0000000000d3",
			ORG_ID,
			request.id,
			JSON.stringify(gate),
			"2026-08-21T03:00:00.000Z",
		);
		expect(await target.get({ requestId: request.id })).toMatchObject({
			latestDraft: { body: "Third", gate },
		});
		insertGated.run(
			"00000000-0000-4000-8000-0000000000d4",
			ORG_ID,
			request.id,
			JSON.stringify({ status: "maybe" }),
			"2026-08-21T04:00:00.000Z",
		);
		expect(await target.get({ requestId: request.id })).toMatchObject({
			latestDraft: { gate: null },
		});
		await expect(other.get({ requestId: request.id })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});

it("ships the latest authorized draft with the inbox and never exposes it to another person", async () => {
	const { sqlite, owner, target, other } = fixture();
	const request = await createTargetedInteraction(owner);
	sqlite
		.prepare(
			"INSERT INTO work_interaction_reply_drafts (id,org_id,interaction_id,drafter_type,drafter_id,body,rationale,turn_type,created_at) VALUES (?,?,?,'tedi','drafter',?,'Fits the plan','reply',?)",
		)
		.run(
			"00000000-0000-4000-8000-0000000000d1",
			ORG_ID,
			request.id,
			"Tuesday works.",
			"2026-08-21T01:00:00.000Z",
		);
	const row = (await target.listInbox({ states: ["open"] })).data.find(
		(row) => row.request.id === request.id,
	);
	expect(row).toMatchObject({
		canRespond: true,
		request: { version: request.version },
		latestDraft: { body: "Tuesday works." },
	});
	expect((await other.listInbox({ states: ["open"] })).data).toEqual([]);
});

it("regenerates display copy only for the addressed person, preserving decisions and rejecting stale versions", async () => {
	const { owner, target, other, sqlite } = fixture();
	const request = await createTargetedInteraction(owner);
	await expect(
		other.regenerateCard({
			requestId: request.id,
			expectedRequestVersion: request.version,
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	const generator = await import("../../services/decision-card-generator");
	const spy = vi.spyOn(generator, "generateDecisionCard").mockResolvedValue({
		version: 1,
		title: "Keep the reviewed boundary?",
		body: "The reviewed boundary is ready for a decision.",
		recommendation:
			"Review the boundary because the source asks for an exact answer.",
		model: "fictional-small-model",
		generatedAt: "2026-10-18T11:00:00.000Z",
	});
	try {
		const saved = await target.regenerateCard({
			requestId: request.id,
			expectedRequestVersion: request.version,
		});
		expect(saved).toMatchObject({
			state: "open",
			kind: request.kind,
			prompt: request.prompt,
			subject: request.subject,
			version: request.version + 1,
			metadata: { cardPresentation: { title: "Keep the reviewed boundary?" } },
		});
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM work_interaction_responses")
				.get(),
		).toEqual({ n: 0 });
		await expect(
			target.regenerateCard({
				requestId: request.id,
				expectedRequestVersion: request.version,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	} finally {
		spy.mockRestore();
	}
});
