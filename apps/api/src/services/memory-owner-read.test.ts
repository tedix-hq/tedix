import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { tenantStoreMigrations } from "../../../../packages/db/src/tenant-store/migrations";
import { executeMemoryQuery } from "@tedix/db/queries/memory-graph/tenant-rpc";
import { FactSchema } from "@tedix/api-contract/schemas/memory-graph";
import type { BaseContext } from "../rpc/orpc";
import { readOwnedMemory } from "./memory-owner-read";

const mocks = vi.hoisted(() => ({ workspace: vi.fn(), visible: vi.fn() }));
vi.mock("@tedix/db/queries/os-workspaces/workspaces", () => ({
	getOsWorkspace: mocks.workspace,
}));
vi.mock("./os-workspace-visibility", () => ({
	assertOsWorkspaceVisible: mocks.visible,
}));

const organizationId = "fictional-orchard";
const owner = { kind: "organization", organizationId } as const;
const query = {
	operation: "hydrateRecall",
	input: {
		factIds: [
			"public",
			"private-a",
			"private-b",
			"restricted",
			"blocked",
			"foreign",
		],
	},
} as const;
const context = (overrides: Partial<BaseContext> = {}): BaseContext =>
	({
		authType: "tedi",
		organizationId,
		tediId: "a",
		tediScopes: ["mcp:memory.read"],
		headers: new Headers(),
		env: {},
		...overrides,
	}) as BaseContext;
const runtime = { ownedMemory: vi.fn() };
const config = { plane: "runtime", runtime } as const;

beforeEach(() => {
	runtime.ownedMemory.mockReset().mockResolvedValue([]);
	mocks.workspace.mockReset();
	mocks.visible.mockReset().mockResolvedValue(undefined);
});

describe("verified memory reader routing", () => {
	it("binds a tedi and organization independently of workspace membership and request identity", async () => {
		await readOwnedMemory(context(), config, owner, {
			operation: "hydrateRecall",
			input: { factIds: ["private-a"], tediId: "b" },
		});
		expect(runtime.ownedMemory).toHaveBeenCalledWith(
			owner,
			{ organizationId, principalId: "tedi:a", workspaceIds: [] },
			{
				operation: "hydrateRecall",
				input: { factIds: ["private-a"], tediId: "a" },
			},
		);
		expect(mocks.workspace).not.toHaveBeenCalled();
	});
	it("keeps external-agent identity separate from human provenance and forwarded tedi hints", async () => {
		await readOwnedMemory(
			context({
				authType: "service-binding",
				externalAgentPrincipalId: "agent",
				externalAgentSessionId: "session",
				externalAgentClientRecordId: "client",
				gatewayEndUserId: "owner",
			}),
			config,
			owner,
			{ operation: "hydrateRecall", input: { factIds: [], tediId: "b" } },
		);
		expect(runtime.ownedMemory).toHaveBeenCalledWith(
			owner,
			expect.objectContaining({ principalId: "external-agent:agent" }),
			{ operation: "hydrateRecall", input: { factIds: [], tediId: undefined } },
		);
	});
	it("preserves authenticated M2M org reads while requiring a canonical identity for new scopes", async () => {
		const caller = context({
			authType: "m2m",
			serviceAccount: { clientId: "client-a", scope: "mcp:memory.read" },
		});
		await readOwnedMemory(caller, config, owner, {
			operation: "fallbackRecall",
			input: { tediId: "b" },
		});
		expect(runtime.ownedMemory).toHaveBeenCalledWith(
			owner,
			expect.objectContaining({ principalId: "m2m:client-a" }),
			{ operation: "fallbackRecall", input: { tediId: undefined } },
		);
		await expect(
			readOwnedMemory(
				caller,
				config,
				{ kind: "personal", organizationId, principalId: "m2m:client-a" },
				{ operation: "fallbackRecall", input: {} },
			),
		).rejects.toThrow("canonical service principal");
		await expect(
			readOwnedMemory(
				caller,
				config,
				{ kind: "workspace", organizationId, workspaceId: "ws" },
				{ operation: "fallbackRecall", input: {} },
			),
		).rejects.toThrow("canonical service principal");
		expect(mocks.workspace).not.toHaveBeenCalled();
		expect(runtime.ownedMemory).toHaveBeenCalledTimes(1);
		await readOwnedMemory(
			context({
				...caller,
				serviceAccount: {
					...caller.serviceAccount!,
					canonicalPrincipalId: "service-a",
				},
			}),
			config,
			{ kind: "personal", organizationId, principalId: "service:service-a" },
			{ operation: "fallbackRecall", input: {} },
		);
		expect(runtime.ownedMemory).toHaveBeenCalledTimes(2);
	});
	it.each([
		{ authType: "tedi", tediId: undefined },
		{
			authType: "service-binding",
			tediId: undefined,
			descopeUserId: "owner",
			gatewayEndUserId: "owner",
		},
		{
			authType: "service-binding",
			externalAgentPrincipalId: "agent",
			externalAgentSessionId: undefined,
		},
		{
			authType: "apikey",
			apiKey: {
				id: "key",
				organizationId: "foreign",
				name: "test",
				scopes: ["mcp:memory.read"],
			},
		},
	] satisfies Partial<BaseContext>[])(
		"rejects unresolved or foreign credential identity before storage: %j",
		async (overrides) => {
			await expect(
				readOwnedMemory(context(overrides), config, owner, {
					operation: "hydrateRecall",
					input: { factIds: [] },
				}),
			).rejects.toThrow();
			expect(runtime.ownedMemory).not.toHaveBeenCalled();
		},
	);
	it("does not treat forwarded identity headers as authority", async () => {
		await expect(
			readOwnedMemory(
				context({
					tediId: undefined,
					headers: new Headers({
						"X-Tedix-Tedi-Id": "a",
						"X-Tedix-Acting-User": "owner",
					}),
				}),
				config,
				owner,
				{ operation: "fallbackRecall", input: {} },
			),
		).rejects.toThrow("identity");
		expect(runtime.ownedMemory).not.toHaveBeenCalled();
	});
	it.each([
		"createFact",
		"updateFact",
		"getFact",
		"topicFacts",
		"citationDependents",
		"recordRecallAccess",
	])("rejects unsupported operation %s before storage", async (operation) => {
		await expect(
			readOwnedMemory(context(), config, owner, {
				operation,
				input: {},
			} as never),
		).rejects.toThrow("Unsupported memory read operation");
		expect(runtime.ownedMemory).not.toHaveBeenCalled();
	});
	it("requires read scopes even for a verified identity", async () => {
		await expect(
			readOwnedMemory(
				context({ tediScopes: ["mcp:memory.write"] }),
				config,
				owner,
				{ operation: "fallbackRecall", input: {} },
			),
		).rejects.toThrow("permission");
		expect(runtime.ownedMemory).not.toHaveBeenCalled();
	});
	it("requires user RBAC and respects narrower OIDC scopes", async () => {
		const user = {
			sub: "member",
			permissions: ["tedis:read"],
			roles: [],
		} as NonNullable<BaseContext["user"]>;
		await expect(
			readOwnedMemory(
				context({ authType: "user", user, oidcScopes: [] }),
				config,
				owner,
				{ operation: "fallbackRecall", input: {} },
			),
		).rejects.toThrow("permission");
		await expect(
			readOwnedMemory(
				context({ authType: "user", user: { ...user, permissions: [] } }),
				config,
				owner,
				{ operation: "fallbackRecall", input: {} },
			),
		).rejects.toThrow("permission");
		expect(runtime.ownedMemory).not.toHaveBeenCalled();
	});
	it("denies foreign owners before reading workspace state", async () => {
		await expect(
			readOwnedMemory(
				context(),
				config,
				{ kind: "workspace", organizationId: "foreign", workspaceId: "ws" },
				{ operation: "fallbackRecall", input: {} },
			),
		).rejects.toThrow("authenticated organization");
		expect(mocks.workspace).not.toHaveBeenCalled();
		expect(runtime.ownedMemory).not.toHaveBeenCalled();
	});
	it("uses live workspace visibility on every call and honors revocation", async () => {
		const scoped = {
			kind: "workspace",
			organizationId,
			workspaceId: "ws",
		} as const;
		const workspace = {
			id: "ws",
			organizationId,
			status: "active",
			visibility: "private",
			ownerUserId: "member",
		};
		mocks.workspace.mockResolvedValue(workspace);
		await readOwnedMemory(context(), config, scoped, {
			operation: "fallbackRecall",
			input: {},
		});
		expect(mocks.workspace).toHaveBeenCalledWith(undefined, {
			organizationId,
			workspaceId: "ws",
		});
		expect(mocks.visible).toHaveBeenCalledWith(expect.anything(), workspace);
		expect(runtime.ownedMemory).toHaveBeenCalledWith(
			scoped,
			expect.objectContaining({ workspaceIds: ["ws"] }),
			expect.anything(),
		);
		mocks.visible.mockRejectedValue(new Error("access revoked"));
		await expect(
			readOwnedMemory(context(), config, scoped, {
				operation: "fallbackRecall",
				input: {},
			}),
		).rejects.toThrow("access revoked");
		expect(runtime.ownedMemory).toHaveBeenCalledTimes(1);
	});
	it("requires active workspace state", async () => {
		mocks.workspace.mockResolvedValue({ id: "ws", status: "archived" });
		await expect(
			readOwnedMemory(
				context(),
				config,
				{ kind: "workspace", organizationId, workspaceId: "ws" },
				{ operation: "fallbackRecall", input: {} },
			),
		).rejects.toThrow("Active memory workspace");
		expect(runtime.ownedMemory).not.toHaveBeenCalled();
	});
	it("binds personal ownership to the verified principal and never falls back to org D1", async () => {
		await readOwnedMemory(
			context(),
			config,
			{ kind: "personal", organizationId, principalId: "tedi:a" },
			{ operation: "fallbackRecall", input: {} },
		);
		await expect(
			readOwnedMemory(
				context(),
				config,
				{ kind: "personal", organizationId, principalId: "tedi:b" },
				{ operation: "fallbackRecall", input: {} },
			),
		).rejects.toThrow("another principal");
		await expect(
			readOwnedMemory(
				context(),
				{ plane: "platform-d1", db: {} as BaseContext["db"] },
				{ kind: "personal", organizationId, principalId: "tedi:a" },
				{ operation: "fallbackRecall", input: {} },
			),
		).rejects.toThrow("owner-partitioned");
		expect(runtime.ownedMemory).toHaveBeenCalledTimes(1);
	});
});

describe("gateway policy parity on migrated source and tenant SQLite", () => {
	let source: DatabaseSync;
	let tenant: DatabaseSync;
	beforeAll(() => {
		source = createMigratedSqlite();
		for (const id of [organizationId, "other"])
			source
				.prepare("INSERT INTO organizations(id,name,slug) VALUES (?,?,?)")
				.run(id, id, id);
		for (const id of ["a", "b"])
			source
				.prepare(
					"INSERT INTO tedis(id,organization_id,name,slug) VALUES (?,?,?,?)",
				)
				.run(id, organizationId, id, id);
		tenant = new DatabaseSync(":memory:");
		for (const migration of Object.values(tenantStoreMigrations))
			tenant.exec(migration);
		tenant
			.prepare(
				"INSERT INTO memory_store_identity VALUES (1,?,'organization',?,'2026-11-08')",
			)
			.run(organizationId, organizationId);
		for (const db of [source, tenant]) {
			for (const [id, org, tedi, visibility, review, policy] of [
				[
					"public",
					organizationId,
					null,
					"org",
					"confirmed",
					"can_use_as_evidence",
				],
				[
					"private-a",
					organizationId,
					"a",
					"private",
					"confirmed",
					"requires_user_confirmation",
				],
				[
					"private-b",
					organizationId,
					"b",
					"private",
					"confirmed",
					"can_use_as_evidence",
				],
				[
					"restricted",
					organizationId,
					"a",
					"org",
					"restricted",
					"can_use_as_evidence",
				],
				[
					"blocked",
					organizationId,
					"a",
					"org",
					"confirmed",
					"do_not_inject_automatically",
				],
				["foreign", "other", "a", "org", "confirmed", "can_use_as_evidence"],
			]) {
				const insert = () =>
					db
						.prepare(
							"INSERT INTO memory_facts(id,organization_id,tedi_id,visibility,review_status,use_policy,content,fact_type,confidence,valid_from,created_at,updated_at) VALUES (?,?,?,?,?,?,'Cobalt PO-4471 inventory on November 3','technical',0.9,'2026-11-03T09:00:00Z','2026-08-03T09:00:00Z','2026-11-03T09:00:00Z')",
						)
						.run(id, org, tedi, visibility, review, policy);
				if (db === tenant && org !== organizationId)
					expect(insert).toThrow("outside this workspace");
				else insert();
			}
		}
	});
	afterAll(() => tenant?.close());
	it.each(["a", "b", undefined])(
		"preserves principal %s visibility and policies through hydration and recall",
		async (tediId) => {
			const sourceDb = createDbClient(createD1Facade(source));
			const tenantDb = createDbClient(createD1Facade(tenant));
			const caller = tediId
				? context({ tediId, db: sourceDb })
				: context({
						authType: "apikey",
						tediId: undefined,
						db: sourceDb,
						apiKey: {
							id: "reader",
							name: "test",
							organizationId,
							scopes: ["mcp:memory.read"],
						},
					});
			// Execute the runtime port against the real TenantStore schema; the transport itself is tested in workerd.
			runtime.ownedMemory.mockImplementation((_owner, _access, bound) =>
				executeMemoryQuery(
					{ db: tenantDb, auditDb: tenantDb.$client },
					{ organizationId },
					bound,
				),
			);
			const browseRequest = {
				operation: "browse",
				input: { view: "stale", orderBy: "updated", limit: 20, offset: 0 },
			} as const;
			const browsed = await readOwnedMemory(
				caller,
				{ plane: "platform-d1", db: sourceDb },
				owner,
				browseRequest,
			);
			expect(
				await readOwnedMemory(caller, config, owner, browseRequest),
			).toEqual(browsed);
			const { browse } =
				await import("../rpc/routers/memory-graph/observations");
			const publicCaller = tediId
				? context({
						authType: undefined,
						tediId: undefined,
						tediScopes: undefined,
						db: sourceDb,
						headers: new Headers({
							"X-Service-Binding": "true",
							"X-Tedix-Tedi-Id": tediId,
							"X-Tedix-Tedi-Scopes": "mcp:memory.read",
						}),
					})
				: caller;
			const publicResult = await createRouterClient(
				{ browse },
				{ context: publicCaller },
			).browse({ view: "stale" });
			expect(publicResult.facts.map((fact) => fact.id)).toEqual(
				browsed.facts.map((fact) => fact.id),
			);
			expect(publicResult.facts.map((fact) => fact.id).sort()).toEqual(
				[
					"public",
					"restricted",
					"blocked",
					...(tediId ? [`private-${tediId}`] : []),
				].sort(),
			);
			expect(
				publicResult.facts.find((fact) => fact.id === "blocked")?.usePolicy,
			).toBe("do_not_inject_automatically");
			for (const fact of publicResult.facts)
				expect(FactSchema.safeParse(fact).success).toBe(true);
			const requests = [
				{
					operation: "hydrateRecall",
					input: { factIds: [...query.input.factIds], tediId: "forged" },
				},
				{
					operation: "lexicalRecall",
					input: { query: "Cobalt inventory", tediId: "forged" },
				},
				{
					operation: "lexicalRecall",
					input: { query: "PO-4471", tediId: "forged" },
				},
				{
					operation: "temporalRecall",
					input: { query: "November 3", tediId: "forged" },
				},
				{ operation: "fallbackRecall", input: { tediId: "forged" } },
			] as const;
			for (const request of requests) {
				const timed = {
					...request,
					input: { ...request.input, now: "2026-11-08T12:00:00Z" },
				};
				const before = await readOwnedMemory(
					caller,
					{ plane: "platform-d1", db: sourceDb },
					owner,
					timed,
				);
				const after = await readOwnedMemory(caller, config, owner, timed);
				expect(after).toEqual(before);
				const ids = after.map((row) => ("factId" in row ? row.factId : row.id));
				expect(ids).toContain("public");
				expect(ids).not.toContain("foreign");
				expect(ids).not.toContain("restricted");
				expect(ids).not.toContain("blocked");
				expect(ids.includes("private-a")).toBe(tediId === "a");
				expect(ids.includes("private-b")).toBe(tediId === "b");
				if (request.operation === "hydrateRecall")
					for (const fact of after)
						expect(FactSchema.safeParse(fact).success).toBe(true);
			}
		},
	);
});
