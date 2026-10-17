import * as subscriptions from "@tedix/db/queries/provider-events";
import { createRouterClient } from "@orpc/server";
import * as organizations from "@tedix/db/queries/organizations";
import * as tools from "@tedix/db/queries/tools";
import { fetchTediToken } from "../rpc/routers/connections/credentials-tedi";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as accounts from "@tedix/db/queries/connection-instances";
import * as members from "@tedix/db/queries/organization-members";
import * as resources from "@tedix/db/queries/os-workspaces/resources";
import * as workspaces from "@tedix/db/queries/os-workspaces/workspaces";
import * as tedis from "@tedix/db/queries/tedis";
import * as skills from "@tedix/db/queries/cognitive/skill-crud";
import * as runs from "@tedix/db/queries/skill-runs";
import * as artifacts from "@tedix/db/queries/skill-run-artifacts";
import * as consents from "@tedix/db/queries/personal-resource-delegations";
import * as vault from "../rpc/routers/connections/policy-resolution";
import type { BaseContext } from "../rpc/orpc";
import {
	authorizePersonalResourceDelegation,
	resolvePersonalSubscriptionCredential,
	validatePersonalRunSources,
	authorizePersonalDerivedSource,
	personalConnectionGrantFingerprint,
	preparePersonalResourceDelegation,
	personalDelegationSource,
	validatePersonalDelegationToken,
} from "./personal-resource-delegation-authority";
const id = "10000000-0000-4000-8000-000000000001";
const doc =
	"---\ncapabilities:\n  mcp:\n    google: [list_events]\n---\nCalendar skill";
const input = {
	tediId: id,
	skillId: id,
	skillRevision: 1,
	workspaceId: id,
	resourceId: id,
	connectionInstanceId: id,
	operations: ["read"],
	toolIds: ["list_events"],
	expiresAt: "2099-01-01T00:00:00Z",
};
const use = {
	delegationId: id,
	tediId: id,
	skillId: id,
	skillRevision: 1,
	workspaceId: id,
	resourceId: id,
	connectionInstanceId: id,
	providerId: "google",
	providerResourceId: "calendar-a",
	operation: "read",
	toolId: "list_events",
	requiredScopes: ["read"],
};
function context(background = false) {
	return {
		authType: background ? "service-binding" : "user",
		tediId: background ? id : undefined,
		tediScopes: background ? ["connections.read"] : undefined,
		organizationId: id,
		db: {},
		env: { ENVIRONMENT: "production" },
		headers: new Headers(
			background
				? {
						"X-Tedix-Mcp-Tool-Id": "list_events",
						"X-Tedix-Skill-Run-Id": id,
						"X-Tedix-Workflow-Execution-Epoch": "2",
					}
				: {},
		),
		user: background ? undefined : { sub: "alice" },
	} as unknown as BaseContext;
}
let account: Record<string, unknown>,
	resource: Record<string, unknown>,
	run: Record<string, unknown>,
	consent: Record<string, unknown>;
beforeEach(async () => {
	vi.restoreAllMocks();
	account = {
		id,
		ownerUserId: "alice",
		organizationId: null,
		providerId: "google",
		tokenSub: "subject",
		tokenIds: ["grant"],
	};
	resource = {
		id,
		workspaceId: id,
		organizationId: id,
		status: "active",
		connectionScope: "user",
		providerId: "google",
		providerResourceId: "calendar-a",
		resourceType: "calendar",
		personalOwnerUserId: "alice",
		connectionInstanceId: id,
		requiredScopes: '["read"]',
	};
	run = {
		id,
		organizationId: id,
		tediId: id,
		skillId: id,
		skillRevision: 1,
		status: "running",
		executionEpoch: 2,
		workflowInstanceId: "workflow",
		workflowSource: "source",
		skillDoc: doc,
	};
	consent = {
		...input,
		id,
		organizationId: id,
		ownerUserId: "alice",
		providerId: "google",
		providerResourceId: "calendar-a",
		resourceType: "calendar",
		requiredScopes: ["read"],
		accountSubject: "subject",
		grantFingerprint: await personalConnectionGrantFingerprint(["grant"]),
		createdAt: "2026-10-01",
		revokedAt: null,
	};
	run.resourceAccessEnvelope = {
		version: 1,
		sources: [personalDelegationSource(consent as never)],
	};
	vi.spyOn(accounts, "getConnectionInstance").mockImplementation(
		async () => account as never,
	);
	vi.spyOn(members, "getMemberByUserId").mockResolvedValue({
		status: "active",
	} as never);
	vi.spyOn(resources, "getOsWorkspaceResource").mockImplementation(
		async () => resource as never,
	);
	vi.spyOn(workspaces, "getOsWorkspace").mockResolvedValue({
		status: "active",
	} as never);
	vi.spyOn(tedis, "getTediByIdForOrganization").mockResolvedValue({
		id,
		retiredAt: null,
	} as never);
	vi.spyOn(skills, "getSkillEntry").mockResolvedValue({
		id,
		revision: 1,
		content: doc,
		lifecycleState: "active",
	} as never);
	vi.spyOn(runs, "getSkillRun").mockImplementation(async () => run as never);
	vi.spyOn(consents, "getPersonalResourceDelegation").mockImplementation(
		async () => consent as never,
	);
	vi.spyOn(
		consents,
		"listActiveOwnerSkillPersonalResourceDelegations",
	).mockImplementation(async () =>
		consent.revokedAt ? [] : [consent as never],
	);
	vi.spyOn(vault, "fetchNamedConnection").mockResolvedValue({
		id: "grant",
		tokenSub: "subject",
		scopes: ["read"],
		accessToken: "secret",
	} as never);
});
describe("explicit personal-resource delegation authority", () => {
	it("captures exact owner, account grants, calendar and required scopes", async () => {
		const row = await preparePersonalResourceDelegation(context(), input);
		expect(row).toMatchObject({
			ownerUserId: "alice",
			providerResourceId: "calendar-a",
			accountSubject: "subject",
			requiredScopes: ["read"],
		});
		expect(row.grantFingerprint).toHaveLength(64);
		expect(row).not.toHaveProperty("accessToken");
	});
	it("rejects disconnected accounts before a vault lookup can revive grants", async () => {
		account.tokenIds = [];
		await expect(
			preparePersonalResourceDelegation(context(), input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(vault.fetchNamedConnection).not.toHaveBeenCalled();
	});
	it("rejects undeclared tools and past consent expiry", async () => {
		await expect(
			preparePersonalResourceDelegation(context(), {
				...input,
				toolIds: ["delete_events"],
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			preparePersonalResourceDelegation(context(), {
				...input,
				expiresAt: "2000-01-01",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("checks returned account identity, token grant and OAuth scopes", () => {
		for (const token of [
			{ tokenSub: "other", scopes: ["read"] },
			{ tokenSub: "subject", scopes: [] },
		])
			expect(() =>
				validatePersonalDelegationToken(
					{ accountSubject: "subject", requiredScopes: ["read"] },
					token,
					["grant"],
					"grant",
				),
			).toThrow();
		expect(() =>
			validatePersonalDelegationToken(
				{ accountSubject: "subject", requiredScopes: [] },
				{ tokenSub: "subject" },
				["grant"],
				"new-grant",
			),
		).toThrow();
	});
	it("requires trusted run provenance and binds the epoch", async () => {
		await expect(
			authorizePersonalResourceDelegation(context(), use),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const ctx = context(true);
		ctx.headers.set("X-Tedix-Workflow-Execution-Epoch", "1");
		await expect(
			authorizePersonalResourceDelegation(ctx, use),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("returns exact canonical lookup authority for an active admitted execution", async () => {
		expect(
			await authorizePersonalResourceDelegation(context(true), use),
		).toMatchObject({
			ownerUserId: "alice",
			connectionInstanceId: id,
			approvedTokenIds: ["grant"],
			skillRunId: id,
		});
	});
	it("admits a queued projection only after this exact execution epoch started", async () => {
		run.status = "queued";
		const marker = vi
			.spyOn(artifacts, "getRunArtifact")
			.mockResolvedValue(null);
		await expect(
			authorizePersonalResourceDelegation(context(true), use),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		marker.mockImplementation(async (_db, runId, path) =>
			runId === id && path === "epochs/2/started.json"
				? ({ outcome: "success" } as never)
				: null,
		);
		await expect(
			authorizePersonalResourceDelegation(context(true), use),
		).resolves.toMatchObject({ ownerUserId: "alice" });
		const stale = context(true);
		stale.headers.set("X-Tedix-Workflow-Execution-Epoch", "1");
		await expect(
			authorizePersonalResourceDelegation(stale, use),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		for (const status of ["paused", "completed", "failed", "canceled"]) {
			run.status = status;
			await expect(
				authorizePersonalResourceDelegation(context(true), use),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
	});
	it("uses an existing read grant after skill edits despite app-wide Gmail write scopes", async () => {
		const readScope = "https://www.googleapis.com/auth/gmail.readonly";
		const appScopes = [
			readScope,
			"https://www.googleapis.com/auth/gmail.compose",
			"https://www.googleapis.com/auth/gmail.modify",
		];
		const gmailDoc =
			"---\ncapabilities:\n  mcp:\n    google_gmail: [search_threads, label_thread]\n---\nGmail skill";
		Object.assign(resource, {
			providerId: "google-gmail",
			resourceType: "mailbox",
			providerResourceId: "alice@example.test",
			requiredScopes: JSON.stringify([readScope]),
		});
		Object.assign(consent, {
			providerId: resource.providerId,
			resourceType: resource.resourceType,
			providerResourceId: resource.providerResourceId,
			requiredScopes: [readScope],
			toolIds: ["search_threads"],
			skillRevision: 5,
		});
		Object.assign(run, {
			skillRevision: 9,
			skillDoc: gmailDoc,
			resourceAccessEnvelope: {
				version: 1,
				sources: [personalDelegationSource(consent as never)],
			},
		});
		vi.mocked(skills.getSkillEntry).mockResolvedValue({
			id,
			revision: 10,
			content: gmailDoc,
			lifecycleState: "active",
		} as never);
		vi.spyOn(tedis, "getTediOrganizationId").mockResolvedValue(id);
		vi.spyOn(organizations, "getOrganizationById").mockResolvedValue({
			id,
			descopeTenantId: "tenant-example",
		} as never);
		vi.spyOn(tools, "getToolByAppAndToolIdForOrganization").mockImplementation(
			async (_db, { toolId }) =>
				({ enabled: true, config: { mcpToolName: toolId } }) as never,
		);
		vi.mocked(vault.fetchNamedConnection).mockResolvedValue({
			id: "grant",
			tokenSub: "subject",
			scopes: appScopes,
			accessToken: "secret",
		} as never);
		const ctx = context(true);
		ctx.headers.set("X-Tedix-Mcp-Tool-Id", "search_threads");
		ctx.headers.set("X-Service-Binding", "true");
		const client = createRouterClient({ fetchTediToken }, { context: ctx });
		const request = {
			tediId: id,
			providerId: "google-gmail",
			scope: "user" as const,
			scopes: appScopes,
			delegatedToolUse: { appId: id, arguments: { query: "newer_than:3d" } },
		};
		await expect(client.fetchTediToken(request)).resolves.toEqual({
			accessToken: "secret",
			scopes: [readScope],
		});
		expect(vault.fetchNamedConnection).toHaveBeenLastCalledWith(
			expect.anything(),
			{ userId: "alice" },
			"google-gmail",
			id,
			[readScope],
		);
		ctx.headers.set("X-Tedix-Mcp-Tool-Id", "label_thread");
		await expect(client.fetchTediToken(request)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		ctx.headers.set("X-Tedix-Mcp-Tool-Id", "search_threads");
		consent.revokedAt = "2026-10-02";
		await expect(client.fetchTediToken(request)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it.each([
		"revocation",
		"expiry",
		"disconnect",
		"reconnect",
		"calendar",
		"scopes",
		"retiredRun",
		"restart",
	])("fails closed on %s after an earlier successful call", async (change) => {
		await authorizePersonalResourceDelegation(context(true), use);
		if (change === "revocation") consent.revokedAt = "2026-10-02";
		if (change === "expiry") consent.expiresAt = "2000-01-01";
		if (change === "disconnect") account.tokenIds = [];
		if (change === "reconnect") account.tokenIds = ["new-grant"];
		if (change === "calendar") resource.providerResourceId = "calendar-b";
		if (change === "scopes") resource.requiredScopes = '["read","write"]';
		if (change === "retiredRun") run.workflowRetiredAt = "2026-10-02";
		if (change === "restart") run.restartRequestedAt = "2026-10-02";
		await expect(
			authorizePersonalResourceDelegation(context(true), use),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("rejects withdrawn membership and archived skill consent", async () => {
		vi.mocked(members.getMemberByUserId).mockResolvedValue({
			status: "inactive",
		} as never);
		await expect(
			authorizePersonalResourceDelegation(context(true), use),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		vi.mocked(members.getMemberByUserId).mockResolvedValue({
			status: "active",
		} as never);
		vi.mocked(skills.getSkillEntry).mockResolvedValue({
			id,
			revision: 1,
			lifecycleState: "archived",
		} as never);
		await expect(
			authorizePersonalResourceDelegation(context(true), use),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("keeps a grant usable after the skill is edited, until revoke or expiry", async () => {
		vi.mocked(skills.getSkillEntry).mockResolvedValue({
			id,
			revision: 2,
			content: doc,
			lifecycleState: "active",
		} as never);
		run.skillRevision = 2;
		const edited = { ...use, skillRevision: 2 };
		expect(consent.skillRevision).toBe(1);
		await expect(
			authorizePersonalResourceDelegation(context(true), edited),
		).resolves.toMatchObject({ ownerUserId: "alice" });
		await expect(
			validatePersonalRunSources(context(), {
				tediId: id,
				skillId: id,
				resourceAccessEnvelope: {
					version: 1,
					sources: [personalDelegationSource(consent as never)],
				},
			}),
		).resolves.toBeDefined();
		consent.expiresAt = "2000-01-01";
		await expect(
			authorizePersonalResourceDelegation(context(true), edited),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		consent.expiresAt = "2099-01-01T00:00:00Z";
		consent.revokedAt = "2026-10-02";
		await expect(
			authorizePersonalResourceDelegation(context(true), edited),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("denies a grant to another skill or another worker", async () => {
		const otherSkill = "20000000-0000-4000-8000-000000000002";
		run.skillId = otherSkill;
		await expect(
			authorizePersonalResourceDelegation(context(true), {
				...use,
				skillId: otherSkill,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		run.skillId = id;
		const otherWorker = "30000000-0000-4000-8000-000000000003";
		run.tediId = otherWorker;
		const ctx = context(true);
		(ctx as { tediId?: string }).tediId = otherWorker;
		await expect(
			authorizePersonalResourceDelegation(ctx, { ...use, tediId: otherWorker }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it.each([
		{ providerResourceId: "calendar-b" },
		{ operation: "delete" },
		{ skillRevision: 2 },
		{ connectionInstanceId: "other" },
		{ requiredScopes: ["write"] },
		{ toolId: "delete_events" },
	])(
		"cannot substitute resource, account, skill or operation %j",
		async (patch) => {
			await expect(
				authorizePersonalResourceDelegation(context(true), {
					...use,
					...patch,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		},
	);
});

describe("admitted personal source boundaries", () => {
	it("rejects a caller source whose consent is revoked before admission", async () => {
		const envelope = {
			version: 1 as const,
			sources: [personalDelegationSource(consent as never)],
		};
		await expect(
			validatePersonalRunSources(context(), {
				tediId: id,
				skillId: id,
				resourceAccessEnvelope: envelope,
			}),
		).resolves.toEqual(envelope);
		consent.revokedAt = "2026-10-01";
		await expect(
			validatePersonalRunSources(context(), {
				tediId: id,
				skillId: id,
				resourceAccessEnvelope: envelope,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("cannot use a consent unless this running run was admitted with its source", async () => {
		run.resourceAccessEnvelope = { version: 1, sources: [] };
		await expect(
			authorizePersonalResourceDelegation(context(true), use),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("lets a skill run read its derived output while the owner grant covers the operation", async () => {
		const stored = personalDelegationSource(consent as never);
		expect(await authorizePersonalDerivedSource(context(true), stored)).toBe(
			true,
		);
		expect(
			await authorizePersonalDerivedSource(context(true), {
				...stored,
				operations: ["write"],
			}),
		).toBe(false);
		consent.revokedAt = "2026-10-01";
		expect(await authorizePersonalDerivedSource(context(true), stored)).toBe(
			false,
		);
	});
	it("keeps derived output readable for the owner and skill after a skill edit", async () => {
		const stored = personalDelegationSource(consent as never);
		vi.mocked(skills.getSkillEntry).mockResolvedValue({
			id,
			revision: 2,
			content: doc,
			lifecycleState: "active",
		} as never);
		run.skillRevision = 2;
		expect(await authorizePersonalDerivedSource(context(), stored)).toBe(true);
		expect(await authorizePersonalDerivedSource(context(true), stored)).toBe(
			true,
		);
	});
	it("keeps derived output readable for the owner after revoke, never for others", async () => {
		const stored = personalDelegationSource(consent as never);
		consent.revokedAt = "2026-10-01";
		expect(await authorizePersonalDerivedSource(context(), stored)).toBe(true);
		expect(await authorizePersonalDerivedSource(context(true), stored)).toBe(
			false,
		);
		const reader = context();
		reader.user = { sub: "bob" } as never;
		expect(await authorizePersonalDerivedSource(reader, stored)).toBe(false);
	});
	it("does not let another worker skill read a derived output", async () => {
		const stored = personalDelegationSource(consent as never);
		run.skillId = "20000000-0000-4000-8000-000000000002";
		expect(await authorizePersonalDerivedSource(context(true), stored)).toBe(
			false,
		);
	});

	it("does not expose personal derived bytes to another workspace reader", async () => {
		const reader = context();
		reader.user = { sub: "bob" } as never;
		expect(
			await authorizePersonalDerivedSource(
				reader,
				personalDelegationSource(consent as never),
			),
		).toBe(false);
		expect(
			await authorizePersonalDerivedSource(
				context(),
				personalDelegationSource(consent as never),
			),
		).toBe(true);
	});
});
describe("standing personal subscription authority", () => {
	function setup() {
		consent.operations = ["read", "subscribe"];
		const row = {
			id,
			organizationId: id,
			connectionScope: "user",
			personalOwnerUserId: "alice",
			workspaceId: id,
			workspaceResourceId: id,
			delegationId: id,
			executionToolId: "list_events",
			resourceDelegationIds: [id],
			connectionInstanceId: id,
			tediId: id,
			skillId: id,
			skillRevision: 1,
			providerId: "google",
			calendarId: "calendar-a",
			status: "registering",
		};
		vi.spyOn(subscriptions, "getProviderEventSubscription").mockResolvedValue(
			row as never,
		);
		return row;
	}
	it("permits a persisted owner-approved watch without a running execution and derives its source", async () => {
		setup();
		vi.mocked(runs.getSkillRun).mockResolvedValue(null);
		const result = await resolvePersonalSubscriptionCredential(context(), {
			subscriptionId: id,
			organizationId: id,
		});
		expect(result.resourceAccessEnvelope.sources).toEqual([
			personalDelegationSource(consent as never),
		]);
		expect(runs.getSkillRun).not.toHaveBeenCalled();
	});
	it("rejects ambient worker token fallback and changed persisted watch", async () => {
		const row = setup();
		await expect(
			resolvePersonalSubscriptionCredential(context(true), {
				subscriptionId: id,
				organizationId: id,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		vi.mocked(subscriptions.getProviderEventSubscription)
			.mockResolvedValueOnce(row as never)
			.mockResolvedValueOnce({ ...row, status: "disabled" } as never);
		await expect(
			resolvePersonalSubscriptionCredential(context(), {
				subscriptionId: id,
				organizationId: id,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("fails before fetching credentials when any selected consent is absent", async () => {
		const row = setup();
		row.resourceDelegationIds.push("10000000-0000-4000-8000-000000000002");
		vi.mocked(consents.getPersonalResourceDelegation).mockImplementation(
			async (_db, args) => (args.id === id ? (consent as never) : null),
		);
		await expect(
			resolvePersonalSubscriptionCredential(context(), {
				subscriptionId: id,
				organizationId: id,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(vault.fetchNamedConnection).not.toHaveBeenCalled();
	});
});
