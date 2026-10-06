import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { resolveHealthProbeApp, runHealthChecks } from "./mcp-health";

describe("resolveHealthProbeApp", () => {
	it("resolves user probes inside the caller organization", async () => {
		const global = async () => ({ id: "wrong-org" }) as never;
		const forOrganization = async (
			_db: BaseContext["db"],
			slug: string,
			organizationId: string,
		) => ({ id: "installed", slug, organizationId }) as never;
		const listForOrganization = async () => [];
		const context = {
			authType: "user",
			organizationId: "org-acme",
			db: {},
		} as BaseContext;

		await expect(
			resolveHealthProbeApp(context, "initech", {
				global,
				forOrganization,
				listForOrganization,
			}),
		).resolves.toMatchObject({
			id: "installed",
			slug: "initech",
			organizationId: "org-acme",
		});
	});

	it("resolves a catalog source reference to its tenant-installed proxy", async () => {
		const context = {
			authType: "user",
			organizationId: "org-acme",
			db: {},
		} as BaseContext;

		await expect(
			resolveHealthProbeApp(context, "initech", {
				global: async () => null,
				forOrganization: async () => null,
				listForOrganization: async () =>
					[
						{
							id: "installed",
							slug: "initech-acme",
							organizationId: "org-acme",
							metadata: {
								mcpConfig: { aggregateApps: [{ slug: "initech" }] },
							},
						},
					] as never,
			}),
		).resolves.toMatchObject({ id: "installed", slug: "initech-acme" });
	});

	it("keeps platform probes on global app discovery", async () => {
		const global = async (_db: BaseContext["db"], slug: string) =>
			({ id: "platform", slug }) as never;
		const forOrganization = async () => ({ id: "wrong" }) as never;
		const listForOrganization = async () => [];
		const context = {
			authType: "service-binding",
			organizationId: null,
			db: {},
		} as BaseContext;

		await expect(
			resolveHealthProbeApp(context, "tedix", {
				global,
				forOrganization,
				listForOrganization,
			}),
		).resolves.toMatchObject({ id: "platform", slug: "tedix" });
	});
});

describe("runHealthChecks", () => {
	it("uses only stateless MCP 2026 requests for Tedix app probes", async () => {
		const requests: Array<{
			headers: Headers;
			method: string;
			params: Record<string, unknown>;
		}> = [];
		const fetcher = {
			fetch: async (requestOrUrl: Request | string, init?: RequestInit) => {
				const request =
					requestOrUrl instanceof Request
						? requestOrUrl
						: new Request(requestOrUrl, init);
				const body = (await request.json()) as {
					id: number;
					method: string;
					params?: Record<string, unknown>;
				};
				requests.push({
					headers: request.headers,
					method: body.method,
					params: body.params ?? {},
				});
				const result = (() => {
					switch (body.method) {
						case "server/discover":
							return {
								resultType: "complete",
								supportedVersions: ["2026-07-28"],
								capabilities: { extensions: {} },
							};
						case "tools/list":
							return {
								resultType: "complete",
								tools: [{ name: "get_info", inputSchema: { type: "object" } }],
								ttlMs: 60_000,
								cacheScope: "private",
							};
						case "resources/list":
							return {
								resultType: "complete",
								resources: [],
								ttlMs: 60_000,
								cacheScope: "private",
							};
						case "resources/templates/list":
							return {
								resultType: "complete",
								resourceTemplates: [],
								ttlMs: 60_000,
								cacheScope: "private",
							};
						default:
							return undefined;
					}
				})();
				if (body.method === "resources/read") {
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						error: { code: -32602, message: "missing resource" },
					});
				}
				return Response.json({ jsonrpc: "2.0", id: body.id, result });
			},
		} as unknown as Fetcher;

		const checks = await runHealthChecks(
			"https://mcp.tedix.dev/mcp",
			"example.mcp.tedix.dev",
			{},
			fetcher,
		);

		expect(checks.every((check) => check.passed)).toBe(true);
		expect(checks.find((check) => check.name === "list-tools")?.data).toEqual({
			toolCount: 1,
		});
		expect(requests.some((request) => request.method === "initialize")).toBe(
			false,
		);
		for (const request of requests) {
			expect(request.headers.get("mcp-protocol-version")).toBe("2026-07-28");
			expect(request.headers.get("mcp-method")).toBe(request.method);
			expect(
				(request.params._meta as Record<string, unknown>)[
					"io.modelcontextprotocol/protocolVersion"
				],
			).toBe("2026-07-28");
		}
		const missing = requests.find(
			(request) => request.method === "resources/read",
		);
		expect(missing?.headers.get("mcp-name")).toContain(
			"missing-protocol-probe",
		);
	});
});
