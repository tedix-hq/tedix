import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { oidcSessions } from "@tedix/db/schema/oidc-sessions";
import { organizations } from "@tedix/db/schema/organizations";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { principalIdentities } from "@tedix/db/schema";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { users } from "@tedix/db/schema/users";
import {
	insertOidcRecord,
	consumeOidcLogin,
	resolveOidcMember,
} from "@tedix/db/queries/oidc-sessions";
import { oidcDigest, readOidcConfig } from "@tedix/auth/oidc";
import { handleOidcLogin, resolveOidcUser } from "./oidc-login";
import type { BaseContext } from "./rpc/context";

const ORG = "00000000-0000-4000-8000-000000000001",
	USER = "00000000-0000-4000-8000-000000000002";
const config = readOidcConfig({
	kind: "oidc",
	issuer: "https://id.example.test/realms/acme",
	clientId: "tedix",
	redirectUri: "https://acme.example.test/auth/oidc/callback",
	scopes: ["openid", "profile"],
	scopeMapping: { profile: ["apps:read"] },
});
async function setup(status: "active" | "invited" | "deactivated" = "active") {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			organizations,
			users,
			organizationMembers,
			principalIdentities,
			oidcSessions,
			// The profile read looks up a new account's welcome record.
			userConfigs,
		),
	);
	const statements: string[] = [];
	const db = createDbClient(
		createD1Facade({
			prepare(query) {
				statements.push(query);
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);
	await db.insert(organizations).values({
		id: ORG,
		name: "Acme",
		slug: "acme",
		metadata: { identityProvider: config },
	});
	await db.insert(users).values({ id: USER, email: "alice@example.test" });
	await db.insert(organizationMembers).values({
		id: "00000000-0000-4000-8000-000000000003",
		organizationId: ORG,
		userId: USER,
		descopeUserId: "unused-adapter-subject",
		email: "alice@example.test",
		role: "member",
		status,
	});
	await db.insert(principalIdentities).values({
		id: "mapping",
		principalType: "user",
		principalId: USER,
		provider: "oidc",
		issuer: config.issuer,
		subject: "alice",
	});
	await insertOidcRecord(db, {
		id: await oidcDigest("secret"),
		organizationId: ORG,
		kind: "session",
		subject: "alice",
		configDigest: await oidcDigest(JSON.stringify(config)),
		scopes: ["profile"],
		expiresAt: Math.floor(Date.now() / 1000) + 300,
	});
	const context = {
		db,
		env: { ENVIRONMENT: "development" },
		headers: new Headers(),
		url: new URL("https://api/rpc/userProfile/getMine"),
	} as BaseContext;
	return { db, context, sqlite, statements };
}
describe("OIDC Tedix sessions", () => {
	it("resolves session, configuration and membership in one statement with timing", async () => {
		const { context, statements } = await setup();
		statements.length = 0;
		const result = await resolveOidcUser(context, "secret");
		expect(statements).toHaveLength(1);
		expect(result.session.organizationId).toBe(ORG);
		expect(result.member.userId).toBe(USER);
		expect(result.member.email).toBe("alice@example.test");
		expect(result.member.role).toBe("member");
		expect(result.scopes).toEqual(["apps:read"]);
		expect(context.serverTiming).toEqual([
			expect.stringMatching(/^auth-identity;dur=\d+\.\d$/),
		]);
	});

	it("observes role, permission and membership changes on the next call", async () => {
		const { context, sqlite } = await setup();
		await resolveOidcUser(context, "secret");
		sqlite.exec(
			`UPDATE organization_members SET role='admin', custom_permissions='["apps:read"]'`,
		);
		const changed = await resolveOidcUser(context, "secret");
		expect(changed.member.role).toBe("admin");
		expect(changed.member.permissions).toEqual(["apps:read"]);
		sqlite.exec("UPDATE organization_members SET status='deactivated'");
		await expect(resolveOidcUser(context, "secret")).rejects.toThrow(
			"active membership",
		);
	});

	it.each([
		"UPDATE oidc_sessions SET expires_at=0",
		"UPDATE oidc_sessions SET kind='login'",
		"UPDATE principal_identities SET status='revoked'",
		"UPDATE principal_identities SET issuer='https://other.example.test'",
		`UPDATE principal_identities SET organization_id='${ORG}'`,
		'UPDATE organizations SET metadata=\'{"retiredAt":"2026-11-18"}\'',
	])("refuses changed session authority: %s", async (mutation) => {
		const { context, sqlite } = await setup();
		await resolveOidcUser(context, "secret");
		sqlite.exec(mutation);
		await expect(resolveOidcUser(context, "secret")).rejects.toThrow();
	});

	it("does not use another organization's membership for the session", async () => {
		const { context, db, sqlite } = await setup();
		await db
			.insert(organizations)
			.values({ id: "other", name: "Other", slug: "other" });
		sqlite.exec("UPDATE organization_members SET organization_id='other'");
		await expect(resolveOidcUser(context, "secret")).rejects.toThrow(
			"active membership",
		);
	});

	it("authenticates the normal RPC profile path and enforces mapped API scopes", async () => {
		const { context, sqlite, statements } = await setup();
		context.headers.set("Cookie", "__Host-tedix-oidc=secret");
		const { createRouterClient } = await import("@orpc/server");
		const { userProfileContractRouter } =
			await import("./rpc/routers/user-profile");
		const profile = await createRouterClient(userProfileContractRouter, {
			context,
		}).getMine({});
		expect(profile.id).toBe(USER);
		expect(context.authType).toBe("user");
		expect(context.oidcScopes).toEqual(["apps:read"]);
		const { getRequestOrganizationMembership } =
			await import("./rpc/org-membership");
		statements.length = 0;
		for (const lookup of [
			{},
			{ canonicalUserId: USER, fallbackToSubject: false },
		]) {
			await expect(
				getRequestOrganizationMembership(context, ORG, USER, lookup),
			).resolves.toMatchObject({
				id: "00000000-0000-4000-8000-000000000003",
				userId: USER,
				descopeUserId: "unused-adapter-subject",
				kind: "human",
				customPermissions: null,
				status: "active",
			});
		}
		expect(statements).toHaveLength(0);
		const { hasRequiredScope } = await import("./rpc/orpc");
		expect(hasRequiredScope(context, "apps:read")).toBe(true);
		expect(hasRequiredScope(context, "apps:write")).toBe(false);
		const { organizationsContractRouter } =
			await import("./rpc/routers/organizations");
		expect(
			(
				await createRouterClient(organizationsContractRouter, {
					context,
				}).getMyOrganization({})
			).organization.id,
		).toBe(ORG);
		expect(
			sqlite.prepare("SELECT count(*) AS count FROM organizations").get()!
				.count,
		).toBe(1);
	});

	it("resolves the exact canonical principal and configured scopes", async () => {
		const { context } = await setup();
		const result = await resolveOidcUser(context, "secret");
		expect(result.member.userId).toBe(USER);
		expect(result.scopes).toEqual(["apps:read"]);
	});
	it.each(["invited", "deactivated"] as const)(
		"refuses %s membership without token-role fallback",
		async (status) => {
			const { context } = await setup(status);
			await expect(resolveOidcUser(context, "secret")).rejects.toThrow(
				"active membership",
			);
		},
	);
	it("refuses cross-tenant, unbound and revoked subjects", async () => {
		const { context, sqlite, db } = await setup();
		context.headers.set("X-Tedix-Tenant-Id", "another-org");
		await expect(resolveOidcUser(context, "secret")).rejects.toThrow(
			"tenant mismatch",
		);
		expect(
			await resolveOidcMember(db, ORG, config.issuer, "unknown"),
		).toBeUndefined();
		context.headers.delete("X-Tedix-Tenant-Id");
		sqlite.exec("UPDATE principal_identities SET status='revoked'");
		await expect(resolveOidcUser(context, "secret")).rejects.toThrow();
	});
	it("invalidates sessions when organization configuration changes", async () => {
		const { context, sqlite } = await setup();
		sqlite.exec(`UPDATE organizations SET metadata='{}'`);
		await expect(resolveOidcUser(context, "secret")).rejects.toThrow();
	});
	it("consumes login state atomically once and rejects expiry", async () => {
		const { db } = await setup();
		await insertOidcRecord(db, {
			id: "state",
			organizationId: ORG,
			kind: "login",
			configDigest: "config",
			expiresAt: 100,
		});
		expect(await consumeOidcLogin(db, "state", 10)).toBeDefined();
		expect(await consumeOidcLogin(db, "state", 10)).toBeUndefined();
		await insertOidcRecord(db, {
			id: "expired",
			organizationId: ORG,
			kind: "login",
			configDigest: "config",
			expiresAt: 1,
		});
		expect(await consumeOidcLogin(db, "expired", 10)).toBeUndefined();
	});
	it("revokes the RP session on same-origin logout, even if the IdP is unavailable", async () => {
		const { context } = await setup();
		context.headers.set("Cookie", "__Host-tedix-oidc=secret");
		const cross = new Request("https://api/auth/oidc/logout", {
			method: "POST",
			headers: {
				Origin: "https://evil.example.test",
				Cookie: context.headers.get("Cookie")!,
			},
		});
		expect((await handleOidcLogin(cross, context)).status).toBe(403);
		const request = new Request("https://api/auth/oidc/logout", {
			method: "POST",
			headers: {
				Origin: "https://acme.example.test",
				Cookie: context.headers.get("Cookie")!,
			},
		});
		const response = await handleOidcLogin(request, context);
		expect(response.status).toBe(200);
		expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
		await expect(resolveOidcUser(context, "secret")).rejects.toThrow();
	});
});
