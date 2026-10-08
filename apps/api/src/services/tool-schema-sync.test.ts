import {
	resolveMcpToolRequiredScopes,
	isMcpToolVisibleToCaller,
} from "@tedix/mcp-shared/auth/tool-scopes";
import { skillsContract } from "@tedix/api-contract/contracts/cognitive";
import {
	listContractEndpoints,
	resolveContractEndpoint,
} from "@tedix/api-contract/utils/contract-routers";
import { procedureOutputSchema } from "@tedix/api-contract/utils/procedure-schemas";
import { zodToStructuredOutputJsonSchema } from "@tedix/api-contract/utils/tool-json-schema";
import * as toolJsonSchema from "@tedix/api-contract/utils/tool-json-schema";
import type { DbClient } from "@tedix/db/client";
import type { AppTool } from "@tedix/db/schema";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	runToolSchemaSync,
	OS_TOOL_ID_OVERRIDES,
	WORK_HIERARCHY_TOOL_ID_OVERRIDES,
	OS_KIND_OVERRIDES,
} from "./tool-schema-sync";

const TEST_ADMIN_APP_ID = "5eed0020-0000-4000-8000-000000000020";

function makeRpcTool(
	overrides: Partial<AppTool> & {
		toolId: string;
		endpoint: string;
		config?: Record<string, unknown>;
	},
): AppTool {
	return {
		...overrides,
		id: overrides.id ?? `tool-${overrides.toolId}`,
		appId: overrides.appId ?? TEST_ADMIN_APP_ID,
		toolId: overrides.toolId,
		title: overrides.title ?? overrides.toolId,
		toolTypeId: "rpc",
		inputSchema:
			overrides.inputSchema ??
			({
				type: "object",
				properties: {},
				additionalProperties: false,
			} as AppTool["inputSchema"]),
		outputSchema: overrides.outputSchema ?? null,
		config: {
			transport: "rpc",
			endpoint: overrides.endpoint,
			...overrides.config,
		},
	} as AppTool;
}

function makeDb(rows: AppTool[]) {
	const updates: Array<{ id: string; patch: Partial<AppTool> }> = [];
	const inserts: AppTool[] = [];
	const deletes: string[] = [];
	let selectedRows = rows;
	const store = [...rows];

	const db = {
		select: () => ({
			from: () => ({
				where: () => ({
					orderBy: async () => selectedRows,
				}),
			}),
		}),
		// `upsertTool` reaches through db.query for id/unique-constraint lookups;
		// the sync resolves the admin app by slug through the same surface.
		query: {
			apps: {
				findFirst: async () => ({ id: TEST_ADMIN_APP_ID, slug: "tedix" }),
			},
			appTools: {
				findFirst: async ({
					where,
				}: {
					where: { id?: string; appId?: string; toolId?: string };
				}) => {
					if (where.id) return store.find((row) => row.id === where.id);
					if (where.appId && where.toolId) {
						return store.find(
							(row) => row.appId === where.appId && row.toolId === where.toolId,
						);
					}
					return undefined;
				},
			},
		},
		insert: () => ({
			values: async (value: AppTool) => {
				inserts.push(value);
				store.push(value);
				selectedRows = [...selectedRows, value];
			},
		}),
		delete: () => ({
			where: async () => {
				const row = store[deletes.length];
				if (!row) return;
				deletes.push(row.id);
				const keep = (item: AppTool) => item.id !== row.id;
				selectedRows = selectedRows.filter(keep);
				const index = store.findIndex((item) => item.id === row.id);
				if (index >= 0) store.splice(index, 1);
			},
		}),
		update: () => ({
			set: (patch: Partial<AppTool>) => ({
				where: async (where: { queryChunks: Array<{ value?: unknown }> }) => {
					const rowId = where.queryChunks.find((chunk) =>
						store.some((row) => row.id === chunk.value),
					)?.value;
					const endpoint = (patch.config as Record<string, unknown> | undefined)
						?.endpoint;
					const row =
						store.find((candidate) => {
							if (rowId !== undefined) return rowId === candidate.id;
							if (patch.id && candidate.id === patch.id) return true;
							const config = candidate.config as Record<string, unknown> | null;
							return (
								typeof endpoint === "string" && config?.endpoint === endpoint
							);
						}) ?? store[updates.length];
					updates.push({ id: row.id, patch });
					const apply = (item: AppTool) =>
						item.id === row.id ? ({ ...item, ...patch } as AppTool) : item;
					selectedRows = selectedRows.map(apply);
					for (let i = 0; i < store.length; i++) store[i] = apply(store[i]!);
				},
			}),
		}),
	};

	return { db: db as unknown as DbClient, updates, inserts, deletes, store };
}

describe("schema-only provenance refresh", () => {
	async function synchronizedTool() {
		const fixture = makeDb([
			makeRpcTool({
				toolId: "get_tedis_status",
				endpoint: "tedis/getStatus",
				config: { nativeDirect: true, responsePath: "json" },
				authRequired: true,
				visibility: "private",
				annotations: { readOnlyHint: true },
				writeCapability: "read",
			}),
		]);
		const result = await runToolSchemaSync(fixture.db, {
			apply: true,
			toolIds: ["get_tedis_status"],
			pruneStale: false,
		});
		expect(result).toMatchObject({ updated: 1, failed: 0 });
		return fixture.store[0]!;
	}

	it("refreshes stale provenance with unchanged schemas and preserves native config and authority", async () => {
		const row = await synchronizedTool();
		row.schemaSyncedAt = "2026-01-01T00:00:00.000Z";
		row.updatedAt = "2026-01-01T00:00:00.001Z";
		const original = structuredClone(row);
		const fixture = makeDb([row]);
		const options = {
			toolIds: [row.toolId],
			pruneStale: false,
			limit: 1,
		};
		const preview = await runToolSchemaSync(fixture.db, options);
		expect(preview.items).toEqual([
			expect.objectContaining({
				status: "wouldUpdate",
				changed: ["schemaSource"],
			}),
		]);
		expect(fixture.updates).toHaveLength(0);
		const result = await runToolSchemaSync(fixture.db, {
			...options,
			apply: true,
		});
		expect(result).toMatchObject({ updated: 1, inSync: 0, failed: 0 });
		expect(fixture.updates).toHaveLength(1);
		const patch = fixture.updates[0]!.patch;
		expect(patch.schemaSyncedAt).toBe(patch.updatedAt);
		expect(Number.isFinite(Date.parse(patch.schemaSyncedAt!))).toBe(true);
		expect(patch.schemaSourceHash).toBe(original.schemaSourceHash);
		expect(patch).not.toHaveProperty("config");
		expect(fixture.store[0]).toEqual({
			...original,
			...patch,
		});
		expect(fixture.store[0]!.config).toEqual(original.config);
		expect(fixture.store[0]!.visibility).toBe("private");
		expect(fixture.store[0]!.authRequired).toBe(true);
		expect(fixture.store[0]!.annotations).toEqual(original.annotations);
		expect(fixture.store[0]!.writeCapability).toBe(original.writeCapability);
		fixture.updates.length = 0;
		expect(
			await runToolSchemaSync(fixture.db, { ...options, apply: true }),
		).toMatchObject({ inSync: 1, planned: 0, updated: 0 });
		expect(fixture.updates).toHaveLength(0);
	});

	it("recomputes the contract projection hash after a config-only change", async () => {
		const row = await synchronizedTool();
		const beforeHash = row.schemaSourceHash;
		row.config = { ...row.config, nativeDirect: false };
		const fixture = makeDb([row]);
		const result = await runToolSchemaSync(fixture.db, {
			apply: true,
			toolIds: [row.toolId],
			pruneStale: false,
		});
		expect(result.items[0]).toMatchObject({ changed: ["schemaSource"] });
		expect(fixture.store[0]!.schemaSourceHash).not.toBe(beforeHash);
		expect(fixture.store[0]!.config).toEqual(row.config);
		expect(fixture.updates[0]!.patch).not.toHaveProperty("config");
		expect(await runToolSchemaSync(fixture.db, { apply: false })).toMatchObject(
			{ inSync: 1, planned: 0 },
		);
	});

	it.each([
		["schemaDialect", null],
		["schemaSource", null],
		["schemaSourceRef", "work/wrongEndpoint"],
		["schemaSourceHash", "0".repeat(64)],
		["schemaSyncedAt", null],
		["schemaSyncedAt", "not-a-date"],
		["updatedAt", null],
		["updatedAt", "not-a-date"],
	] as const)(
		"repairs invalid or missing %s=%s without schema/config writes",
		async (key, value) => {
			const row = await synchronizedTool();
			Object.assign(row, { [key]: value });
			const fixture = makeDb([row]);
			const result = await runToolSchemaSync(fixture.db, {
				apply: true,
				toolIds: [row.toolId],
				pruneStale: false,
			});
			expect(result.items[0]).toMatchObject({
				status: "updated",
				changed: ["schemaSource"],
			});
			expect(fixture.updates[0]!.patch).not.toHaveProperty("inputSchema");
			expect(fixture.updates[0]!.patch).not.toHaveProperty("outputSchema");
			expect(fixture.updates[0]!.patch).not.toHaveProperty("config");
			expect(
				await runToolSchemaSync(fixture.db, { apply: false }),
			).toMatchObject({ inSync: 1, planned: 0 });
		},
	);

	it("leaves a fresh unchanged row alone", async () => {
		const row = await synchronizedTool();
		row.updatedAt = "2025-01-01T00:00:00.000Z";
		const fixture = makeDb([row]);
		expect(
			await runToolSchemaSync(fixture.db, { apply: true, pruneStale: false }),
		).toMatchObject({ inSync: 1, updated: 0, planned: 0 });
		expect(fixture.updates).toHaveLength(0);
	});

	it("does not certify provenance or write a partial projection when conversion fails", async () => {
		const row = await synchronizedTool();
		row.schemaSyncedAt = null;
		const fixture = makeDb([row]);
		const before = structuredClone(row);
		const converter = vi
			.spyOn(toolJsonSchema, "zodToStructuredOutputJsonSchema")
			.mockImplementation(() => {
				throw new Error("unsupported contract output");
			});
		try {
			const result = await runToolSchemaSync(fixture.db, {
				apply: true,
				toolIds: [row.toolId],
				pruneStale: false,
			});
			expect(result).toMatchObject({ updated: 0, inSync: 0, skipped: 1 });
			expect(result.items[0]).toMatchObject({ status: "converterUnsupported" });
			expect(fixture.updates).toHaveLength(0);
			expect(fixture.store[0]).toEqual(before);
		} finally {
			converter.mockRestore();
		}
	});

	it("honors the allowlist and limit and never prunes unknown or non-RPC rows", async () => {
		const row = await synchronizedTool();
		row.schemaSyncedAt = null;
		const other = { ...row, id: "other-row", toolId: "other_tool" };
		const unknown = makeRpcTool({
			toolId: "unknown_tool",
			endpoint: "missing/router",
		});
		const nonRpc = {
			...row,
			id: "non-rpc",
			toolId: "non_rpc",
			config: { transport: "http", nativeDirect: true },
		} as AppTool;
		const fixture = makeDb([row, other, unknown, nonRpc]);
		const before = structuredClone(fixture.store);
		const result = await runToolSchemaSync(fixture.db, {
			apply: true,
			toolIds: [row.toolId, unknown.toolId, nonRpc.toolId],
			limit: 1,
			pruneStale: false,
		});
		expect(result).toMatchObject({ updated: 1, deleted: 0 });
		expect(result.items).toHaveLength(2);
		expect(result.items[1]).toMatchObject({ status: "noContract" });
		expect(fixture.updates.map((update) => update.id)).toEqual([row.id]);
		expect(fixture.store.slice(1)).toEqual(before.slice(1));
		expect(fixture.deletes).toHaveLength(0);
		const limitedFixture = makeDb([
			{ ...fixture.store[0]!, schemaSyncedAt: null },
			other,
		]);
		const limited = await runToolSchemaSync(limitedFixture.db, {
			apply: true,
			toolIds: [row.toolId, other.toolId],
			limit: 1,
			pruneStale: false,
		});
		expect(limited).toMatchObject({ updated: 1, skipped: 1 });
		expect(limited.items[1]).toMatchObject({
			status: "skipped",
			message: "Limit reached",
		});
	});
});

describe("projection native transport opt-in", () => {
	const endpoint = "workItems/listCliProjection";
	const options = {
		mode: "projection" as const,
		apply: true,
		endpoints: [endpoint],
		pruneStale: false,
	};

	it("preserves a reviewed true opt-in through projection and repeated no-op sync", async () => {
		const fixture = makeDb([
			makeRpcTool({
				toolId: "list_work_item_cli_rows",
				endpoint,
				config: { nativeDirect: true, unreviewedPolicy: "discard" },
				authRequired: true,
				visibility: "private",
			}),
		]);
		const result = await runToolSchemaSync(fixture.db, options);
		expect(result).toMatchObject({ updated: 1, failed: 0 });
		const projected = structuredClone(fixture.store[0]!);
		expect(projected.config).toMatchObject({
			transport: "rpc",
			endpoint,
			nativeDirect: true,
		});
		expect(projected.config).not.toHaveProperty("unreviewedPolicy");
		expect(projected).toMatchObject({
			authRequired: true,
			visibility: "private",
		});
		expect(projected.schemaSourceHash).toMatch(/^[a-f0-9]{64}$/);
		expect(Number.isFinite(Date.parse(projected.schemaSyncedAt!))).toBe(true);
		expect(Number.isFinite(Date.parse(projected.updatedAt!))).toBe(true);
		const control = makeDb([
			makeRpcTool({ toolId: projected.toolId, endpoint }),
		]);
		await runToolSchemaSync(control.db, options);
		const withoutOptIn = control.store[0]!;
		expect(projected.config).toEqual({
			...withoutOptIn.config,
			nativeDirect: true,
		});
		expect(projected.schemaSourceHash).not.toBe(withoutOptIn.schemaSourceHash);
		expect(projected.annotations).toEqual(withoutOptIn.annotations);
		expect(projected.writeCapability).toBe(withoutOptIn.writeCapability);
		expect(
			resolveMcpToolRequiredScopes(projected, "selected_org", undefined),
		).toEqual(
			resolveMcpToolRequiredScopes(withoutOptIn, "selected_org", undefined),
		);
		fixture.updates.length = 0;
		expect(await runToolSchemaSync(fixture.db, options)).toMatchObject({
			inSync: 1,
			updated: 0,
			planned: 0,
		});
		expect(fixture.updates).toHaveLength(0);
		expect(fixture.store[0]).toEqual(projected);
		// The existing schema owner refreshes provenance with one server timestamp
		// without undoing the projection's explicit native transport policy.
		const refreshed = await runToolSchemaSync(fixture.db, {
			apply: true,
			toolIds: [projected.toolId],
			pruneStale: false,
		});
		expect(refreshed).toMatchObject({ updated: 1, failed: 0 });
		expect(fixture.store[0]!.config).toEqual(projected.config);
		expect(fixture.store[0]!.schemaSyncedAt).toBe(fixture.store[0]!.updatedAt);
	});

	it.each([undefined, false, "true", 1, {}, []])(
		"does not opt in absent or non-true policy %j",
		async (nativeDirect) => {
			const fixture = makeDb([
				makeRpcTool({
					toolId: "list_work_item_cli_rows",
					endpoint,
					config: nativeDirect === undefined ? {} : { nativeDirect },
				}),
			]);
			expect(await runToolSchemaSync(fixture.db, options)).toMatchObject({
				updated: 1,
				failed: 0,
			});
			expect(fixture.store[0]!.config).not.toHaveProperty("nativeDirect");
		},
	);

	it("does not enable native transport for newly generated rows", async () => {
		const fixture = makeDb([]);
		expect(await runToolSchemaSync(fixture.db, options)).toMatchObject({
			created: 1,
			failed: 0,
		});
		expect(fixture.inserts[0]!.config).not.toHaveProperty("nativeDirect");
	});
});

describe("runToolSchemaSync entity routing flags", () => {
	it("plans config repair for tedi-scoped oRPC tools", async () => {
		const { db } = makeDb([
			makeRpcTool({
				toolId: "get_tedis_status",
				endpoint: "tedis/getStatus",
			}),
		]);

		const result = await runToolSchemaSync(db, {
			apply: false,
			toolIds: ["get_tedis_status"],
		});

		expect(result.planned).toBe(1);
		expect(result.items[0]).toMatchObject({
			toolId: "get_tedis_status",
			status: "wouldUpdate",
			changed: expect.arrayContaining(["config"]),
		});
	});

	it("applies allowExplicitTediId when the contract input exposes tediId", async () => {
		const { db, updates } = makeDb([
			makeRpcTool({
				toolId: "get_tedis_status",
				endpoint: "tedis/getStatus",
				config: { responsePath: "json" },
			}),
		]);

		const result = await runToolSchemaSync(db, {
			apply: true,
			toolIds: ["get_tedis_status"],
		});

		expect(result.updated).toBe(1);
		expect(updates).toHaveLength(1);
		expect(updates[0].patch.config).toMatchObject({
			transport: "rpc",
			endpoint: "tedis/getStatus",
			responsePath: "json",
			allowExplicitTediId: true,
		});
	});

	it("applies allowExplicitAppId when the contract input exposes appId", async () => {
		const { db, updates } = makeDb([
			makeRpcTool({
				toolId: "get_app",
				endpoint: "apps/get",
			}),
		]);

		const result = await runToolSchemaSync(db, {
			apply: true,
			toolIds: ["get_app"],
		});

		expect(result.updated).toBe(1);
		expect(updates[0].patch.config).toMatchObject({
			transport: "rpc",
			endpoint: "apps/get",
			allowExplicitAppId: true,
		});
	});

	it("projects tenant SEO research with explicit app routing and open-world annotations", async () => {
		const { db, updates } = makeDb([
			makeRpcTool({
				toolId: "research_keywords",
				endpoint: "seo/researchKeywords",
				config: { responsePath: "json" },
			}),
		]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: ["seo/researchKeywords"],
		});

		expect(result).toMatchObject({
			total: 1,
			updated: 1,
			planned: 1,
		});
		expect(updates).toHaveLength(1);
		expect(updates[0].patch).toMatchObject({
			config: {
				transport: "rpc",
				endpoint: "seo/researchKeywords",
				allowExplicitAppId: true,
			},
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		});
	});

	it("projects REST methods and their idempotence metadata", async () => {
		const endpoints = ["appTools/reorder"];
		const { db, updates } = makeDb([
			makeRpcTool({
				toolId: "reorder_app_tools",
				endpoint: endpoints[0]!,
			}),
		]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints,
		});

		expect(result).toMatchObject({ total: 1, updated: 1, planned: 1 });
		const patches = new Map(
			updates.map(({ patch }) => [
				(patch.config as Record<string, unknown>).endpoint,
				patch,
			]),
		);
		expect(patches.get("appTools/reorder")).toMatchObject({
			config: { method: "PUT" },
			annotations: {
				readOnlyHint: false,
				idempotentHint: true,
			},
		});
	});

	it("injects organizationId for org-sub-collection routes (members)", async () => {
		const { db, updates } = makeDb([
			makeRpcTool({
				toolId: "list_members",
				endpoint: "members/listMembers",
			}),
		]);

		const result = await runToolSchemaSync(db, {
			apply: true,
			toolIds: ["list_members"],
		});

		expect(result.updated).toBe(1);
		expect(updates[0].patch.config).toMatchObject({
			transport: "rpc",
			endpoint: "members/listMembers",
			injectOrganizationId: true,
		});
	});

	it("does NOT inject organizationId for org-level resource ops", async () => {
		const { db, updates } = makeDb([
			makeRpcTool({
				toolId: "get_my_organization",
				endpoint: "organizations/get",
			}),
		]);

		await runToolSchemaSync(db, {
			apply: true,
			toolIds: ["get_my_organization"],
		});

		// `/{organizationId}` (org IS the resource) must not auto-inject — a
		// destructive org op must keep an explicit org. No org-injection flag is
		// added, so config may not be patched at all; either way the flag is unset.
		const patchedConfig = updates[0]?.patch?.config as
			| Record<string, unknown>
			| undefined;
		expect(patchedConfig?.injectOrganizationId).toBeUndefined();
	});

	it("does NOT inject organizationId for the cross-org cancel route", async () => {
		// `/{organizationId}/cancel` is
		// path-structurally identical to the member sub-collection routes but are
		// platform-admin CROSS-org actions that skip requireOrganizationAccess —
		// auto-rescoping them to the caller's own org would be a footgun. The
		// router allowlist (not a path heuristic) must exclude them.
		for (const [toolId, endpoint] of [
			["cancel_organization", "organizations/cancel"],
		] as const) {
			const { db, updates } = makeDb([makeRpcTool({ toolId, endpoint })]);
			await runToolSchemaSync(db, { apply: true, toolIds: [toolId] });
			const patchedConfig = updates[0]?.patch?.config as
				| Record<string, unknown>
				| undefined;
			expect(patchedConfig?.injectOrganizationId).toBeUndefined();
		}
	});

	it("plans stale oRPC tool deletion when a contract endpoint is gone", async () => {
		const { db, deletes } = makeDb([
			makeRpcTool({
				id: "tool-stale",
				toolId: "probe_removed_runtime",
				endpoint: "tedis/probeRemovedRuntime",
			}),
		]);

		const result = await runToolSchemaSync(db, {
			apply: false,
			toolIds: ["probe_removed_runtime"],
		});

		expect(result).toMatchObject({
			planned: 1,
			deleted: 0,
			skipped: 0,
			failed: 0,
		});
		expect(result.items[0]).toMatchObject({
			toolUuid: "tool-stale",
			toolId: "probe_removed_runtime",
			endpoint: "tedis/probeRemovedRuntime",
			status: "wouldDelete",
		});
		expect(deletes).toHaveLength(0);
	});

	it("deletes stale oRPC tools in apply mode", async () => {
		const { db, deletes } = makeDb([
			makeRpcTool({
				id: "tool-stale",
				toolId: "probe_removed_runtime",
				endpoint: "tedis/probeRemovedRuntime",
			}),
		]);

		const result = await runToolSchemaSync(db, {
			apply: true,
			toolIds: ["probe_removed_runtime"],
		});

		expect(result).toMatchObject({
			planned: 1,
			deleted: 1,
			skipped: 0,
			failed: 0,
		});
		expect(result.items[0]).toMatchObject({
			toolUuid: "tool-stale",
			toolId: "probe_removed_runtime",
			endpoint: "tedis/probeRemovedRuntime",
			status: "deleted",
		});
		expect(deletes).toEqual(["tool-stale"]);
	});

	it("keeps stale oRPC tools report-only when pruning is disabled", async () => {
		const { db, deletes } = makeDb([
			makeRpcTool({
				id: "tool-stale",
				toolId: "probe_removed_runtime",
				endpoint: "tedis/probeRemovedRuntime",
			}),
		]);

		const result = await runToolSchemaSync(db, {
			apply: true,
			pruneStale: false,
			toolIds: ["probe_removed_runtime"],
		});

		expect(result).toMatchObject({
			planned: 0,
			deleted: 0,
			skipped: 1,
		});
		expect(result.items[0]).toMatchObject({
			status: "noContract",
		});
		expect(deletes).toHaveLength(0);
	});
});

describe("oRPC tool projection sync", () => {
	it("lists contract endpoints with internal procedures behind an explicit flag", () => {
		expect(
			listContractEndpoints({
				router: "toolSchemaSync",
				includeInternal: false,
			}),
		).toHaveLength(0);

		expect(
			listContractEndpoints({
				router: "toolSchemaSync",
				includeInternal: true,
			}).map((endpoint) => `${endpoint.router}/${endpoint.procPath}`),
		).toEqual([
			"toolSchemaSync/check",
			"toolSchemaSync/preview",
			"toolSchemaSync/run",
		]);
	});

	it("covers every top-level API router used by the unified contract", () => {
		const endpoints = listContractEndpoints({ includeInternal: true }).map(
			(endpoint) => `${endpoint.router}/${endpoint.procPath}`,
		);
		const uniqueEndpoints = new Set(endpoints);

		expect(uniqueEndpoints.size).toBe(endpoints.length);
		expect(endpoints).toContain("skills/auditToolCoverage");
		expect(endpoints).toContain("skills/listPromotionCandidates");
		expect(endpoints).toContain("flywheelHealth/learningCurves");
		expect(endpoints).toContain("flywheelHealth/getOrphanRunHealth");
		expect(endpoints).toContain("workItems/create");
		expect(endpoints).toContain("tedis/getStatus");
		expect(endpoints).toContain("toolSchemaSync/run");
		expect(endpoints).toContain("cognitiveRuntime/getStability");
		expect(endpoints).toContain("workflows/listDefinitions");
		expect(endpoints).toContain("workflows/listRuns");
	});

	it("projects browser endpoints as a global stateless provider surface", async () => {
		const { db } = makeDb([]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
			router: "browser",
		});
		const byEndpoint = new Map(
			result.items.map((item) => [item.endpoint, item.toolId]),
		);

		expect(result).toMatchObject({
			mode: "projection",
			total: 7,
			planned: 7,
			created: 0,
			updated: 0,
		});
		expect(byEndpoint.get("browser/capturePage")).toBe("capture_page");
		expect(byEndpoint.get("browser/extractMarkdown")).toBe("extract_markdown");
		expect(byEndpoint.get("browser/extractContent")).toBe("extract_content");
		expect(byEndpoint.get("browser/extractLinks")).toBe("extract_links");
		expect(byEndpoint.get("browser/scrapeElements")).toBe("scrape_elements");
		expect(byEndpoint.get("browser/extractJson")).toBe("extract_json");
		expect(byEndpoint.get("browser/startCrawl")).toBe("start_crawl");
	});

	it("emits list_capabilities for capabilities/list without any override (bare verb + router)", async () => {
		// Probe on a NON-admin appId so the implicit Tedix-admin override merge
		// (CAPABILITY_TOOL_ID_OVERRIDES) cannot mask what the generator emits.
		// This is why capabilities/list needs no entry in that map, unlike its
		// siblings (create → create_capabilities pluralization, tree →
		// noun-first tree_capabilities).
		const { db } = makeDb([]);

		const result = await runToolSchemaSync(db, {
			appId: "00000000-0000-4000-8000-00000000probe",
			mode: "projection",
			apply: false,
			router: "capabilities",
		});
		const byEndpoint = new Map(
			result.items.map((item) => [item.endpoint, item.toolId]),
		);

		expect(byEndpoint.get("capabilities/list")).toBe("list_capabilities");
	});

	it("fails closed when an explicit projection router resolves no contracts", async () => {
		const { db } = makeDb([]);

		await expect(
			runToolSchemaSync(db, {
				mode: "projection",
				apply: false,
				router: "missingRouter",
			}),
		).rejects.toThrow(
			'Explicit tool projection resolved no contract endpoints for router "missingRouter"',
		);
	});

	it("resolves explicit endpoint allowlists without depending on router walking", () => {
		expect(
			listContractEndpoints({
				endpoints: [
					"tediAppAssignments/validateMcpAccessBatch",
					"mcpHealth/run",
					"mcpEval/run",
				],
				includeInternal: true,
			}).map((endpoint) => `${endpoint.router}/${endpoint.procPath}`),
		).toEqual([
			"mcpEval/run",
			"mcpHealth/run",
			"tediAppAssignments/validateMcpAccessBatch",
		]);
	});

	it("previews missing oRPC procedures as wouldCreate without mutating", async () => {
		const { db, updates } = makeDb([]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
			endpoints: ["toolSchemaSync/preview"],
			includeInternal: true,
		});

		expect(result).toMatchObject({
			mode: "projection",
			total: 1,
			planned: 1,
			updated: 0,
			inSync: 0,
		});
		expect(result.items[0]).toMatchObject({
			toolId: "preview_tool_schema_sync",
			endpoint: "toolSchemaSync/preview",
			status: "wouldCreate",
			// `preview` for router `tool_schema_sync` → bare verb keeps router suffix.
			changed: expect.arrayContaining([
				"inputSchema",
				"outputSchema",
				"config",
				"schemaSource",
			]),
		});
		expect(updates).toHaveLength(0);
	});

	it("projects root-array outputs with the MCP structuredContent data envelope", async () => {
		const { db, inserts } = makeDb([]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: ["projects/listHealthJudgments"],
		});

		expect(result).toMatchObject({ total: 1, created: 1, failed: 0 });
		expect(inserts[0]?.outputSchema).toMatchObject({
			type: "object",
			required: ["data"],
			additionalProperties: false,
			properties: {
				data: {
					type: "array",
					items: { type: "object" },
				},
			},
		});
	});

	it("projects nullable output alternatives with the runtime data envelope", async () => {
		const { db, inserts } = makeDb([]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: ["adapterBindings/get"],
		});

		expect(result).toMatchObject({ total: 1, created: 1, failed: 0 });
		expect(inserts[0]?.outputSchema).toMatchObject({
			anyOf: [
				{ type: "object", required: expect.arrayContaining(["id"]) },
				{
					type: "object",
					properties: { data: { type: "null" } },
					required: ["data"],
					additionalProperties: false,
				},
			],
		});
	});

	it("projects every Docs write result with a concrete output schema", async () => {
		const { db, inserts } = makeDb([]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: [
				"docs/publishBuild",
				"docs/rollbackBuild",
				"docs/validateChange",
			],
		});

		expect(result).toMatchObject({ total: 3, created: 3, failed: 0 });
		expect(inserts.map((insert) => insert.outputSchema)).toEqual([
			expect.objectContaining({ type: "object" }),
			expect.objectContaining({ type: "object" }),
			expect.objectContaining({ anyOf: expect.any(Array) }),
		]);
	});

	it("projects governed share create and list inputs as object schemas", async () => {
		const { db, inserts } = makeDb([]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: ["osShares/shares/create", "osShares/shares/list"],
		});

		expect(result).toMatchObject({
			total: 2,
			created: 2,
			failed: 0,
			skipped: 0,
		});
		expect(result.items).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ status: "converterUnsupported" }),
			]),
		);
		for (const row of inserts) {
			expect(row.inputSchema).toMatchObject({
				type: "object",
				properties: {
					resourceType: expect.any(Object),
					resourceId: expect.any(Object),
				},
				required: expect.arrayContaining(["resourceType", "resourceId"]),
			});
		}
	});

	it("projects the tenant catalog bootstrap surface for ordinary Unified gateways", async () => {
		const { db, updates } = makeDb([]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
			router: "tenantCatalog",
		});

		expect(result.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					toolId: "install_tenant_mcp_app",
					endpoint: "tenantCatalog/installTenantMcpApp",
					status: "wouldCreate",
				}),
			]),
		);
		expect(updates).toHaveLength(0);
	});

	it("uses explicit projection overrides for operator-facing tool ids and annotations", async () => {
		const { db } = makeDb([]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
			endpoints: ["apps/create"],
			toolIdOverrides: { "apps/create": "create_app" },
			kindOverrides: { "apps/create": "write" },
			includeInternal: true,
		});

		expect(result.items[0]).toMatchObject({
			toolId: "create_app",
			endpoint: "apps/create",
			status: "wouldCreate",
		});
	});

	it("projects stable skill-workflow names by default for the Tedix admin app", async () => {
		const { db } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
			endpoints: [
				"skills/runWorkflowStatus",
				"skills/listWorkflowRetryCandidates",
				"skills/inspectWorkflowRun",
				"skills/restartWorkflow",
			],
		});
		const byEndpoint = new Map(
			result.items.map((item) => [item.endpoint, item.toolId]),
		);

		expect(byEndpoint).toEqual(
			new Map([
				["skills/runWorkflowStatus", "get_skill_workflow_status"],
				[
					"skills/listWorkflowRetryCandidates",
					"list_skill_workflow_retry_candidates",
				],
				["skills/inspectWorkflowRun", "inspect_skill_workflow_run"],
				["skills/restartWorkflow", "restart_skill_workflow"],
			]),
		);
	});

	it("projects the stable governance-overview name and read kind by default for the Tedix admin app", async () => {
		const { db } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
			router: "governance",
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({
			endpoint: "governance/overview",
			toolId: "get_governance_overview",
		});
	});

	it("projects stable capability-map names and kinds by default for the Tedix admin app", async () => {
		const { db } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
			router: "capabilities",
		});
		const byEndpoint = new Map(
			result.items.map((item) => [item.endpoint, item.toolId]),
		);

		expect(byEndpoint).toEqual(
			new Map([
				["capabilities/create", "create_capability"],
				["capabilities/update", "update_capability"],
				["capabilities/archive", "archive_capability"],
				["capabilities/list", "list_capabilities"],
				["capabilities/tree", "get_capability_tree"],
				["capabilities/coverage", "get_capability_coverage"],
				["capabilities/unmapped", "list_unmapped_capability_entities"],
				["capabilities/link", "link_capability"],
				["capabilities/unlink", "unlink_capability"],
			]),
		);
	});

	it("projects CMS recovery capture tools with read, write, and destructive intent", async () => {
		const { db, inserts } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: [
				"sites/startCmsRecoveryCapture",
				"sites/getCmsRecoveryCapture",
				"sites/purgeCmsRecoveryCapture",
				"sites/startCmsSiteRestore",
				"sites/getCmsSiteRestore",
			],
		});
		expect(
			new Map(result.items.map((item) => [item.endpoint, item.toolId])),
		).toEqual(
			new Map([
				["sites/startCmsRecoveryCapture", "start_cms_recovery_capture"],
				["sites/getCmsRecoveryCapture", "get_cms_recovery_capture"],
				["sites/purgeCmsRecoveryCapture", "purge_cms_recovery_capture"],
				["sites/startCmsSiteRestore", "start_cms_site_restore"],
				["sites/getCmsSiteRestore", "get_cms_site_restore"],
			]),
		);
		const byToolId = new Map(inserts.map((tool) => [tool.toolId, tool]));
		expect(
			byToolId.get("start_cms_recovery_capture")?.annotations,
		).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
		});
		expect(byToolId.get("get_cms_recovery_capture")?.annotations).toMatchObject(
			{
				readOnlyHint: true,
				destructiveHint: false,
			},
		);
		expect(byToolId.get("start_cms_site_restore")?.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		});
		expect(byToolId.get("get_cms_site_restore")?.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
		});
		expect(
			byToolId.get("purge_cms_recovery_capture")?.annotations,
		).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		});
	});

	it("projects stable work-hierarchy tool ids by default for the Tedix admin app", async () => {
		// Work hierarchy v1: the 8 projected tool ids that need a projection sync.
		// projects/list needs no override (the bare-verb rule already emits
		// list_projects); the workItems reads carry their object in the proc name.
		const { db } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
			endpoints: [
				"projects/create",
				"projects/list",
				"projects/get",
				"projects/update",
				"projects/archive",
				"projects/getRollup",
			],
		});
		const byEndpoint = new Map(
			result.items.map((item) => [item.endpoint, item.toolId]),
		);

		expect(byEndpoint).toEqual(
			new Map([
				["projects/create", "create_project"],
				["projects/list", "list_projects"],
				["projects/get", "get_project"],
				["projects/update", "update_project"],
				["projects/archive", "archive_project"],
				["projects/getRollup", "get_project_rollup"],
			]),
		);
	});

	it("projects Tedix OS lifecycle deletions with stable singular ids and destructive annotations", async () => {
		const { db, inserts } = makeDb([]);
		const endpoints = [
			"osWorkspaces/workspaces/delete",
			"osWorkspaces/gadgets/delete",
			"osWorkspaces/outputs/delete",
			"osWorkspaces/blueprints/archive",
			"osWorkspaces/blueprints/delete",
			"osApprovalRules/delete",
			"osShares/shares/delete",
		];
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints,
		});

		expect(
			new Map(result.items.map((item) => [item.endpoint, item.toolId])),
		).toEqual(
			new Map([
				["osWorkspaces/workspaces/delete", "delete_os_workspace"],
				["osWorkspaces/gadgets/delete", "delete_os_gadget"],
				["osWorkspaces/outputs/delete", "delete_os_output"],
				["osWorkspaces/blueprints/archive", "archive_os_blueprint"],
				["osWorkspaces/blueprints/delete", "delete_os_blueprint"],
				["osApprovalRules/delete", "delete_os_approval_rule"],
				["osShares/shares/delete", "delete_os_share_link"],
			]),
		);
		const byToolId = new Map(inserts.map((tool) => [tool.toolId, tool]));
		for (const toolId of [
			"delete_os_workspace",
			"delete_os_gadget",
			"delete_os_output",
			"delete_os_blueprint",
			"delete_os_approval_rule",
			"delete_os_share_link",
		]) {
			expect(byToolId.get(toolId)?.annotations).toMatchObject({
				readOnlyHint: false,
				destructiveHint: true,
			});
		}
		expect(byToolId.get("archive_os_blueprint")?.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
		});
	});

	it("projects stable work-graph-steward tool ids with the right annotations", async () => {
		// The read reports; the run can transition items to stale + link/flag
		// org-wide, so it must project as destructive to trip the approval gate.
		const { db, inserts } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: [
				"workItems/getWorkGraphHealth",
				"workItems/runWorkGraphSteward",
			],
		});

		const byEndpoint = new Map(
			result.items.map((item) => [item.endpoint, item.toolId]),
		);
		expect(byEndpoint).toEqual(
			new Map([
				["workItems/getWorkGraphHealth", "get_work_graph_health"],
				["workItems/runWorkGraphSteward", "run_work_graph_steward"],
			]),
		);

		const byToolId = new Map(inserts.map((tool) => [tool.toolId, tool]));
		expect(byToolId.get("get_work_graph_health")?.annotations).toMatchObject({
			readOnlyHint: true,
		});
		expect(byToolId.get("run_work_graph_steward")?.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		});
		expect(
			byToolId.get("run_work_graph_steward")?.inputSchema.properties,
		).toMatchObject({
			confirmDestructive: { type: "boolean" },
			reason: { type: "string", minLength: 1, maxLength: 4000 },
		});
	});

	it("projects Earned Delegation as a stable evidence and governance namespace", async () => {
		const { db, inserts } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: [
				"earnedDelegation/getProfile",
				"earnedDelegation/createActivity",
				"earnedDelegation/recordObservation",
				"earnedDelegation/attestObservation",
				"earnedDelegation/certifyObservation",
				"earnedDelegation/proposeDecision",
				"earnedDelegation/decideDecision",
			],
		});

		expect(
			new Map(result.items.map((item) => [item.endpoint, item.toolId])),
		).toEqual(
			new Map([
				["earnedDelegation/getProfile", "get_earned_delegation_profile"],
				["earnedDelegation/createActivity", "create_entrustable_activity"],
				["earnedDelegation/recordObservation", "record_competency_observation"],
				["earnedDelegation/attestObservation", "attest_competency_observation"],
				[
					"earnedDelegation/certifyObservation",
					"certify_competency_observation",
				],
				["earnedDelegation/proposeDecision", "propose_entrustment_decision"],
				["earnedDelegation/decideDecision", "decide_entrustment_decision"],
			]),
		);
		const byToolId = new Map(inserts.map((tool) => [tool.toolId, tool]));
		expect(
			byToolId.get("get_earned_delegation_profile")?.annotations,
		).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
		});
		for (const toolId of [
			"create_entrustable_activity",
			"decide_entrustment_decision",
		]) {
			expect(byToolId.get(toolId)?.annotations).toMatchObject({
				readOnlyHint: false,
				destructiveHint: true,
			});
		}
		for (const toolId of [
			"record_competency_observation",
			"attest_competency_observation",
			"certify_competency_observation",
			"propose_entrustment_decision",
		]) {
			expect(byToolId.get(toolId)?.annotations).toMatchObject({
				readOnlyHint: false,
				destructiveHint: false,
			});
		}
	});

	it("projects only the curated external-agent lifecycle tools", async () => {
		const { db, inserts } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			router: "externalAgentIdentity",
		});

		expect(result.items.map((item) => item.toolId).sort()).toEqual([
			"create_external_agent_principal",
			"end_external_agent_session",
			"list_stale_external_agent_knowledge_sessions",
			"record_external_agent_knowledge_checkpoint",
			"record_external_agent_knowledge_disposition",
			"rename_external_agent_principal",
			"retire_abandoned_external_agent_session",
			"revoke_external_agent_mcp_credential",
			"start_external_agent_session_for_host",
		]);
		const endpoints = new Set(result.items.map((item) => item.endpoint));
		expect(endpoints.has("externalAgentIdentity/resolveOwnerHostSession")).toBe(
			false,
		);
		expect(endpoints.has("externalAgentIdentity/openSession")).toBe(false);
		expect(
			endpoints.has("externalAgentIdentity/authorizeWorkloadSession"),
		).toBe(false);
		expect(endpoints.has("externalAgentIdentity/issueMcpCredential")).toBe(
			false,
		);
		expect(endpoints.has("externalAgentIdentity/resolveSessionAuth")).toBe(
			false,
		);
		expect(
			endpoints.has("externalAgentIdentity/recordVerifiedMcpExecution"),
		).toBe(false);
		const byId = new Map(inserts.map((tool) => [tool.toolId, tool]));
		expect(byId.get("end_external_agent_session")?.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		});
		expect(
			byId.get("retire_abandoned_external_agent_session")?.annotations,
		).toMatchObject({ readOnlyHint: false, destructiveHint: true });
		expect(
			byId.get("list_stale_external_agent_knowledge_sessions")?.annotations,
		).toMatchObject({ readOnlyHint: true, destructiveHint: false });
		expect(
			byId.get("start_external_agent_session_for_host")?.annotations,
		).toMatchObject({ readOnlyHint: false, destructiveHint: false });
		expect(
			byId.get("start_external_agent_session_for_host")?.config,
		).toMatchObject({ endpoint: "externalAgentIdentity/openOwnerHostSession" });
	});

	it("projects generic non-code evidence as a stable write", async () => {
		const { db, inserts } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: ["workItems/submitEvidence"],
		});

		expect(
			new Map(result.items.map((item) => [item.endpoint, item.toolId])),
		).toEqual(
			new Map([["workItems/submitEvidence", "submit_work_item_evidence"]]),
		);
		const byToolId = new Map(inserts.map((tool) => [tool.toolId, tool]));
		for (const toolId of ["submit_work_item_evidence"]) {
			expect(byToolId.get(toolId)?.annotations).toMatchObject({
				readOnlyHint: false,
				destructiveHint: false,
			});
		}
	});

	it("projects factory completion and cancellation with stable risk annotations", async () => {
		const { db, inserts } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: ["workItems/complete", "workItems/cancel"],
		});
		expect(result.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					endpoint: "workItems/complete",
					toolId: "complete_work_item",
				}),
				expect.objectContaining({
					endpoint: "workItems/cancel",
					toolId: "cancel_work_item",
				}),
			]),
		);
		expect(
			inserts.find((tool) => tool.toolId === "complete_work_item")?.annotations,
		).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
		});
		expect(
			inserts.find((tool) => tool.toolId === "cancel_work_item")?.annotations,
		).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		});
	});

	it("projects governed entity and graph benchmark tools with stable capabilities", async () => {
		const { db, inserts } = makeDb([]);
		const endpoints = [
			"memoryEntities/createEntity",
			"memoryEntities/recordMention",
			"memoryEntities/listCandidates",
			"memoryEntities/proposeResolution",
			"memoryEntities/proposeResolutionRollback",
			"memoryEntities/reviewResolution",
			"memoryEntities/getMentionResolution",
			"graphRetrievalBenchmarks/createSuite",
			"graphRetrievalBenchmarks/addCase",
			"graphRetrievalBenchmarks/lockSuite",
			"graphRetrievalBenchmarks/getSuite",
			"graphRetrievalBenchmarks/startPair",
			"graphRetrievalBenchmarks/recordObservation",
			"graphRetrievalBenchmarks/completeRun",
			"graphRetrievalBenchmarks/executePair",
			"graphRetrievalBenchmarks/evaluatePair",
			"graphRetrievalBenchmarks/getRun",
			"graphRetrievalBenchmarks/getGate",
		];
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints,
		});
		expect(result.failed).toBe(0);
		const byEndpoint = new Map(
			result.items.map((item) => [item.endpoint, item.toolId]),
		);
		expect(byEndpoint.get("memoryEntities/createEntity")).toBe(
			"create_memory_entity",
		);
		expect(byEndpoint.get("memoryEntities/reviewResolution")).toBe(
			"review_entity_resolution",
		);
		expect(byEndpoint.get("graphRetrievalBenchmarks/lockSuite")).toBe(
			"lock_graph_retrieval_benchmark_suite",
		);
		expect(byEndpoint.get("graphRetrievalBenchmarks/getGate")).toBe(
			"get_graph_retrieval_graduation_gate",
		);
		const byToolId = new Map(inserts.map((tool) => [tool.toolId, tool]));
		expect(byToolId.get("list_entity_candidates")?.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
		});
		expect(byToolId.get("review_entity_resolution")?.annotations).toMatchObject(
			{
				readOnlyHint: false,
				destructiveHint: true,
			},
		);
		expect(
			byToolId.get("evaluate_graph_retrieval_benchmark_pair")?.annotations,
		).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		});
	});

	it("marks graph reads as read-only and projection controls as destructive", async () => {
		const { db, inserts } = makeDb([]);
		const endpoints = [
			"memoryGraph/graph/path",
			"memoryGraph/graph/similar",
			"memoryGraph/graph/communities",
			"memoryGraph/graph/influence",
			"memoryGraph/graph/sync",
			"memoryGraph/graph/maintenance",
			"memoryGraph/graph/maintenanceTaskStatus",
			"memoryGraph/graph/maintenanceTaskCancel",
		];
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints,
		});
		expect(result.failed).toBe(0);
		const toolIdByEndpoint = new Map(
			result.items.map((item) => [item.endpoint, item.toolId]),
		);
		const byToolId = new Map(inserts.map((tool) => [tool.toolId, tool]));
		for (const endpoint of [
			...endpoints.slice(0, 4),
			"memoryGraph/graph/maintenanceTaskStatus",
		]) {
			expect(
				byToolId.get(toolIdByEndpoint.get(endpoint)!)?.annotations,
			).toMatchObject({
				readOnlyHint: true,
				destructiveHint: false,
			});
		}
		for (const endpoint of [
			...endpoints.slice(4, 6),
			"memoryGraph/graph/maintenanceTaskCancel",
		]) {
			expect(
				byToolId.get(toolIdByEndpoint.get(endpoint)!)?.annotations,
			).toMatchObject({
				readOnlyHint: false,
				destructiveHint: true,
			});
		}
		expect(
			toolIdByEndpoint.get("memoryGraph/graph/maintenanceTaskStatus"),
		).toBe("get_graph_gds_refresh_task");
		expect(
			toolIdByEndpoint.get("memoryGraph/graph/maintenanceTaskCancel"),
		).toBe("cancel_graph_gds_refresh_task");
	});

	it("projects org graph health as a stable read tool", async () => {
		// Blocked-work dependency analysis (org "digital twin", Stage 1): a
		// read-only recursive-CTE report, so readOnlyHint true / destructiveHint
		// false with the verb-first id pinned via WORK_HIERARCHY_TOOL_ID_OVERRIDES.
		const { db, inserts } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: ["workItems/getOrgGraphHealth"],
		});

		const byEndpoint = new Map(
			result.items.map((item) => [item.endpoint, item.toolId]),
		);
		expect(byEndpoint).toEqual(
			new Map([["workItems/getOrgGraphHealth", "get_org_graph_health"]]),
		);

		const byToolId = new Map(inserts.map((tool) => [tool.toolId, tool]));
		expect(byToolId.get("get_org_graph_health")?.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
		});
	});

	it("projects stable role-template tool ids with the right annotations", async () => {
		// Reusable role primitive: 3 verb-first tools. The router key is camelCase
		// (roleTemplates), so all three need id overrides. create=write, list=read,
		// apply=destructive (overwrites persona/profile + seeds objectives → trips
		// the destructive approval gate for interactive callers).
		const { db, inserts } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: [
				"roleTemplates/create",
				"roleTemplates/list",
				"roleTemplates/apply",
			],
		});

		const byEndpoint = new Map(
			result.items.map((item) => [item.endpoint, item.toolId]),
		);
		expect(byEndpoint).toEqual(
			new Map([
				["roleTemplates/create", "create_role_template"],
				["roleTemplates/list", "list_role_templates"],
				["roleTemplates/apply", "apply_role_template"],
			]),
		);

		const byToolId2 = new Map(inserts.map((tool) => [tool.toolId, tool]));
		expect(byToolId2.get("create_role_template")?.annotations).toMatchObject({
			readOnlyHint: false,
		});
		expect(byToolId2.get("list_role_templates")?.annotations).toMatchObject({
			readOnlyHint: true,
		});
		expect(byToolId2.get("apply_role_template")?.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		});
	});

	it("projects canonical muscle-memory lifecycle tools", async () => {
		const { db, inserts } = makeDb([]);
		const endpoints = [
			"muscle/list",
			"muscle/register",
			"muscle/crystallize",
			"muscle/usage",
		];
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints,
		});

		expect(
			new Map(result.items.map((item) => [item.endpoint, item.toolId])),
		).toEqual(
			new Map([
				["muscle/list", "list_muscle_memories"],
				["muscle/register", "register_muscle_memory"],
				["muscle/crystallize", "crystallize_muscle_memory"],
				["muscle/usage", "track_muscle_usage"],
			]),
		);
		const byToolId = new Map(inserts.map((tool) => [tool.toolId, tool]));
		expect(byToolId.get("list_muscle_memories")?.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
		});
		for (const toolId of [
			"register_muscle_memory",
			"crystallize_muscle_memory",
			"track_muscle_usage",
		]) {
			expect(byToolId.get(toolId)?.annotations).toMatchObject({
				readOnlyHint: false,
				destructiveHint: false,
			});
		}
	});

	it("projects the Purpose Charter and owner brief as stable operator tools", async () => {
		const { db, inserts } = makeDb([]);
		const endpoints = [
			"organizationPurpose/getActive",
			"organizationPurpose/listRevisions",
			"organizationPurpose/createRevision",
			"organizationPurpose/getOwnerBrief",
		];
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints,
		});

		expect(
			new Map(result.items.map((item) => [item.endpoint, item.toolId])),
		).toEqual(
			new Map([
				["organizationPurpose/getActive", "get_active_purpose_charter"],
				["organizationPurpose/listRevisions", "list_purpose_charter_revisions"],
				[
					"organizationPurpose/createRevision",
					"create_purpose_charter_revision",
				],
				["organizationPurpose/getOwnerBrief", "get_owner_brief"],
			]),
		);
		const byToolId = new Map(inserts.map((tool) => [tool.toolId, tool]));
		expect(
			byToolId.get("get_active_purpose_charter")?.outputSchema,
		).toMatchObject({
			type: "object",
			required: ["charter"],
			properties: { charter: {} },
		});
		expect(byToolId.get("get_owner_brief")?.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
		});
		expect(
			byToolId.get("create_purpose_charter_revision")?.annotations,
		).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
		});
	});

	it("projects the knowledge-market report as a stable read tool", async () => {
		// flywheel P5 #6: verb-first generated id needs no override, and the GET
		// route must project read-only annotations.
		const { db } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: ["flywheelHealth/getKnowledgeMarketReport"],
		});

		expect(result.created).toBe(1);
		expect(result.items[0]).toMatchObject({
			toolId: "get_knowledge_market_report",
			endpoint: "flywheelHealth/getKnowledgeMarketReport",
			status: "created",
		});
	});

	it("projects canonical orphan-run health as a stable read tool", async () => {
		const { db, inserts } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: ["flywheelHealth/getOrphanRunHealth"],
		});

		expect(result).toMatchObject({ created: 1 });
		expect(result.items[0]).toMatchObject({
			toolId: "get_orphan_run_health",
			endpoint: "flywheelHealth/getOrphanRunHealth",
			status: "created",
		});
		expect(inserts[0]).toMatchObject({
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
			},
			inputSchema: {
				type: "object",
				properties: {
					sampleLimit: {
						type: "integer",
						minimum: 1,
						maximum: 100,
						default: 25,
					},
				},
			},
			config: {
				transport: "rpc",
				endpoint: "flywheelHealth/getOrphanRunHealth",
				method: "GET",
				responsePath: "json",
			},
		});
		expect(
			resolveContractEndpoint("flywheelHealth/getOrphanRunHealth")?.route?.path,
		).toBe("/flywheel/orphan-run-health");
	});

	it("repairs workflow read/write/destructive annotations from default intent", async () => {
		const { db, updates } = makeDb([
			makeRpcTool({
				toolId: "list_skill_workflow_retry_candidates",
				endpoint: "skills/listWorkflowRetryCandidates",
				annotations: { readOnlyHint: false },
			}),
			makeRpcTool({
				toolId: "inspect_skill_workflow_run",
				endpoint: "skills/inspectWorkflowRun",
				annotations: { readOnlyHint: false },
			}),
			makeRpcTool({
				toolId: "reject_skill_workflow",
				endpoint: "skills/rejectWorkflow",
				annotations: { readOnlyHint: true },
			}),
			makeRpcTool({
				toolId: "restart_skill_workflow",
				endpoint: "skills/restartWorkflow",
				annotations: { readOnlyHint: true },
			}),
			makeRpcTool({
				toolId: "send_skill_workflow_event",
				endpoint: "skills/runWorkflowSendEvent",
				annotations: { readOnlyHint: true },
			}),
		]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: [
				"skills/listWorkflowRetryCandidates",
				"skills/inspectWorkflowRun",
				"skills/rejectWorkflow",
				"skills/restartWorkflow",
				"skills/runWorkflowSendEvent",
			],
		});
		expect(result.updated).toBe(5);
		const annotations = new Map(
			updates.map(({ patch }) => [
				(patch.config as Record<string, unknown>).endpoint,
				patch.annotations,
			]),
		);
		expect(annotations.get("skills/listWorkflowRetryCandidates")).toMatchObject(
			{
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
			},
		);
		expect(annotations.get("skills/inspectWorkflowRun")).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
		});
		expect(annotations.get("skills/rejectWorkflow")).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		});
		expect(annotations.get("skills/restartWorkflow")).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		});
		expect(annotations.get("skills/runWorkflowSendEvent")).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		});
	});

	it("projects explicit widget overlays onto materialized oRPC tools", async () => {
		const { db } = makeDb([
			makeRpcTool({
				toolId: "get_catalog_stats",
				endpoint: "catalog/getStats",
			}),
		]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
			endpoints: ["catalog/getStats"],
			toolIdOverrides: { "catalog/getStats": "get_catalog_stats" },
			kindOverrides: { "catalog/getStats": "read" },
			widgetOverrides: {
				"catalog/getStats": {
					layoutId: "catalog-stats",
					description: "Catalog stats summary with source breakdown.",
					layoutSpec: {
						root: "stats",
						elements: {
							stats: {
								type: "StatGrid",
								props: { stats: [] },
								children: [],
							},
						},
					},
				},
			},
			includeInternal: true,
		});

		expect(result.items[0]).toMatchObject({
			toolId: "get_catalog_stats",
			endpoint: "catalog/getStats",
			status: "wouldUpdate",
			changed: expect.arrayContaining(["config", "widget"]),
		});
	});

	it("projects the canonical workflow catalog name, intent, and widget", async () => {
		const { db, inserts } = makeDb([]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: ["workflows/listDefinitions"],
			includeInternal: true,
		});

		expect(result.items[0]).toMatchObject({
			toolId: "list_workflow_definitions",
			endpoint: "workflows/listDefinitions",
			status: "created",
		});
		expect(inserts[0]).toMatchObject({
			toolId: "list_workflow_definitions",
			widgetKey: "render",
			widgetRoute: "/r/workflow-definitions",
			annotations: expect.objectContaining({
				readOnlyHint: true,
				destructiveHint: false,
			}),
			config: expect.objectContaining({
				endpoint: "workflows/listDefinitions",
				layoutId: "workflow-definitions",
				layoutSpec: expect.objectContaining({ root: "shell" }),
			}),
		});
	});

	it("projects workflow health with stable observe tooling and MCP UI", async () => {
		const { db, inserts } = makeDb([]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: ["workflows/listDefinitionHealth"],
			includeInternal: true,
		});

		expect(result.items[0]).toMatchObject({
			toolId: "list_workflow_definition_health",
			endpoint: "workflows/listDefinitionHealth",
			status: "created",
		});
		expect(inserts[0]).toMatchObject({
			toolId: "list_workflow_definition_health",
			widgetKey: "render",
			widgetRoute: "/r/workflow-health",
			annotations: expect.objectContaining({
				readOnlyHint: true,
				destructiveHint: false,
			}),
			config: expect.objectContaining({
				endpoint: "workflows/listDefinitionHealth",
				layoutId: "workflow-health",
				layoutSpec: expect.objectContaining({ root: "shell" }),
			}),
		});
	});

	it("uses existing tool ids when projecting existing endpoints", async () => {
		const { db } = makeDb([
			makeRpcTool({
				toolId: "get_tedi_call_costs",
				endpoint: "tediUsage/getCallCosts",
			}),
		]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
			endpoints: ["tediUsage/getCallCosts"],
		});

		expect(result.total).toBe(1);
		expect(result.items[0].toolId).toBe("get_tedi_call_costs");
		expect(result.items[0].endpoint).toBe("tediUsage/getCallCosts");
	});

	it("projects the full oRPC surface by default, including internal procedures", async () => {
		const { db } = makeDb([]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
		});
		const projectedEndpoints = result.items.map((item) => item.endpoint);

		expect(result.total).toBe(result.items.length);
		expect(new Set(projectedEndpoints).size).toBe(projectedEndpoints.length);
		expect(
			projectedEndpoints.some((endpoint) =>
				endpoint.startsWith("tenantBehavioralEvals/"),
			),
		).toBe(false);
		expect(
			projectedEndpoints.filter(
				(endpoint) =>
					endpoint.startsWith("cognitiveRuntime/") &&
					endpoint.includes("ArtifactRelease"),
			),
		).toEqual([]);
		expect(result.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					endpoint: "skills/listPromotionCandidates",
					status: "wouldCreate",
				}),
				expect.objectContaining({
					endpoint: "skills/auditToolCoverage",
					status: "wouldCreate",
				}),
				expect.objectContaining({
					endpoint: "toolSchemaSync/run",
					status: "wouldCreate",
				}),
				expect.objectContaining({
					endpoint: "workItems/create",
					status: "wouldCreate",
				}),
				expect.objectContaining({
					endpoint: "cognitiveRuntime/getStability",
					status: "wouldCreate",
				}),
				expect.objectContaining({
					endpoint: "workflows/listDefinitions",
					toolId: "list_workflow_definitions",
					status: "wouldCreate",
				}),
				expect.objectContaining({
					endpoint: "workflows/listDefinitionHealth",
					toolId: "list_workflow_definition_health",
					status: "wouldCreate",
				}),
				expect.objectContaining({
					endpoint: "workflows/listRuns",
					status: "wouldCreate",
				}),
			]),
		);
	});

	it("never projects human artifact release review endpoints, including explicit repair", async () => {
		const { db } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
			endpoints: [
				"cognitiveRuntime/createRedactedArtifactRevision",
				"cognitiveRuntime/getArtifactReleaseReview",
				"cognitiveRuntime/approveArtifactRelease",
				"cognitiveRuntime/revokeArtifactRelease",
			],
		});
		expect(result.total).toBe(0);
		expect(result.items).toEqual([]);
	});

	it("never projects tenant behavioral evals, including explicit router repair", async () => {
		const { db } = makeDb([]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
			router: "tenantBehavioralEvals",
		});

		expect(result.total).toBe(0);
		expect(result.items).toEqual([]);

		const unrelated = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
			endpoints: ["workflows/listDefinitions"],
		});
		expect(unrelated.items).toEqual([
			expect.objectContaining({ endpoint: "workflows/listDefinitions" }),
		]);
	});

	it.each(["mcpCredentials", "mcpGovernance"])(
		"never projects internal %s procedures as MCP tools",
		async (router) => {
			const { db } = makeDb([]);
			const result = await runToolSchemaSync(db, {
				mode: "projection",
				apply: false,
				router,
				includeInternal: true,
			});
			expect(result.total).toBe(0);
			expect(result.items).toEqual([]);
		},
	);

	it("drops the router suffix when the proc already names an object", async () => {
		// `rotate_access_key` for router `tedis` previously generated
		// `rotate_access_key_tedis`; now the proc stands alone.
		const { db } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
			endpoints: ["tedis/rotateAccessKey"],
		});
		const byEndpoint = new Map(
			result.items.map((item) => [item.endpoint, item.toolId]),
		);
		expect(byEndpoint.get("tedis/rotateAccessKey")).toBe("rotate_access_key");
	});

	it("keeps the router as the object for bare-verb procs", async () => {
		// `list` for router `skills` → `list_skills`.
		const { db } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
			endpoints: ["skills/list", "workflows/listRuns"],
		});
		const byEndpoint = new Map(
			result.items.map((item) => [item.endpoint, item.toolId]),
		);
		// skills/list resolves only when the contract exposes a bare `list`; if it
		// does not, the endpoint is filtered out, so only assert when present.
		if (byEndpoint.has("skills/list")) {
			expect(byEndpoint.get("skills/list")).toBe("list_skills");
		}
		expect(byEndpoint.get("workflows/listRuns")).toBe("list_runs");
	});

	it("slots the router after the verb for preposition procs", async () => {
		// `list_by_app` for router `skills` → `list_skills_by_app`.
		const { db } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
			endpoints: ["skills/listByApp", "skills/getForMcp"],
		});
		const byEndpoint = new Map(
			result.items.map((item) => [item.endpoint, item.toolId]),
		);
		expect(byEndpoint.get("skills/listByApp")).toBe("list_skills_by_app");
		expect(byEndpoint.get("skills/getForMcp")).toBe("get_skills_for_mcp");
	});

	it("leaves procs that already contain the router token untouched", async () => {
		// `search` for router `memory_graph` → bare verb keeps `search_memory_graph`;
		// the proc never carries a redundant router suffix.
		const { db } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
			endpoints: ["memoryGraph/search"],
		});
		const byEndpoint = new Map(
			result.items.map((item) => [item.endpoint, item.toolId]),
		);
		if (byEndpoint.has("memoryGraph/search")) {
			expect(byEndpoint.get("memoryGraph/search")).toBe("search_memory_graph");
		}
	});

	it("disambiguates colliding generated tool ids with the router prefix", async () => {
		// workflows/getStatus and tedis/getStatus both generate `get_status`;
		// every colliding entry is decorated deterministically with its router.
		const { db } = makeDb([]);
		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
			endpoints: ["workflows/getStatus", "tedis/getStatus"],
		});
		const byEndpoint = new Map(
			result.items.map((item) => [item.endpoint, item.toolId]),
		);
		expect(byEndpoint.get("workflows/getStatus")).toBe("get_workflows_status");
		expect(byEndpoint.get("tedis/getStatus")).toBe("get_tedis_status");
	});

	it("rejects the sync when two overrides claim the same tool id", async () => {
		// Overrides are never collision-adjusted, so a duplicate override would
		// hit the (app_id, tool_id) unique index — or worse, upsertTool would
		// clobber the sibling row in place. The lint fails before any write and
		// names both the tool id and the colliding endpoints.
		const { db, updates, inserts } = makeDb([]);

		await expect(
			runToolSchemaSync(db, {
				mode: "projection",
				apply: true,
				endpoints: ["workflows/getStatus", "tedis/getStatus"],
				toolIdOverrides: {
					"workflows/getStatus": "get_status_everywhere",
					"tedis/getStatus": "get_status_everywhere",
				},
			}),
		).rejects.toThrow(
			/TOOL_ID_COLLISION.*"get_status_everywhere".*tedis\/getStatus.*workflows\/getStatus|TOOL_ID_COLLISION.*"get_status_everywhere".*workflows\/getStatus.*tedis\/getStatus/,
		);
		expect(updates).toHaveLength(0);
		expect(inserts).toHaveLength(0);
	});

	it("rejects the sync when an override collides with a generated tool id", async () => {
		// workflows/getStatus is pinned to `get_status`; tedis/getStatus generates
		// `get_status` and — being alone in its bucket — is never disambiguated.
		const { db, inserts } = makeDb([]);

		await expect(
			runToolSchemaSync(db, {
				mode: "projection",
				apply: true,
				endpoints: ["workflows/getStatus", "tedis/getStatus"],
				toolIdOverrides: { "workflows/getStatus": "get_status" },
			}),
		).rejects.toThrow(/TOOL_ID_COLLISION.*"get_status"/);
		expect(inserts).toHaveLength(0);
	});

	it("renames existing rows in place when regenerateToolIds is set", async () => {
		// Aggressive mode: a row holding the legacy suffixed name is renamed to
		// the convention-correct generated name, keeping its row id.
		const { db, updates } = makeDb([
			makeRpcTool({
				id: "tool-legacy",
				toolId: "rotate_access_key_tedis",
				endpoint: "tedis/rotateAccessKey",
			}),
		]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: ["tedis/rotateAccessKey"],
			regenerateToolIds: true,
		});

		expect(result.updated).toBe(1);
		expect(result.items[0]).toMatchObject({
			toolUuid: "tool-legacy",
			toolId: "rotate_access_key",
			endpoint: "tedis/rotateAccessKey",
			status: "updated",
		});
		expect(updates[0].id).toBe("tool-legacy");
		expect(updates[0].patch.toolId).toBe("rotate_access_key");
	});

	it("preserves the existing tool id when regenerateToolIds is not set", async () => {
		const { db } = makeDb([
			makeRpcTool({
				id: "tool-legacy",
				toolId: "rotate_access_key_tedis",
				endpoint: "tedis/rotateAccessKey",
			}),
		]);

		const result = await runToolSchemaSync(db, {
			mode: "projection",
			apply: false,
			endpoints: ["tedis/rotateAccessKey"],
		});

		expect(result.items[0].toolId).toBe("rotate_access_key_tedis");
	});

	it("keeps promotion candidate projection compact", () => {
		const schema = zodToStructuredOutputJsonSchema(
			procedureOutputSchema(skillsContract.listPromotionCandidates),
		) as {
			properties?: {
				entries?: {
					items?: { properties?: Record<string, unknown> };
				};
			};
		};
		const entryProperties = schema.properties?.entries?.items?.properties ?? {};

		expect(entryProperties).toHaveProperty("tediId");
		expect(entryProperties).toHaveProperty("successCount");
		expect(entryProperties).not.toHaveProperty("content");
		expect(entryProperties).not.toHaveProperty("files");
		expect(entryProperties).not.toHaveProperty("inputSchema");
	});

	it("projects workflow-history reconciliation fields", () => {
		const schema = zodToStructuredOutputJsonSchema(
			procedureOutputSchema(skillsContract.runWorkflowHistory),
		) as {
			properties?: {
				runs?: {
					items?: { properties?: Record<string, unknown> };
				};
			};
		};
		const runProperties = schema.properties?.runs?.items?.properties ?? {};

		expect(runProperties).toHaveProperty("runtimeEnvironment");
		expect(runProperties).toHaveProperty("lastReconciledAt");
		expect(runProperties).not.toHaveProperty("params");
		expect(runProperties).not.toHaveProperty("capabilityManifest");
	});

	it("projects media artifact metadata separately from wrapper artifact mime", () => {
		const schema = zodToStructuredOutputJsonSchema(
			procedureOutputSchema(skillsContract.getRunArtifact),
		) as {
			properties?: Record<string, unknown>;
		};
		const properties = schema.properties ?? {};

		expect(properties).toHaveProperty("mimeType");
		expect(properties).toHaveProperty("mediaMimeType");
		expect(properties).toHaveProperty("mediaPath");
		expect(properties).toHaveProperty("mediaKind");
		expect(properties).toHaveProperty("mediaBase64");
	});
});

describe("runToolSchemaSync subscription publishes", () => {
	function makeRecordingEnv() {
		const published: Array<{ appId?: string; method: string }> = [];
		const env = {
			MCP_SERVICE: {
				fetch: async (req: Request) => {
					published.push(
						(await req.json()) as { appId?: string; method: string },
					);
					return new Response(null, { status: 200 });
				},
			},
		} as unknown as CloudflareEnv;
		return { env, published };
	}

	it("publishes tools + resources list_changed after an applied sync that changed rows", async () => {
		const { db } = makeDb([
			makeRpcTool({
				id: "tool-stale",
				toolId: "probe_removed_runtime",
				endpoint: "tedis/probeRemovedRuntime",
			}),
		]);
		const { env, published } = makeRecordingEnv();

		const result = await runToolSchemaSync(
			db,
			{ apply: true, toolIds: ["probe_removed_runtime"] },
			env,
		);

		expect(result.deleted).toBe(1);
		expect(published.map((p) => p.method)).toEqual([
			"notifications/tools/list_changed",
			"notifications/resources/list_changed",
		]);
		for (const event of published) {
			expect(event.appId).toBe("5eed0020-0000-4000-8000-000000000020");
		}
	});

	it("does not publish for a preview (apply: false) run", async () => {
		const { db } = makeDb([
			makeRpcTool({
				id: "tool-stale",
				toolId: "probe_removed_runtime",
				endpoint: "tedis/probeRemovedRuntime",
			}),
		]);
		const { env, published } = makeRecordingEnv();

		await runToolSchemaSync(
			db,
			{ apply: false, toolIds: ["probe_removed_runtime"] },
			env,
		);

		expect(published).toHaveLength(0);
	});
});

describe("durable worker projection transport budget", () => {
	it.each([
		"runTediDurableCode",
		"approveTediCodeExecution",
		"rollbackTediCodeExecution",
	])("authors budget for %s", async (proc) => {
		const { db, inserts } = makeDb([]);
		await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: [`tedis/${proc}`],
		});
		expect(inserts[0]?.config?.timeout).toBe(315000);
	});
	it.each([15000, 315000, 400000, NaN, Infinity, "bad"])(
		"regenerates persisted budget %s safely",
		async (timeout) => {
			const { db, updates } = makeDb([
				makeRpcTool({
					toolId: "run_tedi_durable_code",
					endpoint: "tedis/runTediDurableCode",
					config: { timeout },
				}),
			]);
			await runToolSchemaSync(db, {
				mode: "projection",
				apply: true,
				endpoints: ["tedis/runTediDurableCode"],
			});
			expect(updates[0]?.patch.config?.timeout).toBe(
				typeof timeout === "number" && Number.isFinite(timeout)
					? Math.max(315000, timeout)
					: 315000,
			);
		},
	);
	it("leaves ordinary read projection at its existing default", async () => {
		const { db, inserts } = makeDb([]);
		await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: ["tedis/getTediCodeExecution"],
		});
		expect(inserts[0]?.config?.timeout).toBeUndefined();
	});
});

it("projects background subscription controls and persistent state with explicit effects", async () => {
	const endpoints = [
		"osGadgetState/get",
		"osGadgetState/put",
		"osGadgetState/delete",
		"providerEvents/register",
		"providerEvents/list",
		"providerEvents/disable",
		"providerEvents/reconcile",
	];
	const { db, inserts } = makeDb([]);
	const result = await runToolSchemaSync(db, {
		mode: "projection",
		apply: true,
		endpoints,
	});
	expect(result.failed).toBe(0);
	expect(inserts).toHaveLength(endpoints.length);
	for (const endpoint of endpoints) {
		const tool = inserts.find(
			(row) => row.toolId === OS_TOOL_ID_OVERRIDES[endpoint],
		);
		expect(tool).toBeDefined();
		expect(tool?.config).toMatchObject({ transport: "rpc", endpoint });
		expect(tool?.annotations?.readOnlyHint).toBe(
			OS_KIND_OVERRIDES[endpoint] === "read",
		);
		expect(tool?.annotations?.destructiveHint).toBe(
			OS_KIND_OVERRIDES[endpoint] === "destructive",
		);
	}
});

describe("calendar and personal consent projections", () => {
	it("projects the callback tool as a destructive, pinned reconciliation operation", async () => {
		const { db, inserts } = makeDb([]);
		await runToolSchemaSync(db, {
			mode: "projection",
			apply: true,
			endpoints: ["calendarCoordinator/reconcileSubscription"],
		});
		const tool = inserts.find(
			(t) => t.toolId === "reconcile_calendar_subscription",
		);
		expect(tool?.config).toMatchObject({
			endpoint: "calendarCoordinator/reconcileSubscription",
		});
		expect(tool?.inputSchema).toMatchObject({
			required: expect.arrayContaining([
				"subscriptionId",
				"expectedSkillRevision",
			]),
		});
		expect(OS_KIND_OVERRIDES["calendarCoordinator/reconcileSubscription"]).toBe(
			"destructive",
		);
	});
	it("keeps consent and external mutations distinct from inventory and persisted previews", () => {
		for (const endpoint of [
			"personalResourceDelegations/create",
			"personalResourceDelegations/revoke",
			"calendarCoordinator/activate",
			"calendarCoordinator/apply",
			"calendarCoordinator/compensate",
		])
			expect(OS_KIND_OVERRIDES[endpoint]).toBe("destructive");
		for (const endpoint of [
			"calendarCoordinator/supportedAccounts",
			"calendarCoordinator/listCalendars",
			"calendarCoordinator/status",
			"personalResourceDelegations/list",
		])
			expect(OS_KIND_OVERRIDES[endpoint]).toBe("read");
		for (const endpoint of [
			"calendarCoordinator/preview",
			"calendarCoordinator/previewCompensation",
			"calendarCoordinator/recover",
		])
			expect(OS_KIND_OVERRIDES[endpoint]).toBe("write");
	});
});

it("projects all six CLI endpoint/name/scope triples through the existing authority resolver", () => {
	expect(WORK_HIERARCHY_TOOL_ID_OVERRIDES["workItems/listCliProjection"]).toBe(
		"list_work_item_cli_rows",
	);
	expect(
		resolveMcpToolRequiredScopes(
			{
				toolId: "list_work_item_cli_rows",
				toolTypeId: "rpc",
				config: { endpoint: "workItems/listCliProjection" },
			},
			"selected_org",
			undefined,
		),
	).toEqual(["mcp:work.read"]);
	expect(
		WORK_HIERARCHY_TOOL_ID_OVERRIDES["workItems/getCheckpointProjection"],
	).toBe("get_work_item_checkpoint");
	expect(
		resolveMcpToolRequiredScopes(
			{
				toolId: "get_work_item_checkpoint",
				toolTypeId: "rpc",
				config: { endpoint: "workItems/getCheckpointProjection" },
			},
			"selected_org",
			undefined,
		),
	).toEqual(["mcp:work.read"]);
	expect(
		WORK_HIERARCHY_TOOL_ID_OVERRIDES["workItems/listAttemptCliProjection"],
	).toBe("list_work_attempt_cli_rows");
	expect(
		resolveMcpToolRequiredScopes(
			{
				toolId: "list_work_attempt_cli_rows",
				toolTypeId: "rpc",
				config: { endpoint: "workItems/listAttemptCliProjection" },
			},
			"selected_org",
			undefined,
		),
	).toEqual(["mcp:work.read"]);
	expect(
		WORK_HIERARCHY_TOOL_ID_OVERRIDES["workItems/listEvidenceCliProjection"],
	).toBe("list_work_evidence_cli_rows");
	expect(
		resolveMcpToolRequiredScopes(
			{
				toolId: "list_work_evidence_cli_rows",
				toolTypeId: "rpc",
				config: { endpoint: "workItems/listEvidenceCliProjection" },
			},
			"selected_org",
			undefined,
		),
	).toEqual(["mcp:work.read"]);
	expect(
		WORK_HIERARCHY_TOOL_ID_OVERRIDES["workItems/listEventCliProjection"],
	).toBe("list_work_event_cli_rows");
	expect(
		resolveMcpToolRequiredScopes(
			{
				toolId: "list_work_event_cli_rows",
				toolTypeId: "rpc",
				config: { endpoint: "workItems/listEventCliProjection" },
			},
			"selected_org",
			undefined,
		),
	).toEqual(["mcp:work.read"]);
	expect(
		WORK_HIERARCHY_TOOL_ID_OVERRIDES["workInteractions/listCliInboxProjection"],
	).toBe("list_work_interaction_cli_rows");
	expect(
		resolveMcpToolRequiredScopes(
			{
				toolId: "list_work_interaction_cli_rows",
				toolTypeId: "rpc",
				config: { endpoint: "workInteractions/listCliInboxProjection" },
			},
			"selected_org",
			undefined,
		),
	).toEqual(["mcp:messaging.read"]);
});

it("keeps exact read projections denied for missing/wrong scope and unknown alias endpoint", () => {
	const tool = {
		toolId: "list_work_interaction_cli_rows",
		toolTypeId: "rpc",
		config: { endpoint: "workInteractions/listCliInboxProjection" },
	};
	expect(
		isMcpToolVisibleToCaller(tool, "org_alias", undefined, {
			authType: "oauth",
			scopes: ["mcp:work.read"],
		}),
	).toBe(false);
	expect(
		isMcpToolVisibleToCaller(tool, "org_alias", undefined, {
			authType: "oauth",
			scopes: [],
		}),
	).toBe(false);
	expect(
		isMcpToolVisibleToCaller(tool, "org_alias", undefined, {
			authType: "oauth",
			scopes: ["mcp:messaging.read"],
		}),
	).toBe(true);
	expect(
		isMcpToolVisibleToCaller(
			{
				toolId: "list_unknown_projection",
				toolTypeId: "rpc",
				config: { endpoint: "unknown/listCliProjection" },
			},
			"org_alias",
			undefined,
			{ authType: "oauth", scopes: ["mcp:work.read"] },
		),
	).toBe(false);
});
