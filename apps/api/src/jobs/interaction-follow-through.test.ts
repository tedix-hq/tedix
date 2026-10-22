import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { tedis } from "@tedix/db/schema/tedis";
import { workItems, workAttempts } from "@tedix/db/schema/work-items";
import { tediRuntimeEvents } from "@tedix/db/schema/cognitive-runtime";
import {
	externalAgentSessions,
	externalAgentPrincipals,
} from "@tedix/db/schema/external-agent-identity";
import {
	workInteractions,
	workInteractionCardPresentations,
	workInteractionResponses,
} from "@tedix/db/schema/work-factory";
import {
	createWorkInteraction,
	getWorkInteraction,
} from "@tedix/db/queries/work-items/interactions";
import {
	listDueWorkInteractionReviews,
	reviewWorkInteraction,
} from "@tedix/db/queries/work-items/interaction-reviews";
import { workInteractionsContractRouter } from "../rpc/routers/work-interactions";
import type { BaseContext } from "../rpc/orpc";
import { dispatchInteractionReviews } from "./interaction-follow-through";

const ORG = "00000000-0000-4000-8000-000000000001";
const WORK = "00000000-0000-4000-8000-000000000002";
const TEDI = "00000000-0000-4000-8000-000000000003";
const ASK = "00000000-0000-4000-8000-000000000004";
const ANSWER = "00000000-0000-4000-8000-000000000005";
const createdAt = "2026-10-13T10:00:00.000Z";
const now = "2026-10-17T10:00:00.000Z";

async function fixture(fetchWake?: (request: Request) => Promise<Response>) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			organizationMembers,
			tedis,
			workItems,
			workAttempts,
			tediRuntimeEvents,
			externalAgentSessions,
			externalAgentPrincipals,
			workInteractions,
			workInteractionCardPresentations,
			workInteractionResponses,
		),
	);
	sqlite
		.prepare(
			"INSERT INTO tedis(id,organization_id,name,slug,status) VALUES (?,?,'River','river','active')",
		)
		.run(TEDI, ORG);
	sqlite
		.prepare(
			"INSERT INTO tedis(id,organization_id,name,slug,status) VALUES ('other',?,'Brook','brook','active')",
		)
		.run(ORG);
	sqlite
		.prepare(
			"INSERT INTO organization_members(id,organization_id,user_id,descope_user_id,email,role,status) VALUES ('member',?,'person','person-sub','person@example.test','owner','active')",
		)
		.run(ORG);
	sqlite
		.prepare(
			"INSERT INTO work_items(id,org_id,title,created_at) VALUES (?,?,'Fictional review',?)",
		)
		.run(WORK, ORG, createdAt);
	const facade = createD1Facade(sqlite);
	const db = createDbClient(facade);
	await createWorkInteraction(db, {
		id: ASK,
		orgId: ORG,
		workItemId: WORK,
		kind: "question",
		subject: "Choose a review date",
		prompt: "Which date?",
		creator: { type: "tedi", id: TEDI },
		targetType: "user",
		targetId: "person",
		now: createdAt,
	});
	const env = {
		DB: facade,
		ENVIRONMENT: "test",
		TEDI_SERVICE: {
			fetch:
				fetchWake ??
				(async () => Response.json({ accepted: true, run_id: "review-run" })),
		},
	} as CloudflareEnv;
	const client = (tediId = TEDI) =>
		createRouterClient(workInteractionsContractRouter, {
			context: {
				authType: "service-binding",
				tediId,
				tediScopes: ["mcp:messaging.write"],
				organizationId: ORG,
				env,
				db,
				headers: new Headers({ "X-Service-Binding": "true" }),
				url: new URL("https://api.example.test/rpc"),
			} as BaseContext,
		});
	const answer = () => {
		sqlite
			.prepare(
				"UPDATE work_interactions SET status='resolved',version=2,resolved_at=? WHERE id=?",
			)
			.run(now, ASK);
		sqlite
			.prepare(
				"INSERT INTO work_interaction_responses(id,org_id,interaction_id,resolved_request_version,resolution_fence,responder_type,responder_id,body,response_kind,resolves_request,responded_at) VALUES (?,?,?,2,'answer-fence','user','person','Next Monday','answer',1,?)",
			)
			.run(ANSWER, ORG, ASK, now);
	};
	const event = (
		id: string,
		at = now,
		owner = TEDI,
		org = ORG,
		kind = "tool.completed",
	) =>
		sqlite
			.prepare(
				"INSERT INTO tedi_runtime_events(id,organization_id,tedi_id,kind,run_id,runtime_backend,created_at,payload) VALUES (?,?,?,?,'continued-run','cloudflare-agents',?,'{}')",
			)
			.run(id, org, owner, kind, at);
	return { sqlite, db, env, client, answer, event };
}

describe("owned Needs-you follow-through", () => {
	it("records the review deadline and dispatches one idempotent owner review", async () => {
		const wakes: Array<Record<string, unknown>> = [];
		const { db, env } = await fixture(async (request) => {
			wakes.push(await request.json());
			return Response.json({ accepted: true, run_id: "review-run" });
		});
		expect(
			(await getWorkInteraction(db, { orgId: ORG, interactionId: ASK }))
				?.metadata.followThrough,
		).toMatchObject({ reviewAt: "2026-10-16T10:00:00.000Z" });
		expect(
			await listDueWorkInteractionReviews(db, "2026-10-15T10:00:00.000Z"),
		).toHaveLength(0);
		expect(await dispatchInteractionReviews(env, Date.parse(now))).toEqual({
			interactionReviews: 1,
		});
		expect(await dispatchInteractionReviews(env, Date.parse(now))).toEqual({
			interactionReviews: 0,
		});
		expect(wakes).toHaveLength(1);
		expect(wakes[0]).toMatchObject({
			client_request_id: `interaction-review:${ASK}:1`,
		});
		expect(String(wakes[0]!.text)).toContain(
			"close it with a note or reask once",
		);
	});
	it("keeps failed wake acceptance retryable with the same dispatch identity", async () => {
		const keys: unknown[] = [];
		const { env, db } = await fixture(async (request) => {
			keys.push(
				((await request.json()) as { client_request_id: string })
					.client_request_id,
			);
			return Response.json({ ok: true });
		});
		await expect(
			dispatchInteractionReviews(env, Date.parse(now)),
		).rejects.toThrow("Ambiguous");
		await expect(
			dispatchInteractionReviews(env, Date.parse(now)),
		).rejects.toThrow("Ambiguous");
		expect(await listDueWorkInteractionReviews(db, now)).toHaveLength(1);
		expect(keys[0]).toBe(keys[1]);
	});
	it("lets only the original owner re-ask once, then close with a note", async () => {
		const { client, db, sqlite } = await fixture();
		await expect(
			client("other").review({
				requestId: ASK,
				expectedRequestVersion: 1,
				action: "reask",
				note: "Still needed for the current review.",
			}),
		).rejects.toThrow("Only the original");
		const reasked = await client().review({
			requestId: ASK,
			expectedRequestVersion: 1,
			action: "reask",
			note: "Still needed for the current review.",
		});
		expect(reasked.metadata.followThrough).toMatchObject({
			note: "Still needed for the current review.",
		});
		expect(reasked.prompt).toContain("Follow-up:");
		sqlite
			.prepare(
				"UPDATE work_interactions SET metadata=json_set(metadata,'$.followThrough.reviewAt',?) WHERE id=?",
			)
			.run(createdAt, ASK);
		await expect(
			client().review({
				requestId: ASK,
				expectedRequestVersion: 2,
				action: "reask",
				note: "Please reply again.",
			}),
		).rejects.toThrow("only once");
		const closed = await client().review({
			requestId: ASK,
			expectedRequestVersion: 2,
			action: "close",
			note: "The source no longer needs this decision.",
		});
		expect(closed.state).toBe("cancelled");
		expect(closed.metadata.followThrough).toMatchObject({
			note: "The source no longer needs this decision.",
		});
		expect(await listDueWorkInteractionReviews(db, now)).toHaveLength(0);
	});
	it("requires action evidence after the exact answer and deduplicates its receipt", async () => {
		const { client, answer, event } = await fixture();
		answer();
		const input = {
			requestId: ASK,
			expectedRequestVersion: 2,
			action: "continued" as const,
			responseId: ANSWER,
			evidenceId: "action",
			note: "Updated the review and checked its saved date.",
		};
		await expect(client().review(input)).rejects.toThrow(
			"evidence was not found",
		);
		event("old", createdAt);
		event("foreign", now, TEDI, "other-org");
		event("other-owner", now, "other");
		event("queued", now, TEDI, ORG, "run.started");
		for (const evidenceId of ["old", "foreign", "other-owner", "queued"])
			await expect(client().review({ ...input, evidenceId })).rejects.toThrow(
				"evidence was not found",
			);
		event("action");
		const continued = await client().review(input);
		expect(continued.metadata.followThrough).toMatchObject({
			receipt: { responseId: ANSWER, evidenceId: "action", note: input.note },
		});
		expect((await client().review(input)).version).toBe(continued.version);
		await expect(
			client().review({
				...input,
				expectedRequestVersion: continued.version,
				responseId: "00000000-0000-4000-8000-000000000099",
			}),
		).rejects.toThrow("current exact answer");
	});
	it.each(["completed", "cancelled"])(
		"suppresses reviews after Work is %s",
		async (disposition) => {
			const { db, sqlite, client } = await fixture();
			sqlite
				.prepare("UPDATE work_items SET disposition=? WHERE id=?")
				.run(disposition, WORK);
			expect(await listDueWorkInteractionReviews(db, now)).toHaveLength(0);
			await expect(
				client().review({
					requestId: ASK,
					expectedRequestVersion: 1,
					action: "reask",
					note: "Still needed.",
				}),
			).rejects.toThrow("completed or cancelled Work");
		},
	);
});

it("keeps external-agent ownership fenced to the original session and directs its review there", async () => {
	const { sqlite, db, env } = await fixture();
	sqlite
		.prepare(
			"INSERT INTO external_agent_principals(id,organization_id,key,display_name,credential_binding_type,credential_binding_id,created_by_type,created_by_id,created_at,updated_at) VALUES ('agent',?,'fixture-agent','Fictional coding agent','api_key','fixture-key','user','person','2026-10-13T10:00:00.000Z','2026-10-13T10:00:00.000Z')",
		)
		.run(ORG);
	for (const id of ["session-one", "session-two"])
		sqlite
			.prepare(
				"INSERT INTO external_agent_sessions(id,organization_id,principal_id,external_session_key,harness,harness_version,model_provider,model_id,model_version,identity_source,started_at,last_seen_at) VALUES (?,?,'agent',?,'codex','fixture','fixture','fixture','fixture','explicit',?,?)",
			)
			.run(id, ORG, `codex:${id}`, createdAt, createdAt);
	sqlite
		.prepare(
			"UPDATE work_interactions SET creator_type='external_agent',creator_id='agent',creator_session_id='session-one',creator_external_session_key='codex:session-one' WHERE id=?",
		)
		.run(ASK);
	expect(await dispatchInteractionReviews(env, Date.parse(now))).toEqual({
		interactionReviews: 1,
	});
	const directed = sqlite
		.prepare(
			"SELECT metadata FROM work_interactions WHERE target_type='external_agent' AND target_id='agent'",
		)
		.get() as { metadata: string };
	expect(JSON.parse(directed.metadata)).toMatchObject({
		sessionId: "codex:session-one",
		reviewRequestId: ASK,
	});
	await expect(
		reviewWorkInteraction(db, {
			orgId: ORG,
			interactionId: ASK,
			expectedVersion: 1,
			actor: {
				type: "external_agent",
				id: "agent",
				sessionId: "session-two",
				externalSessionKey: "codex:session-two",
			},
			action: "close",
			note: "Not my session.",
			now,
		}),
	).rejects.toThrow("Only the original");
	expect(
		(
			await reviewWorkInteraction(db, {
				orgId: ORG,
				interactionId: ASK,
				expectedVersion: 1,
				actor: {
					type: "external_agent",
					id: "agent",
					sessionId: "session-one",
					externalSessionKey: "codex:session-one",
				},
				action: "close",
				note: "Rechecked the source; no decision remains.",
				now,
			})
		).status,
	).toBe("cancelled");
});

it("redrives an answered ask only while its continuation receipt is missing", async () => {
	const wakes: Array<Record<string, unknown>> = [];
	const { env, db, answer, event, client } = await fixture(async (request) => {
		wakes.push(await request.json());
		return Response.json({ accepted: true, run_id: "recovery-run" });
	});
	answer();
	expect(
		await dispatchInteractionReviews(env, Date.parse(now) + 60_000),
	).toEqual({ interactionReviews: 0 });
	expect(
		await dispatchInteractionReviews(env, Date.parse(now) + 360_000),
	).toEqual({ interactionReviews: 1 });
	expect(
		await dispatchInteractionReviews(env, Date.parse(now) + 420_000),
	).toEqual({ interactionReviews: 0 });
	expect(wakes[0]!.client_request_id).toBe(
		`interaction-continuation:${ASK}:2:first`,
	);
	expect(String(wakes[0]!.text)).toContain("Do not re-ask the human");
	expect(
		(await getWorkInteraction(db, { orgId: ORG, interactionId: ASK }))?.metadata
			.followThrough,
	).toMatchObject({
		continuationRunId: "recovery-run",
		continuationRetryAt: "2026-10-17T16:06:00.000Z",
	});
	event("continued-action");
	await client().review({
		requestId: ASK,
		expectedRequestVersion: 2,
		action: "continued",
		responseId: ANSWER,
		evidenceId: "continued-action",
		note: "Applied the decision and checked the source.",
	});
	expect(
		await dispatchInteractionReviews(env, Date.parse(now) + 7 * 3_600_000),
	).toEqual({ interactionReviews: 0 });
});
