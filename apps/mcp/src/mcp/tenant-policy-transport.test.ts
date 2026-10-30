import { describe, expect, it, vi } from "vite-plus/test";
import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import type { ToolExecutionContext } from "./handler";
const { probe } = vi.hoisted(() => ({
	probe: vi.fn().mockResolvedValue("c".repeat(64)),
}));
vi.mock("./upstream-mcp-client", () => ({
	prepareUpstreamIdentityProbe: probe,
	callUpstreamMcpTool: async (call: {
		reauthorize?: () => Promise<{ status: number; error: string } | undefined>;
		identityProbe?: { revalidate: () => Promise<boolean> };
	}) => {
		const denied = await call.reauthorize?.();
		if (
			!denied &&
			call.identityProbe &&
			!(await call.identityProbe.revalidate())
		)
			return { ok: false, status: 403, error: "Policy revoked" };
		return denied
			? { ok: false, ...denied }
			: { ok: true, era: "legacy_streamable_2025", result: { content: [] } };
	},
}));
import { executeMcpTransport } from "./handler-mcp-transport";

const selection = {
	organizationId: "org",
	providerId: "provider",
	scope: "tenant" as const,
	connectionInstanceId: "00000000-0000-4000-8000-000000000001",
	accountRevisionDigest: "a".repeat(64),
};
const config = {
	transport: "mcp",
	mcpServerUrl: "https://provider.example/mcp",
	mcpToolName: "edit",
	auth: { type: "connection", connectionId: "provider", scope: "tenant" },
} as ToolConfig;
const context = {
	appId: "app",
	app: { id: "app", organizationId: "org" },
	appCapabilities: {},
	env: { ENVIRONMENT: "development" },
	config,
	toolId: "edit",
	requestId: "request",
	expectedPolicyCredential: selection,
} as unknown as ToolExecutionContext<ToolConfig>;

describe("policy-bound MCP credential dispatch", () => {
	it("rejects a changed account revision before contacting the provider", async () => {
		const fetchConnectionToken = vi.fn().mockResolvedValue({
			token: "private-token",
			selectedCredential: {
				...selection,
				accountRevisionDigest: "b".repeat(64),
			},
		});
		const result = await executeMcpTransport({}, context, config, {
			fetchConnectionToken,
		});
		expect(result).toMatchObject({
			status: 403,
			data: { error: expect.stringMatching(/account.*policy/i) },
		});
	});
	it("rejects a connection that cannot supply a selected credential", async () => {
		const fetchConnectionToken = vi
			.fn()
			.mockResolvedValue({ token: "private-token" });
		const result = await executeMcpTransport({}, context, config, {
			fetchConnectionToken,
		});
		expect(result.status).toBe(403);
	});
	it("refuses a changed bearer token when the upstream asks to replay", async () => {
		const fetchConnectionToken = vi
			.fn()
			.mockResolvedValueOnce({
				token: "old-token",
				selectedCredential: selection,
			})
			.mockResolvedValueOnce({
				token: "new-token",
				selectedCredential: selection,
			});
		const result = await executeMcpTransport({}, context, config, {
			fetchConnectionToken,
		});
		expect(result).toMatchObject({
			status: 403,
			data: { error: expect.stringMatching(/credential changed/i) },
		});
		expect(fetchConnectionToken).toHaveBeenCalledTimes(2);
	});
	it("prepares identity through the actual resolved credential without returning it", async () => {
		const fetchConnectionToken = vi.fn().mockResolvedValue({
			token: "private-token",
			selectedCredential: selection,
		});
		const result = await executeMcpTransport(
			{},
			{
				...context,
				expectedPolicyCredential: undefined,
				env: {
					...context.env,
					PLATFORM_SERVICE_TOKEN: "service-secret",
				} as CloudflareEnv,
				prepareIdentityProbe: {
					profile: { version: 1, operation: "identity", selectors: [["id"]] },
					binding: "reviewed-profile",
					revalidate: async () => true,
				},
			},
			config,
			{ fetchConnectionToken },
		);
		expect(result).toEqual({
			status: 200,
			data: {
				accountRevisionDigest: "c".repeat(64),
				credentialSummary: {
					scope: "tenant",
					connectionInstanceId: selection.connectionInstanceId,
				},
			},
		});
		expect(probe).toHaveBeenCalledWith(
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer private-token",
				}),
			}),
		);
		expect(JSON.stringify(result)).not.toContain("private-token");
	});
	it("refuses a profile-bound write if its policy was revoked", async () => {
		const fetchConnectionToken = vi.fn().mockResolvedValue({
			token: "private-token",
			selectedCredential: selection,
		});
		const result = await executeMcpTransport(
			{},
			{
				...context,
				expectedPolicyCredential: undefined,
				env: {
					...context.env,
					PLATFORM_SERVICE_TOKEN: "service-secret",
				} as CloudflareEnv,
				expectedPolicyProbe: {
					profile: { version: 1, operation: "identity", selectors: [["id"]] },
					binding: "profile",
					expectedDigest: "c".repeat(64),
					revalidate: async () => false,
				},
			},
			config,
			{ fetchConnectionToken },
		);
		expect(result).toMatchObject({ status: 403 });
	});
});
