import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import type { ToolExecutionContext } from "./handler";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("connection revocation across gateway isolates", () => {
	it.each([
		{ scope: "tenant", tediId: undefined },
		{ scope: "user", tediId: undefined },
		{ scope: "hybrid", tediId: undefined },
		{ scope: "tenant", tediId: "tedi-example" },
		{ scope: "user", tediId: "tedi-example" },
		{ scope: "hybrid", tediId: "tedi-example" },
	] as const)(
		"observes replace, lookup failure and disconnect for $scope / $tediId without TTL expiry",
		async ({ scope, tediId }) => {
			// Separate module graphs give each simulated isolate its own warm caches.
			vi.resetModules();
			const first = new (await import("./handler")).ToolHandler();
			vi.resetModules();
			const second = new (await import("./handler")).ToolHandler();
			vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);

			for (const clientCredentials of [false, true]) {
				let storedCredential: string | null = "old-secret";
				let unavailable = false;
				const apiFetch = vi.fn(async (request: Request) => {
					expect(request.url).toContain(
						tediId && scope !== "tenant"
							? "connections/fetchTediToken"
							: "connections/fetchOrgToken",
					);
					if (unavailable) return Response.json({}, { status: 503 });
					return storedCredential
						? Response.json({ json: { accessToken: storedCredential } })
						: Response.json({}, { status: 404 });
				});
				const usedTokens: string[] = [];
				const exchange = vi.fn((authorization: string | null) => {
					const secret = atob(authorization!.slice("Basic ".length));
					return Response.json({
						access_token: `bearer-for-${secret}`,
						expires_in: 3600,
					});
				});
				globalThis.fetch = vi.fn(async (input, init) => {
					const headers = new Headers(init?.headers);
					if (String(input) === "https://auth.example.com/token")
						return exchange(headers.get("Authorization"));
					usedTokens.push(headers.get("Authorization")!);
					return Response.json({ ok: true });
				}) as typeof fetch;
				const context = {
					appId: "app-example",
					app: {
						id: "app-example",
						slug: "example",
						name: "Example",
						domain: null,
						organizationId: "org-example",
					},
					appCapabilities: {},
					env: {
						ENVIRONMENT: "test",
						API_SERVICE: { fetch: apiFetch },
					} as unknown as CloudflareEnv,
					config: {
						transport: "external",
						method: "GET",
						baseUrl: "https://api.example.com",
						endpoint: "resource",
						auth: {
							type: "connection",
							connectionId: `provider-${clientCredentials}`,
							credentialScope: scope,
							...(clientCredentials
								? {
										clientCredentials: {
											tokenUrl: "https://auth.example.com/token",
										},
									}
								: {}),
						},
					},
					toolId: "get_resource",
					requestId: "request-example",
					callerIdentity: {
						authType: "oauth",
						organizationId: "org-example",
						userId: "user-example",
						tediId,
						scopes: [],
					},
				} as ToolExecutionContext<ToolConfig>;
				const callBoth = async (status: number) => {
					for (const handler of [first, second])
						expect((await handler.execute({}, context)).status).toBe(status);
				};
				const bearer = (secret: string) =>
					`Bearer ${clientCredentials ? `bearer-for-${secret}` : secret}`;

				await callBoth(200);
				await callBoth(200);
				expect(usedTokens).toEqual(Array(4).fill(bearer("old-secret")));
				if (clientCredentials) expect(exchange).toHaveBeenCalledTimes(2);

				storedCredential = "replacement-secret";
				await callBoth(200);
				expect(usedTokens.slice(4)).toEqual(
					Array(2).fill(bearer("replacement-secret")),
				);
				if (clientCredentials) expect(exchange).toHaveBeenCalledTimes(4);

				unavailable = true;
				await callBoth(401);
				unavailable = false;
				storedCredential = null;
				await callBoth(401);
				expect(usedTokens).toHaveLength(6);
				expect(apiFetch).toHaveBeenCalledTimes(10);
				if (clientCredentials) expect(exchange).toHaveBeenCalledTimes(4);
			}
		},
	);
});
