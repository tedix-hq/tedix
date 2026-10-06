import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { getApiClient, getByDomain, getBySlugWithTools, mountMcp } = vi.hoisted(
	() => {
		const getByDomain = vi.fn();
		const getBySlugWithTools = vi.fn();
		return {
			getByDomain,
			getBySlugWithTools,
			getApiClient: vi.fn(() => ({
				apps: {
					getByDomain,
					getBySlugWithTools,
				},
			})),
			mountMcp: vi.fn(
				async (
					_server: unknown,
					_request: Request,
					options: {
						discover?: { serverInfo?: { name?: string; version?: string } };
					},
				) =>
					new Response(
						JSON.stringify({
							serverInfo: options.discover?.serverInfo,
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
			),
		};
	},
);

vi.mock("./lib/api-client", () => ({
	getApiClient,
}));

vi.mock("@tedix/mcp-shared/transport", () => ({
	mountMcp,
}));

import worker from "./index";

function createExecutionContext() {
	return {
		waitUntil: vi.fn((promise: Promise<unknown>) => {
			promise.catch(() => {});
		}),
		passThroughOnException: vi.fn(),
	} as unknown as ExecutionContext;
}

function createEnv() {
	return {
		ENVIRONMENT: "development",
		MCP_URL: "https://mcp.tedix.tech",
		API_URL: "https://api.tedix.tech",
		MCP_UI_URL: "https://mcp-ui.tedix.tech",
		GIT_SHA: "dev",
		DESCOPE_AIH_BASE_URL: "https://api.descope.com",
		DEFAULT_APP_SLUG: "",
		DO_NOT_TRACK: "1",
		API_SERVICE: {
			fetch: vi.fn(),
		},
	} as unknown as CloudflareEnv;
}

describe("base MCP domain routing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getByDomain.mockResolvedValue({ app: null });
		getBySlugWithTools.mockResolvedValue({ app: null, tools: [] });
	});

	it("rejects base-domain scanner paths without app lookup", async () => {
		const env = createEnv();
		const response = await worker.fetch(
			new Request("https://mcp.tedix.tech/wp-includes/wlwmanifest.xml"),
			env,
			createExecutionContext(),
		);

		expect(response.status).toBe(404);
		expect(getApiClient).not.toHaveBeenCalled();
		expect(env.API_SERVICE.fetch).not.toHaveBeenCalled();
	});

	it("serves deployed-SHA health without allowing an edge cache", async () => {
		const env = createEnv();
		// wrangler now narrows a var to the literal values declared in
		// wrangler.jsonc, so `GIT_SHA` types as the placeholders ("dev" |
		// "production"). A release is supposed to override it with the real
		// SHA, which is what this test exercises, so assign through a string
		// view rather than widening the generated type.
		(env as unknown as { GIT_SHA: string }).GIT_SHA =
			"d12dc3f03a5ef8bb61c9a4f1b13d317f4132d458";
		const response = await worker.fetch(
			new Request("https://mcp.tedix.dev/health?proof=fresh"),
			env,
			createExecutionContext(),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		await expect(response.json()).resolves.toMatchObject({
			status: "ok",
			service: "mcp",
			deployedSha: "d12dc3f03a5ef8bb61c9a4f1b13d317f4132d458",
		});
		expect(getApiClient).not.toHaveBeenCalled();
	});

	it("routes base-domain /mcp when the host is a custom MCP domain", async () => {
		getByDomain.mockResolvedValue({
			app: {
				id: "app-custom-domain",
				slug: "custom-domain-app",
				name: "Domain App",
				domain: "domain.example",
				organizationId: "org-custom-domain",
				visibility: "public",
			},
		});
		getBySlugWithTools.mockResolvedValue({
			app: {
				id: "app-custom-domain",
				slug: "custom-domain-app",
				name: "Domain App",
				domain: "domain.example",
				organizationId: "org-custom-domain",
				description: "Custom MCP domain app",
				logoUrl: null,
				customMcpDomain: "mcp.tedix.tech",
				openaiChallengeToken: null,
				openaiAppId: null,
				appStoreStatus: null,
				visibility: "public",
				discoveryStatus: null,
				metadata: {
					mcpConfig: {
						authMode: "public",
						serverName: "Custom Domain MCP",
						serverVersion: "2026.6.6",
					},
				},
			},
			tools: [],
			catalogMcp: null,
			catalogResources: [],
			catalogResourceTemplates: [],
		});

		const env = createEnv();
		const response = await worker.fetch(
			new Request("https://mcp.tedix.tech/mcp"),
			env,
			createExecutionContext(),
		);

		expect(response.status).toBe(200);
		expect(getByDomain).toHaveBeenCalledWith({ domain: "mcp.tedix.tech" });
		expect(getBySlugWithTools).toHaveBeenCalledWith({
			slug: "custom-domain-app",
		});
		expect(mountMcp).toHaveBeenCalledOnce();
		await expect(response.json()).resolves.toMatchObject({
			serverInfo: {
				name: "Custom Domain MCP",
				version: "2026.6.6",
			},
		});
	});

	it("keeps a retryable custom-domain metadata failure as 503 with a cause-chain log", async () => {
		getByDomain.mockResolvedValue({
			app: { id: "app-1", slug: "custom-app", organizationId: "org-1" },
		});
		getBySlugWithTools.mockRejectedValue(
			Object.assign(
				new Error("metadata unavailable", {
					cause: new Error("service binding dropped"),
				}),
				{ status: 503 },
			),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const response = await worker.fetch(
				new Request("https://mcp.tedix.tech/mcp"),
				createEnv(),
				createExecutionContext(),
			);
			expect(response.status).toBe(503);
			expect(response.headers.get("Retry-After")).toBe("2");
			expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
				event: "router.custom_domain_metadata_failed",
				serverHost: "mcp.tedix.tech",
				appSlug: "custom-app",
				exception: {
					message: "metadata unavailable",
					cause: { message: "service binding dropped" },
				},
			});
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("rejects base-domain /mcp when no custom or default app is configured", async () => {
		const env = createEnv();
		const response = await worker.fetch(
			new Request("https://mcp.tedix.tech/mcp"),
			env,
			createExecutionContext(),
		);

		expect(response.status).toBe(400);
		expect(getByDomain).toHaveBeenCalledWith({ domain: "mcp.tedix.tech" });
		expect(getBySlugWithTools).not.toHaveBeenCalled();
		expect(await response.json()).toMatchObject({
			error: "App subdomain required",
		});
	});
});
