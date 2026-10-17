import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { oidcSessions } from "@tedix/db/schema/oidc-sessions";
import { organizations } from "@tedix/db/schema/organizations";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { principalIdentities } from "@tedix/db/schema";
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
		),
	);
	const db = createDbClient(createD1Facade(sqlite));
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
	return { db, context, sqlite };
}
describe("OIDC Tedix sessions", () => {
	it("authenticates the normal RPC profile path and enforces mapped API scopes", async () => {
		const { context, sqlite } = await setup();
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
