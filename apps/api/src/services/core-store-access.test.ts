import { DatabaseSync } from "node:sqlite";
import { createCoreStore } from "@tedix/db/core-store/client";
import { withCoreStore } from "@tedix/db/core-store/scope";
import { readAuthContextCacheVersion } from "@tedix/db/queries/auth-context-cache";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createPGliteFacade } from "@tedix/db/test/pglite-facade";
import { expect, it, vi } from "vite-plus/test";
import { createContext } from "../rpc/context";
import { invalidateIdentityCache } from "./identity-cache-invalidation";
import { reserveVoiceUsage } from "./voice-billing";
import {
	resolveFleetAuthorityDb,
	resolveFleetAuthorityBinding,
} from "../lib/fleet-authority";
import {
	organizationModelEnv,
	requireUnrestrictedModelEgress,
} from "./unrouted-model-egress";
import * as residency from "@tedix/db/queries/data-residency";
import * as gatingQueries from "@tedix/db/queries/app-gating";
import { checkAppEligibilityById } from "../lib/app-gating";

vi.mock("@tedix/db/core-store/client", async (original) => ({
	...(await original<typeof import("@tedix/db/core-store/client")>()),
	createCoreStore: vi.fn(),
}));

it.each(["d1", "postgres"] as const)(
	"uses the selected %s store for fleet access, model policy reads and logout invalidation",
	async (dialect) => {
		const ddl =
			"CREATE TABLE auth_context_cache_state (id integer PRIMARY KEY, version text NOT NULL); INSERT INTO auth_context_cache_state VALUES (1, 'before')";
		const sqlite = dialect === "d1" ? new DatabaseSync(":memory:") : undefined;
		const pg = dialect === "postgres" ? await createPGliteFacade() : undefined;
		const d1 = sqlite ? createD1Facade(sqlite) : undefined;
		if (sqlite) sqlite.exec(ddl);
		if (pg) await pg.engine.exec(ddl);
		const close = vi.fn(async () => {});
		if (pg) vi.mocked(createCoreStore).mockReturnValue({ db: pg.db, close });
		const env = {
			CORE_STORE: dialect,
			DB: d1 ?? {
				prepare() {
					throw new Error("D1 must not be queried");
				},
			},
			CORE_HYPERDRIVE: { connectionString: "postgres://unused" },
			TEDIX_FLEET_AUTHORITY_MODE: "co-located",
			ENVIRONMENT: "production",
		} as CloudflareEnv;
		try {
			await withCoreStore(env, async () => {
				const context = createContext(
					new Request("https://api.example.test/rpc/read", {
						headers: { "x-d1-bookmark": "caller-bookmark" },
					}),
					env,
				);
				expect(await readAuthContextCacheVersion(context.db)).toBe("before");
				expect(
					await readAuthContextCacheVersion(resolveFleetAuthorityDb(env)),
				).toBe("before");
				if (pg) expect(() => resolveFleetAuthorityBinding(env)).toThrow();
				const gating = vi
					.spyOn(gatingQueries, "getAppGatingMetadata")
					.mockImplementation(async (db) => {
						expect(await readAuthContextCacheVersion(db)).toBe("before");
						return undefined;
					});
				const tools = vi
					.spyOn(gatingQueries, "getEnabledToolIdsForApp")
					.mockResolvedValue(["example-tool"]);
				try {
					await expect(
						checkAppEligibilityById(env.DB, "app-example", "org-example"),
					).resolves.toMatchObject({
						eligible: true,
						availableTools: ["example-tool"],
					});
				} finally {
					gating.mockRestore();
					tools.mockRestore();
				}
				const policy = vi
					.spyOn(residency, "getOrganizationResidencyPolicy")
					.mockImplementation(async (db) => {
						expect(await readAuthContextCacheVersion(db as never)).toBe(
							"before",
						);
						return {
							organizationId: "org-example",
							mode: "eu",
							revision: 1,
							updatedAt: "2026-11-27T00:00:00Z",
							updatedBy: "user-example",
						};
					});
				try {
					const send = vi.fn();
					const scoped = organizationModelEnv(
						{ ...env, AI: { run: send } },
						{} as never,
						"org-example",
					);
					await expect(scoped.AI.run()).rejects.toThrow(
						"EU_PROVIDER_ROUTE_REQUIRED",
					);
					// Callers still passing a raw D1 binding must use the scoped Postgres client.
					await expect(
						requireUnrestrictedModelEgress(
							{} as never,
							"org-example",
							"PDF conversion",
							env.DB,
						),
					).rejects.toThrow("EU_PROVIDER_ROUTE_REQUIRED");
					expect(send).not.toHaveBeenCalled();
				} finally {
					policy.mockRestore();
				}
				const response = await invalidateIdentityCache(
					new Request("https://api.example.test/logout", { method: "POST" }),
					env,
				);
				expect(response.status).toBe(204);
				expect(await readAuthContextCacheVersion(context.db)).not.toBe(
					"before",
				);
				if (pg) {
					expect(context.db).toBe(pg.db);
					expect(context.dbBookmark?.()).toBeNull();
					expect(context.dbMetrics).toBeUndefined();
				}
			});
			if (pg) expect(close).toHaveBeenCalledOnce();
		} finally {
			sqlite?.close();
			await pg?.close();
		}
	},
);

it.each(["d1", "postgres"] as const)(
	"checks voice pricing on the selected %s store without a D1 fallback",
	async (dialect) => {
		const ddl = `CREATE TABLE provider_model_rate_versions (
			id text PRIMARY KEY, provider text, model_id text, deployment_scope text,
			input_token_min integer, input_token_max integer, effective_from text,
			input_microusd_per_million integer, output_microusd_per_million integer,
			cache_read_microusd_per_million integer, cache_write_microusd_per_million integer,
			currency text, evidence_uri text, evidence_digest text, verified_at text,
			published_at text, published_by text, change_reason text, supersedes_rate_version_id text
		)`;
		const sqlite = dialect === "d1" ? new DatabaseSync(":memory:") : undefined;
		const pg = dialect === "postgres" ? await createPGliteFacade() : undefined;
		if (sqlite) sqlite.exec(ddl);
		if (pg) await pg.engine.exec(ddl);
		if (pg)
			vi.mocked(createCoreStore).mockReturnValue({
				db: pg.db,
				close: async () => {},
			});
		const env = {
			CORE_STORE: dialect,
			DB: sqlite ? createD1Facade(sqlite) : undefined,
			TEDIX_BILLING_SETTLEMENT_MODE: "managed",
		};
		try {
			await withCoreStore(env, async () => {
				await expect(
					reserveVoiceUsage(
						env,
						{ organizationId: "org-example", source: "kernel" },
						{
							provider: "azure-openai",
							model: "gpt-transcribe",
							deploymentScope: "example-scope",
							usageKind: "voice_stt",
							unit: "seconds",
							estimatedQuantity: 120,
						},
						"2026-07-27T12:00:00.000Z",
					),
				).rejects.toMatchObject({ code: "pricing_unavailable" });
			});
		} finally {
			sqlite?.close();
			await pg?.close();
		}
	},
);
