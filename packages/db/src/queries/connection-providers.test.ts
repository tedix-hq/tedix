import { describe, expect, it, vi } from "vite-plus/test";
import type { DbClient } from "../client";
import type { ConnectionProviderRow } from "../schema/connection-providers";
import {
	applyConnectionCredentialTemplate,
	buildConnectionProviderMaps,
	getConnectionProviderByDescopeAppId,
	getConnectionProviderById,
	getConnectionProviderIssuerPin,
	listConnectionProviders,
	listConnectionProvidersByCategory,
	listConnectionProvidersByType,
	pinConnectionProviderIssuer,
} from "./connection-providers";

/**
 * Minimal drizzle double: `select().from()[.where()].orderBy()`/`.limit()`
 * resolves to `rows` on the terminal clause. Every query in
 * connection-providers.ts ends in `.orderBy(...)` or `.limit(...)`, so the
 * chain never needs to resolve off a bare `.from()`/`.where()`. Mirrors the
 * pattern in tedis-runtime-meta.test.ts.
 */
function makeDb(rows: ConnectionProviderRow[]): {
	db: DbClient;
	select: ReturnType<typeof vi.fn>;
} {
	const node = {
		from: () => node,
		where: () => node,
		orderBy: () => Promise.resolve(rows),
		limit: () => Promise.resolve(rows),
	};
	const select = vi.fn(() => node);
	return { db: { select } as unknown as DbClient, select };
}

function row(overrides: Partial<ConnectionProviderRow>): ConnectionProviderRow {
	return {
		id: "example",
		name: "Example",
		description: "An example provider",
		icon: "https://example.com/favicon.ico",
		category: "development",
		type: "oauth",
		descopeAppId: null,
		descopeAppAliases: null,
		sortOrder: 0,
		recommendedScope: "user",
		supportedScopes: ["tenant", "user"],
		requiredScopes: [],
		credentialProfile: null,
		oauthConfig: null,
		pinnedIssuer: null,
		authorizationResponseIssSupported: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("listConnectionProviders", () => {
	it("normalizes null DB columns to undefined on the returned template", async () => {
		const { db } = makeDb([
			row({ id: "google-gmail", descopeAppId: "google-gmail" }),
		]);
		const [gmail] = await listConnectionProviders(db);
		expect(gmail).toMatchObject({
			id: "google-gmail",
			descopeAppId: "google-gmail",
		});
		expect(gmail?.descopeAppAliases).toBeUndefined();
		expect(gmail?.credentialProfile).toBeUndefined();
		expect(gmail?.oauthConfig).toBeUndefined();
		expect(gmail).not.toHaveProperty("sortOrder");
		expect(gmail).not.toHaveProperty("createdAt");
	});
});

describe("getConnectionProviderById", () => {
	it("returns undefined when no row matches", async () => {
		const { db } = makeDb([]);
		expect(await getConnectionProviderById(db, "unknown")).toBeUndefined();
	});

	it("returns the matching row mapped to a template", async () => {
		const { db } = makeDb([row({ id: "github" })]);
		expect(await getConnectionProviderById(db, "github")).toMatchObject({
			id: "github",
		});
	});
});

describe("getConnectionProviderByDescopeAppId", () => {
	it("matches a row's primary descopeAppId", async () => {
		const { db } = makeDb([
			row({ id: "promptwatch-api-key", descopeAppId: "promptwatch-api-key" }),
		]);
		expect(
			await getConnectionProviderByDescopeAppId(db, "promptwatch-api-key"),
		).toMatchObject({
			id: "promptwatch-api-key",
		});
	});

	it("resolves through a descopeAppAlias to the owning provider", async () => {
		const { db } = makeDb([
			row({
				id: "promptwatch-api-key",
				descopeAppId: "promptwatch-api-key",
				descopeAppAliases: ["promptwatch-acme", "promptwatch-globex"],
				credentialProfile: { tokenTemplate: "{apiKey}" },
			}),
		]);
		const viaAlias = await getConnectionProviderByDescopeAppId(
			db,
			"promptwatch-acme",
		);
		expect(viaAlias?.id).toBe("promptwatch-api-key");
		expect(viaAlias?.credentialProfile?.tokenTemplate).toBe("{apiKey}");
	});

	it("does not infer providers from unrelated ids", async () => {
		const { db } = makeDb([row({ id: "github", descopeAppId: "github" })]);
		expect(
			await getConnectionProviderByDescopeAppId(db, "unregistered-project-id"),
		).toBeUndefined();
	});
});

describe("listConnectionProvidersByCategory / listConnectionProvidersByType", () => {
	it("filters by category", async () => {
		const { db, select } = makeDb([
			row({ id: "google-analytics", category: "analytics" }),
		]);
		const results = await listConnectionProvidersByCategory(db, "analytics");
		expect(results).toHaveLength(1);
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("filters by type", async () => {
		const { db } = makeDb([row({ id: "nosana-api-key", type: "api_key" })]);
		const results = await listConnectionProvidersByType(db, "api_key");
		expect(results).toEqual([
			expect.objectContaining({ id: "nosana-api-key", type: "api_key" }),
		]);
	});
});

describe("buildConnectionProviderMaps", () => {
	it("indexes by id and by descopeAppId, including aliases", () => {
		const providers = [
			{
				id: "promptwatch-api-key",
				name: "PromptWatch",
				description: "",
				icon: "",
				category: "analytics" as const,
				type: "api_key" as const,
				requiredScopes: [],
				supportedScopes: ["tenant" as const],
				recommendedScope: "tenant" as const,
				descopeAppId: "promptwatch-api-key",
				descopeAppAliases: ["promptwatch-acme"],
			},
		];
		const { byId, byDescopeAppId } = buildConnectionProviderMaps(providers);
		expect(byId.get("promptwatch-api-key")).toBe(providers[0]);
		expect(byDescopeAppId.get("promptwatch-api-key")).toBe(providers[0]);
		expect(byDescopeAppId.get("promptwatch-acme")).toBe(providers[0]);
		expect(byDescopeAppId.has("nonexistent")).toBe(false);
	});

	it("skips providers with no descopeAppId in the descopeAppId map", () => {
		const providers = [
			{
				id: "unregistered-template",
				name: "Unregistered",
				description: "",
				icon: "",
				category: "development" as const,
				type: "oauth" as const,
				requiredScopes: [],
				supportedScopes: ["user" as const],
				recommendedScope: "user" as const,
			},
		];
		const { byId, byDescopeAppId } = buildConnectionProviderMaps(providers);
		expect(byId.get("unregistered-template")).toBe(providers[0]);
		expect(byDescopeAppId.size).toBe(0);
	});
});

describe("issuer pinning (ADR tedi-client-oauth-cimd phase 1a)", () => {
	it("surfaces pin columns on the mapped template", async () => {
		const { db } = makeDb([
			row({
				id: "linear",
				pinnedIssuer: "https://auth.linear.app",
				authorizationResponseIssSupported: true,
			}),
		]);
		const [linear] = await listConnectionProviders(db);
		expect(linear?.pinnedIssuer).toBe("https://auth.linear.app");
		expect(linear?.authorizationResponseIssSupported).toBe(true);
	});

	it("maps legacy NULL pin columns to undefined on the template", async () => {
		const { db } = makeDb([row({ id: "github" })]);
		const [github] = await listConnectionProviders(db);
		expect(github?.pinnedIssuer).toBeUndefined();
		expect(github?.authorizationResponseIssSupported).toBeUndefined();
	});

	describe("getConnectionProviderIssuerPin", () => {
		it("returns undefined when the provider has no row at all", async () => {
			const { db } = makeDb([]);
			expect(await getConnectionProviderIssuerPin(db, "linear")).toBe(
				undefined,
			);
		});

		it("returns null pin values for a legacy row that predates pinning", async () => {
			const { db } = makeDb([row({ id: "github" })]);
			expect(await getConnectionProviderIssuerPin(db, "github")).toMatchObject({
				pinnedIssuer: null,
				authorizationResponseIssSupported: null,
			});
		});

		it("returns the recorded pin", async () => {
			const { db } = makeDb([
				row({
					id: "linear",
					pinnedIssuer: "https://auth.linear.app",
					authorizationResponseIssSupported: false,
				}),
			]);
			expect(await getConnectionProviderIssuerPin(db, "linear")).toMatchObject({
				pinnedIssuer: "https://auth.linear.app",
				authorizationResponseIssSupported: false,
			});
		});
	});

	describe("pinConnectionProviderIssuer", () => {
		/** Insert-capable double: captures `.values(...)` and the upsert clause. */
		function makeInsertDb() {
			const captured: {
				values?: Record<string, unknown>;
				onConflict?: { target: unknown; set: Record<string, unknown> };
			} = {};
			const insert = vi.fn(() => ({
				values: (values: Record<string, unknown>) => {
					captured.values = values;
					return {
						onConflictDoUpdate: (clause: {
							target: unknown;
							set: Record<string, unknown>;
						}) => {
							captured.onConflict = clause;
							return Promise.resolve();
						},
					};
				},
			}));
			return { db: { insert } as unknown as DbClient, captured, insert };
		}

		it("first discovery inserts a minimal row carrying the pin, with behavior-preserving scope defaults", async () => {
			const { db, captured, insert } = makeInsertDb();
			await pinConnectionProviderIssuer(db, {
				id: "linear",
				issuer: "https://auth.linear.app",
				authorizationResponseIssSupported: true,
				name: "Linear",
				description: "Linear MCP",
				icon: "https://linear.app/favicon.ico",
			});
			expect(insert).toHaveBeenCalledTimes(1);
			expect(captured.values).toMatchObject({
				id: "linear",
				name: "Linear",
				type: "oauth",
				pinnedIssuer: "https://auth.linear.app",
				authorizationResponseIssSupported: true,
				// Must mirror the template-less fallbacks in apps/api so creating
				// the decoration row does not change scope behavior.
				recommendedScope: "user",
				supportedScopes: ["tenant", "user"],
			});
		});

		it("rescan updates only the pin columns on conflict", async () => {
			const { db, captured } = makeInsertDb();
			await pinConnectionProviderIssuer(db, {
				id: "linear",
				issuer: "https://auth.linear.app",
				authorizationResponseIssSupported: true,
				name: "Linear",
			});
			const set = captured.onConflict?.set ?? {};
			expect(Object.keys(set).sort()).toEqual([
				"authorizationResponseIssSupported",
				"pinnedIssuer",
				"updatedAt",
			]);
			expect(set.pinnedIssuer).toBe("https://auth.linear.app");
			expect(set.authorizationResponseIssSupported).toBe(true);
		});

		it("never downgrades the RFC 9207 support flag on update (ratchet)", async () => {
			const { db, captured } = makeInsertDb();
			await pinConnectionProviderIssuer(db, {
				id: "linear",
				issuer: "https://auth.linear.app",
				authorizationResponseIssSupported: false,
				name: "Linear",
			});
			// A `false` rediscovery must not overwrite a stored `true` — the update
			// value is a COALESCE(existing, 0) SQL expression, not a literal false.
			expect(
				captured.onConflict?.set.authorizationResponseIssSupported,
			).not.toBe(false);
			expect(
				captured.onConflict?.set.authorizationResponseIssSupported,
			).not.toBe(true);
		});
	});
});

describe("applyConnectionCredentialTemplate", () => {
	it("composes a compound opaque token from collected fields", () => {
		expect(
			applyConnectionCredentialTemplate("{projectId}:{managementKey}", {
				projectId: "P123",
				managementKey: "K456",
			}),
		).toBe("P123:K456");
	});

	it("trims field values before substitution", () => {
		expect(
			applyConnectionCredentialTemplate("{apiKey}", { apiKey: "  secret  " }),
		).toBe("secret");
	});

	it("throws when a referenced field is missing", () => {
		expect(() => applyConnectionCredentialTemplate("{apiKey}", {})).toThrow(
			"Missing credential field: apiKey",
		);
	});
});
