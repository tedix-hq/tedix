import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	CatalogRequestLifetime,
	hydratedCatalogAdmission,
} from "./catalog-admission";
import * as serverFactory from "./mcp/server-factory";
import { handleMcpRequest } from "./mcp-request";

const resolved = {
	app: { id: "fixture-admission", slug: "fixture-admission", name: "Fixture" },
	metadata: {
		mcpConfig: {
			codeMode: true,
			aggregateApps: [{ slug: "fixture-source" }],
			interactionEvents: true,
		},
	},
	tools: [],
};
const env = { MCP_SUBSCRIPTIONS: {} } as unknown as CloudflareEnv;
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
function rpc(method: string, human = false) {
	return new Request("https://fixture.mcp.test/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"MCP-Protocol-Version": "2026-07-28",
			"Mcp-Method": method,
			...(human
				? {
						"x-tedix-auth-type": "oauth",
						"x-tedix-auth-user-id": "fixture-human",
					}
				: {}),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method,
			params: {
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		}),
	});
}
afterEach(() => vi.restoreAllMocks());

describe("catalog admission routing", () => {
	it.each(["GET", "server/discover", "tools/list", "events/list"])(
		"keeps %s outside the hydrated queue",
		async (method) => {
			vi.spyOn(serverFactory, "getAppContext").mockRejectedValue(
				new Error("Must not hydrate the catalog"),
			);
			const gate = vi
				.spyOn(hydratedCatalogAdmission, "run")
				.mockRejectedValue(new Error("Queue must be bypassed"));
			const request =
				method === "GET"
					? new Request("https://fixture.mcp.test/mcp")
					: rpc(method);
			const response = await handleMcpRequest(
				request,
				resolved as never,
				env,
				ctx,
			);
			expect(response.status).toBe(method === "GET" ? 405 : 200);
			await response.text();
			expect(gate).not.toHaveBeenCalled();
		},
	);

	it("revalidates a queued grant before any catalog hydration", async () => {
		vi.spyOn(hydratedCatalogAdmission, "run").mockImplementation(
			async (_request, handler) =>
				handler(new CatalogRequestLifetime(() => {}), true),
		);
		const revalidate = vi.fn(async () =>
			Response.json({ error: "human_mcp_grant_invalid" }, { status: 403 }),
		);
		const response = await handleMcpRequest(
			rpc("resources/list", true),
			resolved as never,
			env,
			ctx,
			undefined,
			undefined,
			undefined,
			revalidate,
		);
		expect(response.status).toBe(403);
		expect(revalidate).toHaveBeenCalledTimes(1);
	});

	it("fails closed for a queued human without an admission revalidator", async () => {
		vi.spyOn(hydratedCatalogAdmission, "run").mockImplementation(
			async (_request, handler) =>
				handler(new CatalogRequestLifetime(() => {}), true),
		);
		const response = await handleMcpRequest(
			rpc("resources/list", true),
			resolved as never,
			env,
			ctx,
		);
		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("1");
		expect(await response.json()).toEqual({
			error: "mcp_access_revalidation_required",
		});
	});
});
