import { WORK_PROPOSAL_SCHEMA } from "@tedix/api-contract/schemas/work-interactions";
import { projects } from "@tedix/db/schema/projects";
import { organizations } from "@tedix/db/schema/organizations";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { tedis } from "@tedix/db/schema/tedis";
import {
	workInteractionAttention,
	workInteractionCardPresentations,
	workInteractionDeliveries,
	workInteractionReplyDrafts,
	workInteractionResponses,
	workInteractions,
} from "@tedix/db/schema/work-factory";
import {
	workEvents,
	workItemComments,
	workItems,
} from "@tedix/db/schema/work-items";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { workInteractionsContractRouter } from "./work-interactions";
import {
	type ProposalStartActions,
	proposalStartTestHooks,
} from "./work-items/proposal-start";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const WORK_ITEM_ID = "00000000-0000-4000-8000-000000000002";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			organizations,
			projects,
			workItems,
			workEvents,
			workItemComments,
			workInteractions,
			workInteractionCardPresentations,
			workInteractionResponses,
			workInteractionAttention,
			workInteractionReplyDrafts,
			workInteractionDeliveries,
			organizationMembers,
			tedis,
		),
	);
	// schemaDdl omits triggers; use the production response-application trigger.
	const migration = readFileSync(
		new URL(
			"../../../../../packages/db/drizzle/20261010144722_auto_reply_resolves_question/migration.sql",
			import.meta.url,
		),
		"utf8",
	);
	const applyResponse = migration
		.split("--> statement-breakpoint")
		.find((statement) =>
			statement
				.trimStart()
				.startsWith("CREATE TRIGGER `work_interaction_response_apply`"),
		);
	if (!applyResponse)
		throw new Error("Response trigger missing from migration");
	sqlite.exec(applyResponse);
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
	sqlite
		.prepare(
			"INSERT INTO tedis (id,organization_id,name,slug,status) VALUES (?,?,?,?,'active')",
		)
		.run("chat-tedi", ORG_ID, "Chat worker", "chat-worker");
	const facade = createD1Facade(sqlite);
	const clientFor = (identity: {
		userId: string;
		sub: string;
		role: "owner" | "admin" | "member";
		headers?: Headers;
	}) =>
		createRouterClient(workInteractionsContractRouter, {
			context: {
				authType: "user",
				db: createDbClient(facade),
				env: {
					ENVIRONMENT: "test",
					DB: facade,
				} as CloudflareEnv,
				headers: identity.headers ?? new Headers(),
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
		kernel: (approvingUserId?: string) =>
			createRouterClient(workInteractionsContractRouter, {
				context: {
					authType: "service-binding",
					tediId: "chat-tedi",
					tediScopes: ["mcp:messaging.write", "mcp:work.write"],
					db: createDbClient(facade),
					env: { ENVIRONMENT: "test", DB: facade } as CloudflareEnv,
					headers: new Headers({
						"X-Service-Binding": "true",
						...(approvingUserId
							? { "X-Tedix-Approved-Work-Responder": approvingUserId }
							: {}),
					}),
					organizationId: ORG_ID,
					url: new URL("https://api.tedix.test/rpc/workInteractions/respond"),
				} as BaseContext,
			}),
		owner: clientFor({ userId: "owner-id", sub: "owner-sub", role: "owner" }),
		target: clientFor({
			userId: "target-id",
			sub: "target-sub",
			role: "admin",
		}),
		other: clientFor({ userId: "other-id", sub: "other-sub", role: "member" }),
		forged: clientFor({
			userId: "other-id",
			sub: "other-sub",
			role: "member",
			headers: new Headers({
				"X-Tedix-Acting-User": "target-sub",
				"X-Tedix-Approved-Work-Responder": "target-sub",
			}),
		}),
	};
}

const PROJECT_ID = "00000000-0000-4000-8000-000000000003";

function metadata(children = true, projectId: string | undefined = PROJECT_ID) {
	return {
		schema: WORK_PROPOSAL_SCHEMA,
		source: "test evidence",
		proposal: {
			key: "proposal-1",
			projectId,
			item: {
				title: "Proposed epic",
				description: "Deliver the outcome",
				sourceIntentId: "proposal:epic",
			},
			children: children
				? [
						{ title: "First task", sourceIntentId: "proposal:first" },
						{ title: "Second task", sourceIntentId: "proposal:second" },
					]
				: [],
		},
	};
}

function setup() {
	const f = fixture();
	f.sqlite
		.prepare(
			"INSERT INTO projects (id,org_id,key,name,created_at) VALUES (?,?,?,?,?)",
		)
		.run(
			PROJECT_ID,
			ORG_ID,
			"PROPOSAL",
			"Proposal project",
			new Date().toISOString(),
		);
	const propose = (value: Record<string, unknown> = metadata()) =>
		f.owner.create({
			workItemId: WORK_ITEM_ID,
			kind: "handoff",
			subject: "Proposed Work",
			prompt: "Create this Work?",
			requestedFrom: { type: "user", id: "target-id" },
			metadata: value,
		});
	const accept = (request: { id: string; version: number }) =>
		f.target.respond({
			requestId: request.id,
			expectedRequestVersion: request.version,
			responseKind: "handoff_accepted",
			resolvesRequest: true,
			body: "Accepted",
			metadata: { source: "user", workItemIds: ["untrusted"] },
		});
	const rows = () =>
		f.sqlite
			.prepare(
				"SELECT id,title,description,source_intent_id,parent_work_item_id,project_id,work_kind,priority FROM work_items WHERE source_intent_id IS NOT NULL ORDER BY source_intent_id",
			)
			.all();
	return { ...f, propose, accept, rows };
}

describe("Work proposal acceptance", () => {
	it("puts a member's onboarding proposal in their inbox, outside the owner's inbox", async () => {
		const f = setup();
		const request = await f.other.create({
			workItemId: WORK_ITEM_ID,
			kind: "handoff",
			subject: "Add to the board: fictional member task",
			prompt: "Accept or decline this task from your local sessions.",
			requestedFrom: { type: "user", id: "other-id" },
			metadata: metadata(false),
		});
		expect((await f.owner.listInbox({ states: ["open"] })).data).toEqual([]);
		const inbox = await f.other.listInbox({ states: ["open"] });
		expect(inbox.data).toHaveLength(1);
		expect(inbox.data[0]).toMatchObject({
			request: { id: request.id },
			canRespond: true,
		});
		await expect(
			f.owner.respond({
				requestId: request.id,
				expectedRequestVersion: request.version,
				responseKind: "handoff_accepted",
				resolvesRequest: true,
				body: "Accepted",
			}),
		).rejects.toThrow();
		expect(f.rows()).toHaveLength(0);
		await f.other.respond({
			requestId: request.id,
			expectedRequestVersion: request.version,
			responseKind: "handoff_accepted",
			resolvesRequest: true,
			body: "Accepted",
		});
		expect(f.rows()).toHaveLength(1);
	});

	it("creates Work for the approving human and records the chat tedi as actor", async () => {
		const f = setup();
		const request = await f.propose();
		const result = await f.kernel("target-sub").respond({
			requestId: request.id,
			expectedRequestVersion: request.version,
			responseKind: "handoff_accepted",
			resolvesRequest: true,
			body: "Accepted",
			metadata: { actor: { type: "user", id: "spoofed" } },
		});
		expect(f.rows()).toHaveLength(3);
		expect(result.request.state).toBe("resolved");
		expect(result.response).toMatchObject({
			respondedByType: "user",
			respondedById: "target-id",
			metadata: { actor: { type: "tedi", id: "chat-tedi" } },
		});
	});

	it.each(["other-sub", undefined])(
		"rejects chat acceptance without the targeted human's approval (%s)",
		async (approver) => {
			const f = setup();
			const request = await f.propose();
			await expect(
				f.kernel(approver).respond({
					requestId: request.id,
					expectedRequestVersion: request.version,
					responseKind: "handoff_accepted",
					resolvesRequest: true,
					body: "Accepted",
				}),
			).rejects.toThrow("Responder is not the request target");
			expect(f.rows()).toHaveLength(0);
			expect(
				f.sqlite
					.prepare("SELECT status FROM work_interactions WHERE id=?")
					.get(request.id)?.status,
			).toBe("open");
		},
	);

	it("rejects an inactive approving human", async () => {
		const f = setup();
		const request = await f.propose();
		f.sqlite
			.prepare(
				"UPDATE organization_members SET status='inactive' WHERE user_id='target-id'",
			)
			.run();
		await expect(
			f.kernel("target-sub").respond({
				requestId: request.id,
				expectedRequestVersion: request.version,
				responseKind: "handoff_accepted",
				resolvesRequest: true,
				body: "Accepted",
			}),
		).rejects.toThrow(
			"Approved Work responder must be an active organization user",
		);
		expect(f.rows()).toHaveLength(0);
	});

	it.each(["removed", "forged", "policy"])(
		"rejects %s authority without recording a response or creating Work",
		async (scenario) => {
			const f = setup();
			const request = await f.propose();
			if (scenario === "removed") {
				f.sqlite
					.prepare("DELETE FROM organization_members WHERE user_id='target-id'")
					.run();
			}
			const client =
				scenario === "forged"
					? f.forged
					: f.kernel(scenario === "removed" ? "target-sub" : undefined);
			await expect(
				client.respond({
					requestId: request.id,
					expectedRequestVersion: request.version,
					responseKind: "handoff_accepted",
					resolvesRequest: true,
					body: "Accepted",
					metadata: {
						source: "policy",
						actor: { type: "user", id: "target-id" },
					},
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(f.rows()).toEqual([]);
			expect(
				f.sqlite
					.prepare("SELECT status, version FROM work_interactions WHERE id=?")
					.get(request.id),
			).toMatchObject({ status: "open", version: request.version });
			expect(
				f.sqlite
					.prepare("SELECT COUNT(*) AS count FROM work_interaction_responses")
					.get()?.count,
			).toBe(0);
		},
	);

	it("creates an epic and two children, and stores their ids with response evidence", async () => {
		const f = setup();
		const result = await f.accept(await f.propose());
		const ids = result.response.metadata.workItemIds as string[];
		expect(ids).toHaveLength(3);
		expect(f.rows()).toEqual([
			expect.objectContaining({
				id: ids[0],
				title: "Proposed epic",
				description: "Deliver the outcome",
				parent_work_item_id: null,
				project_id: PROJECT_ID,
				work_kind: "other",
				priority: "medium",
			}),
			expect.objectContaining({
				id: ids[1],
				parent_work_item_id: ids[0],
				project_id: PROJECT_ID,
			}),
			expect.objectContaining({
				id: ids[2],
				parent_work_item_id: ids[0],
				project_id: PROJECT_ID,
			}),
		]);
		expect(result.response.metadata.source).toBe("user");
		const stored = f.sqlite
			.prepare("SELECT metadata FROM work_interaction_responses WHERE id=?")
			.get(result.response.id);
		expect(JSON.parse(stored!.metadata as string).workItemIds).toEqual(ids);
		expect(result.request.state).toBe("resolved");
	});

	it("reuses every source intent when a fresh proposal is accepted", async () => {
		const f = setup();
		const first = await f.accept(await f.propose());
		const second = await f.accept(await f.propose());
		expect(second.response.metadata.workItemIds).toEqual(
			first.response.metadata.workItemIds,
		);
		expect(f.rows()).toHaveLength(3);
	});

	it("deduplicates concurrent accepts of fresh proposals through the unique index", async () => {
		const f = setup();
		const first = await f.propose();
		const second = await f.propose();
		const results = await Promise.all([f.accept(first), f.accept(second)]);
		expect(results[0]!.response.metadata.workItemIds).toEqual(
			results[1]!.response.metadata.workItemIds,
		);
		expect(f.rows()).toHaveLength(3);
	});

	it("creates a single unfiled item without children", async () => {
		const f = setup();
		const value = metadata(false);
		delete value.proposal.projectId;
		const result = await f.accept(await f.propose(value));
		expect(f.rows()).toEqual([
			expect.objectContaining({ project_id: null, parent_work_item_id: null }),
		]);
		expect(result.response.metadata.workItemIds).toHaveLength(1);
	});

	it("nests the proposal item under an existing Work item", async () => {
		const f = setup();
		const parent = (await f.accept(await f.propose(metadata(false)))).response
			.metadata.workItemIds as string[];
		const value = metadata(false);
		value.proposal.item.sourceIntentId = "proposal:nested";
		const result = await f.accept(
			await f.propose({
				...value,
				proposal: { ...value.proposal, parentWorkItemId: parent[0] },
			}),
		);
		expect(f.rows()).toContainEqual(
			expect.objectContaining({
				id: (result.response.metadata.workItemIds as string[])[0],
				parent_work_item_id: parent[0],
			}),
		);
	});

	it("declines without creating Work", async () => {
		const f = setup();
		const request = await f.propose();
		const result = await f.target.respond({
			requestId: request.id,
			expectedRequestVersion: request.version,
			responseKind: "handoff_declined",
			resolvesRequest: true,
			body: "Declined",
		});
		expect(result.response.responseKind).toBe("handoff_declined");
		expect(result.request.state).toBe("resolved");
		expect(f.rows()).toEqual([]);
	});

	it("rejects a non-target user before creating Work", async () => {
		const f = setup();
		const request = await f.propose();
		await expect(
			f.other.respond({
				requestId: request.id,
				expectedRequestVersion: request.version,
				responseKind: "handoff_accepted",
				body: "Accepted",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(f.rows()).toEqual([]);
	});

	it.each([{}, { schema: WORK_PROPOSAL_SCHEMA, proposal: { key: "invalid" } }])(
		"leaves ordinary or malformed handoffs unchanged (%j)",
		async (value) => {
			const f = setup();
			const result = await f.accept(await f.propose(value));
			expect(result.response.responseKind).toBe("handoff_accepted");
			expect(result.response.metadata.workItemIds).toEqual(["untrusted"]);
			expect(f.rows()).toEqual([]);
		},
	);

	it("stores a non-resolving acceptance without creating Work", async () => {
		const f = setup();
		const request = await f.propose();
		const result = await f.target.respond({
			requestId: request.id,
			expectedRequestVersion: request.version,
			responseKind: "handoff_accepted",
			resolvesRequest: false,
			body: "Acknowledged",
		});
		expect(result.request.state).toBe("open");
		expect(f.rows()).toEqual([]);
	});

	it.each(["stale", "expired"])(
		"creates nothing for a %s request",
		async (state) => {
			const f = setup();
			const request = await f.propose();
			if (state === "stale") request.version++;
			else
				f.sqlite
					.prepare(
						"UPDATE work_interactions SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
					)
					.run(request.id);
			await expect(f.accept(request)).rejects.toMatchObject({
				code: "CONFLICT",
			});
			expect(f.rows()).toEqual([]);
		},
	);

	it("leaves a failed child create answerable and retries without duplicating partial Work", async () => {
		const f = setup();
		const request = await f.propose();
		f.sqlite.exec(
			"CREATE TRIGGER fail_child BEFORE INSERT ON work_items WHEN NEW.source_intent_id='proposal:second' BEGIN SELECT RAISE(ABORT, 'child create failed'); END",
		);
		await expect(f.accept(request)).rejects.toMatchObject({
			cause: { message: "child create failed" },
		});
		expect(f.rows()).toHaveLength(2);
		expect(
			f.sqlite
				.prepare("SELECT status,version FROM work_interactions WHERE id=?")
				.get(request.id),
		).toMatchObject({ status: "open", version: request.version });
		expect(
			f.sqlite
				.prepare("SELECT COUNT(*) AS count FROM work_interaction_responses")
				.get()!.count,
		).toBe(0);
		f.sqlite.exec("DROP TRIGGER fail_child");
		const result = await f.accept(request);
		expect(result.response.metadata.workItemIds).toHaveLength(3);
		expect(f.rows()).toHaveLength(3);
	});
});

describe("Accepted proposal starts its first step", () => {
	function started() {
		const calls: Array<[string, unknown]> = [];
		const contexts: BaseContext[] = [];
		const actions: ProposalStartActions = {
			async delegate(_context, input) {
				contexts.push(_context);
				calls.push(["delegate", input]);
				return { runId: input.idempotencyKey, status: "queued" };
			},
			async planFactory(_context, input) {
				contexts.push(_context);
				calls.push(["factory", input]);
				return {
					name: input.name ?? "Weekly digest",
					slug: "weekly-digest",
					cron: "17 7 * * *",
					status: "planned",
				};
			},
			async createDocument(_context, input) {
				contexts.push(_context);
				calls.push(["doc", input]);
				return { outputId: "output-1" };
			},
		};
		proposalStartTestHooks.use(actions);
		onTestFinished(() => proposalStartTestHooks.reset());
		const f = setup();
		f.sqlite
			.prepare(
				"INSERT INTO tedis (id,organization_id,name,slug,status,mcp_capability_profile,created_at) VALUES (?,?,?,?,'active',?,?)",
			)
			.run(
				"docs-tedi",
				ORG_ID,
				"Docs worker",
				"docs-worker",
				"tenant_default",
				"2026-09-01T00:00:00.000Z",
			);
		const withStart = (start: Record<string, unknown>) => {
			const value = metadata(false);
			return { ...value, proposal: { ...value.proposal, start } };
		};
		const disposition = (id: string) =>
			f.sqlite.prepare("SELECT disposition FROM work_items WHERE id=?").get(id)
				?.disposition;
		return { ...f, calls, contexts, withStart, disposition };
	}

	it.each(["delegate", "factory", "doc"])(
		"starts an approved-chat %s as the approving member, preserving the tedi audit actor",
		async (kind) => {
			const f = started();
			const request = await f.propose(
				f.withStart({
					kind,
					brief: "Collect the export requirements for the launch.",
				}),
			);
			const result = await f.kernel("target-sub").respond({
				requestId: request.id,
				expectedRequestVersion: request.version,
				responseKind: "handoff_accepted",
				resolvesRequest: true,
				body: "Accepted",
			});
			expect(f.contexts).toHaveLength(1);
			const context = f.contexts[0]!;
			expect(context).toMatchObject({
				authType: "user",
				userId: "target-id",
				userRole: "admin",
				user: { sub: "target-sub" },
				organizationId: ORG_ID,
			});
			expect(context.tediId).toBeUndefined();
			expect(context.tediScopes).toBeUndefined();
			expect([...context.headers]).toEqual([]);
			expect(result.response).toMatchObject({
				respondedByType: "user",
				respondedById: "target-id",
				metadata: {
					actor: { type: "tedi", id: "chat-tedi" },
					started: { kind },
				},
			});
		},
	);

	it("delegates the new Work to the named tedi once, even when accepted again", async () => {
		const f = started();
		const brief = "Reproduce the publish error and fix its validation.";
		const proposal = f.withStart({
			kind: "delegate",
			brief,
			tedi: "docs-worker",
		});
		const first = await f.accept(await f.propose(proposal));
		const [id] = first.response.metadata.workItemIds as string[];
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0]).toEqual([
			"delegate",
			expect.objectContaining({ tediId: "docs-tedi", workItemId: id }),
		]);
		expect((f.calls[0]![1] as { content: string }).content).toContain(brief);
		expect(f.disposition(id!)).toBe("accepted");
		expect(first.response.metadata.started).toMatchObject({
			kind: "delegate",
			status: "started",
			tediName: "Docs worker",
			link: `/work/items/${id}`,
		});
		expect(first.response.body).toContain(
			'Started: Docs worker is working on "Proposed epic"',
		);
		const second = await f.accept(await f.propose(proposal));
		expect(f.calls).toHaveLength(1);
		expect(second.response.metadata.started).toEqual(
			first.response.metadata.started,
		);
	});

	it("plans a factory without switching it on", async () => {
		const f = started();
		const result = await f.accept(
			await f.propose(
				f.withStart({
					kind: "factory",
					brief: "Summarise new support tickets every morning.",
					name: "Ticket digest",
				}),
			),
		);
		expect(f.calls).toEqual([
			[
				"factory",
				expect.objectContaining({
					goal: "Summarise new support tickets every morning.",
					name: "Ticket digest",
				}),
			],
		]);
		expect(result.response.metadata.started).toMatchObject({
			kind: "factory",
			status: "planned",
			command: expect.stringContaining("tedix factory create --goal"),
		});
	});

	it("drafts a document in the member's workspace", async () => {
		const f = started();
		const workspaceId = "00000000-0000-4000-8000-000000000009";
		const result = await f.accept(
			await f.propose(
				f.withStart({
					kind: "doc",
					brief: "Outline the launch plan with owners and dates.",
					workspaceId,
				}),
			),
		);
		expect(f.calls[0]).toEqual([
			"doc",
			expect.objectContaining({ title: "Proposed epic", workspaceId }),
		]);
		expect(result.response.metadata.started).toMatchObject({
			status: "drafted",
			link: "/outputs/output-1",
		});
	});

	it("keeps the accept when the start fails and says so", async () => {
		const f = started();
		proposalStartTestHooks.use({
			delegate: async () => {
				throw new Error("Home is unavailable");
			},
			planFactory: async () => {
				throw new Error("unused");
			},
			createDocument: async () => {
				throw new Error("unused");
			},
		});
		const result = await f.accept(
			await f.propose(
				f.withStart({
					kind: "delegate",
					brief: "Reproduce the publish error and fix its validation.",
				}),
			),
		);
		expect(result.request.state).toBe("resolved");
		expect(result.response.metadata.started).toMatchObject({
			status: "failed",
			error: "Home is unavailable",
		});
		expect(result.response.body).toContain("starting it failed");
	});

	it("only creates Work for a proposal without a start", async () => {
		const f = started();
		const result = await f.accept(await f.propose(metadata(false)));
		expect(f.calls).toEqual([]);
		expect(result.response.metadata.started).toBeUndefined();
	});
});
