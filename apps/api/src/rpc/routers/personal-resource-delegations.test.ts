import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "../../../../../packages/db/src/test/d1-facade";
import * as members from "@tedix/db/queries/organization-members";
import * as accounts from "@tedix/db/queries/connection-instances";
import * as resources from "@tedix/db/queries/os-workspaces/resources";
import * as workspaces from "@tedix/db/queries/os-workspaces/workspaces";
import * as tedis from "@tedix/db/queries/tedis";
import * as skills from "@tedix/db/queries/cognitive/skill-crud";
import * as vault from "./connections/policy-resolution";
import type { BaseContext } from "../orpc";
import { personalResourceDelegationsRouter } from "./personal-resource-delegations";
const id = "10000000-0000-4000-8000-000000000001";
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
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		"CREATE TABLE personal_resource_delegations (id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, tedi_id TEXT NOT NULL, skill_id TEXT NOT NULL, skill_revision INTEGER NOT NULL, workspace_id TEXT NOT NULL, resource_id TEXT NOT NULL, connection_instance_id TEXT NOT NULL, provider_id TEXT NOT NULL, resource_type TEXT NOT NULL, provider_resource_id TEXT NOT NULL, account_subject TEXT NOT NULL, grant_fingerprint TEXT NOT NULL, required_scopes TEXT NOT NULL, operations TEXT NOT NULL, tool_ids TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT)",
	);
	return createDbQueryClient(createD1Facade(sqlite));
}
function context(
	db: ReturnType<typeof fixture>,
	owner = "alice",
	authType = "user",
) {
	return {
		authType,
		organizationId: id,
		db,
		env: { ENVIRONMENT: "production" },
		headers: new Headers(),
		url: new URL("https://api.example.test/rpc"),
		user:
			authType === "user"
				? { sub: owner, permissions: [], roles: [], exp: 9999999999 }
				: undefined,
		apiKey: authType === "apikey" ? { scopes: ["*"] } : undefined,
	} as unknown as BaseContext;
}
beforeEach(() => {
	vi.restoreAllMocks();
	vi.spyOn(members, "getMemberByUserId").mockResolvedValue({
		status: "active",
	} as never);
	vi.spyOn(accounts, "getConnectionInstance").mockImplementation(
		async (_db, owner) =>
			owner.userId === "alice"
				? ({ id, tokenSub: "subject", tokenIds: ["grant"] } as never)
				: undefined,
	);
	vi.spyOn(resources, "getOsWorkspaceResource").mockResolvedValue({
		status: "active",
		connectionScope: "user",
		personalOwnerUserId: "alice",
		connectionInstanceId: id,
		providerAccess: { canRead: true, canWrite: false },
		providerId: "google",
		providerResourceId: "calendar-a",
		resourceType: "calendar",
		requiredScopes: '["read"]',
	} as never);
	vi.spyOn(workspaces, "getOsWorkspace").mockResolvedValue({
		status: "active",
	} as never);
	vi.spyOn(tedis, "getTediByIdForOrganization").mockResolvedValue({
		id,
		retiredAt: null,
	} as never);
	vi.spyOn(skills, "getSkillEntry").mockResolvedValue({
		revision: 1,
		lifecycleState: "active",
		content:
			"---\ncapabilities:\n  mcp:\n    google: [list_events]\n---\nCalendar skill",
	} as never);
	vi.spyOn(vault, "fetchNamedConnection").mockResolvedValue({
		id: "grant",
		tokenSub: "subject",
		scopes: ["read"],
		accessToken: "secret",
	} as never);
});
describe("personal delegation owner lifecycle through real oRPC router and D1", () => {
	it("creates, lists and idempotently revokes without leaking token metadata", async () => {
		const client = createRouterClient(personalResourceDelegationsRouter, {
			context: context(fixture()),
		});
		const row = await client.create(input);
		expect(row.providerResourceId).toBe("calendar-a");
		expect(row).not.toHaveProperty("grantFingerprint");
		expect(row).not.toHaveProperty("accountSubject");
		expect(await client.list({})).toEqual([row]);
		const revoked = await client.revoke({ id: row.id });
		expect(revoked.revokedAt).toBeTruthy();
		expect(await client.revoke({ id: row.id })).toEqual(revoked);
	});
	it("does not let another member read, revoke or grant the owner's account", async () => {
		const db = fixture();
		const alice = createRouterClient(personalResourceDelegationsRouter, {
			context: context(db),
		});
		const row = await alice.create(input);
		const bob = createRouterClient(personalResourceDelegationsRouter, {
			context: context(db, "bob"),
		});
		expect(await bob.list({})).toEqual([]);
		await expect(bob.revoke({ id: row.id })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(bob.create(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it.each(["apikey", "service-binding", "tedi"])(
		"rejects %s even when scopes are broad",
		async (authType) => {
			const client = createRouterClient(personalResourceDelegationsRouter, {
				context: context(fixture(), "alice", authType),
			});
			await expect(client.create(input)).rejects.toThrow();
			await expect(client.list({})).rejects.toThrow();
			await expect(client.revoke({ id })).rejects.toThrow();
		},
	);
	it("requires active owner membership", async () => {
		vi.mocked(members.getMemberByUserId).mockResolvedValue({
			status: "inactive",
		} as never);
		const client = createRouterClient(personalResourceDelegationsRouter, {
			context: context(fixture()),
		});
		await expect(client.create(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it("does not accept injected owner identity", async () => {
		const client = createRouterClient(personalResourceDelegationsRouter, {
			context: context(fixture()),
		});
		await expect(
			client.create({ ...input, ownerUserId: "bob" } as never),
		).rejects.toThrow();
	});
});
