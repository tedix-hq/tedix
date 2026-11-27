import { beforeEach, expect, it, vi } from "vite-plus/test";
import { startPoppyDoorRequest } from "./poppy-door-traffic";
import type { ResolvedApp } from "./resolution";

const { record, client } = vi.hoisted(() => ({
	record: vi.fn(),
	client: vi.fn(),
}));
vi.mock("./lib/api-client", () => ({ getApiClient: client }));
beforeEach(() => {
	vi.clearAllMocks();
	client.mockReturnValue({ audit: { recordPoppyDoorRequest: record } });
});
const resolvedApp = {
	app: { id: "app-example", organizationId: "org-example" },
	tools: [{ toolId: "search_products" }],
} as ResolvedApp;
const env = { API_SERVICE: {} } as CloudflareEnv;

it("keeps only verified client_id and known operations, including MCP errors in JSON and SSE", async () => {
	for (const sse of [false, true]) {
		const request = new Request(
			"https://store.example/mcp?secret=private-query",
			{
				method: "POST",
				headers: {
					"Poppy-Session": "private-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					method: "tools/call",
					params: {
						name: "search_products",
						arguments: { query: "private-person" },
					},
				}),
			},
		);
		const traffic = startPoppyDoorRequest({ request, resolvedApp, env });
		traffic.identify("https://agent.example/agent.json");
		const body = JSON.stringify({
			result: {
				isError: true,
				content: [{ type: "text", text: "private-result" }],
			},
		});
		const response = new Response(
			sse ? `event: message\ndata: ${body}\n\n` : body,
			{
				headers: {
					"content-type": sse ? "text/event-stream" : "application/json",
				},
			},
		);
		await traffic.record(response);
		expect(record).toHaveBeenLastCalledWith({
			appId: "app-example",
			time: expect.any(String),
			client_id: "https://agent.example/agent.json",
			method: "tools/call",
			tool: "search_products",
			refused: null,
			outcome: "error",
			httpStatus: 200,
		});
		expect(JSON.stringify(record.mock.calls)).not.toContain("private-");
		expect(await request.json()).toHaveProperty("method", "tools/call");
		expect(await response.text()).toContain("private-result");
	}
	expect(client).toHaveBeenCalledWith({
		serviceFetch: env.API_SERVICE,
		orgId: "org-example",
	});
});

it.each(["invalid_session", "version_unsupported", "rate_limited"])(
	"records %s as unidentified rather than trusting inbound claims",
	async (error) => {
		const request = new Request("https://store.example/mcp", {
			method: "POST",
			body: JSON.stringify({
				method: "tools/list",
				client_id: "https://forged.example/agent.json",
				params: { name: "private-person" },
			}),
		});
		await startPoppyDoorRequest({ request, resolvedApp, env }).record(
			Response.json(
				{ error },
				{ status: error === "rate_limited" ? 429 : 400 },
			),
		);
		expect(record).toHaveBeenCalledWith(
			expect.objectContaining({
				client_id: "unidentified",
				method: "tools/list",
				tool: null,
				refused: error,
				outcome: "refused",
			}),
		);
		expect(JSON.stringify(record.mock.calls)).not.toMatch(
			/forged|private-person/,
		);
	},
);

it("records a GET without waiting for its event stream", async () => {
	const request = new Request("https://store.example/mcp");
	const response = new Response(new ReadableStream({ start() {} }), {
		headers: { "content-type": "text/event-stream" },
	});
	await startPoppyDoorRequest({ request, resolvedApp, env }).record(response);
	expect(record).toHaveBeenCalledWith(
		expect.objectContaining({ method: "GET", outcome: "success" }),
	);
	await response.body?.cancel();
});
