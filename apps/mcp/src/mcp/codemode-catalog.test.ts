import { executeCatalogOperation } from "./codemode";
/**
 * Locks the contract that `discover.search` and `discover.list_namespaces`
 * preserve `annotations` and `outputSchema` per tool — independent of the
 * 32k MAX_CODEMODE_DESCRIPTION_CHARS budget that truncates the compact TS
 * types block in the outer `code` tool description.
 *
 * The catalog is an in-memory data structure built by `buildCatalogProvider`
 * and served by `discover.*` at runtime; it does not live in the description
 * string, so type-budget overflow must not strip these signals.
 *
 * Background: Sam Morrow Part 3 — destructive intent + return shape must
 * survive even when a large tedi (e.g. tedix-unified with 1641 tools across
 * 69 namespaces) blows past the description budget.
 */

import { describe, expect, it, vi } from "vite-plus/test";

import {
	buildCatalogProvider,
	shapeCodeModeResultForModel,
	enrichToolNotFoundError,
	enrichUnmountedNamespaceError,
} from "./codemode";
import type { AppTool, ServerContext } from "./server-context";

function tool(overrides: Partial<AppTool>): AppTool {
	return {
		id: `row-${overrides.toolId ?? "tool"}`,
		toolId: "tool_id",
		title: "Tool Title",
		description: "tool description",
		toolTypeId: "rpc",
		inputSchema: { type: "object", properties: {} },
		outputSchema: null,
		config: null,
		icons: null,
		executionTaskSupport: null,
		annotations: null,
		meta: null,
		invocationStatus: null,
		fileParams: null,
		adapterScope: null,
		resultStrategy: null,
		outputTemplate: null,
		widgetKey: null,
		widgetRoute: null,
		widgetAccessible: null,
		visibility: null,
		widgetDescription: null,
		widgetPrefersBorder: null,
		widgetDomain: null,
		schemaDialect: null,
		schemaSource: null,
		schemaSourceRef: null,
		schemaSourceHash: null,
		schemaSyncedAt: null,
		sortOrder: null,
		enabled: true,
		createdAt: null,
		updatedAt: null,
		...overrides,
	};
}

function buildLargeServerCtx(toolCount: number): ServerContext {
	const loadedTools = new Map<string, AppTool>();
	for (let i = 0; i < toolCount; i++) {
		const isDelete = i % 7 === 0;
		const isReadOnly = i % 3 === 0 && !isDelete;
		const toolId = isDelete
			? `app__delete_thing_${i}`
			: isReadOnly
				? `app__list_things_${i}`
				: `app__do_thing_${i}`;
		loadedTools.set(
			toolId,
			tool({
				id: `row-${i}`,
				toolId,
				title: toolId,
				description: `Tool number ${i} — `.repeat(20),
				annotations: isDelete
					? {
							destructiveHint: true,
							readOnlyHint: false,
							idempotentHint: true,
							openWorldHint: false,
						}
					: isReadOnly
						? {
								destructiveHint: false,
								readOnlyHint: true,
								idempotentHint: true,
								openWorldHint: false,
							}
						: null,
				outputSchema: {
					type: "object",
					properties: {
						id: { type: "string" },
						kind: { type: "string", const: isDelete ? "deleted" : "ok" },
					},
				},
			}),
		);
	}
	return { loadedTools } as unknown as ServerContext;
}

async function runSearch(
	provider: ReturnType<typeof buildCatalogProvider>,
	query: string,
	limit = 50,
	extra: Record<string, unknown> = {},
): Promise<CatalogSearchResult> {
	const tools = provider.tools as Record<
		string,
		{ execute: (input: unknown) => Promise<unknown> }
	>;
	const exec = tools.search?.execute;
	if (!exec) throw new Error("discover.search not registered");
	const result = (await exec({
		query,
		limit,
		...extra,
	})) as CatalogSearchResult;
	return result;
}

// discover.search returns a plain object — decorated arrays lose their
// expando props at the sandbox RPC boundary.
type CatalogSearchResult = {
	results: Array<Record<string, unknown>>;
	namespaces: Record<string, Record<string, Record<string, unknown>>>;
	meta: Record<string, unknown>;
};

function catalogToolEntries(results: CatalogSearchResult) {
	return results.results;
}

function namespaceTools(
	results: CatalogSearchResult,
	namespace: string,
): Record<string, Record<string, unknown>> | undefined {
	return results.namespaces[namespace];
}

function resultMeta(results: CatalogSearchResult): Record<string, unknown> {
	return results.meta ?? {};
}

describe("Code Mode catalog (discover.*) annotations + outputSchema", () => {
	it("keeps discovery alive when one tool has no capability mapping", async () => {
		const ctx = buildLargeServerCtx(1);
		ctx.loadedTools.set(
			"unknown__create_app_tool",
			tool({ toolId: "unknown__create_app_tool", title: "Unclassified" }),
		);
		const provider = buildCatalogProvider(ctx, undefined);
		const results = await runSearch(provider, "Unclassified");
		expect(results.results).toContainEqual(
			expect.objectContaining({
				authorized: false,
				scopeMappingMissing: true,
			}),
		);
	});

	it("preserves destructiveHint; surfaces outputSchema on includeOutputSchema opt-in", async () => {
		const ctx = buildLargeServerCtx(50);
		const provider = buildCatalogProvider(ctx, undefined);
		// Default discovery is compact: annotations stay, outputSchema is omitted.
		const compact = catalogToolEntries(
			await runSearch(provider, "delete_thing"),
		);
		expect(compact.length).toBeGreaterThan(0);
		expect(compact[0]!.annotations).toMatchObject({ destructiveHint: true });
		expect(compact[0]!.outputSchema).toBeUndefined();
		// Opt in to recover the return shape for downstream planning.
		const results = await runSearch(provider, "delete_thing", 50, {
			includeOutputSchema: true,
		});
		const entries = catalogToolEntries(results);
		expect(entries.length).toBeGreaterThan(0);
		const sample = entries[0]!;
		expect(sample.annotations).toMatchObject({ destructiveHint: true });
		expect(sample.outputSchema).toMatchObject({ type: "object" });
		expect(sample.callable).toEqual(expect.any(String));
	});

	it("preserves readOnlyHint on list_* tools", async () => {
		const ctx = buildLargeServerCtx(50);
		const provider = buildCatalogProvider(ctx, undefined);
		const results = await runSearch(provider, "list_things", 50, {
			includeOutputSchema: true,
		});
		const entries = catalogToolEntries(results);
		expect(entries.length).toBeGreaterThan(0);
		const entry = entries[0]!;
		expect(entry.annotations).toMatchObject({ readOnlyHint: true });
		expect(entry.outputSchema).toBeDefined();
	});

	it("humanizes weak/placeholder descriptions from the verb-first tool name", async () => {
		const ctx = {
			loadedTools: new Map<string, AppTool>([
				// Placeholder description from tool-schema-sync (contract had no summary).
				[
					"tedix__assemble_memory_graph",
					tool({
						id: "row-mem",
						toolId: "tedix__assemble_memory_graph",
						description: "Tedix oRPC endpoint memoryGraph/assemble",
					}),
				],
				// Empty description.
				[
					"tedix__list_adapter_bindings_by_app",
					tool({
						id: "row-adp",
						toolId: "tedix__list_adapter_bindings_by_app",
						description: "",
					}),
				],
				// Real authored description must be left untouched.
				[
					"tedix__record_skills",
					tool({
						id: "row-skill",
						toolId: "tedix__record_skills",
						description: "Persist a reusable skill for the org library.",
					}),
				],
			]),
		} as unknown as ServerContext;
		const provider = buildCatalogProvider(ctx, undefined);
		const byTool = (results: CatalogSearchResult, name: string) =>
			catalogToolEntries(results).find(
				(e) => (e as { tool?: string }).tool === name,
			) as { description?: string } | undefined;
		expect(
			byTool(await runSearch(provider, "memory", 10), "assemble_memory_graph")
				?.description,
		).toBe("Assemble memory graph.");
		expect(
			byTool(
				await runSearch(provider, "adapter bindings", 10),
				"list_adapter_bindings_by_app",
			)?.description,
		).toBe("List adapter bindings by app.");
		// Real authored description is left untouched.
		expect(
			byTool(await runSearch(provider, "record skills", 10), "record_skills")
				?.description,
		).toBe("Persist a reusable skill for the org library.");
	});

	it("surfaces schema freshness per tool and catalog build freshness in search metadata", async () => {
		const ctx = {
			loadedTools: new Map<string, AppTool>([
				[
					"tedix__list_skills",
					tool({
						id: "row-skills",
						toolId: "tedix__list_skills",
						title: "List skills",
						description: "List recent skills for a tedi.",
						schemaDialect: "json-schema-2020-12",
						schemaSource: "orpc",
						schemaSourceRef: "skills/list",
						schemaSourceHash: "sha256:abc123",
						schemaSyncedAt: "2026-06-14T18:04:17.468Z",
						updatedAt: "2026-06-14T18:04:17.468Z",
					}),
				],
				[
					"tedix__legacy_unsynced",
					tool({
						id: "row-legacy",
						toolId: "tedix__legacy_unsynced",
						title: "Legacy unsynced",
						description: "Fixture without schema sync metadata.",
					}),
				],
			]),
		} as unknown as ServerContext;
		const provider = buildCatalogProvider(ctx, undefined);
		const results = await runSearch(provider, "skills", 10);

		const entry = namespaceTools(results, "tedix")?.list_skills;
		expect(entry?.schemaFreshness).toMatchObject({
			dialect: "json-schema-2020-12",
			source: "orpc",
			sourceRef: "skills/list",
			sourceHash: "sha256:abc123",
			syncedAt: "2026-06-14T18:04:17.468Z",
			toolUpdatedAt: "2026-06-14T18:04:17.468Z",
		});

		const freshness = resultMeta(results).freshness as Record<string, unknown>;
		expect(freshness).toMatchObject({
			schemaSyncedTools: 1,
			oldestSchemaSyncedAt: "2026-06-14T18:04:17.468Z",
			newestSchemaSyncedAt: "2026-06-14T18:04:17.468Z",
		});
		expect(freshness.toolCount).toBeGreaterThanOrEqual(2);
		expect(freshness.namespaceCount).toBeGreaterThanOrEqual(3);
		expect(freshness.unsyncedTools).toBe(
			Number(freshness.toolCount) - Number(freshness.schemaSyncedTools),
		);
		expect(freshness.catalogBuiltAt).toEqual(expect.any(String));
	});

	it("survives a catalog that would overflow the 32k type budget", async () => {
		// 2_500 tools × verbose descriptions guarantees the compact-types block
		// alone would exceed MAX_CODEMODE_DESCRIPTION_CHARS (32_000), forcing
		// the type-signature drop. The catalog data path must remain intact.
		const ctx = buildLargeServerCtx(2_500);
		const provider = buildCatalogProvider(ctx, undefined);

		const destructive = await runSearch(provider, "delete_thing", 100, {
			includeOutputSchema: true,
		});
		const destructiveEntries = catalogToolEntries(destructive);
		expect(destructiveEntries.length).toBeGreaterThan(0);
		for (const entry of destructiveEntries) {
			expect(entry.annotations).toMatchObject({ destructiveHint: true });
			expect(entry.outputSchema).toBeDefined();
		}

		const readOnly = await runSearch(provider, "list_things", 100, {
			includeOutputSchema: true,
		});
		const readOnlyEntries = catalogToolEntries(readOnly);
		expect(readOnlyEntries.length).toBeGreaterThan(0);
		for (const entry of readOnlyEntries) {
			expect(entry.annotations).toMatchObject({ readOnlyHint: true });
			expect(entry.outputSchema).toBeDefined();
		}
	});

	it("omits annotations only when the source tool has none (no synthetic defaults)", async () => {
		const ctx = {
			loadedTools: new Map<string, AppTool>([
				[
					"app__plain_tool",
					tool({
						id: "row-plain",
						toolId: "app__plain_tool",
						annotations: null,
						outputSchema: null,
					}),
				],
			]),
		} as unknown as ServerContext;
		const provider = buildCatalogProvider(ctx, undefined);
		const results = await runSearch(provider, "plain_tool");
		const entry = catalogToolEntries(results)[0]!;
		expect(entry.annotations).toBeUndefined();
		expect(entry.outputSchema).toBeUndefined();
		expect(entry.callable).toEqual(expect.any(String));
	});

	it("ranks broad natural-language searches instead of requiring every term to match", async () => {
		const ctx = {
			loadedTools: new Map<string, AppTool>([
				[
					"google_gmail_tedix__search_threads",
					tool({
						id: "row-gmail",
						toolId: "google_gmail_tedix__search_threads",
						title: "Search Gmail threads",
						description: "Search Gmail inbox threads and email conversations.",
					}),
				],
				[
					"cpo__get_tedi_runtime_status",
					tool({
						id: "row-cpo-runtime",
						toolId: "cpo__get_tedi_runtime_status",
						title: "Get tedi runtime status",
						description: "Inspect runtime events, queue depth, and logs.",
					}),
				],
			]),
		} as unknown as ServerContext;
		const provider = buildCatalogProvider(ctx, undefined);

		const gmail = await runSearch(
			provider,
			"gmail google workspace mail messages inbox",
		);
		expect(
			namespaceTools(gmail, "google_gmail_tedix")?.search_threads?._match,
		).toMatchObject({
			matchedTerms: expect.arrayContaining(["gmail", "google", "inbox"]),
			unmatchedTerms: expect.arrayContaining(["workspace"]),
		});

		const cpo = await runSearch(
			provider,
			"tedi conversations runtime events logs cpo",
		);
		expect(namespaceTools(cpo, "cpo")?.get_tedi_runtime_status?.callable).toBe(
			"cpo.get_tedi_runtime_status",
		);
		expect(
			namespaceTools(cpo, "cpo")?.get_tedi_runtime_status?._match,
		).toMatchObject({
			matchedTerms: expect.arrayContaining(["tedi", "runtime", "logs", "cpo"]),
		});
	});

	it("bounds the indexed description and keeps repeat searches stable", async () => {
		// A broad search over the aggregate Connect catalog (13k tools, vendor
		// REST-doc descriptions) exceeded the Worker CPU limit. Only a bounded
		// description prefix is indexed, and each entry is normalized once.
		const ctx = {
			loadedTools: new Map<string, AppTool>([
				[
					"vendor__get_report",
					tool({
						id: "row-vendor",
						toolId: "vendor__get_report",
						title: "Get report",
						description: `Report summary. ${"filler ".repeat(1_000)} quarterlyledger`,
					}),
				],
			]),
		} as unknown as ServerContext;
		const provider = buildCatalogProvider(ctx, undefined);

		const head = await runSearch(provider, "report summary");
		expect(namespaceTools(head, "vendor")?.get_report).toBeDefined();
		const again = await runSearch(provider, "report summary");
		expect(again.results).toEqual(head.results);

		const tail = await runSearch(provider, "quarterlyledger");
		expect(namespaceTools(tail, "vendor")?.get_report).toBeUndefined();
	});

	it("returns discovery metadata and nearest namespaces when a search is empty", async () => {
		const ctx = {
			loadedTools: new Map<string, AppTool>([
				[
					"google_gmail_tedix__search_threads",
					tool({
						id: "row-gmail",
						toolId: "google_gmail_tedix__search_threads",
						title: "Search Gmail threads",
					}),
				],
			]),
		} as unknown as ServerContext;
		const provider = buildCatalogProvider(ctx, undefined);
		const results = await runSearch(provider, "gmaik", 10);

		const discovery = resultMeta(results).discovery as Record<string, unknown>;
		expect(discovery).toMatchObject({
			mode: "empty",
			query: "gmaik",
		});
		const nearest = discovery.nearestNamespaces as Array<
			Record<string, unknown>
		>;
		expect(nearest[0]).toMatchObject({ namespace: "google_gmail_tedix" });
	});
});

describe("progressive disclosure (namespace filter, description budget, schema page size)", () => {
	function twoNamespaceCtx(): ServerContext {
		return {
			loadedTools: new Map<string, AppTool>([
				[
					"initech__get_invoices",
					tool({
						id: "row-initech",
						toolId: "initech__get_invoices",
						title: "Get invoices",
						description: `Returns invoices. ${"Vendor REST doc dump. ".repeat(60)}`,
						config: { endpoint: "initech/getInvoices" },
					}),
				],
				[
					"work__list_work_items",
					tool({
						id: "row-work",
						toolId: "work__list_work_items",
						title: "List work items",
						description: "List work items with filters.",
						config: { endpoint: "work/listWorkItems" },
					}),
				],
			]),
		} as unknown as ServerContext;
	}

	it("honors the namespace filter on ranked and browse searches", async () => {
		const provider = buildCatalogProvider(twoNamespaceCtx(), undefined);

		const ranked = await runSearch(provider, "list", 10, {
			namespace: "work",
		});
		const rankedRows = catalogToolEntries(ranked);
		expect(rankedRows.length).toBeGreaterThan(0);
		for (const row of rankedRows) expect(row.namespace).toBe("work");

		const browse = await runSearch(provider, "", 10, { namespace: "initech" });
		const browseRows = catalogToolEntries(browse);
		expect(browseRows.length).toBeGreaterThan(0);
		for (const row of browseRows) expect(row.namespace).toBe("initech");
		expect(resultMeta(browse).discovery).toMatchObject({
			namespace: "initech",
			mode: "browse",
		});
	});

	it("rejects an unknown namespace with a thrown error instead of silently ignoring it", async () => {
		// Expando props on the result array are stripped at the sandbox RPC
		// boundary, so an annotated empty page would be indistinguishable from a
		// real empty catalog — the rejection must be an error to be visible.
		const provider = buildCatalogProvider(twoNamespaceCtx(), undefined);
		await expect(
			runSearch(provider, "list", 10, { namespace: "inotech" }),
		).rejects.toThrow(/Unknown namespace "inotech".*initech/);
	});

	it("truncates long descriptions on search rows; describe returns the full text", async () => {
		const provider = buildCatalogProvider(twoNamespaceCtx(), undefined);
		const results = await runSearch(provider, "invoices", 10);
		const row = catalogToolEntries(results).find(
			(entry) => entry.callable === "initech.get_invoices",
		);
		expect(row).toBeDefined();
		expect(row?.descriptionTruncated).toBe(true);
		expect((row?.description as string).length).toBeLessThan(320);
		expect(row?.description).toMatch(/…$/);

		// Short descriptions pass through untouched, without the flag.
		const shortRow = catalogToolEntries(
			await runSearch(provider, "work items", 10),
		).find((entry) => entry.callable === "work.list_work_items");
		expect(shortRow?.description).toBe("List work items with filters.");
		expect(shortRow?.descriptionTruncated).toBeUndefined();

		const tools = provider.tools as Record<
			string,
			{ execute: (input: unknown) => Promise<unknown> }
		>;
		const described = (await tools.describe?.execute?.({
			callable: "initech.get_invoices",
		})) as Record<string, unknown>;
		expect((described.description as string).includes("…")).toBe(false);
		expect((described.description as string).length).toBeGreaterThan(1000);
		expect(described.descriptionTruncated).toBeUndefined();
	});

	it("keeps the paid-tool notice intact when truncating", async () => {
		const paidCtx = {
			loadedTools: new Map<string, AppTool>([
				[
					"scan__scan_hostname",
					tool({
						id: "row-paid",
						toolId: "scan__scan_hostname",
						title: "Scan hostname",
						description: `Scans a hostname. ${"Long vendor prose. ".repeat(40)}`,
						config: {
							endpoint: "scan/hostname",
							payment: {
								enabled: true,
								amount: "0.10",
								network: "base",
								recipient: "0x1111111111111111111111111111111111111111",
							},
						},
					}),
				],
			]),
		} as unknown as ServerContext;
		const provider = buildCatalogProvider(paidCtx, undefined);
		const row = catalogToolEntries(await runSearch(provider, "scan", 10)).find(
			(entry) => entry.callable === "scan.scan_hostname",
		);
		expect(row?.descriptionTruncated).toBe(true);
		expect(row?.description).toContain("Paid tool: 0.10");
	});

	it("annotates rows with caller-relative authorization through the dispatch-gate seam", async () => {
		const loadedTools = new Map<string, AppTool>([
			[
				"gated_tool",
				tool({
					id: "row-gated",
					toolId: "gated_tool",
					title: "Gated tool",
					description: "Requires an explicit scope.",
					config: { endpoint: "vault/openVault" },
				}),
			],
			[
				"open_tool",
				tool({
					id: "row-open",
					toolId: "open_tool",
					title: "Open tool",
					description: "Observe-scoped via namespace fallback.",
					config: { endpoint: "audit/readPublic" },
				}),
			],
		]);
		const appMetadata = {
			mcpConfig: { toolScopes: { gated_tool: ["mcp:apps.write"] } },
		};

		const rowsFor = async (callerIdentity: unknown) => {
			const ctx = {
				loadedTools,
				appMetadata,
				callerIdentity,
			} as unknown as ServerContext;
			const provider = buildCatalogProvider(ctx, undefined);
			const results = await runSearch(provider, "tool", 10);
			return Object.fromEntries(
				catalogToolEntries(results).map((row) => [row.tool, row]),
			);
		};

		// Caller missing the scope: discoverable but marked not executable.
		// (With a toolScopes map configured, unlisted tools fall back to their
		// namespace scope — mcp:observe.* for the audit namespace here.)
		const limited = await rowsFor({
			authType: "oauth",
			scopes: ["mcp:observe.read", "mcp:observe.write", "mcp:observe.admin"],
		});
		expect(limited.gated_tool).toMatchObject({
			authorized: false,
			requiredScopes: ["mcp:apps.write"],
			missingScopes: ["mcp:apps.write"],
		});
		expect(limited.open_tool?.authorized).toBe(true);
		expect(limited.open_tool?.missingScopes).toBeUndefined();

		// platform authority is separate; trusted service binding bypasses.
		const admin = await rowsFor({
			authType: "oauth",
			scopes: ["platform:admin"],
		});
		expect(admin.gated_tool?.authorized).toBe(false);
		const service = await rowsFor({ authType: "service", scopes: [] });
		expect(service.gated_tool?.authorized).toBe(true);
	});

	it("collapses repeated tedi-native role verbs onto the caller's row", async () => {
		const roleCtx = {
			callerIdentity: { authType: "tedi", tediId: "cto-id" },
			loadedTools: new Map<string, AppTool>(
				(["cto", "ceo", "cfo"] as const).map(
					(role) =>
						[
							`${role}__run_tedi_turn`,
							tool({
								id: `row-${role}-send`,
								toolId: `${role}__run_tedi_turn`,
								title: "Send message",
								description: "Send a message to this worker.",
								schemaSource: "mcp",
								schemaSourceRef: "run_tedi_turn",
								config: {
									endpoint: `${role}/messagesSend`,
									_aggregateTediId: `${role}-id`,
								},
							}),
						] as [string, AppTool],
				),
			),
		} as unknown as ServerContext;
		const provider = buildCatalogProvider(roleCtx, undefined);

		// Unfiltered: one representative row owned by the authenticated tedi,
		// with the other workers listed as equivalent owners.
		const rows = catalogToolEntries(await runSearch(provider, "send message"));
		const sendRows = rows.filter((r) => r.tool === "run_tedi_turn");
		expect(sendRows).toHaveLength(1);
		expect(sendRows[0]?.callable).toBe("cto.run_tedi_turn");
		expect(sendRows[0]?.equivalentTediOwners).toEqual([
			{ namespace: "ceo", callable: "ceo.run_tedi_turn" },
			{ namespace: "cfo", callable: "cfo.run_tedi_turn" },
		]);

		// Browse (empty query, unfiltered) collapses the same way.
		const browseRows = catalogToolEntries(await runSearch(provider, ""));
		expect(browseRows.filter((r) => r.tool === "run_tedi_turn")).toHaveLength(
			1,
		);

		// An explicit namespace filter still shows that worker's own row.
		const cto = await runSearch(provider, "send message", 10, {
			namespace: "cto",
		});
		expect(catalogToolEntries(cto)[0]?.callable).toBe("cto.run_tedi_turn");
	});

	it("names the result envelope's top-level keys on describe", async () => {
		const ctx = {
			loadedTools: new Map<string, AppTool>([
				[
					"work__list_work_items",
					tool({
						id: "row-work",
						toolId: "work__list_work_items",
						title: "List work items",
						description: "List work items with filters.",
						config: { endpoint: "work/listWorkItems" },
						outputSchema: {
							type: "object",
							properties: {
								data: { type: "array" },
								pagination: { type: "object" },
							},
						},
					}),
				],
				[
					"work__peek",
					tool({
						id: "row-peek",
						toolId: "work__peek",
						title: "Peek",
						description: "No declared output schema.",
						config: { endpoint: "work/peek" },
					}),
				],
			]),
		} as unknown as ServerContext;
		const provider = buildCatalogProvider(ctx, undefined);
		const tools = provider.tools as Record<
			string,
			{ execute: (input: unknown) => Promise<unknown> }
		>;
		const described = (await tools.describe?.execute?.({
			callable: "work.list_work_items",
		})) as Record<string, unknown>;
		expect(described.resultEnvelopeKeys).toEqual(["data", "pagination"]);

		// A tool with no declared output schema simply omits the hint.
		const bare = (await tools.describe?.execute?.({
			callable: "work.peek",
		})) as Record<string, unknown>;
		expect(bare.resultEnvelopeKeys).toBeUndefined();

		// Search rows stay compact — the hint is describe-only.
		const rows = catalogToolEntries(await runSearch(provider, "work items", 5));
		expect(rows.every((row) => row.resultEnvelopeKeys === undefined)).toBe(
			true,
		);
	});

	it("ranks recorded org skills alongside tools in unfiltered search", async () => {
		const ctx = {
			loadedTools: new Map<string, AppTool>([
				[
					"work__list_work_items",
					tool({
						id: "row-work",
						toolId: "work__list_work_items",
						title: "List work items",
						description: "List work items with filters.",
						config: { endpoint: "work/listWorkItems" },
					}),
				],
			]),
			apiClient: {
				skills: {
					listByOrg: async () => ({
						entries: [
							{
								id: "s1",
								slug: "gateway-measurement-loop",
								title: "Gateway measurement loop",
								description:
									"Run golden-task measurements and record results to the sheet.",
								summary: null,
								successCount: 7,
								lifecycleState: "active",
							},
							{
								id: "s2",
								slug: "retired-procedure",
								title: "Retired procedure",
								description: "Old measurement flow.",
								summary: null,
								successCount: 0,
								lifecycleState: "archived",
							},
						],
						total: 2,
					}),
				},
			},
		} as unknown as ServerContext;
		const provider = buildCatalogProvider(ctx, undefined);

		const results = await runSearch(provider, "measurement loop", 10);
		const skillRow = catalogToolEntries(results).find(
			(row) => row.kind === "skill",
		);
		expect(skillRow).toMatchObject({
			kind: "skill",
			uri: "skill://gateway-measurement-loop/SKILL.md",
			slug: "gateway-measurement-loop",
			lifecycleState: "active",
		});
		expect(String(skillRow?.load)).toContain("get_skills_for_mcp");

		// Archived skills never enumerate.
		expect(
			catalogToolEntries(results).some(
				(row) => row.slug === "retired-procedure",
			),
		).toBe(false);

		// Namespace-filtered search stays tools-only.
		const filtered = await runSearch(provider, "measurement loop", 10, {
			namespace: "work",
		});
		expect(
			catalogToolEntries(filtered).some((row) => row.kind === "skill"),
		).toBe(false);

		// A ctx without an apiClient degrades to tools-only discovery.
		const bare = buildCatalogProvider(
			{
				loadedTools: new Map<string, AppTool>(),
			} as unknown as ServerContext,
			undefined,
		);
		const bareResults = await runSearch(bare, "measurement", 10);
		expect(catalogToolEntries(bareResults)).toHaveLength(0);
	});

	it("defaults schema-bearing searches to a small page; explicit limit wins", async () => {
		const provider = buildCatalogProvider(buildLargeServerCtx(40), undefined);
		const tools = provider.tools as Record<
			string,
			{ execute: (input: unknown) => Promise<unknown> }
		>;
		const schemaDefault = (await tools.search?.execute?.({
			query: "thing",
			includeParameters: true,
		})) as CatalogSearchResult;
		expect(catalogToolEntries(schemaDefault).length).toBeLessThanOrEqual(5);
		expect(resultMeta(schemaDefault).pagination).toMatchObject({ limit: 5 });

		const explicit = (await tools.search?.execute?.({
			query: "thing",
			includeParameters: true,
			limit: 20,
		})) as CatalogSearchResult;
		expect(resultMeta(explicit).pagination).toMatchObject({ limit: 20 });

		const compactDefault = (await tools.search?.execute?.({
			query: "thing",
		})) as CatalogSearchResult;
		expect(resultMeta(compactDefault).pagination).toMatchObject({ limit: 25 });
	});
});

describe("Jev-backed Code Mode discovery", () => {
	it("calls the governed API only with caller-authorized candidate descriptions", async () => {
		const rankDiscovery = vi.fn(async (_input: unknown) => ({
			rankedIds: ["work.get_item", "work.list_items"],
			executionAttempts: [],
			usagePersistence: "persisted" as const,
		}));
		const ctx = {
			app: { organizationId: "org-1" },
			appMetadata: {
				mcpConfig: {
					toolScopes: {
						work__list_items: ["mcp:observe.read"],
						work__get_item: ["mcp:observe.read"],
						work__delete_item: ["mcp:apps.write"],
					},
				},
			},
			callerIdentity: { authType: "oauth", scopes: ["mcp:observe.read"] },
			loadedTools: new Map<string, AppTool>(
				["list_items", "delete_item", "get_item"].map((name) => [
					`work__${name}`,
					tool({
						toolId: `work__${name}`,
						title: name,
						description: `Manage work items with ${name}`,
						config: { endpoint: `work/${name}` },
					}),
				]),
			),
			apiClient: { cognitiveRuntime: { rankDiscovery } },
		} as unknown as ServerContext;
		const result = await runSearch(
			buildCatalogProvider(ctx, undefined),
			"manage work items",
		);
		expect(rankDiscovery).toHaveBeenCalledOnce();
		expect(
			(rankDiscovery.mock.calls[0]?.[0] as { candidates: unknown[] })
				.candidates,
		).toEqual([
			expect.objectContaining({ id: "work.get_item", kind: "tool" }),
			expect.objectContaining({ id: "work.list_items", kind: "tool" }),
		]);
		expect(
			result.results
				.filter((row) => row.authorized === true)
				.map((row) => row.callable),
		).toEqual(["work.get_item", "work.list_items"]);
		expect(
			result.results.find((row) => row.callable === "work.delete_item"),
		).toMatchObject({ authorized: false });
		expect(resultMeta(result).discovery).toMatchObject({ order: "jev" });
	});
});

describe("dual-mount namespace aliases (app/apps + tedi/tedis)", () => {
	it("(a) alias mirrors resolve under an explicit namespace filter but do not enumerate", async () => {
		const ctx = {
			loadedTools: new Map<string, AppTool>([
				[
					"apps__list_apps",
					tool({
						id: "row-apps-list",
						toolId: "apps__list_apps",
						title: "List apps",
						description: "List apps.",
						config: { endpoint: "apps/list" },
					}),
				],
			]),
		} as unknown as ServerContext;
		const provider = buildCatalogProvider(ctx, undefined);

		// Unfiltered search enumerates only the canonical namespace once.
		const appsResult = await runSearch(provider, "list_apps");
		const appsEntry = namespaceTools(appsResult, "apps");
		expect(appsEntry?.list_apps).toBeDefined();
		expect(appsEntry?.list_apps?.callable).toBe("apps.list_apps");
		expect(namespaceTools(appsResult, "app")).toBeUndefined();

		// The alias form still resolves under an explicit namespace filter,
		// with its alias-namespace callable and provenance marker.
		const aliasFiltered = await runSearch(provider, "list_apps", 10, {
			namespace: "app",
		});
		const aliasEntry = namespaceTools(aliasFiltered, "app");
		expect(aliasEntry?.list_apps?.callable).toBe("app.list_apps");
		expect(aliasEntry?.list_apps?.aliasOf).toBe("apps");
	});

	it("(b) an explicit {apps:'app'} override enumerates only the canonical 'app' form", async () => {
		const ctx = {
			loadedTools: new Map<string, AppTool>([
				[
					"apps__create_app",
					tool({
						id: "row-app-create",
						toolId: "apps__create_app",
						title: "Create app",
						description: "Create an app.",
						config: { endpoint: "apps/create" },
					}),
				],
			]),
		} as unknown as ServerContext;
		// Explicit override: "apps" → "app" (the override renames; alias covers the reverse)
		const provider = buildCatalogProvider(ctx, { apps: "app" });

		const result = await runSearch(provider, "create_app");
		// With override, primary resolves to "app" and is the only enumerated form.
		const appEntry = namespaceTools(result, "app");
		expect(appEntry?.create_app).toBeDefined();
		expect(appEntry?.create_app?.callable).toBe("app.create_app");
		expect(namespaceTools(result, "apps")).toBeUndefined();

		// The "apps" side still resolves when explicitly filtered.
		const aliasFiltered = await runSearch(provider, "create_app", 10, {
			namespace: "apps",
		});
		expect(namespaceTools(aliasFiltered, "apps")?.create_app?.callable).toBe(
			"apps.create_app",
		);
	});

	it("(c) a semantic-rename namespace does NOT gain a peer alias", async () => {
		const ctx = {
			loadedTools: new Map<string, AppTool>([
				[
					"skills__list_skills",
					tool({
						id: "row-skills-list",
						toolId: "skills__list_skills",
						title: "List skills",
						description: "List skills.",
						config: { endpoint: "skills/list" },
					}),
				],
			]),
		} as unknown as ServerContext;
		const provider = buildCatalogProvider(ctx, undefined);

		const result = await runSearch(provider, "list_skills");
		// "skills" has no peer alias — only the primary namespace is registered
		expect(namespaceTools(result, "skills")?.list_skills).toBeDefined();
		// No alias namespace for "skills"
		expect(namespaceTools(result, "skill")).toBeUndefined();
	});

	it("discover.list_namespaces enumerates only the canonical form; aliases live in governance metadata", async () => {
		const ctx = {
			loadedTools: new Map<string, AppTool>([
				[
					"tedis__list_tedis",
					tool({
						id: "row-tedis",
						toolId: "tedis__list_tedis",
						title: "List tedis",
						description: "List tedis.",
						config: { endpoint: "tedis/list" },
					}),
				],
			]),
		} as unknown as ServerContext;
		const provider = buildCatalogProvider(ctx, undefined);

		const tools = provider.tools as Record<
			string,
			{ execute: (input: unknown) => Promise<unknown> }
		>;
		const namespaces = (await tools.list_namespaces!.execute({})) as Record<
			string,
			{ tools: number; governance?: { aliases?: readonly string[] } }
		>;
		expect(namespaces.tedis).toBeDefined();
		expect(namespaces.tedis!.tools).toBeGreaterThan(0);
		expect(namespaces.tedis!.governance?.aliases).toContain("tedi");
		// The pure-alias mirror namespace is not enumerated as its own entry.
		expect(namespaces.tedi).toBeUndefined();
	});
});

describe("enrichToolNotFoundError (did-you-mean suggestions)", () => {
	const callables = [
		"skills.list_by_app_skills",
		"skills.list_by_org_skills",
		"skills.find_skills",
		"skills.record_skills",
		"memory.search_memory_graph",
		"memory.learn_memory_graph",
		"tedis.rotate_access_key_tedis",
		"ceo.list_skills",
		"cmo.list_skills",
		"discover.search",
	];

	it("appends nearest callables to upstream Tool not found errors", () => {
		const enriched = enrichToolNotFoundError(
			'Tool "list_skills" not found',
			callables,
		);
		// The guessed name "list_skills" should surface both the per-tedi exact
		// matches and the suffixed skills-namespace variants.
		expect(enriched).toContain("ceo.list_skills");
		expect(enriched).toContain("Closest callables:");
		expect(enriched).toContain("discover.search");
	});

	it("suggests suffixed names for clean-name guesses", () => {
		const enriched = enrichToolNotFoundError(
			'Tool "rotate_access_key" not found',
			callables,
		);
		expect(enriched).toContain("tedis.rotate_access_key_tedis");
	});

	it("leaves non-tool-not-found errors untouched", () => {
		const error = "Execution timed out";
		expect(enrichToolNotFoundError(error, callables)).toBe(error);
	});

	it("still teaches discover.search when nothing is close", () => {
		const enriched = enrichToolNotFoundError(
			'Tool "zzz_qqq" not found',
			callables,
		);
		expect(enriched).not.toContain("Closest callables:");
		expect(enriched).toContain("discover.search");
	});
});

describe("enrichUnmountedNamespaceError (missing binding vs typo)", () => {
	const known = new Set(["descope_api_tedix", "acme_api", "skills"]);
	const mounted = new Set(["skills", "discover", "codemode", "ui"]);
	// Extraction saw the namespace; the potential inventory cannot explain its absence.
	const requested = new Set(["descope_api_tedix", "acme_api"]);

	it("reports a missing binding without inferring an upstream failure or retry", () => {
		const enriched = enrichUnmountedNamespaceError(
			"descope_api_tedix is not defined",
			known,
			mounted,
			requested,
		);
		expect(enriched).toContain("unavailable in this request");
		expect(enriched).toContain("current organization target");
		expect(enriched).toContain("does not establish an upstream failure");
		expect(enriched).not.toContain("IS configured");
		expect(enriched).not.toContain("failed or timed out");
		expect(enriched).not.toContain("retry");
	});

	it("does not diagnose deliberately excluded platform tools as an outage", () => {
		const enriched = enrichUnmountedNamespaceError(
			"work is not defined",
			new Set(["work"]),
			new Set(["home", "discover"]),
			new Set(["work"]),
		);
		expect(enriched).toContain("potential namespace inventory");
		expect(enriched).toContain("discover.search");
		expect(enriched).not.toContain("upstream app is down");
		expect(enriched).not.toContain("degraded partial");
		expect(enriched).not.toContain("retry the same call");
	});

	it("leaves a genuine typo as a plain scope error", () => {
		const error = "descopeApiTedix is not defined";
		expect(
			enrichUnmountedNamespaceError(error, known, mounted, requested),
		).toBe(error);
	});

	it("leaves a mounted namespace untouched (local variable typo)", () => {
		const error = "skills is not defined";
		expect(
			enrichUnmountedNamespaceError(error, known, mounted, requested),
		).toBe(error);
	});

	it("leaves unrelated errors untouched", () => {
		const error = 'Tool "zzz" not found';
		expect(
			enrichUnmountedNamespaceError(error, known, mounted, requested),
		).toBe(error);
	});

	it("names dynamic access when the snippet never requested the namespace", () => {
		// `ns[variable](args)` is invisible to the extraction regex, so the
		// namespace is never hydrated. Telling the caller to retry would be wrong.
		const enriched = enrichUnmountedNamespaceError(
			"skills is not defined",
			new Set(["skills"]),
			new Set(["discover"]),
			new Set(["discover"]),
		);
		expect(enriched).toContain("never requested it");
		expect(enriched).toContain("computed access");
		expect(enriched).toContain("returned callable literally");
		expect(enriched).not.toContain("IS configured");
		expect(enriched).not.toContain("retry");
		expect(enriched).not.toContain("timed out");
	});

	it("does not infer a cause when extraction is unavailable", () => {
		const enriched = enrichUnmountedNamespaceError(
			"descope_api_tedix is not defined",
			known,
			mounted,
			null,
		);
		expect(enriched).toContain("unavailable in this request");
		expect(enriched).toContain("discover.search");
		expect(enriched).not.toContain("failed or timed out");
		expect(enriched).not.toContain("retry");
	});

	it("matches ReferenceError-prefixed messages", () => {
		const enriched = enrichUnmountedNamespaceError(
			"ReferenceError: acme_api is not defined",
			known,
			mounted,
			requested,
		);
		expect(enriched).toContain('Namespace "acme_api" is unavailable');
		expect(enriched).not.toContain("IS configured");
	});
});

describe("discover.search results flat array", () => {
	it("collapses mirrored tedi workflow tools onto canonical callables with owner metadata", async () => {
		const ctx = {
			loadedTools: new Map<string, AppTool>([
				[
					"skills__inspect_skill_workflow_run",
					tool({
						id: "canonical-inspect",
						toolId: "skills__inspect_skill_workflow_run",
						title: "Inspect skill workflow run",
						description: "Inspect one workflow run and its evidence.",
						schemaSource: "orpc",
						schemaSourceRef: "skills/inspectWorkflowRun",
					}),
				],
				...(["ceo", "cto", "cfo"] as const).map(
					(namespace) =>
						[
							`${namespace}__inspect_skill_workflow_run`,
							tool({
								id: `${namespace}-inspect`,
								toolId: `${namespace}__inspect_skill_workflow_run`,
								title: `${namespace} inspect skill workflow run`,
								description: "Inspect one tedi-owned workflow run.",
								schemaSource: "mcp",
								schemaSourceRef: "inspect_skill_workflow_run",
							}),
						] as [string, AppTool],
				),
			]),
		} as unknown as ServerContext;
		const provider = buildCatalogProvider(ctx, undefined);
		const results = await runSearch(provider, "inspect skill workflow run");
		const inspect = results.results.filter(
			(entry) => entry.callable === "skills.inspect_skill_workflow_run",
		);

		expect(inspect).toHaveLength(1);
		expect(results.results[0]?.callable).toBe(
			"skills.inspect_skill_workflow_run",
		);
		expect(inspect[0]?.equivalentTediOwners).toEqual([
			{
				namespace: "ceo",
				callable: "ceo.inspect_skill_workflow_run",
			},
			{
				namespace: "cfo",
				callable: "cfo.inspect_skill_workflow_run",
			},
			{
				namespace: "cto",
				callable: "cto.inspect_skill_workflow_run",
			},
		]);
		expect(
			results.results.some((entry) =>
				String(entry.callable).startsWith("cto.inspect_"),
			),
		).toBe(false);

		const fullCatalog = await runSearch(provider, "");
		expect(
			fullCatalog.results.filter(
				(entry) => entry.callable === "skills.inspect_skill_workflow_run",
			),
		).toHaveLength(1);
		expect(
			fullCatalog.results.some((entry) =>
				String(entry.callable).startsWith("ceo.inspect_"),
			),
		).toBe(false);
	});

	it("emits { results, namespaces, meta } as a plain object", async () => {
		const ctx = {
			loadedTools: new Map<string, AppTool>([
				[
					"skills__list_skills",
					tool({
						id: "row-skills-list",
						toolId: "skills__list_skills",
						title: "List skills",
						description: "List available skills for the org.",
					}),
				],
				[
					"skills__find_skills",
					tool({
						id: "row-skills-find",
						toolId: "skills__find_skills",
						title: "Find skills",
						description: "Find a specific skill by keyword.",
					}),
				],
			]),
		} as unknown as ServerContext;
		const provider = buildCatalogProvider(ctx, undefined);
		const results = await runSearch(provider, "skills");

		// Plain object on purpose: the previous decorated-array shape passed
		// structuredClone locally (Node preserves array expando props) but the
		// workerd JS-RPC serializer strips them, so sandbox code silently lost
		// every attached property. The object shape is boundary-safe.
		expect(Array.isArray(results)).toBe(false);
		const flat = results.results;
		expect(Array.isArray(flat)).toBe(true);
		expect(flat.length).toBeGreaterThan(0);

		// Each entry must carry callable, namespace, and tool
		for (const entry of flat) {
			expect(typeof entry.callable).toBe("string");
			expect(typeof entry.namespace).toBe("string");
			expect(typeof entry.tool).toBe("string");
		}

		// Namespace map and meta live on named keys.
		expect(typeof results.namespaces.skills).toBe("object");
		expect(results.meta).toBeDefined();
	});

	it("results[] is a real array with .slice and .map without throwing", async () => {
		const ctx = buildLargeServerCtx(10);
		const provider = buildCatalogProvider(ctx, undefined);
		const results = await runSearch(provider, "thing");
		const flat = results.results;
		expect(Array.isArray(flat)).toBe(true);
		const sliced = flat.slice(0, 3);
		const mapped = flat.map((e) => e.callable);
		expect(sliced.length).toBeLessThanOrEqual(3);
		expect(mapped.every((c) => typeof c === "string")).toBe(true);
	});

	it("meta and namespaces survive structured clone on named keys", async () => {
		const ctx = buildLargeServerCtx(10);
		const provider = buildCatalogProvider(ctx, undefined);
		const results = await runSearch(provider, "thing");
		const cloned = structuredClone(results) as CatalogSearchResult;

		expect(cloned.results[0]).toMatchObject({ callable: expect.any(String) });
		expect(cloned.meta).toBeDefined();
		expect(cloned.namespaces).toBeDefined();
		expect(
			(cloned.meta.pagination as Record<string, unknown>).total,
		).toBeDefined();
	});

	it("discover.describe returns one full definition by exact callable", async () => {
		const ctx = buildLargeServerCtx(10);
		const refs = {
			executionId: undefined,
			paymentExtra: undefined,
			paymentResponses: [],
			rpcCallCount: 0,
			rpcNamespaces: new Set<string>(),
			sideEffectQueue: Promise.resolve(),
			failureBudget: { state: () => ({}) },
			discoverCalls: 0,
			discoverParameterRequests: 0,
		};
		const provider = buildCatalogProvider(ctx, undefined, refs as never);
		const tools = provider.tools as Record<
			string,
			{ execute: (input: unknown) => Promise<unknown> }
		>;
		const describe = tools.describe?.execute;
		if (!describe) throw new Error("discover.describe not registered");

		// The cheap flow: compact search names the callable, describe fetches the
		// one schema — so the single entry must carry the heavy blobs a compact
		// search page omits.
		const entry = (await describe({
			callable: "app.list_things_3",
		})) as Record<string, unknown>;
		expect(entry).toMatchObject({ callable: "app.list_things_3" });
		expect(entry.outputSchema).toBeDefined();

		// Missing exposure has a catalog-specific recovery path.
		expect(await describe("app.list_things_3")).toMatchObject({
			callable: "app.list_things_3",
		});
		await expect(describe({ callable: "app.no_such_tool" })).rejects.toThrow(
			"not exposed in the current gateway catalog",
		);
		await expect(describe({ callable: "no-dot" })).rejects.toThrow(
			"exact namespace.tool",
		);

		for (const callable of ["app.delete_thing_0", "apps.delete_thing_0"]) {
			expect(await describe({ callable })).toMatchObject({
				parameters: {
					properties: {
						confirmDestructive: { type: "boolean" },
						reason: { type: "string" },
					},
				},
			});
		}
		const found = await runSearch(provider, "delete_thing_0", 5, {
			includeParameters: true,
		});
		expect(
			found.results.find((r) => r.callable === "app.delete_thing_0"),
		).toMatchObject({
			parameters: { properties: { confirmDestructive: { type: "boolean" } } },
		});
		expect(
			ctx.loadedTools.get("app__delete_thing_0")?.inputSchema.properties,
		).toEqual({});
		expect(
			(
				(await describe("app.list_things_3")) as {
					parameters: { properties: unknown };
				}
			).parameters.properties,
		).toEqual({});

		// Discovery-option telemetry: describe counts as a schema request.
		expect(refs.discoverCalls).toBeGreaterThan(0);
		expect(refs.discoverParameterRequests).toBeGreaterThan(0);
	});

	it("serializes discovery results to a single shape for the model", async () => {
		const ctx = buildLargeServerCtx(10);
		const provider = buildCatalogProvider(ctx, undefined);
		const results = await runSearch(provider, "thing", 5);

		// Sandbox value keeps everything: results plus the namespace map.
		expect(results.namespaces.app).toBeDefined();

		// The model-facing wire form drops the namespace-map duplicate: each
		// tool would otherwise serialize 2-3x.
		const shaped = shapeCodeModeResultForModel(results) as Record<
			string,
			unknown
		>;
		expect(Array.isArray(shaped)).toBe(false);
		expect(shaped.results).toBeDefined();
		expect(shaped.meta).toBeDefined();
		expect(shaped.namespaces).toBeUndefined();
		expect(Object.keys(shaped).sort()).toEqual(["meta", "results"]);
	});
});

describe("native catalog owning projection parity", () => {
	it("matches search and describe without sandbox evaluation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		try {
			const ctx = buildLargeServerCtx(12);
			const provider = buildCatalogProvider(ctx, undefined);
			const expected = await runSearch(provider, "thing", 3, {
				includeParameters: true,
			});
			expect(
				await executeCatalogOperation(
					ctx,
					{ transport: "catalog", endpoint: "catalog/search" },
					{ query: "thing", limit: 3, includeParameters: true },
				),
			).toEqual(expected);
			const tools = provider.tools as Record<
				string,
				{ execute: (input: unknown) => Promise<unknown> }
			>;
			expect(
				await executeCatalogOperation(
					ctx,
					{ transport: "catalog", endpoint: "catalog/describe" },
					{ callable: "app.do_thing_1" },
				),
			).toEqual(await tools.describe!.execute({ callable: "app.do_thing_1" }));
		} finally {
			vi.useRealTimers();
		}
	});
});

it("preserves native projection parity for scopes, freshness, paging, aliases, skills and governed ranking", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	try {
		const rankDiscovery = vi.fn(async () => ({
			rankedIds: ["work.get_item"],
			executionAttempts: [],
			usagePersistence: "persisted",
		}));
		const ctx = {
			app: { organizationId: "fictional-org" },
			appMetadata: {
				mcpConfig: {
					toolScopes: {
						work__get_item: ["mcp:apps.read"],
						work__delete_item: ["mcp:apps.write"],
					},
				},
			},
			callerIdentity: { authType: "oauth", scopes: ["mcp:apps.read"] },
			loadedTools: new Map(
				["get_item", "delete_item"].map((name) => [
					"work__" + name,
					tool({
						toolId: "work__" + name,
						title: name,
						description: "Manage work items",
						schemaSyncedAt: "2025-12-31T00:00:00Z",
						config: {
							endpoint: "apps/get",
							_aggregateNamespace: "work",
							_aggregateTediRemoteName: name,
						},
					}),
				]),
			),
			apiClient: {
				cognitiveRuntime: { rankDiscovery },
				skills: {
					listByOrg: async () => ({
						total: 1,
						entries: [
							{
								id: "fictional-skill",
								slug: "inspect-work",
								title: "Inspect work",
								description: "Manage work items",
								summary: null,
								lifecycleState: "active",
								successCount: 1,
							},
						],
					}),
				},
			},
		} as unknown as ServerContext;
		for (const input of [
			{
				query: "",
				limit: 1,
				offset: 1,
				includeParameters: true,
				includeOutputSchema: true,
			},
			{ query: "manage work items" },
			{ namespace: "work", query: "" },
		]) {
			const provider = buildCatalogProvider(ctx, undefined);
			const expected = await (
				provider.tools as Record<
					string,
					{ execute(input: unknown): Promise<unknown> }
				>
			).search!.execute(input);
			expect(
				await executeCatalogOperation(
					ctx,
					{ transport: "catalog", endpoint: "catalog/search" },
					input,
				),
			).toEqual(expected);
		}
		const browse = (await executeCatalogOperation(
			ctx,
			{ transport: "catalog", endpoint: "catalog/search" },
			{ query: "", limit: 100 },
		)) as CatalogSearchResult;
		const skills = {
			...ctx,
			apiClient: { skills: ctx.apiClient.skills },
		} as unknown as ServerContext;
		const nativeSkills = (await executeCatalogOperation(
			skills,
			{ transport: "catalog", endpoint: "catalog/search" },
			{ query: "inspect work" },
		)) as CatalogSearchResult;
		expect(nativeSkills.results.some((row) => row.kind === "skill")).toBe(true);
		expect(nativeSkills).toEqual(
			await runSearch(
				buildCatalogProvider(skills, undefined),
				"inspect work",
				25,
			),
		);
		expect(
			browse.results.find((row) => row.callable === "work.delete_item")
				?.authorized,
		).toBe(false);
		expect(browse.meta.freshness).toMatchObject({ schemaSyncedTools: 2 });
		const aliases = {
			loadedTools: new Map(
				["app", "apps"].map((namespace) => [
					namespace + "__get_item",
					tool({
						toolId: namespace + "__get_item",
						schemaSource: "orpc",
						schemaSourceRef: "apps/get",
					}),
				]),
			),
		} as unknown as ServerContext;
		expect(
			await executeCatalogOperation(
				aliases,
				{ transport: "catalog", endpoint: "catalog/search" },
				{ query: "", namespace: "app" },
			),
		).toEqual(
			await runSearch(buildCatalogProvider(aliases, undefined), "", 25, {
				namespace: "app",
			}),
		);
		expect(rankDiscovery).toHaveBeenCalled();
		await expect(
			executeCatalogOperation(
				ctx,
				{ transport: "catalog", endpoint: "catalog/search" },
				{ namespace: "missing", query: "" },
			),
		).rejects.toThrow("Unknown namespace");
		await expect(
			(
				buildCatalogProvider(ctx, undefined).tools as Record<
					string,
					{ execute(input: unknown): Promise<unknown> }
				>
			).search!.execute({ namespace: "missing", query: "" }),
		).rejects.toThrow("Unknown namespace");
		for (const callable of [
			"work.get_item",
			"missing.no_tool",
			"work.no_tool",
		]) {
			const provider = buildCatalogProvider(ctx, undefined);
			const expected = (
				provider.tools as Record<
					string,
					{ execute(input: unknown): Promise<unknown> }
				>
			).describe!.execute({ callable });
			const actual = executeCatalogOperation(
				ctx,
				{ transport: "catalog", endpoint: "catalog/describe" },
				{ callable },
			);
			expect(await Promise.allSettled([actual])).toEqual(
				await Promise.allSettled([expected]),
			);
		}
	} finally {
		vi.useRealTimers();
	}
});

it("keeps reviewed endpoint floors and denials identical in native discovery", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	try {
		for (const endpoint of [
			"organizations/cancel",
			"tedis/inspectRuntimeOutbox",
			"workspaceApps/list",
			"providerEvents/list",
			"unreviewed/unknown",
		]) {
			const row = tool({
				toolId: "customer__inspect_endpoint",
				config: {
					transport: "rpc",
					endpoint,
					_aggregateNamespace: "customer",
					_aggregateTediRemoteName: "inspect_endpoint",
				},
				annotations: { readOnlyHint: true },
			});
			for (const scopes of [
				["mcp:catalog.read"],
				["mcp:tedis.read"],
				["mcp:apps.read"],
				["platform:admin"],
			]) {
				const ctx = {
					loadedTools: new Map([[row.toolId, row]]),
					callerIdentity: { authType: "oauth", scopes },
					appMetadata: {
						mcpConfig: { authMode: "authenticated", enforcePolicies: false },
					},
				} as unknown as ServerContext;
				expect(
					await executeCatalogOperation(
						ctx,
						{ transport: "catalog", endpoint: "catalog/search" },
						{ query: "", namespace: "customer" },
					),
				).toEqual(
					await runSearch(buildCatalogProvider(ctx, undefined), "", 25, {
						namespace: "customer",
					}),
				);
			}
		}
	} finally {
		vi.useRealTimers();
	}
});

it("search and describe keep literal native identity and independent eligibility/authorization", async () => {
	const row = tool({
		toolId: "work__list_items",
		config: {
			transport: "rpc",
			endpoint: "workItems/list",
			nativeDirect: true,
			_aggregateNamespace: "work",
			_aggregateTediRemoteName: "list_items",
		},
		schemaSource: "orpc",
		schemaSourceRef: "workItems/list",
		schemaSourceHash: "literal-hash",
		schemaSyncedAt: "2026-10-07T00:00:00Z",
	});
	const ctx = {
		appSlug: "gateway",
		loadedTools: new Map([[row.toolId, row]]),
		callerIdentity: { authType: "oauth", scopes: ["mcp:work.read"] },
		appMetadata: {
			mcpConfig: { toolScopes: { [row.toolId]: ["mcp:work.read"] } },
		},
	} as unknown as ServerContext;
	const provider = buildCatalogProvider(ctx, undefined);
	const found = await runSearch(provider, "list_items", 100);
	const entry = found.results.find(
		(x) => (x.native as { name: string })?.name === row.toolId,
	)!;
	expect(entry.native).toMatchObject({
		name: row.toolId,
		toolRowId: row.id,
		endpoint: "workItems/list",
		eligible: true,
		authorized: true,
		schemaFreshness: {
			sourceRef: "workItems/list",
			sourceHash: "literal-hash",
		},
	});
	const describe = (
		provider.tools as Record<
			string,
			{ execute: (x: unknown) => Promise<unknown> }
		>
	).describe!;
	expect(await describe.execute({ callable: entry.callable })).toMatchObject({
		native: entry.native,
	});
	ctx.callerIdentity!.scopes = [];
	const denied = await runSearch(
		buildCatalogProvider(ctx, undefined),
		"list_items",
		100,
	);
	expect(
		denied.results.find(
			(x) => (x.native as { name: string })?.name === row.toolId,
		),
	).toMatchObject({
		authorized: false,
		native: { eligible: true, authorized: false },
	});
	ctx.callerIdentity!.forceCodeMode = true;
	expect(
		(
			await runSearch(buildCatalogProvider(ctx, undefined), "list_items", 100)
		).results.find((x) => (x.native as { name: string })?.name === row.toolId),
	).toMatchObject({ native: { eligible: false, authorized: false } });
});
