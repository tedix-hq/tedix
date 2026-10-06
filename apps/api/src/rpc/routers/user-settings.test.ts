/**
 * Per-user OS settings router: preference persistence under optimistic
 * concurrency, and the read-only operational context projection.
 *
 * Exercised against a real D1 facade so every write assertion can read the ROW
 * back, not just the wire. That distinction is load-bearing here: the contract
 * output schema strips unknown keys, so a wire-only assertion cannot see what a
 * handler actually persisted.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { DEFAULT_OS_USER_PREFERENCES } from "@tedix/api-contract/schemas/user-settings";
import type { OsUserPreferences } from "@tedix/api-contract/schemas/user-settings";
import { DEFAULT_ORGANIZATION_OS_THEME } from "@tedix/api-contract/schemas/os-theme";
import { createDbClient } from "@tedix/db/client";
import { organizationPurposeCharters } from "@tedix/db/schema/organization-purpose";
import { organizations } from "@tedix/db/schema/organizations";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { userSettingsContractRouter } from "./user-settings";

const ORG_1 = "00000000-0000-4000-8000-000000000001";
const ORG_2 = "00000000-0000-4000-8000-000000000002";
const CHARTER_1 = "00000000-0000-4000-8000-0000000000c1";

function createEnv(): { env: CloudflareEnv; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(userConfigs, organizations, organizationPurposeCharters),
	);
	sqlite
		.prepare(
			`INSERT INTO organizations (id, name, slug, type, descope_tenant_id) VALUES (?,?,?,?,?)`,
		)
		.run(ORG_1, "First Org", "first-org", "organization", "org_first");
	sqlite
		.prepare(
			`INSERT INTO organizations (id, name, slug, type, descope_tenant_id) VALUES (?,?,?,?,?)`,
		)
		.run(ORG_2, "Second Org", "second-org", "personal", "personal_second");
	return {
		sqlite,
		env: {
			ENVIRONMENT: "test",
			DB: createD1Facade(sqlite),
		} as unknown as CloudflareEnv,
	};
}

function seedActiveCharter(sqlite: DatabaseSync, orgId: string): void {
	sqlite
		.prepare(
			`INSERT INTO organization_purpose_charters
			 (id, org_id, version, status, purpose, principles, strategic_theses,
			  non_goals, evidence_refs, review_cadence_days, revision_reason,
			  created_at, activated_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		)
		.run(
			CHARTER_1,
			orgId,
			2,
			"active",
			"Serve Mexican auto-repair shops end to end.",
			"[]",
			"[]",
			"[]",
			"[]",
			30,
			"initial",
			"2026-08-01T00:00:00.000Z",
			"2026-08-01T00:00:00.000Z",
		);
}

function userContext(
	env: CloudflareEnv,
	options: {
		organizationId: string;
		userId?: string;
		permissions?: string[];
		role?: string;
		crossTenantOverrideActive?: boolean;
	},
): BaseContext {
	return {
		authType: "user",
		db: createDbClient(env.DB) as BaseContext["db"],
		env,
		headers: new Headers(),
		organizationId: options.organizationId,
		userId: options.userId ?? "tedix-user-1",
		userRole: options.role,
		crossTenantOverrideActive: options.crossTenantOverrideActive,
		url: new URL("https://api.tedix.test/rpc/userSettings"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: options.permissions ?? ["settings:manage"],
			roles: [],
			sub: "descope-user-1",
		},
	} as BaseContext;
}

function apiKeyContext(
	env: CloudflareEnv,
	organizationId: string,
	scopes: string[],
): BaseContext {
	return {
		apiKey: { id: "key-1", name: "test", organizationId, scopes },
		authType: "apikey",
		db: createDbClient(env.DB) as BaseContext["db"],
		env,
		headers: new Headers(),
		organizationId,
		url: new URL("https://api.tedix.test/rpc/userSettings"),
	} as BaseContext;
}

function client(context: BaseContext) {
	return createRouterClient(userSettingsContractRouter, { context });
}

function storedRows(
	sqlite: DatabaseSync,
	userId = "tedix-user-1",
): { key: string; value: string; revision: number }[] {
	return sqlite
		.prepare(
			`SELECT key, value, revision FROM user_configs
			 WHERE user_id = ? AND namespace = 'os.preferences' ORDER BY key`,
		)
		.all(userId) as unknown as {
		key: string;
		value: string;
		revision: number;
	}[];
}

const CUSTOM: OsUserPreferences = {
	theme: "dark",
	density: "compact",
	locale: "es-MX",
	timezone: "America/Mexico_City",
	accessibility: { motion: "reduced", contrast: "high" },
	notifications: { approvals: true, runFailures: false, budgetAlerts: true },
	conversationModelRef: "azure-openai/gpt-5.6-terra",
};

describe("preferences", () => {
	let env: CloudflareEnv;
	let sqlite: DatabaseSync;
	beforeEach(() => {
		({ env, sqlite } = createEnv());
	});

	it("reports defaults as `default` at revision 0 before anything is stored", async () => {
		const result = await client(
			userContext(env, { organizationId: ORG_1 }),
		).getPreferences({});
		expect(result).toEqual({
			preferences: DEFAULT_OS_USER_PREFERENCES,
			source: "default",
			revision: 0,
			updatedAt: null,
		});
		expect(storedRows(sqlite)).toHaveLength(0);
	});

	it("persists the exact preference object and reads it back as `stored`", async () => {
		const c = client(userContext(env, { organizationId: ORG_1 }));
		const saved = await c.updatePreferences({
			preferences: CUSTOM,
			expectedRevision: 0,
		});
		expect(saved).toMatchObject({ source: "stored", revision: 1 });

		const rows = storedRows(sqlite);
		expect(rows).toHaveLength(1);
		// The ROW, not the wire: the response schema would strip a stray key,
		// so only the persisted JSON proves what was written.
		expect(JSON.parse(rows[0]?.value ?? "null")).toEqual(CUSTOM);
		expect(rows[0]?.key).toBe(ORG_1);

		await expect(c.getPreferences({})).resolves.toMatchObject({
			preferences: CUSTOM,
			source: "stored",
			revision: 1,
		});
	});

	it("fails a stale write with CONFLICT and leaves the stored row intact", async () => {
		const c = client(userContext(env, { organizationId: ORG_1 }));
		await c.updatePreferences({ preferences: CUSTOM, expectedRevision: 0 });
		await c.updatePreferences({
			preferences: { ...CUSTOM, theme: "light" },
			expectedRevision: 1,
		});

		await expect(
			c.updatePreferences({
				preferences: { ...CUSTOM, theme: "system" },
				expectedRevision: 1,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { expectedRevision: 1, currentRevision: 2 },
		});

		const rows = storedRows(sqlite);
		expect(rows[0]?.revision).toBe(2);
		expect(JSON.parse(rows[0]?.value ?? "null")).toMatchObject({
			theme: "light",
		});
	});

	it("keeps a member's preferences separate per organization", async () => {
		// The row key is the credential-resolved organization, never input, so
		// the same human in two tenants cannot read or clobber across them.
		await client(userContext(env, { organizationId: ORG_1 })).updatePreferences(
			{ preferences: CUSTOM, expectedRevision: 0 },
		);
		const org2 = client(userContext(env, { organizationId: ORG_2 }));
		await expect(org2.getPreferences({})).resolves.toMatchObject({
			source: "default",
			revision: 0,
		});
		await org2.updatePreferences({
			preferences: { ...CUSTOM, theme: "light" },
			expectedRevision: 0,
		});

		const rows = storedRows(sqlite);
		expect(rows.map((row) => row.key)).toEqual([ORG_1, ORG_2]);
		expect(JSON.parse(rows[0]?.value ?? "null")).toMatchObject({
			theme: "dark",
		});
		expect(JSON.parse(rows[1]?.value ?? "null")).toMatchObject({
			theme: "light",
		});
	});

	it("falls back to defaults, without deleting it, when the stored row is unreadable", async () => {
		sqlite
			.prepare(
				`INSERT INTO user_configs (id, user_id, namespace, key, value, revision)
				 VALUES (?,?,?,?,?,3)`,
			)
			.run(
				"legacy",
				"tedix-user-1",
				"os.preferences",
				ORG_1,
				'{"theme":"neon"}',
			);

		const result = await client(
			userContext(env, { organizationId: ORG_1 }),
		).getPreferences({});
		// `default` is the honest source — nothing usable is stored — but the
		// revision is still the row's, so the next save is a real CAS against it.
		expect(result).toMatchObject({
			preferences: DEFAULT_OS_USER_PREFERENCES,
			source: "default",
			revision: 3,
		});
		expect(storedRows(sqlite)).toHaveLength(1);
	});

	it("refuses a machine principal that resolves no Tedix user identity", async () => {
		await expect(
			client(apiKeyContext(env, ORG_1, ["apps:read"])).getPreferences({}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client(apiKeyContext(env, ORG_1, ["apps:read"])).updatePreferences({
				preferences: CUSTOM,
				expectedRevision: 0,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(storedRows(sqlite)).toHaveLength(0);
	});

	it("rejects an off-catalog conversational model ref at the contract boundary", async () => {
		await expect(
			client(userContext(env, { organizationId: ORG_1 })).updatePreferences({
				preferences: {
					...CUSTOM,
					conversationModelRef: "acme-labs/whatever",
				} as OsUserPreferences,
				expectedRevision: 0,
			}),
		).rejects.toBeTruthy();
		expect(storedRows(sqlite)).toHaveLength(0);
	});

	it("rejects an unresolvable timezone and a malformed locale", async () => {
		const c = client(userContext(env, { organizationId: ORG_1 }));
		await expect(
			c.updatePreferences({
				preferences: { ...CUSTOM, timezone: "Mars/Olympus" },
				expectedRevision: 0,
			}),
		).rejects.toBeTruthy();
		await expect(
			c.updatePreferences({
				preferences: { ...CUSTOM, locale: "not a locale" },
				expectedRevision: 0,
			}),
		).rejects.toBeTruthy();
		expect(storedRows(sqlite)).toHaveLength(0);
	});
});

describe("operational context", () => {
	let env: CloudflareEnv;
	let sqlite: DatabaseSync;
	beforeEach(() => {
		({ env, sqlite } = createEnv());
	});

	it("projects the credential's organization, not a hostname's", async () => {
		const result = await client(
			userContext(env, { organizationId: ORG_2 }),
		).getContext({});
		expect(result.organization).toEqual({
			id: ORG_2,
			name: "Second Org",
			slug: "second-org",
			type: "personal",
			descopeTenantId: "personal_second",
			logoUrl: null,
			appearance: null,
		});
	});

	it("projects only a valid published organization appearance", async () => {
		sqlite
			.prepare("UPDATE organizations SET metadata = ? WHERE id = ?")
			.run(JSON.stringify({ osTheme: DEFAULT_ORGANIZATION_OS_THEME }), ORG_1);
		const published = await client(
			userContext(env, { organizationId: ORG_1 }),
		).getContext({});
		expect(published.organization.appearance).toEqual(
			DEFAULT_ORGANIZATION_OS_THEME,
		);

		sqlite
			.prepare("UPDATE organizations SET metadata = ? WHERE id = ?")
			.run(
				JSON.stringify({ osTheme: { version: 1, css: "*{display:none}" } }),
				ORG_1,
			);
		const invalid = await client(
			userContext(env, { organizationId: ORG_1 }),
		).getContext({});
		expect(invalid.organization.appearance).toBeNull();
	});

	it("reports the caller's effective permissions, not the raw token claims", async () => {
		// `member` implies more than the token lists; the projection must match
		// what the guards actually admit, which is the union.
		const result = await client(
			userContext(env, {
				organizationId: ORG_1,
				permissions: ["apps:read"],
				role: "member",
			}),
		).getContext({});
		expect(result.authority.role).toBe("member");
		expect(result.authority.permissions).toContain("os:run");
		expect(result.authority.permissions).not.toContain("settings:manage");
		expect(result.authority.machineScopes).toEqual([]);
		expect(result.authority.crossTenantOverrideActive).toBe(false);
		const browserAuthorization = await client(
			userContext(env, {
				organizationId: ORG_1,
				permissions: ["apps:read"],
				role: "member",
			}),
		).getBrowserMcpAuthorization({});
		expect(browserAuthorization).toEqual({
			policyVersion: 1,
			scopes: expect.arrayContaining([
				"mcp:apps.read",
				"mcp:tedis.read",
				"mcp:work.read",
				"mcp:work.write",
			]),
		});
		expect(browserAuthorization.scopes).not.toContain("mcp:settings.read");
	});

	it("ignores token claims under a cross-tenant override", async () => {
		// The token's claims belong to a different tenant; only the membership
		// role may authorize, and the projection must say the same.
		const result = await client(
			userContext(env, {
				organizationId: ORG_1,
				permissions: ["settings:manage", "platform:admin"],
				role: "viewer",
				crossTenantOverrideActive: true,
			}),
		).getContext({});
		expect(result.authority.crossTenantOverrideActive).toBe(true);
		expect(result.authority.permissions).not.toContain("settings:manage");
		expect(result.authority.permissions).not.toContain("platform:admin");
		expect(result.authority.permissions).toEqual(
			expect.arrayContaining(["apps:read", "os:read"]),
		);
		const browserAuthorization = await client(
			userContext(env, {
				organizationId: ORG_1,
				permissions: ["settings:manage", "platform:admin"],
				role: "viewer",
				crossTenantOverrideActive: true,
			}),
		).getBrowserMcpAuthorization({});
		expect(browserAuthorization.scopes).toContain("mcp:work.read");
		expect(browserAuthorization.scopes).not.toContain("mcp:settings.read");
	});

	it("reports machine scopes on the machine plane and no permissions", async () => {
		const result = await client(
			apiKeyContext(env, ORG_1, ["apps:read", "tools:read"]),
		).getContext({});
		expect(result.authority.authType).toBe("apikey");
		expect(result.authority.permissions).toEqual([]);
		expect(result.authority.machineScopes).toEqual(["apps:read", "tools:read"]);
		expect(result.authority.role).toBeNull();
	});

	it("distinguishes an unauthored charter from one the caller may not read", async () => {
		seedActiveCharter(sqlite, ORG_1);

		const admin = await client(
			userContext(env, {
				organizationId: ORG_1,
				permissions: ["settings:manage"],
			}),
		).getContext({});
		expect(admin.purpose.access).toBe("granted");
		expect(admin.purpose.charter).toMatchObject({
			id: CHARTER_1,
			version: 2,
			status: "active",
			reviewCadenceDays: 30,
			// activatedAt 2026-08-01 + 30 days.
			reviewDueAt: "2026-08-31T00:00:00.000Z",
		});

		const member = await client(
			userContext(env, {
				organizationId: ORG_1,
				permissions: ["apps:read"],
				role: "member",
			}),
		).getContext({});
		expect(member.purpose).toEqual({ access: "restricted", charter: null });

		const emptyOrg = await client(
			userContext(env, {
				organizationId: ORG_2,
				permissions: ["settings:manage"],
			}),
		).getContext({});
		expect(emptyOrg.purpose).toEqual({ access: "granted", charter: null });
	});
});
