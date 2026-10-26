import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import { describe, expect, it, vi } from "vite-plus/test";
import { ToolHandler, type ToolExecutionContext } from "./handler";

describe("named account credential routing", () => {
	it.each(["user", "tenant"] as const)(
		"selects exact %s slots and observes rotation without stale token caching",
		async (scope) => {
			let token = "token-a";
			const apiFetch = vi.fn(
				async (input: RequestInfo | URL, init?: RequestInit) => {
					const request =
						input instanceof Request ? input : new Request(input, init);
					const body = (await request.json()) as {
						json: Record<string, unknown>;
					};
					expect(body.json).toMatchObject({
						providerId: "microsoft",
						userId: "alice",
						scope,
					});
					return Response.json({ json: { accessToken: token } });
				},
			);
			const context = (id: string): ToolExecutionContext<ToolConfig> => ({
				appId: "app",
				app: {
					id: "app",
					slug: "outlook",
					name: "Outlook",
					domain: null,
					organizationId: "org",
				},
				appCapabilities: {},
				env: {
					API_SERVICE: { fetch: apiFetch },
					ENVIRONMENT: "test",
				} as unknown as CloudflareEnv,
				config: {
					auth: {
						type: "connection",
						connectionId: "microsoft",
						connectionInstanceId: id,
					},
				} as ToolConfig,
				toolId: "get_me",
				requestId: "request",
				callerIdentity: {
					authType: "oauth",
					userId: "alice",
					organizationId: "org",
					scopes: [],
				},
			});
			const handler = new ToolHandler() as unknown as {
				fetchConnectionToken: (
					ctx: ToolExecutionContext<ToolConfig>,
					provider: string,
					scope: "tenant" | "user",
				) => Promise<{ token: string | null }>;
			};
			const a = "11111111-1111-4111-8111-111111111111";
			const b = "22222222-2222-4222-8222-222222222222";
			expect(
				(await handler.fetchConnectionToken(context(a), "microsoft", scope))
					.token,
			).toBe("token-a");
			token = "token-b";
			expect(
				(await handler.fetchConnectionToken(context(b), "microsoft", scope))
					.token,
			).toBe("token-b");
			token = "rotated-a";
			expect(
				(await handler.fetchConnectionToken(context(a), "microsoft", scope))
					.token,
			).toBe("rotated-a");
			expect(apiFetch).toHaveBeenCalledTimes(3);
			await expect(
				handler.fetchConnectionToken(
					context("forged-label"),
					"microsoft",
					scope,
				),
			).rejects.toThrow("Invalid account binding");
			expect(apiFetch).toHaveBeenCalledTimes(3);
		},
	);
});

describe("request-local catalog handler", () => {
	const context = (
		catalogTransport?: ToolExecutionContext<ToolConfig>["catalogTransport"],
	) =>
		({
			config: { transport: "catalog", endpoint: "catalog/search" },
			catalogTransport,
			env: {
				LOADER: {
					load: () => {
						throw new Error("loader forbidden");
					},
					get: () => {
						throw new Error("get forbidden");
					},
				},
			},
		}) as unknown as ToolExecutionContext<ToolConfig>;
	it("isolates concurrent callbacks on the singleton and refuses a missing one", async () => {
		const handler = new ToolHandler();
		const a = vi.fn(async () => ({ org: "fictional-a", results: [] }));
		const b = vi.fn(async () => ({ org: "fictional-b", results: [] }));
		const [left, right] = await Promise.all([
			handler.execute({ query: "a" }, context(a)),
			handler.execute({ query: "b" }, context(b)),
		]);
		expect(left.data).toEqual({ org: "fictional-a", results: [] });
		expect(right.data).toEqual({ org: "fictional-b", results: [] });
		expect(a).toHaveBeenCalledOnce();
		expect(b).toHaveBeenCalledOnce();
		expect((await handler.execute({}, context())).status).toBe(400);
	});
	it("rejects malformed input/config before calling the private capability", async () => {
		const callback = vi.fn(async () => ({}));
		const ctx = context(callback);
		expect(
			(await new ToolHandler().execute({ code: "async()=>1" }, ctx)).status,
		).toBe(400);
		ctx.config = { ...ctx.config, endpoint: "apps/list" };
		expect((await new ToolHandler().execute({}, ctx)).status).toBe(400);
		expect(callback).not.toHaveBeenCalled();
	});
});

describe("scoped connection credentials", () => {
	it.each([
		{ tedi: false, scope: "tenant", aggregate: false },
		{ tedi: true, scope: "tenant", aggregate: false },
		{ tedi: true, scope: "user", aggregate: false },
		{ tedi: false, scope: "tenant", aggregate: true },
		{ tedi: true, scope: "tenant", aggregate: true },
		{ tedi: true, scope: "user", aggregate: true },
	] as const)(
		"forwards mapped arguments and stops before dispatch (tedi=$tedi, scope=$scope, aggregate=$aggregate)",
		async ({ tedi, scope, aggregate }) => {
			const outside = "22222222-2222-4222-8222-222222222222";
			const providerFetch = vi.spyOn(globalThis, "fetch");
			const apiFetch = vi.fn(
				async (input: RequestInfo | URL, init?: RequestInit) => {
					const request =
						input instanceof Request ? input : new Request(input, init);
					expect(request.url).toContain(
						scope === "user" ? "fetchTediToken" : "fetchOrgToken",
					);
					expect(request.headers.get("X-Tedix-Mcp-Tool-Id")).toBe("fetch_page");
					const body = (await request.json()) as {
						json: Record<string, unknown>;
					};
					expect(body.json).toMatchObject({
						connectionInstanceId: "11111111-1111-4111-8111-111111111111",
						delegatedToolUse: { appId: "app", arguments: { url: outside } },
					});
					return Response.json(
						{ json: { message: "Outside the connection's allowed resources" } },
						{ status: 403 },
					);
				},
			);
			const context = {
				appId: aggregate ? "gateway" : "app",
				app: { id: "app", organizationId: "org", slug: "notion" },
				appCapabilities: {},
				env: { API_SERVICE: { fetch: apiFetch }, ENVIRONMENT: "test" },
				config: {
					transport: "mcp",
					...(aggregate ? { _sourceAppId: "app" } : {}),
					mcpServerUrl: "https://provider.example/mcp",
					mcpToolName: "notion-fetch",
					paramMap: { page: "url" },
					auth: {
						type: "connection",
						connectionId: "notion",
						credentialScope: scope,
						connectionInstanceId: "11111111-1111-4111-8111-111111111111",
					},
				},
				toolId: aggregate ? "notion__fetch_page" : "fetch_page",
				requestId: "request",
				callerIdentity: {
					authType: "oauth",
					userId: "alice",
					organizationId: "org",
					...(tedi ? { tediId: "worker" } : {}),
				},
			} as unknown as ToolExecutionContext<ToolConfig>;
			try {
				const handler = new ToolHandler();
				for (let call = 0; call < 2; call++) {
					const result = await handler.execute(
						{ page: outside, ignored: "outside-argument" },
						context,
					);
					expect(result.status).toBe(403);
					expect(result.connectionRecovery).toBeUndefined();
				}
				expect(apiFetch).toHaveBeenCalledTimes(2);
				expect(providerFetch).not.toHaveBeenCalled();
			} finally {
				providerFetch.mockRestore();
			}
		},
	);
});
