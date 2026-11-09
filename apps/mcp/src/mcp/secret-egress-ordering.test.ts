import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const policy = vi.hoisted(() => ({
	fallbackBlocked: vi.fn(async () => true),
}));

vi.mock("./tenant-profile-candidate", () => ({
	resolveTenantProfileCandidate: vi.fn(async () => null),
	tenantProfileCandidateIsBounded: vi.fn(() => false),
}));
vi.mock("./tenant-human-replay", () => ({
	resolveHumanPolicyReplay: vi.fn(async () => null),
}));
vi.mock("./tenant-native-candidate", () => ({
	resolveNativePolicyCandidate: vi.fn(async () => null),
	tenantMachinePolicyFallbackBlocked: policy.fallbackBlocked,
}));

import type { ToolCallback } from "./middleware/telemetry";
import type { AppTool, ServerContext } from "./server-context";
import { registerTextOnlyTool } from "./text-tool-registration";

function fixture() {
	let callback: ToolCallback | undefined;
	const execute = vi.fn(async () => ({
		status: 200,
		data: { executed: true },
	}));
	const agent = {
		server: {
			registerTool: vi.fn((_name, _spec, handler: ToolCallback) => {
				callback = handler;
				return {};
			}),
		},
		registeredTools: new Map(),
		appToolIds: new Set(),
		loadedTools: new Map(),
		authRequiredTools: new Set(),
		env: { ENVIRONMENT: "test" },
		ctx: { waitUntil: vi.fn() },
		appId: "app",
		appSlug: "tickets",
		app: {
			id: "app",
			slug: "tickets",
			name: "Tickets",
			organizationId: "org",
		},
		appCapabilities: {},
		appMetadata: { mcpConfig: { authMode: "public" } },
		apiClient: {
			mcpGovernance: {
				resolveSecretEgressPolicy: vi.fn(async () => ({ mode: "block" })),
			},
		},
		toolHandler: { execute },
		traceId: "trace",
	} as unknown as ServerContext;
	const tool = {
		toolId: "create_ticket",
		toolTypeId: "external",
		title: "Create ticket",
		inputSchema: { type: "object", properties: {} },
		config: { transport: "external", endpoint: "tickets" },
	} as unknown as AppTool;
	return {
		agent,
		tool,
		execute,
		get callback() {
			if (!callback) throw new Error("Tool callback was not registered");
			return callback;
		},
	};
}

describe("direct invocation secret-egress ordering", () => {
	beforeEach(() => policy.fallbackBlocked.mockClear());

	it("reports SECRET_EGRESS_DENIED before organization-policy fallback", async () => {
		const f = fixture();
		await registerTextOnlyTool(f.agent, f.tool, {} as never);
		const marker = ["ghp", "0123456789abcdefghij0123"].join("_");

		const result = await f.callback(
			{ body: `safe fake marker ${marker}` },
			{} as Parameters<ToolCallback>[1],
		);

		expect(result).toMatchObject({
			isError: true,
			structuredContent: { code: "SECRET_EGRESS_DENIED" },
			_meta: {
				"tedix/error": {
					code: "SECRET_EGRESS_DENIED",
					status: 403,
					retryable: false,
				},
			},
		});
		expect(policy.fallbackBlocked).not.toHaveBeenCalled();
		expect(f.execute).not.toHaveBeenCalled();
	});

	it("keeps a genuine organization-policy verification failure attributed", async () => {
		const f = fixture();
		await registerTextOnlyTool(f.agent, f.tool, {} as never);

		const result = await f.callback(
			{ body: "ordinary request" },
			{} as Parameters<ToolCallback>[1],
		);

		expect(result).toMatchObject({
			isError: true,
			content: [
				{
					text: "The organization's tool policy could not be verified; no action was executed.",
				},
			],
		});
		expect(policy.fallbackBlocked).toHaveBeenCalledOnce();
		expect(f.execute).not.toHaveBeenCalled();
	});
});
