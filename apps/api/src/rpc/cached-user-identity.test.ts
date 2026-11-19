import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { organizations } from "@tedix/db/schema/organizations";
import { principalIdentities } from "@tedix/db/schema/principal-identities";
import { oidcSessions } from "@tedix/db/schema/oidc-sessions";
import { users } from "@tedix/db/schema/users";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { invalidateIdentityCache } from "../services/identity-cache-invalidation";
import { createContext } from "./context";
import { resolveCachedUserIdentity } from "./cached-user-identity";

const databases: DatabaseSync[] = [];
afterEach(() => {
	vi.unstubAllGlobals();
	for (const db of databases.splice(0)) db.close();
});

it("uses the production cache, primary fence, role changes and logout together", async () => {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec(
		schemaDdl(
			organizations,
			organizationMembers,
			principalIdentities,
			oidcSessions,
			users,
		),
	);
	sqlite.exec(
		readFileSync(
			new URL(
				"../../../../packages/db/drizzle/20261119100738_auth_context_cache/migration.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	sqlite.exec(
		"INSERT INTO organizations (id, name, slug, descope_tenant_id) VALUES ('org-one', 'One', 'one', 'tenant-one')",
	);
	sqlite.exec(
		"INSERT INTO organization_members (id, organization_id, descope_user_id, email, role) VALUES ('member-one', 'org-one', 'subject-one', 'one@example.test', 'owner')",
	);
	const queries: string[] = [];
	const d1 = createD1Facade({
		prepare: (sql) => {
			queries.push(sql);
			return sqlite.prepare(sql);
		},
		exec: (sql) => sqlite.exec(sql),
	});
	const session = vi.spyOn(d1, "withSession");
	const entries = new Map<string, Response>();
	vi.stubGlobal("caches", {
		open: async () => ({
			match: async (key: Request) => entries.get(key.url)?.clone(),
			put: async (key: Request, response: Response) => {
				entries.set(key.url, response.clone());
			},
		}),
	});
	const env = { DB: d1, ENVIRONMENT: "production" } as CloudflareEnv;
	const input = {
		organizationIdentity: {
			provider: "descope",
			issuer: "issuer",
			subject: "tenant-one",
		},
		userIdentity: {
			provider: "descope",
			issuer: "issuer",
			subject: "subject-one",
		},
	};
	const identityReads = () =>
		queries.filter((sql) => sql.includes("identity_context_organization_id"))
			.length;
	const resolve = async () => {
		const context = createContext(
			new Request("https://api.example.test/rpc/test", {
				headers: { "x-d1-bookmark": "untrusted-bookmark" },
			}),
			env,
		);
		const value = await resolveCachedUserIdentity(
			context,
			"session-one",
			Date.now() + 60_000,
			input,
		);
		return { value, timing: context.serverTiming };
	};
	expect((await resolve()).value?.memberRole).toBe("owner");
	expect((await resolve()).timing).toContain('auth-identity-cache;desc="hit"');
	expect(identityReads()).toBe(1);
	expect(session).toHaveBeenCalledWith("first-primary");
	sqlite.exec(
		"UPDATE organization_members SET role = 'viewer' WHERE id = 'member-one'",
	);
	expect((await resolve()).value?.memberRole).toBe("viewer");
	expect(identityReads()).toBe(2);
	expect(
		(
			await invalidateIdentityCache(
				new Request(
					"https://api.internal/__internal/identity-cache/invalidate",
					{ method: "POST" },
				),
				env,
			)
		).status,
	).toBe(204);
	expect((await resolve()).value?.memberRole).toBe("viewer");
	expect(identityReads()).toBe(3);
});
