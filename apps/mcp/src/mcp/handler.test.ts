import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import { describe, expect, it, vi } from "vite-plus/test";
import { ToolHandler, type ToolExecutionContext } from "./handler";

describe("public-egress secret scanning", () => {
	const context = (mode: "block" | "warn") => {
		const catalogTransport = vi.fn(async () => ({ results: [] }));
		const ctx = {
			apiClient: {
				mcpGovernance: {
					resolveSecretEgressPolicy: vi.fn(async () => ({ mode })),
				},
			},
			publicEgress: true,
			appId: "app",
			app: {
				id: "app",
				slug: "tickets",
				name: "Tickets",
				domain: null,
				organizationId: "org",
			},
			appCapabilities: {},
			env: { ENVIRONMENT: "test" },
			config: { transport: "catalog", endpoint: "catalog/search" },
			catalogTransport,
			toolId: "create_public_ticket",
			requestId: "request",
		} as unknown as ToolExecutionContext<ToolConfig>;
		return { catalogTransport, ctx };
	};

	it("blocks a nested token and names only the matched pattern", async () => {
		const { catalogTransport, ctx } = context("block");
		const token = ["ghp", "0123456789abcdefghij0123"].join("_");
		const result = await new ToolHandler().execute(
			{ payload: { body: `ticket text ${token}` } },
			ctx,
		);
		expect(result).toMatchObject({
			status: 403,
			data: { code: "SECRET_EGRESS_DENIED", retryable: false },
		});
		expect((result.data as { error: string }).error).toContain(
			'"catalog" transport',
		);
		expect(JSON.stringify(result)).toContain("GitHub token");
		expect(JSON.stringify(result)).not.toContain(token);
		expect(ctx.secretEgressDecision).toMatchObject({
			gate: "secret_egress",
			gateDecision: "deny",
			secretPattern: "GitHub token",
		});
		expect(catalogTransport).not.toHaveBeenCalled();
	});

	it("scans a third-party transport even when the tool is not flagged publicEgress", async () => {
		const { ctx } = context("block");
		(ctx as { publicEgress?: boolean }).publicEgress = false;
		(ctx as { config: ToolConfig }).config = {
			transport: "mcp",
			endpoint: "search_repositories",
		} as unknown as ToolConfig;
		const token = ["ghp", "0123456789abcdefghij0123"].join("_");
		const result = await new ToolHandler().execute(
			{ query: `tedix ${token}` },
			ctx,
		);
		expect(result).toMatchObject({
			status: 403,
			data: { code: "SECRET_EGRESS_DENIED" },
		});
		expect((result.data as { error: string }).error).toContain(
			'"mcp" transport',
		);
	});

	describe("calls to the organization's own tedi", () => {
		const slugArg = {
			message:
				"https://www.reddit.com/r/NintendoDE/comments/1xq7wbp/nintendo_switch_in_media_markt_nuernberg_2026_edition/ evidence",
		};
		const tediCall = (tediOrgId: string, publicEgress = false) => {
			const { ctx } = context("block");
			(ctx as { publicEgress?: boolean }).publicEgress = publicEgress;
			(ctx as { config: ToolConfig }).config = {
				transport: "mcp",
				mcpToolName: "run_tedi_turn",
				_aggregateTediId: "tedi-1",
				_aggregateTediOrgId: tediOrgId,
			} as unknown as ToolConfig;
			return ctx;
		};

		it("does not scan a same-organization tedi call, so a long URL slug is not mistaken for a key", async () => {
			const ctx = tediCall("org");
			await new ToolHandler().execute(slugArg, ctx).catch(() => undefined);
			expect(ctx.secretEgressDecision).toBeUndefined();
		});

		it("still blocks another organization's tedi and a tool flagged publicEgress", async () => {
			const token = ["ghp", "0123456789abcdefghij0123"].join("_");
			for (const ctx of [tediCall("other-org"), tediCall("org", true)]) {
				const result = await new ToolHandler().execute(
					{ message: `evidence ${token}` },
					ctx,
				);
				expect(result).toMatchObject({
					status: 403,
					data: { code: "SECRET_EGRESS_DENIED" },
				});
			}
			const foreign = tediCall("other-org");
			await new ToolHandler().execute(slugArg, foreign).catch(() => undefined);
			expect(foreign.secretEgressDecision).toMatchObject({
				secretPattern: "long opaque token",
			});
		});
	});

	describe("calls to the organization's own tedi", () => {
		const slugArg = {
			message:
				"https://www.reddit.com/r/NintendoDE/comments/1xq7wbp/nintendo_switch_in_media_markt_nuernberg_2026_edition/ evidence",
		};
		const tediCall = (tediOrgId: string, publicEgress = false) => {
			const { ctx } = context("block");
			(ctx as { publicEgress?: boolean }).publicEgress = publicEgress;
			(ctx as { config: ToolConfig }).config = {
				transport: "mcp",
				mcpToolName: "run_tedi_turn",
				_aggregateTediId: "tedi-1",
				_aggregateTediOrgId: tediOrgId,
			} as unknown as ToolConfig;
			return ctx;
		};

		it("does not scan a same-organization tedi call, so a long URL slug is not mistaken for a key", async () => {
			const ctx = tediCall("org");
			await new ToolHandler().execute(slugArg, ctx).catch(() => undefined);
			expect(ctx.secretEgressDecision).toBeUndefined();
		});

		it("still blocks another organization's tedi and a tool flagged publicEgress", async () => {
			const token = ["ghp", "0123456789abcdefghij0123"].join("_");
			for (const ctx of [tediCall("other-org"), tediCall("org", true)]) {
				const result = await new ToolHandler().execute(
					{ message: `evidence ${token}` },
					ctx,
				);
				expect(result).toMatchObject({
					status: 403,
					data: { code: "SECRET_EGRESS_DENIED" },
				});
			}
			const foreign = tediCall("other-org");
			await new ToolHandler().execute(slugArg, foreign).catch(() => undefined);
			expect(foreign.secretEgressDecision).toMatchObject({
				secretPattern: "long opaque token",
			});
		});
	});

	it("allows the call in warn mode and ignores a normal UUID", async () => {
		const warned = context("warn");
		const token = ["ghp", "0123456789abcdefghij0123"].join("_");
		expect(
			await new ToolHandler().execute(
				{ query: `ticket text ${token}` },
				warned.ctx,
			),
		).toMatchObject({ status: 200 });
		expect(warned.ctx.secretEgressDecision).toMatchObject({
			gateDecision: "allow",
			gateReason: "secret_detected_warn",
			policyMode: "warn",
		});
		expect(warned.catalogTransport).toHaveBeenCalledOnce();

		const safe = context("block");
		expect(
			await new ToolHandler().execute(
				{ query: "5eed0020-0000-4000-8000-000000000020" },
				safe.ctx,
			),
		).toMatchObject({ status: 200 });
		expect(safe.ctx.secretEgressDecision).toBeUndefined();
	});
});

describe("named account credential routing", () => {
	it.each(["user", "tenant"] as const)(
		"selects exact %s slots and observes rotation without stale token caching",
		async (scope) => {
			let token = "token-a";
			let malformedReceipt = false;
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
					return Response.json({
						json: {
							accessToken: token,
							selectedCredential: {
								organizationId: "org",
								providerId: "microsoft",
								scope,
								...(scope === "user" ? { userId: "alice" } : {}),
								connectionInstanceId: body.json.connectionInstanceId,
								...(malformedReceipt ? { accessToken: token } : {}),
							},
						},
					});
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
				) => Promise<{ token: string | null; selectedCredential?: unknown }>;
			};
			const a = "11111111-1111-4111-8111-111111111111";
			const b = "22222222-2222-4222-8222-222222222222";
			const first = await handler.fetchConnectionToken(
				context(a),
				"microsoft",
				scope,
			);
			expect(first.token).toBe("token-a");
			expect(first.selectedCredential).toEqual({
				organizationId: "org",
				providerId: "microsoft",
				scope,
				...(scope === "user" ? { userId: "alice" } : {}),
				connectionInstanceId: a,
			});
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
			malformedReceipt = true;
			expect(
				(await handler.fetchConnectionToken(context(a), "microsoft", scope))
					.selectedCredential,
			).toBeUndefined();
			expect(apiFetch).toHaveBeenCalledTimes(4);
			await expect(
				handler.fetchConnectionToken(
					context("forged-label"),
					"microsoft",
					scope,
				),
			).rejects.toThrow("Invalid account binding");
			expect(apiFetch).toHaveBeenCalledTimes(4);
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
