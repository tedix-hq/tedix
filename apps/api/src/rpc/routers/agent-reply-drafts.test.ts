/**
 * Tedi-drafted replies on the agent-turn triage router: only the question's
 * target user may request a draft, only the target's configured drafting tedi
 * may propose one, urgent or untriaged turns are never drafted, the drafting
 * turn is queued once per question, delivery is `auto` only inside the
 * autoSend guardrails, and acceptance is measured from cited responses.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import type { AgentTurnTriagePolicyInput } from "@tedix/api-contract/schemas/agent-turn-triage";
import { createDbClient } from "@tedix/db/client";
import { skillEntries } from "@tedix/db/schema/cognitive";
import { chatDispatchIdempotency } from "@tedix/db/schema/cognitive-runtime";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { tedis } from "@tedix/db/schema/tedis";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { workAgentSessions } from "@tedix/db/schema/work-agent-sessions";
import {
	workInteractionReplyDrafts,
	workInteractionResponses,
	workInteractions,
} from "@tedix/db/schema/work-factory";
import { workEvents, workItems } from "@tedix/db/schema/work-items";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import {
	agentTurnTriageContractRouter,
	DEFAULT_AGENT_TURN_TRIAGE_POLICY,
	nextReplyDraftAttempt,
	REPLY_DRAFT_OWNER_TIMEOUT_S,
} from "./agent-turn-triage";

// A gate on the sessions read lets a test hold the prompt's reads open.
const sessionsRead = vi.hoisted(() => ({
	gate: null as Promise<void> | null,
}));
vi.mock("@tedix/db/queries/work-agent-sessions", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@tedix/db/queries/work-agent-sessions")
		>();
	return {
		...actual,
		listWorkAgentSessions: async (
			...args: Parameters<typeof actual.listWorkAgentSessions>
		) => {
			if (sessionsRead.gate) await sessionsRead.gate;
			return actual.listWorkAgentSessions(...args);
		},
	};
});

// The direct reply-draft dispatch reuses the queue consumer's handler.
const directDispatch = vi.hoisted(() => ({
	handle: vi.fn(
		async (_env: unknown, _body: unknown, _opts?: unknown) => "ack",
	),
}));
vi.mock("../../jobs/automation-events", () => ({
	handleAutomationEventMessage: directDispatch.handle,
}));

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const WORK_ITEM_ID = "00000000-0000-4000-8000-000000000002";
const DRAFTER_ID = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TEDI_ID = "00000000-0000-4000-8000-0000000000a2";
const PROJECT_ID = "00000000-0000-4000-8000-0000000000b1";
const QUIET = {
	schema: "tedix.decision-capture.v1",
	triage: {
		status: "ok",
		urgency: "later",
		labels: { risky_action: 0.1 },
		urgentLabels: [],
	},
};

let nextId = 0;
const uuid = () =>
	`00000000-0000-4000-8000-${(++nextId).toString(16).padStart(12, "0")}`;

function fixture(options: { waitUntil?: boolean } = {}) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			userConfigs,
			workItems,
			workEvents,
			workInteractions,
			workInteractionResponses,
			workInteractionReplyDrafts,
			workAgentSessions,
			organizationMembers,
			tedis,
			chatDispatchIdempotency,
			skillEntries,
		),
	);
	sqlite
		.prepare(
			"INSERT INTO work_items (id,org_id,title,created_at) VALUES (?,?,?,?)",
		)
		.run(WORK_ITEM_ID, ORG_ID, "Ship drafts", "2026-08-21T00:00:00.000Z");
	const insertMember = sqlite.prepare(`INSERT INTO organization_members
		(id,organization_id,user_id,descope_user_id,email,role,status)
		VALUES (?,?,?,?,?,?,'active')`);
	insertMember.run(
		"m-target",
		ORG_ID,
		"target-id",
		"target-sub",
		"t@x.test",
		"owner",
	);
	insertMember.run(
		"m-other",
		ORG_ID,
		"other-id",
		"other-sub",
		"o@x.test",
		"admin",
	);
	const insertTedi = sqlite.prepare(
		"INSERT INTO tedis (id,organization_id,name,slug,status) VALUES (?,?,?,?,'active')",
	);
	insertTedi.run(DRAFTER_ID, ORG_ID, "Drafter", "drafter");
	insertTedi.run(OTHER_TEDI_ID, ORG_ID, "Other", "other");
	sqlite
		.prepare(
			"INSERT INTO work_agent_sessions (id,organization_id,user_id,harness,session_key,label,state,summary,state_since,last_event_at,created_at,updated_at) VALUES ('s1',?,'target-id','claude-code','k1','api refactor','working','Migrating the billing router',?,?,'2026-08-21T00:00:00.000Z','2026-08-21T00:00:00.000Z')",
		)
		.run(ORG_ID, "2026-08-21T00:00:00.000Z", new Date().toISOString());

	const facade = createD1Facade(sqlite);
	const send = vi.fn(async (_body: unknown) => undefined);
	// The Clef delivery gate: every default check passes unless a test says otherwise.
	const clef = vi.fn(async (_model: string, _input: unknown) => ({
		answers: {
			irreversible_step: { type: "noul", noul: 0.05 },
			correction_or_challenge: { type: "noul", noul: 0.05 },
			needs_human: { type: "noul", noul: 0.05 },
		} as Record<string, unknown>,
	}));
	const env = {
		ENVIRONMENT: "test",
		DB: facade,
		AI: { run: clef },
		AUTOMATION_EVENTS: { send },
	} as unknown as CloudflareEnv;
	const pending: Promise<unknown>[] = [];
	const base = {
		db: createDbClient(facade) as BaseContext["db"],
		env,
		...(options.waitUntil
			? { waitUntil: (promise: Promise<unknown>) => pending.push(promise) }
			: {}),
		headers: new Headers(),
		organizationId: ORG_ID,
		url: new URL("https://api.tedix.test/rpc/agentTurnTriage"),
	};
	const user = (userId: string, sub: string) =>
		createRouterClient(agentTurnTriageContractRouter, {
			context: {
				...base,
				authType: "user",
				userId,
				user: {
					aud: "test",
					dct: "tenant-1",
					exp: 2,
					iat: 1,
					iss: "https://auth.tedix.test",
					permissions: ["tedis:read", "tedis:update"],
					roles: [],
					sub,
				},
			} as BaseContext,
		});
	// The MCP edge reaches the API over a trusted service binding and forwards
	// the calling tedi's id and resolved scopes.
	const tedi = (tediId: string) =>
		createRouterClient(agentTurnTriageContractRouter, {
			context: {
				...base,
				headers: new Headers({
					"X-Service-Binding": "true",
					"X-Tedix-Mcp-Tool-Id": "work:propose_agent_reply_draft",
					"X-Tedix-Tedi-Id": tediId,
					"X-Tedix-Tedi-Scopes": "mcp:messaging.read mcp:messaging.write",
				}),
			} as BaseContext,
		});

	function question(
		metadata: Record<string, unknown> = QUIET,
		overrides: {
			status?: string;
			targetType?: string;
			targetId?: string;
			createdAt?: string;
			projectId?: string | null;
		} = {},
	) {
		const id = uuid();
		sqlite
			.prepare(
				"INSERT INTO work_interactions (id,org_id,work_item_id,project_id,kind,status,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,version,metadata) VALUES (?,?,?,?,'question',?,?,?,'user','target-id',?,?,?,1,?)",
			)
			.run(
				id,
				ORG_ID,
				WORK_ITEM_ID,
				overrides.projectId ?? null,
				overrides.status ?? "open",
				"Should I ship the migration?",
				"Tests pass. Commit and push now?",
				overrides.targetType ?? "user",
				overrides.targetId ?? "target-id",
				overrides.createdAt ?? "2026-08-21T00:00:00.000Z",
				JSON.stringify(metadata),
			);
		return id;
	}

	const target = user("target-id", "target-sub");
	async function configure(
		patch: Partial<AgentTurnTriagePolicyInput> = {},
	): Promise<void> {
		const { version: _version, ...defaults } = DEFAULT_AGENT_TURN_TRIAGE_POLICY;
		const current = await target.getPolicy({});
		await target.updatePolicy({
			expectedRevision: current.revision,
			policy: {
				...defaults,
				drafting: {
					enabled: true,
					tediId: DRAFTER_ID,
					skillSlug: "operator-reply-style",
				},
				...patch,
			},
		});
	}

	// A gateway credential carries the member's sub but no resolved userId.
	const gatewayUser = (sub: string) =>
		createRouterClient(agentTurnTriageContractRouter, {
			context: {
				...base,
				authType: "user",
				user: {
					aud: "test",
					dct: "tenant-1",
					exp: 2,
					iat: 1,
					iss: "https://auth.tedix.test",
					permissions: ["tedis:read", "tedis:update"],
					roles: [],
					sub,
				},
			} as BaseContext,
		});

	/** A dispatch-ledger row for one attempt key, `ageMs` old. */
	function dispatched(key: string, ageMs: number) {
		sqlite
			.prepare(
				"INSERT INTO chat_dispatch_idempotency (idempotency_key,tedi_id,organization_id,conversation_id,status,created_at) VALUES (?,?,?,?,'queued',?)",
			)
			.run(
				key,
				DRAFTER_ID,
				ORG_ID,
				key,
				new Date(Date.now() - ageMs).toISOString(),
			);
	}

	return {
		sqlite,
		send,
		pending,
		dispatched,
		clef,
		target,
		gatewayTarget: gatewayUser("target-sub"),
		other: user("other-id", "other-sub"),
		drafter: tedi(DRAFTER_ID),
		otherTedi: tedi(OTHER_TEDI_ID),
		question,
		configure,
	};
}

describe("requestReplyDraft", () => {
	it("queues one idempotent drafting turn for the configured tedi", async () => {
		const f = fixture();
		await f.configure();
		const requestId = f.question();
		await expect(f.target.requestReplyDraft({ requestId })).resolves.toEqual({
			status: "queued",
		});
		await f.target.requestReplyDraft({ requestId });
		expect(f.send).toHaveBeenCalledTimes(2);
		const [first] = f.send.mock.calls[0] as [Record<string, unknown>];
		const [second] = f.send.mock.calls[1] as [Record<string, unknown>];
		expect(first).toMatchObject({
			kind: "tedi_turn",
			organizationId: ORG_ID,
			tediId: DRAFTER_ID,
			idempotencyKey: `reply-draft:${requestId}`,
			conversationId: `reply-draft:${requestId}`,
			source: "reply-draft:v6",
		});
		expect(second.idempotencyKey).toBe(first.idempotencyKey);
		const content = first.content as string;
		expect(content).toContain("Should I ship the migration?");
		expect(content).toContain("Tests pass. Commit and push now?");
		expect(content).toContain("api refactor [working]");
		// The configured skill has no readable row here.
		expect(content).toContain(
			'The drafting skill "operator-reply-style" is unavailable',
		);
		// The board is inlined, so the only tool call is the proposal.
		expect(content).toContain(
			`Linked Work Item ${WORK_ITEM_ID} [proposed, medium]: Ship drafts`,
		);
		// The drafter's only tool is Code Mode: the prompt names it and the
		// exact call, with this question's id filled in.
		expect(content).toContain("Make exactly one tool call: tedix_mcp_code");
		expect(content).toContain("Never ask a question, never answer in text");
		expect(content).toContain("no discover.search");
		expect(content).not.toContain("work.list_work_items");
		expect(content).not.toContain("get_skills_for_mcp");
		// Corrections and challenges always wait for the operator's review.
		expect(content).toMatch(/corrects the agent[^.]*always reversible false/);
		expect(content).toContain(
			`async () => await agent.propose_agent_reply_draft({ requestId: "${requestId}", body: "`,
		);
		expect(content).toContain(`turnType: "approval", reversible: true })`);
		expect(content).not.toMatch(/\{\{\w+\}\}/);
	});

	it.each([
		["urgent", { ...QUIET, triage: { ...QUIET.triage, urgency: "now" } }],
		[
			"urgent",
			{ ...QUIET, triage: { ...QUIET.triage, urgentLabels: ["risky_action"] } },
		],
		[
			"untriaged",
			{ ...QUIET, triage: { ...QUIET.triage, status: "unavailable" } },
		],
		["untriaged", { schema: QUIET.schema }],
		["not_decision_capture", { ...QUIET, schema: "other.v1" }],
	])("never drafts a %s turn", async (reason, metadata) => {
		const f = fixture();
		await f.configure();
		const requestId = f.question(metadata);
		await expect(f.target.requestReplyDraft({ requestId })).resolves.toEqual({
			status: "ineligible",
			reason,
		});
		expect(f.send).not.toHaveBeenCalled();
	});

	it("reports closed questions, disabled drafting, and a missing tedi", async () => {
		const f = fixture();
		const resolved = f.question(QUIET, { status: "resolved" });
		const open = f.question();
		await expect(
			f.target.requestReplyDraft({ requestId: open }),
		).resolves.toEqual({ status: "ineligible", reason: "drafting_disabled" });
		await f.configure();
		await expect(
			f.target.requestReplyDraft({ requestId: resolved }),
		).resolves.toEqual({ status: "ineligible", reason: "not_open" });
		f.sqlite.exec(
			`UPDATE tedis SET retired_at='2026-08-21T00:00:00.000Z' WHERE id='${DRAFTER_ID}'`,
		);
		await expect(
			f.target.requestReplyDraft({ requestId: open }),
		).resolves.toEqual({ status: "ineligible", reason: "no_drafting_tedi" });
		expect(f.send).not.toHaveBeenCalled();
	});

	it("is reserved to the question's target user", async () => {
		const f = fixture();
		await f.configure();
		const requestId = f.question();
		await expect(
			f.other.requestReplyDraft({ requestId }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			f.drafter.requestReplyDraft({ requestId }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			f.target.requestReplyDraft({ requestId: uuid() }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(f.send).not.toHaveBeenCalled();
	});
});

describe("requestReplyDraft board context", () => {
	it("inlines the linked item, the project's accepted items, and the skill", async () => {
		const f = fixture();
		await f.configure();
		const insertItem = f.sqlite.prepare(
			"INSERT INTO work_items (id,org_id,project_id,title,disposition,priority,created_at) VALUES (?,?,?,?,?,?,?)",
		);
		for (let index = 0; index < 12; index++) {
			insertItem.run(
				uuid(),
				ORG_ID,
				PROJECT_ID,
				`Accepted ${index}`,
				"accepted",
				"high",
				`2026-08-21T00:00:${String(index).padStart(2, "0")}.000Z`,
			);
		}
		insertItem.run(
			uuid(),
			ORG_ID,
			PROJECT_ID,
			"Still proposed",
			"proposed",
			"high",
			"2026-08-22T00:00:00.000Z",
		);
		f.sqlite
			.prepare(
				"INSERT INTO skill_entries (id,organization_id,title,slug,content,visibility) VALUES (?,?,?,?,?,'org')",
			)
			.run(
				uuid(),
				ORG_ID,
				"Reply style",
				"operator-reply-style",
				"Always ask for the live check.",
			);
		const requestId = f.question(QUIET, { projectId: PROJECT_ID });
		await f.target.requestReplyDraft({ requestId });
		const [event] = f.send.mock.calls[0] as [Record<string, unknown>];
		const content = event.content as string;
		expect(content).toContain(`Accepted Work Items of project ${PROJECT_ID}:`);
		expect(content).toContain("[high]: Accepted 11");
		expect(content).toContain("[high]: Accepted 2");
		// At most ten, newest first; never another disposition.
		expect(content).not.toContain("Accepted 1\n");
		expect(content).not.toContain("Still proposed");
		expect(content).toContain(
			'Drafting skill "operator-reply-style"; follow it where it differs from the style below:\n<<<\nAlways ask for the live check.\n>>>',
		);
	});
});

describe("requestReplyDraft attempts", () => {
	it("starts the next attempt only after an old dispatch left no draft", async () => {
		const f = fixture();
		await f.configure();
		const requestId = f.question();
		f.dispatched(`reply-draft:${requestId}`, 5 * 60_000);
		await expect(f.target.requestReplyDraft({ requestId })).resolves.toEqual({
			status: "queued",
		});
		const [event] = f.send.mock.calls[0] as [Record<string, unknown>];
		expect(event).toMatchObject({
			idempotencyKey: `reply-draft:${requestId}:2`,
			conversationId: `reply-draft:${requestId}:2`,
		});
	});

	it("is a no-op while an attempt is in flight or once a draft exists", async () => {
		const f = fixture();
		await f.configure();
		const inFlight = f.question();
		f.dispatched(`reply-draft:${inFlight}`, 30_000);
		await expect(
			f.target.requestReplyDraft({ requestId: inFlight }),
		).resolves.toEqual({ status: "queued" });

		const drafted = f.question();
		f.dispatched(`reply-draft:${drafted}`, 5 * 60_000);
		await f.drafter.proposeReplyDraft({
			requestId: drafted,
			body: "Ship it.",
			rationale: "Tests pass.",
			reversible: false,
		});
		await expect(
			f.target.requestReplyDraft({ requestId: drafted }),
		).resolves.toEqual({ status: "queued" });
		expect(f.send).not.toHaveBeenCalled();
	});

	it("stops after three attempts", async () => {
		const f = fixture();
		await f.configure();
		const requestId = f.question();
		f.dispatched(`reply-draft:${requestId}`, 9 * 60_000);
		f.dispatched(`reply-draft:${requestId}:2`, 6 * 60_000);
		f.dispatched(`reply-draft:${requestId}:3`, 3 * 60_000);
		await expect(f.target.requestReplyDraft({ requestId })).resolves.toEqual({
			status: "ineligible",
			reason: "attempts_exhausted",
		});
		expect(f.send).not.toHaveBeenCalled();
	});

	it("reads D1 CURRENT_TIMESTAMP rows as UTC", () => {
		const nowMs = Date.parse("2026-10-07T10:30:00.000Z");
		expect(
			nextReplyDraftAttempt({
				hasDraft: false,
				dispatchedAt: ["2026-10-07 10:29:00", null, null],
				nowMs,
			}),
		).toEqual({ action: "pending" });
		expect(
			nextReplyDraftAttempt({
				hasDraft: false,
				dispatchedAt: ["2026-10-07 10:27:00", null, null],
				nowMs,
			}),
		).toEqual({ action: "dispatch", attempt: 2 });
	});
});

describe("requestReplyDraft direct dispatch", () => {
	it("dispatches in the request lifetime instead of queueing", async () => {
		directDispatch.handle.mockClear();
		directDispatch.handle.mockResolvedValueOnce("ack");
		const f = fixture({ waitUntil: true });
		await f.configure();
		const requestId = f.question();
		await expect(f.target.requestReplyDraft({ requestId })).resolves.toEqual({
			status: "queued",
		});
		await Promise.all(f.pending);
		expect(directDispatch.handle).toHaveBeenCalledTimes(1);
		const [, body] = directDispatch.handle.mock.calls[0] as [unknown, unknown];
		expect(body).toMatchObject({
			kind: "tedi_turn",
			idempotencyKey: `reply-draft:${requestId}`,
		});
		expect(f.send).not.toHaveBeenCalled();
	});

	it("answers before the prompt's reads finish", async () => {
		directDispatch.handle.mockClear();
		directDispatch.handle.mockResolvedValueOnce("ack");
		let release = () => {};
		sessionsRead.gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const f = fixture({ waitUntil: true });
			await f.configure();
			const requestId = f.question();
			// The sessions read is still pending: the response must not wait on it.
			await expect(f.target.requestReplyDraft({ requestId })).resolves.toEqual({
				status: "queued",
			});
			expect(f.pending).toHaveLength(1);
			expect(directDispatch.handle).not.toHaveBeenCalled();
			release();
			await Promise.all(f.pending);
			expect(directDispatch.handle).toHaveBeenCalledTimes(1);
			expect(f.send).not.toHaveBeenCalled();
		} finally {
			sessionsRead.gate = null;
			release();
		}
	});

	it("falls back to the queue when the direct dispatch fails", async () => {
		directDispatch.handle.mockClear();
		directDispatch.handle.mockResolvedValueOnce("retry");
		const f = fixture({ waitUntil: true });
		await f.configure();
		const requestId = f.question();
		await f.target.requestReplyDraft({ requestId });
		await Promise.all(f.pending);
		expect(f.send).toHaveBeenCalledTimes(1);
		expect(
			(f.send.mock.calls[0] as [Record<string, unknown>])[0],
		).toMatchObject({ idempotencyKey: `reply-draft:${requestId}` });
	});
});

describe("requestReplyDraft owner routing", () => {
	const draft = {
		body: "Yes, push it.",
		rationale: "Tests pass.",
		reversible: false,
	};

	/** OTHER_TEDI is an org tedi; Clef picks it (t1) with probability `p`. */
	function routedFixture(p: number) {
		const f = fixture();
		f.sqlite
			.prepare("UPDATE tedis SET scope='organization' WHERE id=?")
			.run(OTHER_TEDI_ID);
		f.clef.mockImplementation(async (_model, input) =>
			"owner" in (input as { questions: Record<string, unknown> }).questions
				? {
						answers: {
							owner: {
								type: "choice",
								choice: "t1",
								probabilities: { t1: p, none: 1 - p },
								confidence: p,
							},
						},
					}
				: { answers: {} },
		);
		return f;
	}

	it("sends the first attempt to the owning tedi with a delayed drafter fallback", async () => {
		const f = routedFixture(0.9);
		await f.configure();
		const requestId = f.question();
		await f.target.requestReplyDraft({ requestId });
		expect(f.send).toHaveBeenCalledTimes(2);
		const [fallback, options] = f.send.mock.calls[0] as unknown as [
			Record<string, unknown>,
			{ delaySeconds: number },
		];
		const [owned] = f.send.mock.calls[1] as [Record<string, unknown>];
		expect(owned).toMatchObject({
			tediId: OTHER_TEDI_ID,
			idempotencyKey: `reply-draft:${requestId}`,
			source: "reply-draft:v6:owner",
		});
		expect(owned.skipIfReplyDraftFor).toBeUndefined();
		expect(fallback).toMatchObject({
			tediId: DRAFTER_ID,
			idempotencyKey: `reply-draft:${requestId}:2`,
			conversationId: `reply-draft:${requestId}:2`,
			source: "reply-draft:v6:owner-timeout",
			skipIfReplyDraftFor: requestId,
			content: owned.content,
		});
		expect(options).toEqual({ delaySeconds: REPLY_DRAFT_OWNER_TIMEOUT_S });
	});

	it("keeps the drafter below the routing threshold", async () => {
		const f = routedFixture(0.6);
		await f.configure();
		const requestId = f.question();
		await f.target.requestReplyDraft({ requestId });
		expect(f.send).toHaveBeenCalledTimes(1);
		expect(
			(f.send.mock.calls[0] as [Record<string, unknown>])[0],
		).toMatchObject({ tediId: DRAFTER_ID, source: "reply-draft:v6" });
	});

	it("lets the dispatched owner propose once; the late drafter is refused", async () => {
		const f = routedFixture(0.9);
		await f.configure();
		const requestId = f.question();
		// Not dispatched to it yet: an unconfigured tedi is refused.
		await expect(
			f.otherTedi.proposeReplyDraft({ requestId, ...draft }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		f.sqlite
			.prepare(
				"INSERT INTO chat_dispatch_idempotency (idempotency_key,tedi_id,organization_id,conversation_id,status,created_at) VALUES (?,?,?,?,'queued',CURRENT_TIMESTAMP)",
			)
			.run(
				`reply-draft:${requestId}`,
				OTHER_TEDI_ID,
				ORG_ID,
				`reply-draft:${requestId}`,
			);
		const { draftId } = await f.otherTedi.proposeReplyDraft({
			requestId,
			...draft,
		});
		expect(
			f.sqlite
				.prepare(
					"SELECT drafter_id FROM work_interaction_reply_drafts WHERE id=?",
				)
				.get(draftId),
		).toMatchObject({ drafter_id: OTHER_TEDI_ID });
		await expect(
			f.drafter.proposeReplyDraft({ requestId, ...draft }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});

describe("proposeReplyDraft", () => {
	const draft = {
		body: "Yes, push it.",
		rationale: "Board priority is the migration; you approve green pushes.",
		turnType: "approval",
		reversible: true,
	};

	it("stores a draft from the configured drafting tedi", async () => {
		const f = fixture();
		await f.configure();
		const requestId = f.question();
		const { draftId, delivery } = await f.drafter.proposeReplyDraft({
			requestId,
			...draft,
		});
		// autoSend is off by default: the draft waits for review.
		expect(delivery).toBe("review");
		expect(
			f.sqlite
				.prepare("SELECT * FROM work_interaction_reply_drafts WHERE id=?")
				.get(draftId),
		).toMatchObject({
			interaction_id: requestId,
			drafter_type: "tedi",
			drafter_id: DRAFTER_ID,
			body: draft.body,
			turn_type: "approval",
			delivery: "review",
		});
		// A draft is a proposal: the question stays open and unanswered.
		expect(
			f.sqlite
				.prepare("SELECT status FROM work_interactions WHERE id=?")
				.get(requestId),
		).toMatchObject({ status: "open" });
		expect(
			f.sqlite
				.prepare("SELECT count(*) AS n FROM work_interaction_responses")
				.get(),
		).toMatchObject({ n: 0 });
	});

	it("rejects every other principal", async () => {
		const f = fixture();
		await f.configure();
		const requestId = f.question();
		for (const caller of [f.otherTedi, f.target, f.other]) {
			await expect(
				caller.proposeReplyDraft({ requestId, ...draft }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		const unconfigured = fixture();
		const id = unconfigured.question();
		await expect(
			unconfigured.drafter.proposeReplyDraft({ requestId: id, ...draft }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("rechecks eligibility and never drafts urgent turns", async () => {
		const f = fixture();
		await f.configure();
		for (const metadata of [
			{ ...QUIET, triage: { ...QUIET.triage, urgency: "now" } },
			{
				...QUIET,
				triage: { ...QUIET.triage, urgentLabels: ["human_only_action"] },
			},
			{ schema: QUIET.schema },
		]) {
			const requestId = f.question(metadata);
			await expect(
				f.drafter.proposeReplyDraft({ requestId, ...draft }),
			).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT" });
		}
		const resolved = f.question(QUIET, { status: "resolved" });
		await expect(
			f.drafter.proposeReplyDraft({ requestId: resolved, ...draft }),
		).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT" });
		expect(
			f.sqlite
				.prepare("SELECT count(*) AS n FROM work_interaction_reply_drafts")
				.get(),
		).toMatchObject({ n: 0 });
	});
});

describe("policy owner through the MCP gateway", () => {
	it("resolves the verified member when the credential carries no userId", async () => {
		const f = fixture();
		const { version: _version, ...defaults } = DEFAULT_AGENT_TURN_TRIAGE_POLICY;
		const current = await f.gatewayTarget.getPolicy({});
		await f.gatewayTarget.updatePolicy({
			expectedRevision: current.revision,
			policy: { ...defaults, drafting: { enabled: true, tediId: DRAFTER_ID } },
		});
		// The same row the session user and the draft tools read.
		const viaSession = await f.target.getPolicy({});
		expect(viaSession.source).not.toBe("default");
		expect(viaSession.policy.drafting).toMatchObject({
			enabled: true,
			tediId: DRAFTER_ID,
		});
		const requestId = f.question();
		await expect(
			f.gatewayTarget.requestReplyDraft({ requestId }),
		).resolves.toMatchObject({
			status: "queued",
		});
	});
});

describe("proposeReplyDraft delivery", () => {
	const SESSION = { ...QUIET, sessionId: "session-a" };
	const AUTO_SEND = { autoSend: { enabled: true, maxConsecutive: 3 } };
	const draft = {
		body: "Continue with the migration you recommended.",
		rationale: "Board priority; the step is a reviewed push to main.",
		turnType: "continue",
		reversible: true,
	};
	const at = (minute: number) =>
		`2026-08-21T00:${String(minute).padStart(2, "0")}:00.000Z`;

	/** One agent turn of session-a: a quiet question plus a proposed draft. */
	async function turn(
		f: ReturnType<typeof fixture>,
		minute: number,
		overrides: Partial<typeof draft> = {},
		metadata: Record<string, unknown> = SESSION,
	) {
		const requestId = f.question(metadata, { createdAt: at(minute) });
		const { delivery } = await f.drafter.proposeReplyDraft({
			requestId,
			...draft,
			...overrides,
		});
		return { requestId, delivery };
	}

	function userReply(
		f: ReturnType<typeof fixture>,
		requestId: string,
		replyClass: string,
	) {
		f.sqlite
			.prepare(
				"INSERT INTO work_interaction_responses (id,org_id,interaction_id,resolved_request_version,resolution_fence,responder_type,responder_id,body,response_kind,resolves_request,metadata,responded_at) VALUES (?,?,?,2,'fence','user','target-id','Reply','answer',1,?,?)",
			)
			.run(
				uuid(),
				ORG_ID,
				requestId,
				JSON.stringify({
					source: "user-reply",
					sessionId: "session-a",
					replyClass,
				}),
				new Date().toISOString(),
			);
	}

	it("stays review while the policy is off", async () => {
		const f = fixture();
		await f.configure();
		expect((await turn(f, 1)).delivery).toBe("review");
	});

	it("stays review when the drafter does not assert reversibility", async () => {
		const f = fixture();
		await f.configure(AUTO_SEND);
		expect((await turn(f, 1, { reversible: false })).delivery).toBe("review");
		expect((await turn(f, 2)).delivery).toBe("auto");
	});

	it("stays review without a session id or with a zero budget", async () => {
		const f = fixture();
		await f.configure(AUTO_SEND);
		expect((await turn(f, 1, {}, QUIET)).delivery).toBe("review");
		await f.configure({ autoSend: { enabled: true, maxConsecutive: 0 } });
		expect((await turn(f, 2)).delivery).toBe("review");
	});

	it("exhausts the budget at maxConsecutive and resets after a user reply", async () => {
		const f = fixture();
		await f.configure(AUTO_SEND);
		const deliveries = [];
		for (const minute of [1, 2, 3, 4])
			deliveries.push((await turn(f, minute)).delivery);
		expect(deliveries).toEqual(["auto", "auto", "auto", "review"]);
		// Another session of the same user has its own budget.
		expect(
			(await turn(f, 5, {}, { ...QUIET, sessionId: "session-b" })).delivery,
		).toBe("auto");
		// The user answers the review turn themselves: the budget resets.
		const answered = await turn(f, 6, { reversible: false });
		expect(answered.delivery).toBe("review");
		userReply(f, answered.requestId, "instruction");
		expect((await turn(f, 7)).delivery).toBe("auto");
	});

	it("never auto-sends an urgent turn", async () => {
		const f = fixture();
		await f.configure(AUTO_SEND);
		for (const metadata of [
			{ ...SESSION, triage: { ...QUIET.triage, urgency: "now" } },
			{
				...SESSION,
				triage: { ...QUIET.triage, urgentLabels: ["risky_action"] },
			},
		]) {
			const requestId = f.question(metadata, { createdAt: at(1) });
			await expect(
				f.drafter.proposeReplyDraft({ requestId, ...draft }),
			).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT" });
		}
		expect(
			f.sqlite
				.prepare("SELECT count(*) AS n FROM work_interaction_reply_drafts")
				.get(),
		).toMatchObject({ n: 0 });
	});

	describe("Clef delivery gate", () => {
		const PASSING = {
			irreversible_step: 0.05,
			correction_or_challenge: 0.05,
			needs_human: 0.05,
		};
		function answers(probabilities: Record<string, number>) {
			return {
				answers: Object.fromEntries(
					Object.entries(probabilities).map(([id, noul]) => [
						id,
						{ type: "noul", noul },
					]),
				),
			};
		}
		function storedGate(f: ReturnType<typeof fixture>, requestId: string) {
			const row = f.sqlite
				.prepare(
					"SELECT gate FROM work_interaction_reply_drafts WHERE interaction_id=?",
				)
				.get(requestId) as { gate: string | null };
			return row.gate === null ? null : JSON.parse(row.gate);
		}

		it("auto-sends only when every check passes and records the audit", async () => {
			const f = fixture();
			await f.configure(AUTO_SEND);
			const { requestId, delivery } = await turn(f, 1);
			expect(delivery).toBe("auto");
			const [model, input] = f.clef.mock.calls[0] ?? [];
			expect(model).toBe("@cf/cloudflare/clef-flash");
			expect(input).toMatchObject({
				state: {
					agent_message: "Tests pass. Commit and push now?",
					draft_reply: draft.body,
				},
			});
			expect(Object.keys((input as { questions: object }).questions)).toEqual(
				Object.keys(PASSING),
			);
			expect(storedGate(f, requestId)).toMatchObject({
				status: "pass",
				checks: [
					{ id: "irreversible_step", p: 0.05, pass: true },
					{ id: "correction_or_challenge", p: 0.05, pass: true },
					{ id: "needs_human", p: 0.05, pass: true },
				],
			});
			const detail = await f.target.getReplyDraftAcceptance({});
			expect(detail.byTurnType[0]?.autoSent).toBe(1);
		});

		it.each([
			["irreversible_step", { irreversible_step: 0.31 }],
			["correction_or_challenge", { correction_or_challenge: 0.31 }],
			["needs_human", { needs_human: 0.31 }],
		])("delivers review when %s fails", async (failed, patch) => {
			const f = fixture();
			await f.configure(AUTO_SEND);
			f.clef.mockResolvedValueOnce(answers({ ...PASSING, ...patch }));
			const { requestId, delivery } = await turn(f, 1);
			expect(delivery).toBe("review");
			const gate = storedGate(f, requestId);
			expect(gate.status).toBe("fail");
			expect(
				gate.checks
					.filter((check: { pass: boolean }) => !check.pass)
					.map((check: { id: string }) => check.id),
			).toEqual([failed]);
		});

		it("fails closed when Clef errors or answers malformed", async () => {
			const f = fixture();
			await f.configure(AUTO_SEND);
			f.clef.mockRejectedValueOnce(new Error("5xx from Workers AI"));
			const errored = await turn(f, 1);
			expect(errored.delivery).toBe("review");
			expect(storedGate(f, errored.requestId)).toMatchObject({
				status: "unavailable",
				checks: [],
			});
			f.clef.mockResolvedValueOnce(answers({ irreversible_step: 0.01 }));
			const partial = await turn(f, 2);
			expect(partial.delivery).toBe("review");
			expect(storedGate(f, partial.requestId).status).toBe("unavailable");
		});

		it("is not consulted when an earlier guardrail already chose review", async () => {
			const f = fixture();
			await f.configure(AUTO_SEND);
			const { requestId, delivery } = await turn(f, 1, { reversible: false });
			expect(delivery).toBe("review");
			expect(f.clef).not.toHaveBeenCalled();
			expect(storedGate(f, requestId)).toBeNull();
		});

		it("applies a policy-configured gate", async () => {
			const f = fixture();
			await f.configure({
				...AUTO_SEND,
				deliveryGate: {
					model: "@cf/cloudflare/clef",
					questions: [
						{
							id: "tone_ok",
							instructions: "Is the reply polite?",
							autoWhen: { gte: 0.5 },
						},
					],
				},
			});
			f.clef.mockResolvedValueOnce(answers({ tone_ok: 0.4 }));
			expect((await turn(f, 1)).delivery).toBe("review");
			f.clef.mockResolvedValueOnce(answers({ tone_ok: 0.6 }));
			expect((await turn(f, 2)).delivery).toBe("auto");
			expect(f.clef.mock.calls[1]?.[0]).toBe("@cf/cloudflare/clef");
		});
	});

	it("reports auto sends and overrides in acceptance", async () => {
		const f = fixture();
		await f.configure(AUTO_SEND);
		const first = await turn(f, 1);
		const second = await turn(f, 2);
		userReply(f, second.requestId, "continue");
		const third = await turn(f, 3);
		userReply(f, third.requestId, "correction");
		expect([first.delivery, second.delivery, third.delivery]).toEqual([
			"auto",
			"auto",
			"auto",
		]);
		const { byTurnType } = await f.target.getReplyDraftAcceptance({});
		// first: followed up on the next question (second) with "continue";
		// second: same; third: overridden by a correction on itself.
		expect(byTurnType).toEqual([
			expect.objectContaining({
				turnType: "continue",
				drafts: 3,
				autoSent: 3,
				autoFollowedUp: 3,
				overridden: 1,
				overrideRate: 1 / 3,
			}),
		]);
	});
});

describe("getReplyDraftAcceptance", () => {
	it("measures the caller's cited outcomes against policy thresholds", async () => {
		const f = fixture();
		await f.configure({ eligibility: { minRate: 0.5, minDrafts: 2 } });
		for (const outcome of ["accepted", "accepted", "edited"]) {
			const requestId = f.question();
			const { draftId } = await f.drafter.proposeReplyDraft({
				requestId,
				body: "Yes",
				rationale: "Priority",
				turnType: "approval",
				reversible: true,
			});
			f.sqlite
				.prepare(
					"INSERT INTO work_interaction_responses (id,org_id,interaction_id,resolved_request_version,resolution_fence,responder_type,responder_id,body,response_kind,resolves_request,metadata,responded_at) VALUES (?,?,?,2,'fence','user','target-id','Yes','answer',1,?,?)",
				)
				.run(
					uuid(),
					ORG_ID,
					requestId,
					JSON.stringify({ draftId, draftOutcome: outcome, editRatio: 0 }),
					new Date().toISOString(),
				);
		}
		await expect(f.target.getReplyDraftAcceptance({})).resolves.toEqual({
			byTurnType: [
				{
					turnType: "approval",
					drafts: 3,
					decided: 3,
					accepted: 2,
					edited: 1,
					replaced: 0,
					rate: 2 / 3,
					eligible: true,
					autoSent: 0,
					autoFollowedUp: 0,
					overridden: 0,
					overrideRate: 0,
				},
			],
			policy: { minRate: 0.5, minDrafts: 2 },
		});
		await expect(f.other.getReplyDraftAcceptance({})).resolves.toEqual({
			byTurnType: [],
			policy: { minRate: 0.9, minDrafts: 50 },
		});
		await expect(f.drafter.getReplyDraftAcceptance({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});

describe("requestReplyDraft examples", () => {
	const HEADER = "How this user replied to similar agent turns";

	/** A question the target answered, resolved the way the API leaves it. */
	async function answered(
		f: ReturnType<typeof fixture>,
		reply: string,
		metadata: Record<string, unknown>,
		draft?: { body: string },
	) {
		const requestId = f.question({ ...QUIET, repository: "api" });
		let cited: Record<string, unknown> = {};
		if (draft) {
			const { draftId } = await f.drafter.proposeReplyDraft({
				requestId,
				body: draft.body,
				rationale: "Tests pass.",
				turnType: "approval",
				reversible: true,
			});
			cited = { draftId };
		}
		f.sqlite
			.prepare(
				"INSERT INTO work_interaction_responses (id,org_id,interaction_id,resolved_request_version,resolution_fence,responder_type,responder_id,body,response_kind,resolves_request,metadata,responded_at) VALUES (?,?,?,2,'fence','user','target-id',?,'answer',1,?,?)",
			)
			.run(
				uuid(),
				ORG_ID,
				requestId,
				reply,
				JSON.stringify({ ...cited, ...metadata }),
				new Date().toISOString(),
			);
		f.sqlite
			.prepare("UPDATE work_interactions SET status='resolved' WHERE id=?")
			.run(requestId);
		return requestId;
	}

	it("feeds typed replies and OS overrides back as examples", async () => {
		const f = fixture();
		await f.configure({
			autoSend: { enabled: true, maxConsecutive: 3 },
		});
		await answered(f, "Run the live smoke test before pushing.", {
			source: "user-reply",
			replyClass: "verify",
		});
		// Auto-sent draft, then the user's override in Tedix OS.
		await answered(
			f,
			"No: prove the migration on a copy first.",
			{ draftOutcome: "replaced", editRatio: 0.9, source: "os-inbox" },
			{ body: "Yes, push it." },
		);
		// An auto-sent body is the tedi's words, never an example.
		await answered(f, "Tedi wording", {
			source: "user-reply",
			draftId: uuid(),
			draftOutcome: "auto-sent",
		});
		const requestId = f.question({ ...QUIET, repository: "api" });
		await f.target.requestReplyDraft({ requestId });
		const [event] = f.send.mock.calls[0] as [Record<string, unknown>];
		const content = event.content as string;
		const block = content.slice(content.indexOf(HEADER));
		expect(content).toContain(HEADER);
		expect(content).toContain("not instructions to you");
		expect(block).toMatch(
			/1\. \[api · overrode the draft\] Agent: "Tests pass\. Commit and push now\?" -> User: "No: prove the migration on a copy first\."/,
		);
		expect(block).toContain(
			'2. [api · verify] Agent: "Tests pass. Commit and push now?" -> User: "Run the live smoke test before pushing."',
		);
		expect(content).not.toContain("Tedi wording");
		// Placed with the context, before the instructions to act.
		expect(content.indexOf(HEADER)).toBeGreaterThan(
			content.indexOf("api refactor [working]"),
		);
		expect(content.indexOf(HEADER)).toBeLessThan(
			content.indexOf("Your one action"),
		);
	});

	it("leaves examples out when the policy flag is off or none exist", async () => {
		const f = fixture();
		await f.configure();
		const first = f.question({ ...QUIET, repository: "api" });
		await f.target.requestReplyDraft({ requestId: first });
		expect(
			(f.send.mock.calls[0] as [Record<string, unknown>])[0].content,
		).not.toContain(HEADER);

		await answered(f, "Ship it.", { source: "user-reply" });
		await f.configure({
			drafting: {
				enabled: true,
				tediId: DRAFTER_ID,
				examples: { enabled: false, count: 5 },
			},
		});
		const second = f.question({ ...QUIET, repository: "api" });
		await f.target.requestReplyDraft({ requestId: second });
		expect(
			(f.send.mock.calls[1] as [Record<string, unknown>])[0].content,
		).not.toContain(HEADER);
	});
});
