import { tediApprovalsContractRouter } from "./tedi-approvals";
import { createApprovalRequest } from "@tedix/db/queries/approvals";
import { createWorkItem } from "@tedix/db/queries/work-items/crud";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import {
	createWorkInteraction,
	getWorkInteraction,
} from "@tedix/db/queries/work-items/interactions";
import { claimDelegatedApproval } from "@tedix/db/queries/work-items/delegated-approvals";
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
		creator: { type: "user", id: "owner" },
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
			tediId: tedi,
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
	return { sqlite, db, request, owner, delegate, runtime, toolApproval };
}

describe("standing approval delegation", () => {
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
		});
		expect(review).toMatchObject({
			state: "open",
			requestedFromType: "user",
			requestedFromId: "owner",
		});
		expect(review.metadata.decisionDeck).toBeUndefined();
		expect(
			sqlite
				.prepare(
					"SELECT count(*) AS n FROM work_item_comments WHERE work_item_id=?",
				)
				.get(work)?.n,
		).toBe(1);
		await expect(
			delegate.reopenDelegatedApproval({ requestId: request.id }),
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
		).rejects.toMatchObject({ code: "FORBIDDEN" });
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
		const { owner, runtime, toolApproval } = await fixture();
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
				})
			).state,
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
			requestedFromType: "external_agent",
			requestedFromId: agent,
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
