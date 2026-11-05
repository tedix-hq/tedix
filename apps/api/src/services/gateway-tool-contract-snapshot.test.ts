import { describe, expect, it, vi } from "vite-plus/test";
import {
	type GatewayToolContractSnapshot,
	persistGatewayToolContractSnapshot,
	snapshotOrganizationGatewayToolContracts,
} from "./gateway-tool-contract-snapshot";

const mocks = vi.hoisted(() => ({
	listOrganizations: vi.fn(),
	getOrganizationAggregatorGateways: vi.fn(),
	getAppsBySlugsWithTools: vi.fn(),
	addWorkItemCommentIfAbsent: vi.fn(),
	resolveMcpToolRequiredScopes: vi.fn(),
}));

vi.mock("@tedix/db/queries/organizations", () => ({
	listOrganizations: mocks.listOrganizations,
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getOrganizationAggregatorGateways: mocks.getOrganizationAggregatorGateways,
}));
vi.mock("@tedix/db/queries/app-records", () => ({
	getAppsBySlugsWithTools: mocks.getAppsBySlugsWithTools,
}));
vi.mock("@tedix/db/queries/work-items/comments", () => ({
	addWorkItemCommentIfAbsent: mocks.addWorkItemCommentIfAbsent,
}));
vi.mock("@tedix/mcp-shared/auth/tool-scopes", () => ({
	resolveMcpToolRequiredScopes: mocks.resolveMcpToolRequiredScopes,
}));

function snapshot(
	tools: GatewayToolContractSnapshot["tools"],
): GatewayToolContractSnapshot {
	return {
		version: 1,
		organizationId: "org-1",
		gatewayId: "gateway-1",
		gatewaySlug: "acme-unified",
		tools,
	};
}

function tool(
	name: string,
	overrides: Partial<GatewayToolContractSnapshot["tools"][number]> = {},
) {
	return {
		name,
		namespace: "work",
		requiredScopes: ["mcp:work.read"],
		writeCapability: "read" as const,
		schemaHash: `${name}-hash`,
		...overrides,
	};
}

function bucket(initial: GatewayToolContractSnapshot) {
	let value = JSON.stringify(initial);
	return {
		get: vi.fn(async () => ({ text: async () => value })),
		put: vi.fn(async (_key: string, next: string) => {
			value = next;
		}),
	};
}

describe("gateway tool contract snapshots", () => {
	it("reports added, removed, and changed tools, then writes nothing for the same surface", async () => {
		const store = bucket(
			snapshot([tool("removed"), tool("changed", { schemaHash: "old-hash" })]),
		);
		const notify = vi.fn(async () => undefined);
		const next = snapshot([
			tool("added"),
			tool("changed", { schemaHash: "new-hash" }),
		]);

		await expect(
			persistGatewayToolContractSnapshot(store, next, notify),
		).resolves.toEqual({
			added: ["work.added"],
			removed: ["work.removed"],
			changed: ["work.changed"],
		});
		expect(notify).toHaveBeenCalledTimes(1);
		expect(store.put).toHaveBeenCalledTimes(1);

		await expect(
			persistGatewayToolContractSnapshot(store, next, notify),
		).resolves.toBeNull();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(store.put).toHaveBeenCalledTimes(1);
	});
});

describe("organization gateway snapshot", () => {
	it("leaves out tools Connect cannot serve instead of failing the run", async () => {
		mocks.listOrganizations.mockResolvedValue([{ id: "org-1" }]);
		mocks.getOrganizationAggregatorGateways.mockResolvedValue(
			new Map([["org-1", { slug: "acme-unified" }]]),
		);
		const sourceTool = (toolId: string, endpoint: string) => ({
			toolId,
			config: { endpoint },
			authRequired: true,
			writeCapability: "write",
			contractHash: `${toolId}-hash`,
			schemaSourceHash: null,
		});
		mocks.getAppsBySlugsWithTools
			.mockResolvedValueOnce([
				{
					app: {
						id: "gateway-1",
						slug: "acme-unified",
						metadata: { mcpConfig: { aggregateApps: [{ slug: "tedix" }] } },
					},
					tools: [],
				},
			])
			.mockResolvedValueOnce([
				{
					app: { metadata: {} },
					tools: [
						sourceTool("list_work_items", "work/list"),
						sourceTool(
							"record_cron_execution",
							"flywheelHealth/recordCronExecution",
						),
					],
				},
			]);
		mocks.resolveMcpToolRequiredScopes.mockImplementation(
			(tool: { toolId: string }) => {
				if (tool.toolId.endsWith("record_cron_execution")) {
					throw new Error(
						`Missing MCP capability mapping for tool: ${tool.toolId}`,
					);
				}
				return ["mcp:work.read"];
			},
		);
		const store = { get: vi.fn(async () => null), put: vi.fn() };

		await expect(
			snapshotOrganizationGatewayToolContracts({} as never, store),
		).resolves.toEqual({ gatewaysChecked: 1, gatewaysChanged: 1 });
		const written = JSON.parse(store.put.mock.calls[0]?.[1] as string);
		expect(written.tools.map((tool: { name: string }) => tool.name)).toEqual([
			"list_work_items",
		]);
	});

	it("still fails on any other scope error", async () => {
		mocks.listOrganizations.mockResolvedValue([{ id: "org-1" }]);
		mocks.getOrganizationAggregatorGateways.mockResolvedValue(
			new Map([["org-1", { slug: "acme-unified" }]]),
		);
		mocks.getAppsBySlugsWithTools
			.mockResolvedValueOnce([
				{
					app: {
						id: "gateway-1",
						slug: "acme-unified",
						metadata: { mcpConfig: { aggregateApps: [{ slug: "tedix" }] } },
					},
					tools: [],
				},
			])
			.mockResolvedValueOnce([
				{
					app: { metadata: {} },
					tools: [{ toolId: "broken", config: {}, writeCapability: null }],
				},
			]);
		mocks.resolveMcpToolRequiredScopes.mockImplementation(() => {
			throw new Error("boom");
		});

		await expect(
			snapshotOrganizationGatewayToolContracts({} as never, {
				get: vi.fn(async () => null),
				put: vi.fn(),
			}),
		).rejects.toThrow("boom");
	});
});
