import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { tedis } from "@tedix/db/schema/tedis";
import {
	workItems,
	workAttempts,
	workItemComments,
	workItemRelations,
} from "@tedix/db/schema/work-items";
import { tediRuntimeEvents } from "@tedix/db/schema/cognitive-runtime";
import { buildRuntimeRunId } from "@tedix/api-contract/utils/runtime-identity";
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
const ASK2 = "00000000-0000-4000-8000-000000000006";
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
			workItemComments,
			workItemRelations,
			tediRuntimeEvents,
			externalAgentSessions,
			externalAgentPrincipals,
			workInteractions,
			workInteractionCardPresentations,
			workInteractionResponses,
			auditEvents,
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
	it.each(["before", "after"])(
		"reconciles %s-response delivery without completing the failed review",
		async (visible) => {
			let calls = 0;
			const runId = buildRuntimeRunId({
				tediId: TEDI,
				turnKey: `interaction-review:${ASK}:1`,
				surface: "mcp",
			});
			const { env, db } = await fixture(async () => {
				calls++;
				await record();
				return Response.json({ outcome: "failed" }, { status: 500 });
			});
			const record = async () => {
				await db.insert(tediRuntimeEvents).values({
					id: "original-failed-review",
					organizationId: ORG,
					tediId: TEDI,
					runId,
					kind: "run.failed",
					runtimeBackend: "cloudflare-agents",
					createdAt,
				});
			};
			if (visible === "before") await record();
			expect(await dispatchInteractionReviews(env, Date.parse(now))).toEqual({
				interactionReviews: 1,
			});
			const ask = await getWorkInteraction(db, {
				orgId: ORG,
				interactionId: ASK,
			});
			expect(ask).toMatchObject({
				status: "open",
				version: 1,
				metadata: { followThrough: { reviewRunId: runId } },
			});
			expect(
				await dispatchInteractionReviews(env, Date.parse(now) + 120_000),
			).toEqual({ interactionReviews: 0 });
			expect(calls).toBe(visible === "before" ? 0 : 1);
		},
	);
	it("keeps failed wake acceptance retryable with the same dispatch identity", async () => {
		const keys: unknown[] = [];
		const { env, db } = await fixture(async (request) => {
			keys.push(
				((await request.json()) as { client_request_id: string })
					.client_request_id,
			);
			return Response.json({ ok: true });
		});
		const runId = buildRuntimeRunId({
			tediId: TEDI,
			turnKey: `interaction-review:${ASK}:1`,
			surface: "mcp",
		});
		await db.insert(tediRuntimeEvents).values([
			{
				id: "foreign-org",
				organizationId: "00000000-0000-4000-8000-000000000099",
				tediId: TEDI,
				runId,
				kind: "run.failed",
				runtimeBackend: "cloudflare-agents",
				createdAt,
			},
			{
				id: "other-tedi",
				organizationId: ORG,
				tediId: "other",
				runId,
				kind: "run.failed",
				runtimeBackend: "cloudflare-agents",
				createdAt,
			},
		]);
		for (let attempt = 0; attempt < 2; attempt++) {
			const failure = await dispatchInteractionReviews(
				env,
				Date.parse(now),
			).then(
				() => {
					throw new Error("expected the dispatch to report a failure");
				},
				(error: unknown) => error,
			);
			expect(failure).toBeInstanceOf(AggregateError);
			expect(String((failure as AggregateError).errors[0])).toContain(
				"Ambiguous",
			);
			expect((failure as { counts?: Record<string, number> }).counts).toEqual({
				interactionReviews: 0,
				interactionReviewFailures: 1,
			});
		}
		expect(await listDueWorkInteractionReviews(db, now)).toHaveLength(1);
		expect(keys[0]).toBe(keys[1]);
	});
	it("drains the page behind a failed wake and reports only the failure", async () => {
		const keys: unknown[] = [];
		const { env, db } = await fixture(async (request) => {
			const key = ((await request.json()) as { client_request_id: string })
				.client_request_id;
			keys.push(key);
			return key.startsWith(`interaction-review:${ASK}:`)
				? Response.json({ ok: true })
				: Response.json({ accepted: true, run_id: "review-run-2" });
		});
		await createWorkInteraction(db, {
			id: ASK2,
			orgId: ORG,
			workItemId: WORK,
			kind: "question",
			subject: "Confirm the migration window",
			prompt: "Which window?",
			creator: { type: "tedi", id: TEDI },
			targetType: "user",
			targetId: "person",
			now: createdAt,
		});
		const failure = await dispatchInteractionReviews(env, Date.parse(now)).then(
			() => {
				throw new Error("expected the dispatch to report a failure");
			},
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as { counts?: Record<string, number> }).counts).toEqual({
			interactionReviews: 1,
			interactionReviewFailures: 1,
		});
		expect(keys).toHaveLength(2);
		// ASK sorts first and stays due for the next tick; ASK2 was still woken.
		expect(
			(await listDueWorkInteractionReviews(db, now)).map((row) => row.id),
		).toEqual([ASK]);
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

it.each([false, true])(
	"rechecks an answered delete card before waking its executor (stale=%s)",
	async (stale) => {
		const wakes: Array<Record<string, unknown>> = [];
		const { env, db, sqlite, answer } = await fixture(async (request) => {
			wakes.push(await request.json());
			return Response.json({ accepted: true, run_id: "delete-run" });
		});
		sqlite
			.prepare(
				"UPDATE work_interactions SET subject='Delete the paused copy?',prompt='Delete before it resumes?',metadata=json_set(metadata,'$.decisionSources',json(?)) WHERE id=?",
			)
			.run(
				JSON.stringify([
					{ kind: "work", id: WORK, version: 1, commentCount: 0 },
				]),
				ASK,
			);
		answer();
		if (stale)
			sqlite
				.prepare(
					"INSERT INTO work_item_comments(id,org_id,work_item_id,author_type,body,created_at) VALUES ('credit',?,?,'user','Credits renewed; the instance is live production.',?)",
				)
				.run(ORG, WORK, now);
		await dispatchInteractionReviews(env, Date.parse(now) + 360_000);
		expect(wakes).toHaveLength(stale ? 0 : 1);
		if (stale) {
			const { recheckDecisionAction } =
				await import("../services/decision-action-recheck");
			const changed = await recheckDecisionAction(
				db,
				(await getWorkInteraction(db, { orgId: ORG, interactionId: ASK }))!,
			);
			expect(changed).toEqual({
				change:
					"The linked Work has a newer comment: Credits renewed; the instance is live production.",
				reviewableThrough: now,
				note: "Credits renewed; the instance is live production.",
			});
			expect(
				sqlite
					.prepare(
						"SELECT id FROM work_interactions WHERE json_extract(metadata,'$.replacesDecisionId')=?",
					)
					.all(ASK),
			).toHaveLength(0);
			expect(
				await dispatchInteractionReviews(env, Date.parse(now) + 720_000),
			).toEqual({ interactionReviews: 0 });
			expect(wakes).toHaveLength(0);
		}
		sqlite.close();
	},
);
