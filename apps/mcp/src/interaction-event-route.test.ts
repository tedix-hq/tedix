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
it("lists the reply webhook event and the org-scoped poll events", async () => {
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
				{
					name: "work.item.state_changed",
					delivery: ["poll"],
					inputSchema: { required: ["organization_id"] },
				},
				{ name: "work.approval.requested", delivery: ["poll"] },
				{ name: "skill.run.failed", delivery: ["poll"] },
			],
		},
	});
});
it("advertises webhook delivery for ledger events only when the app opts in", async () => {
	const response = await maybeHandleInteractionEvents(
		request("events/list"),
		{} as CloudflareEnv,
		true,
		true,
	);
	const { result } = (await response!.json()) as {
		result: { events: Array<{ name: string; delivery: string[] }> };
	};
	expect(
		Object.fromEntries(result.events.map((e) => [e.name, e.delivery])),
	).toEqual({
		"work.interaction.responded": ["webhook"],
		"work.item.state_changed": ["poll", "webhook"],
		"work.approval.requested": ["poll", "webhook"],
		"skill.run.failed": ["poll", "webhook"],
	});
	const subscribe = await maybeHandleInteractionEvents(
		new Request("https://plugin.example/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"MCP-Protocol-Version": "2026-07-28",
				"Mcp-Method": "events/subscribe",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "events/subscribe",
				params: {
					name: "work.item.state_changed",
					arguments: { organization_id: ORG },
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientCapabilities": {},
					},
				},
			}),
		}),
		{} as CloudflareEnv,
		true,
		true,
	);
	expect(await subscribe!.json()).toMatchObject({ error: { code: -32024 } });
});
it("answers a delivery mode the event does not offer with Unsupported", async () => {
	const poll = await maybeHandleInteractionEvents(
		request("events/poll", {
			name: "work.interaction.responded",
			arguments: { organization_id: ORG, request_id: REQUEST },
			cursor: null,
		}),
		{} as CloudflareEnv,
		true,
	);
	expect(await poll!.json()).toMatchObject({
		error: { code: -32026, data: { value: "poll" } },
	});
	const subscribe = await maybeHandleInteractionEvents(
		request("events/subscribe", {
			name: "work.item.state_changed",
			arguments: { organization_id: ORG },
		}),
		{} as CloudflareEnv,
		true,
	);
	expect(await subscribe!.json()).toMatchObject({
		error: { code: -32026, data: { value: "webhook" } },
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
