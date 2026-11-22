import { tediApprovalsContractRouter } from "./tedi-approvals";
import {
	consumeHomeToolApprovalCall,
	createApprovalRequest,
} from "@tedix/db/queries/approvals";
import { createWorkItem } from "@tedix/db/queries/work-items/crud";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import {
	createWorkInteraction,
	getWorkInteraction,
} from "@tedix/db/queries/work-items/interactions";
import {
	claimDelegatedApproval,
	preferredVerificationDelegate,
	independentApprovalActor,
} from "@tedix/db/queries/work-items/delegated-approvals";
import {
	delegatedCardAllowed,
	delegatedClassAllowed,
} from "@tedix/api-contract/utils/delegated-approvals";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { workInteractionsContractRouter } from "./work-interactions";

const org = "00000000-0000-4000-8000-000000000001";
const work = "00000000-0000-4000-8000-000000000002";
const tedi = "00000000-0000-4000-8000-000000000003";
const agent = "00000000-0000-4000-8000-000000000004";
const requesterTedi = "00000000-0000-4000-8000-000000000005";
const now = () => new Date().toISOString();

function card() {
	return DecisionEnvelopeSchema.parse({
		version: 1,
		kind: "approval",
		classId: "work.review",
		proposal: "Record the reviewed boundary",
		whyNow: "The review is ready",
		recommendation: "Record it",
		reversibility: "two_way",
		protectedEffects: [],
		blastRadius: "One organization",
		confidence: 0.9,
		costOfWaiting: "The review stays open",
		reasoning: "The reviewed source supports this choice",
		options: [
			{
				id: "approve",
				label: "Record review",
				intent: "approve",
				consequence: "Records the review",
				cost: "None",
				effect: {
					kind: "record_adr",
					workItemId: work,
					commitSha: "a".repeat(40),
				},
			},
			{
				id: "reject",
				label: "Leave it",
				intent: "reject",
				consequence: "Records no review",
				cost: "Review remains open",
			},
		],
	});
}

async function fixture(enabled = true) {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	sqlite
		.prepare(
			"INSERT INTO organizations (id,name,slug,metadata) VALUES (?,?,?,?)",
		)
		.run(
			org,
			"Acme",
			"acme",
			JSON.stringify({
				delegatedApprovals: { enabled, leadAgents: { owner: agent } },
			}),
		);
	sqlite
		.prepare(
			"INSERT INTO organization_members (id,organization_id,user_id,descope_user_id,email,role,status) VALUES (?,?,?,?,?,'owner','active')",
		)
		.run("member", org, "owner", "owner-sub", "owner@acme.test");
	sqlite
		.prepare(
			"INSERT INTO tedis (id,organization_id,name,slug,owner_user_id,status) VALUES (?,?,?,?,?,'active')",
		)
		.run(tedi, org, "Acme lead", "lead", "owner");
	sqlite
		.prepare(
			"INSERT INTO external_agent_principals (id,organization_id,key,display_name,credential_binding_type,credential_binding_id,created_by_type,created_by_id) VALUES (?,?,?,'Lead agent','owner_user','owner','user','owner')",
		)
		.run(agent, org, "lead-agent");
	sqlite
		.prepare(
			"INSERT INTO organization_members (id,organization_id,user_id,descope_user_id,email,role,status) VALUES (?,?,?,?,?,'member','active')",
		)
		.run(
			"requester-member",
			org,
			"requester",
			"requester-sub",
			"requester@acme.test",
		);
	sqlite
		.prepare(
			"INSERT INTO tedis (id,organization_id,name,slug,owner_user_id,status) VALUES (?,?,?,?,?,'active')",
		)
		.run(requesterTedi, org, "Requester", "requester", "owner");
	const facade = createD1Facade(sqlite);
	const db = createDbClient(facade);
	await createWorkItem(db, {
		id: work,
		orgId: org,
		title: "Review boundary",
		accountableOwnerType: "user",
		accountableOwnerId: "owner",
		createdAt: now(),
	});
	const base = {
		db,
		env: { DB: facade, ENVIRONMENT: "test" },
		organizationId: org,
		headers: new Headers(),
		url: new URL("https://api.acme.test/rpc"),
	} as BaseContext;
	const owner = createRouterClient(workInteractionsContractRouter, {
		context: {
			...base,
			authType: "user",
			userId: "owner",
			userRole: "owner",
			user: { sub: "owner-sub" } as BaseContext["user"],
		},
	});
	const delegateContext = {
		...base,
		authType: "service-binding",
		serviceBindingPrincipal: "mcp-edge",
		headers: new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Tedi-Id": tedi,
			"X-Tedix-Tedi-Scopes":
				"mcp:messaging.read mcp:messaging.write mcp:work.write mcp:memory.admin",
		}),
		tediId: tedi,
		tediScopes: [
			"mcp:messaging.read",
			"mcp:messaging.write",
			"mcp:work.write",
			"mcp:memory.admin",
		],
	} as BaseContext;
	const delegate = createRouterClient(workInteractionsContractRouter, {
		context: delegateContext,
	});
	const runtime = createRouterClient(tediApprovalsContractRouter, {
		context: delegateContext,
	});
	const request = await createWorkInteraction(db, {
		id: crypto.randomUUID(),
		orgId: org,
		workItemId: work,
		kind: "question",
		subject: "Review boundary",
		prompt: "Record the reviewed boundary",
		creator: { type: "user", id: "requester" },
		targetType: "user",
		targetId: "owner",
		metadata: { decisionDeck: card() },
		now: now(),
	});
	const toolApproval = async (
		declaredClass: Record<string, string>,
		args = {},
	) => {
		const id = crypto.randomUUID();
		await createApprovalRequest(db, {
			id,
			orgId: org,
			tediId: requesterTedi,
			actionType: "home.tool_write",
			description: "Update the internal record",
			payload: {
				kind: "home_tool_write",
				appSlug: "acme",
				toolName: "edit_record",
				args,
				organizationId: org,
				homeRunId: crypto.randomUUID(),
				conversationId: crypto.randomUUID(),
				initiatedByUserId: "owner-sub",
				declaredClass,
			},
			createdAt: now(),
			expiresAt: "2099-01-01T00:00:00.000Z",
		});
		return id;
	};
	return { sqlite, db, request, owner, delegate, runtime, toolApproval, base };
}

describe("standing approval delegation", () => {
	it.each([false, undefined])(
		"preserves legacy runtime machine deciders when delegation is %s",
		async (enabled) => {
			const { base, sqlite, db } = await fixture(false);
			if (enabled === undefined)
				sqlite
					.prepare("UPDATE organizations SET metadata='{}' WHERE id=?")
					.run(org);
			const identities: Partial<BaseContext>[] = [
				{
					authType: "user",
					userId: "owner",
					userRole: "owner",
					user: { sub: "owner-sub" } as BaseContext["user"],
					externalAgentPrincipalId: agent,
				},
				{
					authType: "user",
					userId: "owner",
					userRole: "owner",
					user: { sub: "owner-sub" } as BaseContext["user"],
					ownerHostSessionId: "host-session",
				},
				{
					authType: "service-binding",
					headers: new Headers({ "X-Service-Binding": "true" }),
					tediId: tedi,
					tediScopes: ["mcp:memory.admin"],
				},
			];
			for (const identity of identities) {
				const client = createRouterClient(tediApprovalsContractRouter, {
					context: { ...base, ...identity } as BaseContext,
				});
				const id = crypto.randomUUID();
				await createApprovalRequest(db, {
					id,
					orgId: org,
					tediId: requesterTedi,
					actionType: "tool_execution",
					description: "Legacy approval",
					payload: {},
					createdAt: now(),
					expiresAt: "2099-01-01T00:00:00.000Z",
				});
				const result = await client.resolve({ id, status: "approved" });
				expect(result).toMatchObject({
					status: "approved",
					resolvedBy:
						identity.authType === "user" ? "owner-sub" : "service-binding",
				});
				expect(result.payload.delegatedApproval).toBeUndefined();
				const self = crypto.randomUUID();
				await createApprovalRequest(db, {
					id: self,
					orgId: org,
					tediId: tedi,
					actionType: "tool_execution",
					description: "Own approval",
					payload: {},
					createdAt: now(),
					expiresAt: "2099-01-01T00:00:00.000Z",
				});
				if (identity.tediId)
					await expect(
						client.resolve({ id: self, status: "approved" }),
					).rejects.toThrow("A tedi cannot decide its own approval request");
			}
			sqlite.close();
		},
	);

	it.each(["tedi", "external_agent"] as const)(
		"the database refuses retargeting a card to its %s creator",
		async (type) => {
			const { sqlite } = await fixture();
			const id = type === "tedi" ? tedi : agent;
			if (type === "external_agent")
				sqlite
					.prepare(
						"INSERT INTO external_agent_sessions (id,organization_id,principal_id,external_session_key,harness,harness_version,model_provider,model_id,model_version,identity_source,started_at,last_seen_at) VALUES ('session',?,?,'external-key','test','1','test','test','1','explicit',?,?)",
					)
					.run(org, agent, now(), now());
			const request = { id: crypto.randomUUID(), version: 1 };
			sqlite
				.prepare(
					"INSERT INTO work_interactions (id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,creator_session_id,creator_external_session_key,target_type,target_id,created_at,metadata) VALUES (?,?,?,'question','Self review','Review',?,?,'session','external-key','user','owner',?,?)",
				)
				.run(
					request.id,
					org,
					work,
					type,
					id,
					now(),
					JSON.stringify({ decisionDeck: card() }),
				);
			const receipt = {
				ownerId: "owner",
				actorType: type,
				actorId: id,
				actorName: "Lead",
				reason: "Review",
			};
			expect(() =>
				sqlite
					.prepare(
						"UPDATE work_interactions SET target_type=?,target_id=?,version=version+1,metadata=json_set(metadata,'$.delegatedApproval',json(?)) WHERE id=?",
					)
					.run(type, id, JSON.stringify(receipt), request.id),
			).toThrow("The card creator cannot be its delegate");
			expect(
				sqlite
					.prepare(
						"SELECT target_type,target_id,version FROM work_interactions WHERE id=?",
					)
					.get(request.id),
			).toMatchObject({
				target_type: "user",
				target_id: "owner",
				version: request.version,
			});
			sqlite.close();
		},
	);

	it.each(["delegate", "delegateToSteward"] as const)(
		"allows a question hand-back via %s without delegated approval when disabled",
		async (via) => {
			const { sqlite, db, owner } = await fixture(false);
			try {
				sqlite
					.prepare(
						"UPDATE organizations SET metadata=json_set(metadata,'$.workStewardship',json(?)) WHERE id=?",
					)
					.run(JSON.stringify({ enabled: true, defaultTediId: tedi }), org);
				const request = await createWorkInteraction(db, {
					id: crypto.randomUUID(),
					orgId: org,
					workItemId: work,
					kind: "question",
					subject: "Choose the next step",
					prompt: "How should we continue?",
					creator: { type: "tedi", id: tedi },
					targetType: "user",
					targetId: "owner",
					now: now(),
				});
				const input = {
					requestId: request.id,
					expectedRequestVersion: request.version,
				};
				if (via === "delegate")
					await owner.delegate({ ...input, tediId: tedi });
				else
					await owner.delegateToSteward({
						...input,
						reason: "Choose the next step",
					});
				const stored = await getWorkInteraction(db, {
					orgId: org,
					interactionId: request.id,
				});
				expect(stored).toMatchObject({
					targetType: "tedi",
					targetId: tedi,
					status: "open",
					version: request.version + 1,
				});
				expect(stored?.metadata.delegatedApproval).toBeUndefined();
			} finally {
				sqlite.close();
			}
		},
	);

	it("does not treat a browser agent on a human credential as the human approver", async () => {
		const { base, toolApproval } = await fixture();
		const id = await toolApproval({
			writeCapability: "write",
			riskTier: "bounded_write",
			blastRadius: "tenant",
		});
		const browser = createRouterClient(tediApprovalsContractRouter, {
			context: {
				...base,
				authType: "user",
				userId: "owner",
				userRole: "owner",
				user: { sub: "owner-sub" } as BaseContext["user"],
				browserAgentSeat: {
					userId: "owner",
					memberId: "seat",
					displayName: "Agent",
					representedUserId: "owner",
					representedUserName: "Owner",
				},
			},
		});
		await expect(
			browser.resolve({
				id,
				status: "approved",
				resolution: "An internal edit",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("uses the live human owner membership and batches policy changes with their audit", async () => {
		const { base, sqlite } = await fixture(false);
		const { organizationsContractRouter } = await import("./organizations");
		const client = createRouterClient(organizationsContractRouter, {
			context: {
				...base,
				authType: "user",
				userId: "owner",
				userRole: "owner",
				user: { sub: "owner-sub" } as BaseContext["user"],
			},
		});
		const metadata = {
			delegatedApprovals: { enabled: true, leadAgents: { owner: agent } },
		};
		sqlite
			.prepare(
				"UPDATE organization_members SET role='admin' WHERE user_id='owner'",
			)
			.run();
		await expect(
			client.update({ organizationId: org, metadata }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		sqlite
			.prepare(
				"UPDATE organization_members SET role='owner' WHERE user_id='owner'",
			)
			.run();
		sqlite.exec(
			"CREATE TRIGGER deny_policy_audit BEFORE INSERT ON audit_events WHEN NEW.action='organization.delegated_approvals_changed' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
		);
		await expect(
			client.update({ organizationId: org, metadata }),
		).rejects.toThrow();
		expect(
			JSON.parse(
				String(
					sqlite
						.prepare("SELECT metadata FROM organizations WHERE id=?")
						.get(org)?.metadata,
				),
			).delegatedApprovals.enabled,
		).toBe(false);
		sqlite.exec("DROP TRIGGER deny_policy_audit");
		await client.update({ organizationId: org, metadata });
		expect(
			sqlite
				.prepare(
					"SELECT actor_type FROM audit_events WHERE action='organization.delegated_approvals_changed' AND resource_id=?",
				)
				.all(org),
		).toEqual([{ actor_type: "user" }]);
	});

	it("rejects the requester in every session and the requesting user's credential", async () => {
		const { db, request } = await fixture();
		const claim = (
			requesterType: "tedi" | "external_agent" | "user",
			requesterId: string,
			actor: {
				type: "tedi" | "external_agent";
				id: string;
				sessionId?: string;
			},
		) =>
			claimDelegatedApproval(db, {
				request: {
					...request,
					creatorType: requesterType,
					creatorId: requesterId,
				},
				actor,
				expectedVersion: request.version,
				now: now(),
				cardAction: "approve",
			});
		expect(await claim("tedi", tedi, { type: "tedi", id: tedi })).toBeNull();
		for (const sessionId of ["first-session", "second-session"]) {
			expect(
				await claim("external_agent", agent, {
					type: "external_agent",
					id: agent,
					sessionId,
				}),
			).toBeNull();
			expect(
				await claim("user", "owner", {
					type: "external_agent",
					id: agent,
					sessionId,
				}),
			).toBeNull();
		}
		expect(
			await independentApprovalActor(
				db,
				org,
				{ type: "external_agent", id: agent },
				{ type: "user", id: "owner" },
			),
		).toBe(false);
		expect(
			await independentApprovalActor(
				db,
				org,
				{ type: "user", id: "owner-sub" },
				{ type: "external_agent", id: agent },
			),
		).toBe(false);
	});

	it("refuses the runtime requester even when it is the owner's own tedi", async () => {
		const { sqlite, runtime, toolApproval } = await fixture();
		const id = await toolApproval({
			writeCapability: "write",
			riskTier: "bounded_write",
			blastRadius: "tenant",
		});
		sqlite
			.prepare("UPDATE tedi_approval_requests SET tedi_id=? WHERE id=?")
			.run(tedi, id);
		await expect(
			runtime.resolve({
				id,
				status: "approved",
				resolution: "An internal edit",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			sqlite
				.prepare("SELECT status FROM tedi_approval_requests WHERE id=?")
				.get(id)?.status,
		).toBe("pending");
	});

	it("executes as the own tedi, lists who/what/why for the owner and reopens without replay", async () => {
		const { sqlite, request, owner, delegate } = await fixture();
		await delegate.respond({
			requestId: request.id,
			expectedRequestVersion: request.version,
			responseKind: "answer",
			body: "Record the review because the source supports the boundary.",
			resolvesRequest: true,
			metadata: { cardAction: "approve", decisionChoice: "approve" },
		});
		expect(
			sqlite
				.prepare(
					"SELECT actor_id,actor_type FROM audit_events WHERE action='work_interaction.delegated_decision' AND resource_id=?",
				)
				.all(request.id),
		).toEqual([{ actor_id: tedi, actor_type: "tedi" }]);
		const list = await owner.listDecidedForYou({ limit: 25 });
		expect(list.data).toHaveLength(1);
		expect(list.data[0]).toMatchObject({
			requestId: request.id,
			subject: "Review boundary",
			decision: "approve",
			receipt: {
				actorType: "tedi",
				actorId: tedi,
				actorName: "Acme lead",
				ownerId: "owner",
				reason: "Record the review because the source supports the boundary.",
			},
		});
		const review = await owner.reopenDelegatedApproval({
			requestId: request.id,
			undo: true,
		});
		expect(review).toMatchObject({
			state: "open",
			requestedFromType: "user",
			requestedFromId: "owner",
		});
		expect(review.metadata.decisionDeck).toBeUndefined();
		expect(review.prompt).toContain(
			"Reopening does not undo or repeat the earlier action, or change the resolved card.",
		);
		expect(
			(await owner.listDecidedForYou({ limit: 25 })).data[0]?.undoneAt,
		).toEqual(expect.any(String));
		expect(
			sqlite
				.prepare(
					"SELECT actor_id FROM audit_events WHERE action='delegated_approval.undone' AND resource_id=?",
				)
				.all(request.id),
		).toEqual([{ actor_id: "owner" }]);
		expect(
			(
				await owner.reopenDelegatedApproval({
					requestId: request.id,
					undo: true,
				})
			).id,
		).toBe(review.id);

		expect(
			sqlite
				.prepare(
					"SELECT count(*) AS n FROM work_item_comments WHERE work_item_id=?",
				)
				.get(work)?.n,
		).toBe(1);
		await expect(
			delegate.reopenDelegatedApproval({ requestId: request.id, undo: true }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("allows only the designated lead and rejects stale claims, another owner and another organization", async () => {
		const { sqlite, db, request } = await fixture();
		const actor = { type: "external_agent" as const, id: agent };
		const claim = (overrides = {}) =>
			claimDelegatedApproval(db, {
				request,
				actor,
				expectedVersion: request.version,
				now: now(),
				cardAction: "approve",
				...overrides,
			});
		expect(await claim({ expectedVersion: 999 })).toBeNull();
		sqlite
			.prepare(
				"UPDATE organization_members SET status='suspended' WHERE user_id='owner'",
			)
			.run();
		expect(await claim()).toBeNull();
		sqlite
			.prepare(
				"UPDATE organization_members SET status='active' WHERE user_id='owner'",
			)
			.run();
		sqlite
			.prepare("UPDATE tedis SET owner_user_id='another-owner' WHERE id=?")
			.run(tedi);
		expect(await claim({ actor: { type: "tedi", id: tedi } })).toBeNull();
		sqlite
			.prepare("UPDATE tedis SET owner_user_id='owner' WHERE id=?")
			.run(tedi);
		expect(await claim({ actor: { type: "tedi", id: agent } })).toBeNull();
		sqlite
			.prepare(
				"UPDATE external_agent_principals SET organization_id='elsewhere' WHERE id=?",
			)
			.run(agent);
		expect(await claim()).toBeNull();
		sqlite
			.prepare(
				"UPDATE external_agent_principals SET organization_id=? WHERE id=?",
			)
			.run(org, agent);
		expect((await claim())?.request).toMatchObject({
			targetType: "external_agent",
			targetId: agent,
			version: request.version + 1,
		});
	});

	it("leaves the default-off organization and disabled policy owner-only", async () => {
		const { sqlite, db, request, delegate } = await fixture(false);
		await expect(
			delegate.respond({
				requestId: request.id,
				expectedRequestVersion: request.version,
				responseKind: "answer",
				body: "Approve",
				resolvesRequest: true,
				metadata: { cardAction: "approve", decisionChoice: "approve" },
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Only the addressed person can execute a decision card",
		});
		sqlite
			.prepare("UPDATE organizations SET metadata='{}' WHERE id=?")
			.run(org);
		expect(
			await claimDelegatedApproval(db, {
				request,
				actor: { type: "tedi", id: tedi },
				expectedVersion: request.version,
				now: now(),
				cardAction: "approve",
			}),
		).toBeNull();
		expect(
			(await getWorkInteraction(db, { orgId: org, interactionId: request.id }))
				?.targetType,
		).toBe("user");
	});

	it("settles a declared internal runtime card as the own tedi and includes it in the same owner list", async () => {
		const { owner, runtime, toolApproval, sqlite, db, delegate } =
			await fixture();
		const id = await toolApproval({
			writeCapability: "write",
			riskTier: "bounded_write",
			blastRadius: "tenant",
		});
		await runtime.resolve({
			id,
			status: "approved",
			resolution: "The edit stays inside the organization and can be revised.",
		});
		const list = await owner.listDecidedForYou({ limit: 25 });
		expect(list.data).toEqual([
			expect.objectContaining({
				source: "runtime",
				requestId: id,
				decision: "approved",
				receipt: expect.objectContaining({ actorId: tedi, ownerId: "owner" }),
			}),
		]);
		expect(
			(
				await owner.reopenDelegatedApproval({
					requestId: id,
					source: "runtime",
					undo: true,
				})
			).state,
		).toBe("open");
		expect(
			sqlite
				.prepare("SELECT status FROM tedi_approval_requests WHERE id=?")
				.get(id)?.status,
		).toBe("cancelled");
		expect(
			await consumeHomeToolApprovalCall(db, {
				id,
				organizationId: org,
				slot: `tenant_${"a".repeat(64)}`,
				now: now(),
			}),
		).toBe(false);
		expect(
			(await owner.listDecidedForYou({ limit: 25 })).data[0]?.undoneAt,
		).toEqual(expect.any(String));
		expect(
			sqlite
				.prepare(
					"SELECT actor_id FROM audit_events WHERE action='approval_request.delegated_decision' AND resource_id=?",
				)
				.all(id),
		).toEqual([{ actor_id: tedi }]);
		await expect(
			delegate.reopenDelegatedApproval({
				requestId: id,
				source: "runtime",
				undo: true,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("rolls back a delegated decision if its audit cannot be written", async () => {
		const { sqlite, runtime, toolApproval } = await fixture();
		const id = await toolApproval({
			writeCapability: "write",
			riskTier: "bounded_write",
			blastRadius: "tenant",
		});
		sqlite.exec(
			"CREATE TRIGGER deny_delegated_audit BEFORE INSERT ON audit_events WHEN NEW.action='approval_request.delegated_decision' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
		);
		await expect(
			runtime.resolve({ id, status: "approved", resolution: "Internal edit" }),
		).rejects.toThrow();
		expect(
			sqlite
				.prepare("SELECT status FROM tedi_approval_requests WHERE id=?")
				.get(id)?.status,
		).toBe("pending");
	});

	it("writes the card decision audit before executing its effect", async () => {
		const { sqlite, delegate, request } = await fixture();
		sqlite.exec(
			"CREATE TRIGGER deny_delegated_audit BEFORE INSERT ON audit_events WHEN NEW.action='work_interaction.delegated_decision_started' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
		);
		await expect(
			delegate.respond({
				requestId: request.id,
				expectedRequestVersion: request.version,
				responseKind: "answer",
				body: "Record review",
				resolvesRequest: true,
				metadata: { cardAction: "approve", decisionChoice: "approve" },
			}),
		).rejects.toThrow();
		expect(
			sqlite
				.prepare(
					"SELECT count(*) AS n FROM work_item_comments WHERE work_item_id=?",
				)
				.get(work)?.n,
		).toBe(0);
		expect(
			sqlite
				.prepare("SELECT status FROM work_interactions WHERE id=?")
				.get(request.id)?.status,
		).toBe("open");
	});

	it.each([
		["irreversible", "write", "high_impact_write", "tenant"],
		["money", "write", "external_side_effect", "external_system"],
		["outside message", "write", "external_side_effect", "external_system"],
		["publication", "write", "external_side_effect", "external_system"],
		["another organization", "write", "bounded_write", "multi_tenant"],
		["sign in", "write", "high_impact_write", "single_resource"],
		["consent", "write", "high_impact_write", "tenant"],
		["delete", "destructive", "high_impact_write", "single_resource"],
	] as const)(
		"refuses runtime %s before recording a delegated decision",
		async (_label, writeCapability, riskTier, blastRadius) => {
			const { owner, runtime, toolApproval } = await fixture();
			const id = await toolApproval({ writeCapability, riskTier, blastRadius });
			await expect(
				runtime.resolve({
					id,
					status: "approved",
					resolution: "Harmless update",
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect((await owner.listDecidedForYou({ limit: 25 })).data).toHaveLength(
				0,
			);
		},
	);

	it("rejects another organization hidden in nested arguments despite a tenant-bounded tool declaration", async () => {
		const { runtime, toolApproval } = await fixture();
		const id = await toolApproval(
			{
				writeCapability: "write",
				riskTier: "bounded_write",
				blastRadius: "tenant",
			},
			{
				first: {
					second: {
						third: { fourth: { organizationId: "other-organization" } },
					},
				},
			},
		);
		await expect(
			runtime.resolve({
				id,
				status: "approved",
				resolution: "Only an internal update",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("routes a runner hold to the designated lead first without authorizing irreversible alternatives", async () => {
		const { owner } = await fixture();
		const request = await owner.create({
			workItemId: work,
			kind: "input",
			subject: "What should happen with this task?",
			prompt: "The runner stopped working.",
			reason: "The runner needs a decision on this task.",
			requestedFrom: { type: "user", id: "owner" },
			metadata: {
				source: "lane-dispatch-blocker",
				laneBlocker: {
					kind: "execution_hold",
					executor: "codex",
					workVersion: 1,
				},
			},
		});
		expect(request).toMatchObject({
			requestedFromType: "tedi",
			requestedFromId: tedi,
		});
		expect(
			delegatedCardAllowed(
				{
					subject: request.subject,
					prompt: request.prompt,
					workItemId: work,
					metadata: request.metadata,
				},
				"cancel",
			),
		).toBe(false);
	});

	it("uses the effect class, never an author's reversible claim or harmless title", () => {
		const request = {
			subject: "An ordinary update",
			prompt: "Harmless",
			workItemId: work,
			metadata: { decisionDeck: card() },
		};
		expect(delegatedCardAllowed(request, "approve")).toBe(true);
		for (const text of [
			"Send money and publish everything",
			"",
			"x".repeat(5000),
		]) {
			expect(
				delegatedCardAllowed(
					{
						...request,
						subject: text,
						prompt: text,
						metadata: {
							decisionDeck: {
								...card(),
								proposal: text,
								reasoning: text,
								reversibility: "one_way",
							},
						},
					},
					"approve",
				),
			).toBe(true);
		}

		expect(
			delegatedClassAllowed({
				actionClass: "always",
				declaredClass: {
					writeCapability: "write",
					riskTier: "bounded_write",
					blastRadius: "tenant",
				},
			}),
		).toBe(false);
		request.metadata.decisionDeck.options[0]!.effect = {
			kind: "complete_work",
			workItemId: work,
		};
		expect(delegatedCardAllowed(request, "approve")).toBe(false);
	});
});

it.each(["lead", "own-tedi", "owner"] as const)(
	"routes one landed verification check to %s",
	async (recipient) => {
		const { sqlite, db, owner, base } = await fixture(false);
		const wakes: { text: string; session_key: string }[] = [];
		Object.assign(base.env, {
			TEDI_SERVICE: {
				fetch: async (request: Request) => {
					wakes.push(await request.json());
					return Response.json({ accepted: true, run_id: "verification-wake" });
				},
			},
		});
		sqlite
			.prepare("UPDATE tedis SET owner_user_id='requester' WHERE id=?")
			.run(requesterTedi);
		try {
			if (recipient !== "lead")
				sqlite
					.prepare(
						"UPDATE external_agent_principals SET status='revoked' WHERE id=?",
					)
					.run(agent);
			if (recipient === "owner")
				sqlite
					.prepare("UPDATE tedis SET status='inactive' WHERE id=?")
					.run(tedi);
			const expected =
				recipient === "lead"
					? { type: "external_agent", id: agent }
					: recipient === "own-tedi"
						? { type: "tedi", id: tedi }
						: null;
			expect(await preferredVerificationDelegate(db, org, "owner")).toEqual(
				expected,
			);
			sqlite
				.prepare(
					"UPDATE work_items SET disposition='accepted', executor_id='codex', version=2 WHERE id=?",
				)
				.run(work);
			sqlite
				.prepare(
					"INSERT INTO work_item_comments (id,org_id,work_item_id,author_type,author_id,body,created_at) VALUES ('delegation',?,?,'user','owner',?,?)",
				)
				.run(
					org,
					work,
					"Delegation: codex work-version=3 Check the result.",
					now(),
				);
			const at = now();
			const expiresAt = new Date(Date.now() + 300_000).toISOString();
			sqlite
				.prepare(`INSERT INTO work_admissions
				(id,org_id,work_item_id,work_item_version,admission_spec_revision,executor_type,executor_id,decision,decided_at,expires_at,created_at)
				SELECT 'admission',org_id,id,version,admission_spec_revision,'tedi',?,'admitted',?,?,? FROM work_items WHERE id=?`)
				.run(requesterTedi, at, expiresAt, at, work);
			sqlite
				.prepare(`INSERT INTO work_attempts
				(id,admission_id,org_id,work_item_id,executor_type,executor_id,expires_at,
				runtime_state,outcome,attempt_number,started_at,heartbeat_at,finished_at,metadata)
				VALUES ('verification','admission',?,?,'tedi',?, ?,
				'finished','landed_unverified',1,?,?,?,?)`)
				.run(
					org,
					work,
					requesterTedi,
					expiresAt,
					at,
					at,
					at,
					JSON.stringify({
						lane: true,
						dispatchVersion: 2,
						verificationRound: 1,
						laneResult: {
							outcome: "landed_unverified",
							workItemId: work,
							workVersion: 2,
							outcomeText: "Review boundary",
						},
					}),
				);
			sqlite
				.prepare(
					"UPDATE work_items SET dispatch_state='held', version=3 WHERE id=?",
				)
				.run(work);
			const input = {
				workItemId: work,
				kind: "input" as const,
				subject: "Check the landed result: Review boundary",
				prompt:
					"Landed, not verified. Check the signed-in row at https://live.acme.test/result. This grants no consent or access.",
				reason: "The landed result needs an agent check.",
				notificationReason: "update" as const,
				requestedFrom: { type: "user" as const, id: "owner" },
				metadata: {
					source: "lane-dispatch-blocker",
					laneBlocker: {
						kind: "verification_check",
						executor: "codex",
						workVersion: 3,
					},
				},
			};
			const first = await owner.create(input);
			const second = await owner.create(input);
			expect(second.id).toBe(first.id);
			const stored = await getWorkInteraction(db, {
				orgId: org,
				interactionId: first.id,
			});
			expect(stored).toMatchObject({
				targetType: expected?.type ?? "user",
				targetId: expected?.id ?? "owner",
			});
			expect(stored?.metadata.decisionDeck).toBeUndefined();
			expect(stored?.metadata.delegatedApproval).toBeUndefined();
			expect(stored?.metadata.blockerRouting).toMatchObject({
				ownerType: expected?.type ?? "user",
				ownerId: expected?.id ?? "owner",
			});
			expect(wakes).toHaveLength(recipient === "own-tedi" ? 1 : 0);
			if (recipient === "own-tedi") {
				expect(wakes[0]?.session_key).toBe(`interaction:${first.id}`);
				expect(wakes[0]?.text).toContain(
					"This wake grants no access, consent, approval or execution authority.",
				);
			}
		} finally {
			sqlite.close();
		}
	},
);
