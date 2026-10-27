import { tediObjectives } from "@tedix/db/schema/tedi-objectives";
import { projects } from "@tedix/db/schema/projects";
import { apiKeys } from "@tedix/db/schema/api-keys";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
import {
	externalAgentPrincipals,
	externalAgentSessions,
	externalAgentMcpCredentials,
} from "@tedix/db/schema/external-agent-identity";
import { createExternalAgentPrincipal } from "@tedix/db/queries/external-agent-identity/principals";
import { openExternalAgentSession } from "@tedix/db/queries/external-agent-identity/sessions";
import { recordExternalAgentMcpCredential } from "@tedix/db/queries/external-agent-identity/mcp-credentials";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { tedis } from "@tedix/db/schema/tedis";
import {
	workResourceRequirements,
	workBudgetEnvelopes,
	workApprovalDecisions,
	workApprovalExecutions,
	workApprovalProposals,
} from "@tedix/db/schema/work-factory";
import { workEvents, workItems } from "@tedix/db/schema/work-items";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { workApprovalsContractRouter } from "./work-approvals";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const WORK_ITEM_ID = "00000000-0000-4000-8000-000000000002";

function fixture(userId = "canonical-user-id") {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			apiKeys,
			learningInteractionEvents,
			workResourceRequirements,
			workBudgetEnvelopes,
			externalAgentPrincipals,
			externalAgentSessions,
			externalAgentMcpCredentials,
			workItems,
			workEvents,
			workApprovalProposals,
			workApprovalDecisions,
			workApprovalExecutions,
			organizationMembers,
			tedis,
			projects,
			tediObjectives,
		),
	);
	sqlite
		.prepare(
			"INSERT INTO work_items (id,org_id,title,required_authorities,created_at) VALUES (?,?,?,json(?),?)",
		)
		.run(
			WORK_ITEM_ID,
			ORG_ID,
			"Canonical identity approval",
			JSON.stringify(["deploy:production"]),
			"2026-08-20T00:00:00.000Z",
		);
	sqlite
		.prepare(
			`INSERT INTO organization_members
			(id,organization_id,user_id,descope_user_id,email,role,status)
			VALUES (?,?,?,?,?,'owner','active')`,
		)
		.run(
			"membership-1",
			ORG_ID,
			"canonical-user-id",
			"provider-subject-id",
			"owner@tedix.test",
		);
	sqlite
		.prepare(
			`INSERT INTO organization_members
			(id,organization_id,user_id,descope_user_id,email,role,status)
			VALUES (?,?,?,?,?,'admin','active')`,
		)
		.run(
			"membership-2",
			ORG_ID,
			"canonical-approver-id",
			"approver-provider-subject-id",
			"approver@tedix.test",
		);
	sqlite
		.prepare(
			"INSERT INTO tedis (id,organization_id,name,slug,status,mcp_capability_profile) VALUES (?,?,?,?,'active','standard')",
		)
		.run("tedi-approver-id", ORG_ID, "Approver", "approver");
	const facade = createD1Facade(sqlite);
	const context = {
		authType: "user",
		db: createDbClient(facade),
		env: { ENVIRONMENT: "test", DB: facade } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		url: new URL("https://api.tedix.test/rpc/work-approvals"),
		userId,
		userRole: "owner",
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: [],
			roles: [],
			sub: "provider-subject-id",
		},
	} as BaseContext;
	const clientFor = (identity: {
		userId: string;
		sub: string;
		role: "owner" | "admin";
	}) =>
		createRouterClient(workApprovalsContractRouter, {
			context: {
				...context,
				userId: identity.userId,
				userRole: identity.role,
				user: { ...context.user!, sub: identity.sub },
			} as BaseContext,
		});
	const clientForTedi = (tediId: string) =>
		createRouterClient(workApprovalsContractRouter, {
			context: {
				...context,
				authType: undefined,
				headers: new Headers({
					"X-Service-Binding": "true",
					"X-Tedix-Org-Id": ORG_ID,
					"X-Tedix-Tedi-Id": tediId,
					"X-Tedix-Tedi-Scopes": "mcp:messaging.read mcp:messaging.write",
				}),
				tediId: undefined,
				tediScopes: undefined,
				user: undefined,
				userId: undefined,
				userRole: undefined,
			} as BaseContext,
		});
	return {
		context,
		sqlite,
		client: createRouterClient(workApprovalsContractRouter, { context }),
		clientFor,
		clientForTedi,
	};
}

describe("Work approval canonical principal identity", () => {
	it("lists legacy system-requested proposals through the validated inbox", async () => {
		const { client, clientFor, sqlite } = fixture();
		const proposal = await client.propose({
			workItemId: WORK_ITEM_ID,
			workItemVersion: 1,
			proposal: { operation: "admit_work_attempt" },
			authorityKey: "deploy:production",
			approverType: "user",
			approverId: "canonical-approver-id",
			requestRationale: "Persisted system admission request",
			expiresAt: "2099-08-20T13:00:00.000Z",
		});
		sqlite
			.prepare("UPDATE work_approval_proposals SET requester_type=? WHERE id=?")
			.run("system", proposal.id);

		const approver = clientFor({
			userId: "canonical-approver-id",
			sub: "approver-provider-subject-id",
			role: "admin",
		});
		const inbox = await approver.listInbox({
			proposalId: proposal.id,
			limit: 1,
		});
		expect(inbox.data).toHaveLength(1);
		expect(inbox.data[0]?.proposal).toMatchObject({
			id: proposal.id,
			requestedByType: "system",
		});
	});
	it("lists a proposal whose Work Item carries the retired claims[] acceptance contract", async () => {
		// Older rows carry a {version:1, claims:[...]} contract. Returning the
		// joined Work Item raw failed strict output validation for every page
		// that reached such a row; work-item reads drop `claims`.
		const { client, clientFor, sqlite } = fixture();
		const approver = clientFor({
			userId: "canonical-approver-id",
			sub: "approver-provider-subject-id",
			role: "admin",
		});
		sqlite
			.prepare(
				"UPDATE work_items SET acceptance_contract = json(?), priority = 'critical' WHERE id = ?",
			)
			.run(
				JSON.stringify({
					version: 1,
					claims: [
						{
							key: "retryable_no_decision",
							label: "x",
							minimumAcceptedEvidence: 1,
							evidenceKinds: ["commit", "test"],
							requiresIndependentReview: true,
						},
					],
				}),
				WORK_ITEM_ID,
			);
		const proposal = await client.propose({
			workItemId: WORK_ITEM_ID,
			workItemVersion: 1,
			proposal: { summary: "legacy contract row" },
			authorityKey: "deploy:production",
			approverType: "user",
			approverId: "canonical-approver-id",
			requestRationale: "Legacy acceptance contract must still list",
			expiresAt: "2099-01-01T00:00:00.000Z",
		});
		const inbox = await approver.listInbox({ limit: 5 });
		const row = inbox.data.find((r) => r.proposal.id === proposal.id);
		expect(row?.workItem.acceptanceContract).toEqual({ version: 1 });
		const audit = await client.listAudit({ limit: 50 });
		expect(
			audit.data.find((r) => r.proposal.id === proposal.id)?.workItem
				.acceptanceContract,
		).toEqual({ version: 1 });
	});

	it("binds proposals to the server-owned admission action", async () => {
		const { client } = fixture();
		const proposal = await client.propose({
			workItemId: WORK_ITEM_ID,
			workItemVersion: 1,
			proposal: { operation: "admit_work_attempt" },
			authorityKey: "deploy:production",
			approverType: "user",
			approverId: "canonical-approver-id",
			requestRationale: "Request Work admission approval",
			expiresAt: "2099-08-20T13:00:00.000Z",
		});
		expect(proposal.action).toBe("admission");
		expect(proposal.authorityKey).toBe("deploy:production");
	});

	it("scopes the actionable inbox to the designated actor and preserves the admin audit ledger", async () => {
		const { client, clientFor } = fixture();
		const proposal = await client.propose({
			workItemId: WORK_ITEM_ID,
			workItemVersion: 1,
			proposal: { operation: "admit_work_attempt" },
			authorityKey: "deploy:production",
			approverType: "user",
			approverId: "canonical-approver-id",
			requestRationale: "Request Work admission approval",
			expiresAt: "2099-08-20T13:00:00.000Z",
		});
		const requesterInbox = await client.listInbox({ limit: 50 });
		expect(requesterInbox.data).toEqual([]);

		const approver = clientFor({
			userId: "canonical-approver-id",
			sub: "approver-provider-subject-id",
			role: "admin",
		});
		const approverInbox = await approver.listInbox({ limit: 50 });
		expect(approverInbox.data).toHaveLength(1);
		expect(approverInbox.data[0]).toMatchObject({
			canDecide: true,
			proposal: { id: proposal.id, approverId: "canonical-approver-id" },
		});

		const audit = await client.listAudit({ limit: 50 });
		expect(audit.data).toHaveLength(1);
		expect(audit.data[0]).toMatchObject({
			canDecide: false,
			proposal: { id: proposal.id },
		});
	});

	it("rejects a non-designated decision and lets the exact inbox actor decide", async () => {
		const { client, clientFor, sqlite } = fixture();
		const proposal = await client.propose({
			workItemId: WORK_ITEM_ID,
			workItemVersion: 1,
			proposal: { operation: "admit_work_attempt" },
			authorityKey: "deploy:production",
			approverType: "user",
			approverId: "canonical-approver-id",
			requestRationale: "Request Work admission approval",
			expiresAt: "2099-08-20T13:00:00.000Z",
		});
		await expect(
			client.decide({
				proposalId: proposal.id,
				expectedProposalVersion: proposal.version,
				decision: "approved",
				rationale: "Requester must not decide",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		const approver = clientFor({
			userId: "canonical-approver-id",
			sub: "approver-provider-subject-id",
			role: "admin",
		});
		const receipt = await approver.decide({
			proposalId: proposal.id,
			expectedProposalVersion: proposal.version,
			decision: "approved",
			rationale: "Exact admission authority reviewed",
		});
		expect(receipt.decision).toMatchObject({
			deciderType: "user",
			deciderId: "canonical-approver-id",
			decision: "approved",
		});
		const learned = sqlite
			.prepare(
				"SELECT client_event_id, actor_id, scope_kind, metadata FROM learning_interaction_events",
			)
			.all() as Array<{
			client_event_id: string;
			actor_id: string;
			scope_kind: string;
			metadata: string;
		}>;
		expect(learned).toHaveLength(1);
		expect(learned[0]).toMatchObject({
			client_event_id: `work-approval:${receipt.decision.id}`,
			actor_id: "approver-provider-subject-id",
			scope_kind: "personal",
		});
		expect(JSON.parse(learned[0].metadata)).toMatchObject({
			serverObserved: true,
			decisionClass: "deploy:production",
			decisionChoice: "approve",
		});
	});

	it("rejects same-human self-approval when JWT sub differs from canonical userId", async () => {
		const { sqlite, client } = fixture();
		await expect(
			client.propose({
				workItemId: WORK_ITEM_ID,
				workItemVersion: 1,
				proposal: { artifactRef: "tedix-api-production" },
				authorityKey: "deploy:production",
				approverType: "user",
				approverId: "canonical-user-id",
				requestRationale: "Request deployment approval",
				expiresAt: "2099-08-20T13:00:00.000Z",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			(
				sqlite
					.prepare("SELECT count(*) AS count FROM work_approval_proposals")
					.get() as { count: number }
			).count,
		).toBe(0);
		expect(
			(
				sqlite
					.prepare("SELECT count(*) AS count FROM work_approval_decisions")
					.get() as { count: number }
			).count,
		).toBe(0);
	});

	it("lets the exact designated active tedi decide without a human wrapper", async () => {
		const { client, clientForTedi } = fixture();
		const proposal = await client.propose({
			workItemId: WORK_ITEM_ID,
			workItemVersion: 1,
			proposal: { operation: "admit_work_attempt" },
			authorityKey: "deploy:production",
			approverType: "tedi",
			approverId: "tedi-approver-id",
			requestRationale: "Request independent tedi admission review",
			expiresAt: "2099-08-20T13:00:00.000Z",
		});
		const approver = clientForTedi("tedi-approver-id");
		const inbox = await approver.listInbox({ limit: 50 });
		expect(inbox.data[0]).toMatchObject({
			canDecide: true,
			proposal: { id: proposal.id, approverType: "tedi" },
		});
		const receipt = await approver.decide({
			proposalId: proposal.id,
			expectedProposalVersion: proposal.version,
			decision: "approved",
			rationale: "Independent tedi reviewed the exact proposal version",
		});
		expect(receipt.decision).toMatchObject({
			deciderType: "tedi",
			deciderId: "tedi-approver-id",
			decision: "approved",
		});
	});

	it("rejects self-approval after falling back from an unknown canonical id to the subject membership", async () => {
		const { sqlite, client } = fixture("stale-context-user-id");
		await expect(
			client.propose({
				workItemId: WORK_ITEM_ID,
				workItemVersion: 1,
				proposal: { artifactRef: "tedix-api-production" },
				authorityKey: "deploy:production",
				approverType: "user",
				approverId: "canonical-user-id",
				requestRationale: "Request deployment approval",
				expiresAt: "2099-08-20T13:00:00.000Z",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			(
				sqlite
					.prepare("SELECT count(*) AS count FROM work_approval_proposals")
					.get() as { count: number }
			).count,
		).toBe(0);
	});
});

async function externalRequester(scopes: string[]) {
	const { context, sqlite } = fixture();
	const now = new Date().toISOString();
	await context.db.insert(apiKeys).values({
		id: "key-requester",
		organizationId: ORG_ID,
		name: "Fixture",
		keyHash: "fictional-requester-hash",
		keyPreview: "fixture",
		status: "active",
	});
	const principal = await createExternalAgentPrincipal(context.db, {
		id: "00000000-0000-4000-8000-000000000010",
		organizationId: ORG_ID,
		key: "requester",
		displayName: "Requester",
		credentialBindingType: "api_key",
		credentialBindingId: "key-requester",
		createdByType: "user",
		createdById: "canonical-user-id",
		createdAt: now,
	});
	const session = await openExternalAgentSession(context.db, {
		id: "00000000-0000-4000-8000-000000000020",
		organizationId: ORG_ID,
		principalId: principal.id,
		externalSessionKey: "codex:approval-request",
		harness: "codex",
		harnessVersion: "test",
		modelProvider: "openai",
		modelId: "test",
		modelVersion: "test",
		identitySource: "native",
		startedAt: now,
	});
	await recordExternalAgentMcpCredential(context.db, {
		id: "00000000-0000-4000-8000-000000000030",
		organizationId: ORG_ID,
		principalId: principal.id,
		sessionId: session.id,
		clientRecordId: "requester-client",
		mcpServerId: "test-server",
		mcpServerUrl: "https://test.mcp.tedix.dev/mcp",
		issuedAt: now,
		expiresAt: "2099-01-01T00:00:00.000Z",
	});
	const client = createRouterClient(workApprovalsContractRouter, {
		context: {
			...context,
			authType: undefined,
			user: undefined,
			userId: undefined,
			userRole: undefined,
			headers: new Headers({
				"X-Service-Binding": "true",
				"X-Tedix-Org-Id": ORG_ID,
				"X-Tedix-Caller-Type": "mcp-edge-external-agent",
				"X-Tedix-External-Agent-Principal-Id": principal.id,
				"X-Tedix-External-Agent-Session-Id": session.id,
				"X-Tedix-External-Agent-Client-Record-Id": "requester-client",
				"X-Tedix-Tedi-Scopes": scopes.join(" "),
			}),
		} as BaseContext,
	});
	return { client, sqlite, principal, session };
}
const requestInput = {
	workItemId: WORK_ITEM_ID,
	workItemVersion: 1,
	proposal: { operation: "admit_work_attempt" as const },
	authorityKey: "deploy:production",
	approverType: "user" as const,
	approverId: "canonical-approver-id",
	requestRationale: "Request admission",
	expiresAt: "2099-08-20T13:00:00.000Z",
};
it("allows a verified external requester with Work write and preserves approver-only surfaces", async () => {
	const { client, principal, session } = await externalRequester([
		"mcp:work.write",
		"mcp:messaging.write",
		"mcp:messaging.read",
	]);
	const proposal = await client.propose(requestInput);
	expect(proposal).toMatchObject({
		requestedByType: "external_agent",
		requestedById: principal.id,
		requestedBySessionId: session.id,
		status: "pending",
	});
	await expect(
		client.decide({
			proposalId: proposal.id,
			expectedProposalVersion: proposal.version,
			decision: "approved",
			rationale: "Cannot self approve",
		}),
	).rejects.toThrow(/designated user or tedi credential/);
	await expect(client.listInbox({})).rejects.toThrow(
		/eligible user or tedi approver credential/,
	);
});
it("requires Work write specifically rather than messaging authority", async () => {
	const allowed = await externalRequester(["mcp:work.write"]);
	await expect(allowed.client.propose(requestInput)).resolves.toMatchObject({
		status: "pending",
	});
	const denied = await externalRequester([
		"mcp:work.read",
		"mcp:messaging.write",
	]);
	await expect(denied.client.propose(requestInput)).rejects.toThrow();
	expect(
		denied.sqlite
			.prepare("SELECT count(*) AS count FROM work_approval_proposals")
			.get(),
	).toMatchObject({ count: 0 });
});

it("returns current canonical scope and admission resources to the designated reviewer", async () => {
	const { client, clientFor, sqlite } = fixture();
	const proposal = await client.propose(requestInput);
	sqlite
		.prepare(
			"UPDATE work_items SET description=?,acceptance_contract=?,risk_level='high',version=2 WHERE id=?",
		)
		.run(
			"Canonical repair scope",
			JSON.stringify({ version: 1, doneLooksLike: "Canonical outcome" }),
			WORK_ITEM_ID,
		);
	sqlite
		.prepare("UPDATE work_approval_proposals SET created_at=? WHERE id=?")
		.run("2020-01-01T00:00:00.000Z", proposal.id);
	const newerProposal = await client.propose({
		...requestInput,
		workItemVersion: 2,
	});
	sqlite
		.prepare(
			"INSERT INTO work_resource_requirements(org_id,work_item_id,resource_key,quantity,created_at,updated_at) VALUES(?,?,?,1,?,?)",
		)
		.run(
			ORG_ID,
			WORK_ITEM_ID,
			"worker:approval-path",
			"2026-09-01T00:00:00Z",
			"2026-09-01T00:00:00Z",
		);
	sqlite
		.prepare(
			"INSERT INTO work_budget_envelopes(id,org_id,scope_type,scope_id,limit_micros,reservation_micros,created_at) VALUES(?,?,'work_item',?,1000,100,?)",
		)
		.run("budget", ORG_ID, WORK_ITEM_ID, "2026-09-01T00:00:00Z");
	const approver = clientFor({
		userId: "canonical-approver-id",
		sub: "approver-provider-subject-id",
		role: "admin",
	});
	expect(
		(await approver.listInbox({ workItemId: WORK_ITEM_ID, limit: 1 })).data[0]
			?.proposal.id,
	).toBe(newerProposal.id);
	const inbox = await approver.listInbox({
		proposalId: proposal.id,
		limit: 1,
	});
	expect(inbox.data[0]).toMatchObject({
		proposal: { id: proposal.id, workItemVersion: 1 },
		workItem: {
			id: WORK_ITEM_ID,
			orgId: ORG_ID,
			description: "Canonical repair scope",
			acceptanceContract: { version: 1, doneLooksLike: "Canonical outcome" },
			riskLevel: "high",
			version: 2,
			requiredAuthorities: ["deploy:production"],
		},
		admissionSpecification: {
			workItemVersion: 2,
			resources: [{ resourceKey: "worker:approval-path", quantity: 1 }],
			budget: { limitMicros: 1000, reservationMicros: 100 },
		},
	});
	expect(inbox.data[0]?.workItem.createdAt).toEqual(expect.any(String));
	expect(Number.isNaN(Date.parse(inbox.data[0]!.workItem.createdAt))).toBe(
		false,
	);
	expect(
		(
			await approver.listInbox({
				proposalId: "00000000-0000-4000-8000-000000000000",
			})
		).data,
	).toEqual([]);
	expect((await client.listInbox({ proposalId: proposal.id })).data).toEqual(
		[],
	);
});

function routineAcceptanceFixture() {
	const f = fixture();
	// Use the installed migration guards, including the decision->proposal trigger.
	const guards = readFileSync(
		new URL(
			"../../../../../packages/db/drizzle/20260821020828_work_factory_external_session_fences/migration.sql",
			import.meta.url,
		),
		"utf8",
	);
	for (const statement of guards.split("--> statement-breakpoint")) {
		if (statement.trim().startsWith("CREATE TRIGGER `work_approval_"))
			f.sqlite.exec(statement);
	}
	const request = {
		workItemId: WORK_ITEM_ID,
		workItemVersion: 1,
		action: "acceptance" as const,
		acceptanceContract: {
			version: 1 as const,
			doneLooksLike: "The bounded guide is published and checked.",
		},
		proposal: {
			scope: "Read-only guide; no publication decision or credential changes.",
		},
		authorityKey: "work:accept",
		approverType: "tedi" as const,
		approverId: "tedi-approver-id",
		requestRationale: "Independent routine acceptance",
		expiresAt: "2099-01-01T00:00:00.000Z",
	};
	const decide = (
		proposalId: string,
		decision: "approved" | "rejected" = "approved",
	) =>
		f.clientForTedi("tedi-approver-id").decide({
			proposalId,
			expectedProposalVersion: 1,
			decision,
			rationale: "Independent scope and done-when review.",
		});
	const item = () =>
		f.sqlite
			.prepare(
				"SELECT disposition,version,acceptance_contract FROM work_items WHERE id=?",
			)
			.get(WORK_ITEM_ID) as {
			disposition: string;
			version: number;
			acceptance_contract: string | null;
		};
	return { ...f, request, decide, item };
}

describe("Independent tedi routine acceptance", () => {
	it("records the tedi decision and authorized executor acceptance without tedi Work-write scopes", async () => {
		const f = routineAcceptanceFixture();
		const proposal = await f.client.propose(f.request);
		expect(proposal.action).toBe("acceptance");
		const result = await f.decide(proposal.id);
		expect(result.proposal.status).toBe("approved");
		expect(result.decision).toMatchObject({
			deciderType: "tedi",
			deciderId: "tedi-approver-id",
		});
		expect(f.item()).toMatchObject({ disposition: "accepted", version: 2 });
		expect(JSON.parse(f.item().acceptance_contract!)).toEqual(
			f.request.acceptanceContract,
		);
		const event = f.sqlite
			.prepare(
				"SELECT actor_type,actor_id,payload FROM work_events WHERE event_type='work.accepted'",
			)
			.get() as { actor_type: string; actor_id: string; payload: string };
		expect(event).toMatchObject({ actor_type: "system", actor_id: "tedix" });
		expect(JSON.parse(event.payload)).toMatchObject({
			executor: "api:work-acceptance",
			proposalId: proposal.id,
			decisionId: result.decision.id,
			deciderId: "tedi-approver-id",
		});
		await expect(f.decide(proposal.id)).rejects.toThrow(/no longer resolvable/);
		expect(
			f.sqlite
				.prepare(
					"SELECT count(*) AS n FROM work_events WHERE event_type='work.accepted'",
				)
				.get(),
		).toMatchObject({ n: 1 });
		// Acceptance preserves the independent admission authority and its action.
		expect(
			f.sqlite
				.prepare("SELECT required_authorities FROM work_items WHERE id=?")
				.get(WORK_ITEM_ID),
		).toMatchObject({
			required_authorities: JSON.stringify(["deploy:production"]),
		});
		expect(
			f.sqlite
				.prepare(
					"SELECT count(*) AS n FROM work_approval_proposals WHERE action='admission'",
				)
				.get(),
		).toMatchObject({ n: 0 });
	});

	it("records rejection while leaving Work proposed", async () => {
		const f = routineAcceptanceFixture();
		const proposal = await f.client.propose(f.request);
		expect((await f.decide(proposal.id, "rejected")).proposal.status).toBe(
			"rejected",
		);
		expect(f.item()).toMatchObject({
			disposition: "proposed",
			version: 1,
			acceptance_contract: null,
		});
		expect(
			f.sqlite.prepare("SELECT count(*) AS n FROM work_events").get(),
		).toMatchObject({ n: 0 });
	});

	it("refuses changed Work revisions without persisting an approval", async () => {
		const f = routineAcceptanceFixture();
		const proposal = await f.client.propose(f.request);
		f.sqlite
			.prepare("UPDATE work_items SET title=?,version=version+1 WHERE id=?")
			.run("Changed scope", WORK_ITEM_ID);
		await expect(f.decide(proposal.id)).rejects.toThrow(/resolution race/);
		expect(f.item().disposition).toBe("proposed");
		expect(
			f.sqlite
				.prepare("SELECT count(*) AS n FROM work_approval_decisions")
				.get(),
		).toMatchObject({ n: 0 });
	});

	it("closes the Work revision race between validation and the D1 batch", async () => {
		const f = routineAcceptanceFixture();
		const proposal = await f.client.propose(f.request);
		let changed = false;
		f.context.db = createDbClient(
			createD1Facade(f.sqlite, {
				onPrepare(query) {
					if (
						!changed &&
						query.startsWith('insert into "work_approval_decisions"')
					) {
						changed = true;
						f.sqlite
							.prepare("UPDATE work_items SET version=version+1 WHERE id=?")
							.run(WORK_ITEM_ID);
					}
				},
			}),
		);
		await expect(f.decide(proposal.id)).rejects.toThrow(/resolution race/);
		expect(changed).toBe(true);
		expect(f.item().disposition).toBe("proposed");
		expect(
			f.sqlite
				.prepare("SELECT count(*) AS n FROM work_approval_decisions")
				.get(),
		).toMatchObject({ n: 0 });
	});

	it("rolls back decision and acceptance if provenance cannot be saved", async () => {
		const f = routineAcceptanceFixture();
		const proposal = await f.client.propose(f.request);
		f.sqlite.exec(
			"CREATE TRIGGER fail_acceptance_event BEFORE INSERT ON work_events BEGIN SELECT RAISE(ABORT,'provenance unavailable'); END",
		);
		await expect(f.decide(proposal.id)).rejects.toThrow(/resolution race/);
		expect(f.item()).toMatchObject({
			disposition: "proposed",
			version: 1,
			acceptance_contract: null,
		});
		expect(
			f.sqlite.prepare("SELECT status FROM work_approval_proposals").get(),
		).toMatchObject({ status: "pending" });
		expect(
			f.sqlite
				.prepare("SELECT count(*) AS n FROM work_approval_decisions")
				.get(),
		).toMatchObject({ n: 0 });
	});

	it.each(["high", "critical"])("refuses %s-risk Work", async (risk) => {
		const f = routineAcceptanceFixture();
		f.sqlite
			.prepare("UPDATE work_items SET risk_level=? WHERE id=?")
			.run(risk, WORK_ITEM_ID);
		await expect(f.client.propose(f.request)).rejects.toThrow(
			/Routine acceptance/,
		);
	});

	it("refuses Work owned by the approver", async () => {
		const f = routineAcceptanceFixture();
		f.sqlite
			.prepare(
				"UPDATE work_items SET accountable_owner_type='tedi',accountable_owner_id=? WHERE id=?",
			)
			.run("tedi-approver-id", WORK_ITEM_ID);
		await expect(f.client.propose(f.request)).rejects.toThrow(/own Work Item/);
	});
	it("refuses a tedi proposing acceptance to itself", async () => {
		const f = routineAcceptanceFixture();
		const { proposeWorkApproval } =
			await import("@tedix/db/queries/work-items/approvals");
		await expect(
			proposeWorkApproval(f.context.db, {
				...f.request,
				id: crypto.randomUUID(),
				orgId: ORG_ID,
				requesterType: "tedi",
				requesterId: "tedi-approver-id",
				rationale: "Self request",
				now: new Date().toISOString(),
			}),
		).rejects.toThrow(/own proposal/);
		expect(f.item().disposition).toBe("proposed");
	});

	it("rejects an empty done-when and missing or mismatched acceptance authority", async () => {
		const f = routineAcceptanceFixture();
		await expect(
			f.client.propose({
				...f.request,
				acceptanceContract: { version: 1, doneLooksLike: "  " },
			}),
		).rejects.toThrow();
		await expect(
			f.client.propose({ ...f.request, acceptanceContract: undefined }),
		).rejects.toThrow(/Routine acceptance/);
		await expect(
			f.client.propose({ ...f.request, authorityKey: "deploy:production" }),
		).rejects.toThrow(/Routine acceptance/);
		await expect(
			f.client.propose({ ...f.request, action: "admission" }),
		).rejects.toThrow(/Acceptance contracts/);
	});

	it("rejects expired and wrong-actor decisions", async () => {
		const f = routineAcceptanceFixture();
		const proposal = await f.client.propose(f.request);
		await expect(
			f
				.clientFor({
					userId: "canonical-approver-id",
					sub: "approver-provider-subject-id",
					role: "admin",
				})
				.decide({
					proposalId: proposal.id,
					expectedProposalVersion: 1,
					decision: "approved",
					rationale: "Cannot impersonate tedi",
				}),
		).rejects.toThrow(/designated approver/);
		const otherOrg = createRouterClient(workApprovalsContractRouter, {
			context: {
				...f.context,
				organizationId: "00000000-0000-4000-8000-000000000099",
			},
		});
		await expect(
			otherOrg.decide({
				proposalId: proposal.id,
				expectedProposalVersion: 1,
				decision: "approved",
				rationale: "Wrong tenant",
			}),
		).rejects.toThrow();
		const { decideWorkApproval } =
			await import("@tedix/db/queries/work-items/approvals");
		await expect(
			decideWorkApproval(f.context.db, {
				id: crypto.randomUUID(),
				orgId: ORG_ID,
				proposalId: proposal.id,
				expectedVersion: 1,
				decision: "approved",
				deciderType: "tedi",
				deciderId: "tedi-approver-id",
				rationale: "Too late",
				now: "2100-01-01T00:00:00.000Z",
			}),
		).rejects.toThrow(/no longer resolvable/);
		expect(f.item().disposition).toBe("proposed");
	});
});
