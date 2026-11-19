import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import { principalIdentities } from "../schema/principal-identities";
import { oidcSessions } from "../schema/oidc-sessions";
import { users } from "../schema/users";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	invalidateAuthContextCache,
	readAuthContextCacheVersion,
} from "./auth-context-cache";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const sqlite of databases.splice(0)) sqlite.close();
});

function fixture() {
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
				"../../drizzle/20261119100738_auth_context_cache/migration.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	sqlite.exec(
		readFileSync(
			new URL(
				"../../drizzle/20261119182503_auth_cache_organization_fields/migration.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	const db = createDbQueryClient(
		createD1Facade({
			prepare: (sql) => sqlite.prepare(sql),
			exec: (sql) => sqlite.exec(sql),
		}),
	);
	return { sqlite, db };
}

describe("authorization cache version fence", () => {
	it("advances atomically for raw SQL role, permission, membership and identity changes", async () => {
		const { sqlite, db } = fixture();
		let version = await readAuthContextCacheVersion(db);
		for (const statement of [
			"INSERT INTO organizations (id, name, slug) VALUES ('org-one', 'One', 'one')",
			"INSERT INTO organization_members (id, organization_id, descope_user_id, email, role) VALUES ('member-one', 'org-one', 'subject-one', 'one@example.test', 'owner')",
			"UPDATE organization_members SET role = 'viewer' WHERE id = 'member-one'",
			"UPDATE organization_members SET custom_permissions = '[]' WHERE id = 'member-one'",
			"UPDATE organization_members SET status = 'deactivated' WHERE id = 'member-one'",
			"DELETE FROM organization_members WHERE id = 'member-one'",
			"UPDATE organizations SET descope_tenant_id = 'tenant-one' WHERE id = 'org-one'",
			"UPDATE organizations SET metadata = json_set(coalesce(metadata, '{}'), '$.identityProvider', json_object('issuer', 'https://issuer.example.test', 'clientId', 'old-client')) WHERE id = 'org-one'",
			"UPDATE organizations SET metadata = json_set(metadata, '$.identityProvider.clientId', 'new-client') WHERE id = 'org-one'",
			"UPDATE organizations SET metadata = json_remove(metadata, '$.identityProvider') WHERE id = 'org-one'",
			"UPDATE organizations SET metadata = json_set(metadata, '$.retiredAt', '2026-01-01T00:00:00Z') WHERE id = 'org-one'",
			"INSERT INTO principal_identities (id, provider, issuer, subject, principal_type, principal_id, created_at, updated_at) VALUES ('identity-one', 'descope', 'issuer', 'subject-one', 'user', 'user-one', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
			"UPDATE principal_identities SET status = 'revoked' WHERE id = 'identity-one'",
		]) {
			sqlite.exec(statement);
			const next = await readAuthContextCacheVersion(db);
			expect(next, statement).not.toBe(version);
			version = next;
		}
	});

	it("invalidates on broker logout and OIDC session deletion", async () => {
		const { sqlite, db } = fixture();
		const before = await readAuthContextCacheVersion(db);
		await invalidateAuthContextCache(db);
		expect(await readAuthContextCacheVersion(db)).not.toBe(before);
		sqlite.exec(
			"INSERT INTO organizations (id, name, slug) VALUES ('org-one', 'One', 'one')",
		);
		sqlite.exec(
			"INSERT INTO oidc_sessions (id, organization_id, kind, config_digest, expires_at) VALUES ('session-one', 'org-one', 'session', 'digest', 9999999999)",
		);
		const version = await readAuthContextCacheVersion(db);
		sqlite.exec("DELETE FROM oidc_sessions WHERE id = 'session-one'");
		expect(await readAuthContextCacheVersion(db)).not.toBe(version);
	});
});
