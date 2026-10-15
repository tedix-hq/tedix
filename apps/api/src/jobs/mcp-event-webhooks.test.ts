import { describe, expect, it, vi } from "vite-plus/test";
import { runMcpEventWebhookDelivery } from "./mcp-event-webhooks";
import { PLATFORM_CRON_DEFINITIONS } from "./platform-cron-catalog";

describe("MCP event webhook delivery tick", () => {
	it("wakes the MCP Worker's delivery pass over the service binding", async () => {
		const fetch = vi.fn(async (request: Request) => {
			expect(new URL(request.url).pathname).toBe("/__internal/events/deliver");
			expect(request.headers.get("X-Service-Binding")).toBe("true");
			return Response.json({ ok: true, claimed: 2, delivered: 1, idle: 1 });
		});
		expect(
			await runMcpEventWebhookDelivery({
				MCP_SERVICE: { fetch },
			} as unknown as CloudflareEnv),
		).toEqual({ claimed: 2, delivered: 1, idle: 1 });
	});

	it("fails the cron receipt when the pass is unavailable", async () => {
		await expect(
			runMcpEventWebhookDelivery({
				MCP_SERVICE: { fetch: async () => new Response(null, { status: 503 }) },
			} as unknown as CloudflareEnv),
		).rejects.toThrow("503");
	});

	it("runs on the existing two-minute trigger behind the MCP binding", () => {
		expect(
			PLATFORM_CRON_DEFINITIONS.find(
				(definition) => definition.id === "mcp-event-webhook-delivery",
			),
		).toEqual({
			id: "mcp-event-webhook-delivery",
			cron: "*/2 * * * *",
			intervalMinutes: 2,
			requiresBinding: "MCP_SERVICE",
		});
	});
});
