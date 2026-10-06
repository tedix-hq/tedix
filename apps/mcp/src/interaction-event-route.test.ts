import { expect, it, vi } from "vite-plus/test";
import { maybeHandleInteractionEvents } from "./index";
const ORG = "10000000-0000-4000-8000-000000000001",
	REQUEST = "20000000-0000-4000-8000-000000000002";
function request(
	method: string,
	params: Record<string, unknown> = {},
	headerMethod = method,
) {
	return new Request("https://plugin.example/mcp", {
		method: "POST",
		headers: {
			Authorization: "Bearer synthetic-only",
			"Content-Type": "application/json",
			"MCP-Protocol-Version": "2026-07-28",
			"Mcp-Method": headerMethod,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method,
			params: {
				...params,
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		}),
	});
}
it("stays absent until explicitly enabled", async () => {
	expect(
		await maybeHandleInteractionEvents(
			request("events/list"),
			{} as CloudflareEnv,
			false,
		),
	).toBeNull();
});
it("lists only the bounded reply event", async () => {
	const response = await maybeHandleInteractionEvents(
		request("events/list"),
		{} as CloudflareEnv,
		true,
	);
	expect(await response!.json()).toMatchObject({
		result: {
			events: [
				{
					name: "work.interaction.responded",
					delivery: ["webhook"],
					inputSchema: { required: ["organization_id", "request_id"] },
				},
			],
		},
	});
});
it("rejects mismatched headers before subscribing", async () => {
	const response = await maybeHandleInteractionEvents(
		request("events/list", {}, "tools/call"),
		{} as CloudflareEnv,
		true,
	);
	expect(await response!.json()).toMatchObject({ error: { code: -32020 } });
});
it("shards by org and request and forwards only original bearer for revalidation", async () => {
	const fetch = vi.fn(async (_url: string, init: RequestInit) => {
		const input = JSON.parse(init.body as string);
		expect(input.credential).toEqual({
			authorization: "Bearer synthetic-only",
			mcpUrl: "https://plugin.example/mcp",
			organizationId: ORG,
			requestId: REQUEST,
		});
		return Response.json({
			id: "sub_fixture",
			refreshBefore: "2026-10-05T12:00:00Z",
			truncated: false,
			cursor: null,
		});
	});
	const idFromName = vi.fn((name: string) => name);
	const env = {
		MCP_SUBSCRIPTIONS: { idFromName, get: () => ({ fetch }) },
	} as unknown as CloudflareEnv;
	const response = await maybeHandleInteractionEvents(
		request("events/subscribe", {
			arguments: { organization_id: ORG, request_id: REQUEST },
		}),
		env,
		true,
	);
	expect(idFromName).toHaveBeenCalledWith(`events:${ORG}:${REQUEST}`);
	expect(await response!.json()).toMatchObject({
		result: {
			id: "sub_fixture",
			refreshBefore: "2026-10-05T12:00:00Z",
			truncated: false,
		},
	});
});
it("rejects an unscoped unsubscribe ID", async () => {
	const response = await maybeHandleInteractionEvents(
		request("events/unsubscribe", { subscriptionId: "sub_unknown" }),
		{} as CloudflareEnv,
		true,
	);
	expect(await response!.json()).toMatchObject({ error: { code: -32602 } });
});
