import { describe, expect, it } from "vite-plus/test";
import {
	MCP_CLIENT_CAPABILITIES_META_KEY,
	MCP_CLIENT_INFO_META_KEY,
	MCP_METHOD_HEADER,
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_NAME_HEADER,
	MCP_PROTOCOL_VERSION_META_KEY,
	MCP_PROTOCOL_VERSION_HEADER,
} from "@tedix/mcp-shared/protocol";
import { MCP_LIST_MAX_PAGES } from "@tedix/mcp-shared/bounded-list";
import {
	callDirectReadMcp,
	directReadConnectionRequirement,
	directReadFenceIsStale,
	listLiveTools,
	reconcileLiveReadOnlyTools,
	unwrapDirectReadToolResult,
	widgetMetadata,
	ownedHomeReadObservation,
} from "./direct-read";

it("binds a trusted read observation to the canonical Home request owner", () => {
	const receipt = {
		version: 1,
		kind: "docs_file_observation",
		receiptId: "00000000-0000-4000-8000-000000000001",
		provider: { appSlug: "docs", toolName: "get_docs_file" },
		resource: {
			organizationSlug: "acme",
			siteId: "00000000-0000-4000-8000-000000000002",
			path: "index.md",
		},
		evidence: {
			contentSha256: "a".repeat(64),
			byteLength: 6,
			observedGitRevision: "b".repeat(40),
		},
		observedAt: "2026-09-22T12:00:00.000Z",
	};
	const owner = {
		organizationId: "org",
		conversationId: "conversation",
		requestEventId: "event",
		idempotencyKey: "key",
		actor: { type: "user", id: "user" },
		appSlug: "tedix-docs",
		toolName: "get_docs_file",
		siteId: receipt.resource.siteId,
		path: receipt.resource.path,
	};
	expect(
		ownedHomeReadObservation(
			{ _meta: { "io.tedix/readObservation": receipt } },
			owner,
		),
	).toEqual({ owner, receipt });
	expect(
		ownedHomeReadObservation(
			{ structuredContent: { "io.tedix/readObservation": receipt } },
			owner,
		),
	).toBeNull();
	expect(
		ownedHomeReadObservation(
			{ _meta: { "io.tedix/readObservation": receipt } },
			{ ...owner, appSlug: "docs" },
		),
	).toBeNull();
	expect(
		ownedHomeReadObservation(
			{ _meta: { "io.tedix/readObservation": receipt } },
			{ ...owner, path: "other.md" },
		),
	).toBeNull();
});

describe("directReadFenceIsStale", () => {
	it("keeps an active request fenced and permits terminal recovery after two minutes", () => {
		const createdAt = "2026-08-22T04:00:00.000Z";
		expect(
			directReadFenceIsStale(createdAt, Date.parse("2026-08-22T04:01:59.999Z")),
		).toBe(false);
		expect(
			directReadFenceIsStale(createdAt, Date.parse("2026-08-22T04:02:00.000Z")),
		).toBe(true);
	});
});

describe("directReadConnectionRequirement", () => {
	it("returns no requirement for tools that do not use connection auth", () => {
		expect(
			directReadConnectionRequirement({
				appMetadata: { mcpConfig: { connectionProviderId: "gmail" } },
				toolConfig: { auth: { type: "header", value: "fixed" } },
			}),
		).toBeNull();
	});

	it("mirrors aggregate-host provider, scope, and scope-label overrides", () => {
		expect(
			directReadConnectionRequirement({
				appMetadata: {
					mcpConfig: {
						connectionProviderId: "google-gmail",
						connectionScope: "hybrid",
						connectionScopes: ["gmail.readonly"],
					},
				},
				toolConfig: {
					auth: {
						type: "connection",
						connectionId: "google-default",
						credentialScope: "tenant",
					},
				},
			}),
		).toEqual({
			providerId: "google-gmail",
			tokenScope: "either",
			scopes: ["gmail.readonly"],
		});
	});

	it("falls back to the tool's exact connection declaration", () => {
		expect(
			directReadConnectionRequirement({
				appMetadata: {},
				toolConfig: {
					auth: {
						type: "connection",
						connectionId: "facturama-api-key",
						scope: "user",
						scopes: ["catalog:read"],
					},
				},
			}),
		).toEqual({
			providerId: "facturama-api-key",
			tokenScope: "user",
			scopes: ["catalog:read"],
		});
	});
});

describe("reconcileLiveReadOnlyTools", () => {
	const connectedTool = {
		name: "list_records",
		title: "List records",
		description: "Lists records",
		inputSchema: { type: "object" },
		connectionState: "connected" as const,
		connectionReason: null,
		connectProviderId: null,
	};

	it("keeps a tool callable only when the live catalog also declares it read-only", () => {
		expect(
			reconcileLiveReadOnlyTools([connectedTool], {
				items: [{ name: "list_records", annotations: { readOnlyHint: true } }],
				truncated: false,
			}),
		).toEqual([connectedTool]);
		expect(
			reconcileLiveReadOnlyTools([connectedTool], {
				items: [{ name: "list_records", annotations: { readOnlyHint: false } }],
				truncated: false,
			}),
		).toMatchObject([
			{
				connectionState: "unavailable",
				connectionReason:
					"The live MCP catalog does not declare this tool read-only.",
			},
		]);
	});

	it("keeps a read-only tool listed past the first catalog page callable", () => {
		expect(
			reconcileLiveReadOnlyTools([connectedTool], {
				items: [
					{ name: "other_tool", annotations: { readOnlyHint: true } },
					{ name: "list_records", annotations: { readOnlyHint: true } },
				],
				truncated: false,
			}),
		).toEqual([connectedTool]);
	});

	it("reports a truncated catalog as unverified instead of blaming the provider", () => {
		expect(
			reconcileLiveReadOnlyTools([connectedTool], {
				items: [{ name: "other_tool", annotations: { readOnlyHint: true } }],
				truncated: true,
			}),
		).toMatchObject([
			{
				connectionState: "unavailable",
				connectionReason:
					"The live MCP tool catalog was too large to verify completely.",
			},
		]);
	});

	it("fails connected tools closed when live discovery is unavailable", () => {
		expect(reconcileLiveReadOnlyTools([connectedTool], null)).toMatchObject([
			{
				connectionState: "unavailable",
				connectionReason: "The live MCP tool catalog could not be verified.",
			},
		]);
	});

	it("preserves connection recovery states without requiring a live call", () => {
		const recovery = {
			...connectedTool,
			connectionState: "connection_required" as const,
			connectionReason: "Connect this app",
			connectProviderId: "provider-id",
		};
		expect(reconcileLiveReadOnlyTools([recovery], null)).toEqual([recovery]);
	});
});

describe("widgetMetadata", () => {
	it("persists the canonical MCP Apps UI resource with its replay inputs", () => {
		expect(
			widgetMetadata(
				{
					structuredContent: { rows: [{ id: "invoice-1" }] },
					_meta: {
						ui: {
							resourceUri: "ui://widgets/mcp-app/initech/r/invoices.html",
						},
					},
				},
				{
					appSlug: "initech",
					toolName: "get_invoices",
					arguments: { limit: 10 },
				},
			),
		).toEqual({
			mcpWidget: {
				resourceUri: "ui://widgets/mcp-app/initech/r/invoices.html",
				toolInput: { limit: 10 },
				toolResult: { rows: [{ id: "invoice-1" }] },
			},
		});
	});
});

/**
 * Stub the MCP edge for `listLiveTools`. `pages` is keyed by the cursor the
 * request carried (`""` for the first, cursorless request).
 */
function mcpEnv(
	pages: (cursor: string) => { tools: unknown[]; nextCursor?: string },
) {
	const cursors: string[] = [];
	const requests: Array<{
		headers: Headers;
		method: string;
		params?: Record<string, unknown>;
	}> = [];
	const env = {
		MCP_URL: "https://mcp.tedix.dev",
		PLATFORM_SERVICE_TOKEN: "svc-token",
		MCP_SERVICE: {
			fetch: async (_input: string, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body ?? "{}")) as {
					id?: unknown;
					method: string;
					params?: Record<string, unknown>;
				};
				requests.push({
					headers: new Headers(init?.headers),
					method: body.method,
					params: body.params,
				});
				const cursor =
					typeof body.params?.cursor === "string" ? body.params.cursor : "";
				cursors.push(cursor);
				if (body.method !== "tools/list") {
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: { resultType: "complete", content: [] },
					});
				}
				// A 2026-07-28 list result: resultType, SEP-2549 freshness hints,
				// and an object inputSchema on every tool.
				const page = pages(cursor);
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						resultType: "complete",
						ttlMs: 0,
						cacheScope: "private",
						...page,
						tools: page.tools.map((tool) => ({
							inputSchema: { type: "object" },
							...(tool as object),
						})),
					},
				});
			},
		},
	} as unknown as CloudflareEnv;
	return { cursors, env, requests };
}

describe("listLiveTools", () => {
	it("finds a read-only tool that sorts past the first catalog page", async () => {
		const { cursors, env, requests } = mcpEnv((cursor) =>
			cursor === ""
				? {
						tools: Array.from({ length: 200 }, (_, i) => ({
							name: `filler_${i}`,
							annotations: { readOnlyHint: true },
						})),
						nextCursor: "page-2",
					}
				: {
						tools: [
							{ name: "list_records", annotations: { readOnlyHint: true } },
						],
					},
		);

		const listed = await listLiveTools({
			context: { env },
			organizationId: "org-1",
			appSlug: "initech",
			actingUserId: "user-1",
		});

		expect(cursors).toEqual(["", "page-2"]);
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect(request.method).toBe("tools/list");
			expect(request.headers.get(MCP_PROTOCOL_VERSION_HEADER)).toBe(
				MCP_MODERN_PROTOCOL_VERSION,
			);
			expect(request.headers.get(MCP_METHOD_HEADER)).toBe("tools/list");
			expect(request.headers.get(MCP_NAME_HEADER)).toBeNull();
			expect(request.params?._meta).toEqual({
				[MCP_PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
				[MCP_CLIENT_INFO_META_KEY]: {
					name: "tedix-home-direct-read",
					version: "1.0.0",
				},
				[MCP_CLIENT_CAPABILITIES_META_KEY]: {},
			});
		}
		expect(listed.truncated).toBe(false);
		expect(listed.items.some((tool) => tool.name === "list_records")).toBe(
			true,
		);
		// The catalog build reads this list; the tool stays callable rather than
		// being flipped to "unavailable" for sorting onto page two.
		expect(
			reconcileLiveReadOnlyTools(
				[
					{
						name: "list_records",
						title: "List records",
						description: "Lists records",
						inputSchema: { type: "object" },
						connectionState: "connected",
						connectionReason: null,
						connectProviderId: null,
					},
				],
				listed,
			)[0]?.connectionState,
		).toBe("connected");
	});

	it("terminates against a server that never stops paginating", async () => {
		let page = 0;
		const { cursors, env } = mcpEnv(() => {
			page += 1;
			return {
				tools: [{ name: `tool_${page}` }],
				nextCursor: `cursor-${page}`,
			};
		});

		const listed = await listLiveTools({
			context: { env },
			organizationId: "org-1",
			appSlug: "hostile",
			actingUserId: undefined,
		});

		expect(cursors).toHaveLength(MCP_LIST_MAX_PAGES);
		expect(listed.truncated).toBe(true);
	});

	it("binds tool calls to the current MCP protocol revision", async () => {
		const { env, requests } = mcpEnv(() => ({ tools: [] }));

		await callDirectReadMcp({
			context: { env },
			organizationId: "org-1",
			appSlug: "initech",
			actingUserId: "user-1",
			method: "tools/call",
			params: { name: "list_records", arguments: { limit: 10 } },
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("tools/call");
		expect(requests[0]?.headers.get(MCP_PROTOCOL_VERSION_HEADER)).toBe(
			MCP_MODERN_PROTOCOL_VERSION,
		);
		expect(requests[0]?.headers.get(MCP_METHOD_HEADER)).toBe("tools/call");
		expect(requests[0]?.headers.get(MCP_NAME_HEADER)).toBe("list_records");
		expect(requests[0]?.params).toMatchObject({
			name: "list_records",
			arguments: { limit: 10 },
			_meta: {
				[MCP_PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
				[MCP_CLIENT_INFO_META_KEY]: {
					name: "tedix-home-direct-read",
					version: "1.0.0",
				},
				[MCP_CLIENT_CAPABILITIES_META_KEY]: {},
			},
		});
	});

	it("rejects input-required outcomes before they can be retained as success", () => {
		expect(() =>
			unwrapDirectReadToolResult(
				{
					resultType: "input_required",
					inputRequests: { approval: { type: "boolean" } },
					requestState: "approval-1",
				},
				"list_records",
			),
		).toThrow(/MCP_INPUT_REQUIRED/);
	});
});
