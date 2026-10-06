import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createRouterClient } from "@orpc/server";
import * as accounts from "@tedix/db/queries/connection-instances";
import * as members from "@tedix/db/queries/organization-members";
import * as resources from "@tedix/db/queries/os-workspaces/resources";
import * as workspaces from "@tedix/db/queries/os-workspaces/workspaces";
import * as tedis from "@tedix/db/queries/tedis";
import * as skills from "@tedix/db/queries/cognitive/skill-crud";
import * as runs from "@tedix/db/queries/skill-runs";
import * as consents from "@tedix/db/queries/personal-resource-delegations";
import * as organizations from "@tedix/db/queries/organizations";
import * as tools from "@tedix/db/queries/tools";
import * as vault from "./connections/policy-resolution";
import {
	personalConnectionGrantFingerprint,
	personalDelegationSource,
} from "../../services/personal-resource-delegation-authority";
import type { BaseContext } from "../orpc";
import { connectionsContractRouter } from "./connections";
const id = "10000000-0000-4000-8000-000000000001";
const doc =
	"---\ncapabilities:\n  mcp:\n    google: [list_events]\n---\nCalendar";
let consent: Record<string, unknown>, run: Record<string, unknown>;
function context() {
	return {
		authType: "service-binding",
		tediId: id,
		tediScopes: ["connections.read"],
		organizationId: id,
		db: {},
		env: { ENVIRONMENT: "production" },
		url: new URL("https://api/rpc"),
		headers: new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Mcp-Tool-Id": "list_events",
			"X-Tedix-Skill-Run-Id": id,
			"X-Tedix-Workflow-Execution-Epoch": "2",
		}),
	} as unknown as BaseContext;
}
const input = {
	tediId: id,
	providerId: "google",
	scope: "user" as const,
	connectionInstanceId: id,
	delegatedToolUse: { appId: id, arguments: { calendarId: "calendar-a" } },
};
beforeEach(async () => {
	vi.restoreAllMocks();
	consent = {
		id,
		organizationId: id,
		ownerUserId: "alice",
		tediId: id,
		skillId: id,
		skillRevision: 1,
		workspaceId: id,
		resourceId: id,
		connectionInstanceId: id,
		providerId: "google",
		providerResourceId: "calendar-a",
		resourceType: "calendar",
		requiredScopes: ["read"],
		operations: ["read"],
		toolIds: ["list_events"],
		accountSubject: "subject",
		grantFingerprint: await personalConnectionGrantFingerprint(["grant"]),
		expiresAt: "2099-01-01T00:00:00Z",
		revokedAt: null,
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
		resourceAccessEnvelope: {
			version: 1,
			sources: [personalDelegationSource(consent as never)],
		},
	};
	vi.spyOn(tedis, "getTediOrganizationId").mockResolvedValue(id);
	vi.spyOn(organizations, "getOrganizationById").mockResolvedValue({
		id,
		descopeTenantId: "tenant",
	} as never);
	vi.spyOn(tedis, "getTediByIdForOrganization").mockResolvedValue({
		id,
		retiredAt: null,
	} as never);
	vi.spyOn(members, "getMemberByUserId").mockResolvedValue({
		status: "active",
	} as never);
	vi.spyOn(workspaces, "getOsWorkspace").mockResolvedValue({
		id,
		status: "active",
	} as never);
	vi.spyOn(resources, "getOsWorkspaceResource").mockResolvedValue({
		id,
		workspaceId: id,
		organizationId: id,
		status: "active",
		connectionScope: "user",
		personalOwnerUserId: "alice",
		connectionInstanceId: id,
		providerId: "google",
		resourceType: "calendar",
		providerResourceId: "calendar-a",
		requiredScopes: '["read"]',
	} as never);
	vi.spyOn(accounts, "getConnectionInstance").mockResolvedValue({
		id,
		tokenSub: "subject",
		tokenIds: ["grant"],
	} as never);
	vi.spyOn(skills, "getSkillEntry").mockResolvedValue({
		id,
		revision: 1,
		lifecycleState: "active",
		content: doc,
	} as never);
	vi.spyOn(runs, "getSkillRun").mockImplementation(async () => run as never);
	vi.spyOn(consents, "getPersonalResourceDelegation").mockImplementation(
		async () => consent as never,
	);
	vi.spyOn(tools, "getToolByAppAndToolIdForOrganization").mockResolvedValue({
		enabled: true,
		config: {
			personalResourceBinding: {
				operation: "read",
				resourceType: "calendar",
				paths: [["calendarId"]],
			},
		},
	} as never);
	vi.spyOn(vault, "fetchNamedConnection").mockResolvedValue({
		id: "grant",
		tokenSub: "subject",
		accessToken: "secret",
		scopes: ["read"],
	});
});
describe("full personal credential router", () => {
	it("resolves only the admitted owner account and checks every use anew", async () => {
		const client = createRouterClient(connectionsContractRouter, {
			context: context(),
		});
		expect(await client.fetchTediToken(input)).toEqual({
			accessToken: "secret",
			scopes: ["read"],
		});
		expect(vault.fetchNamedConnection).toHaveBeenCalledWith(
			expect.anything(),
			{ userId: "alice" },
			"google",
			id,
			["read"],
		);
		consent.revokedAt = "2026-10-01";
		await expect(client.fetchTediToken(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(vault.fetchNamedConnection).toHaveBeenCalledTimes(1);
	});
	it("denies calendar substitution and unknown reviewed mappings before token resolution", async () => {
		const client = createRouterClient(connectionsContractRouter, {
			context: context(),
		});
		await expect(
			client.fetchTediToken({
				...input,
				delegatedToolUse: {
					appId: id,
					arguments: { calendarId: "calendar-b" },
				},
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		vi.mocked(tools.getToolByAppAndToolIdForOrganization).mockResolvedValue({
			enabled: true,
			config: {},
		} as never);
		await expect(client.fetchTediToken(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(vault.fetchNamedConnection).not.toHaveBeenCalled();
	});
	it("requires actual running epoch, snapshot and subject-pinned token", async () => {
		const client = createRouterClient(connectionsContractRouter, {
			context: context(),
		});
		run.executionEpoch = 3;
		await expect(client.fetchTediToken(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		run.executionEpoch = 2;
		run.resourceAccessEnvelope = { version: 1, sources: [] };
		await expect(client.fetchTediToken(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		run.resourceAccessEnvelope = {
			version: 1,
			sources: [personalDelegationSource(consent as never)],
		};
		vi.mocked(vault.fetchNamedConnection).mockResolvedValue({
			id: "replacement",
			tokenSub: "other",
			accessToken: "wrong",
			scopes: ["read"],
		});
		await expect(client.fetchTediToken(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it("does not accept a tedi JWT or human scope as trusted workflow provenance", async () => {
		const caller = context();
		caller.authType = "tedi";
		caller.headers.delete("X-Service-Binding");
		const client = createRouterClient(connectionsContractRouter, {
			context: caller,
		});
		await expect(client.fetchTediToken(input)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(vault.fetchNamedConnection).not.toHaveBeenCalled();
	});
});
