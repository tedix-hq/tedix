import { describe, expect, it } from "vite-plus/test";
import { ProviderEventRegisterSchema } from "./provider-events";
const id = "11111111-1111-4111-8111-111111111111";
const base = {
	providerId: "provider",
	connectionInstanceId: id,
	tediId: id,
	skillId: id,
	skillRevision: 1,
};
describe("provider subscription resource contracts", () => {
	it("accepts neutral calendar and signed webhook keys and MCP event names", () => {
		expect(
			ProviderEventRegisterSchema.parse({
				...base,
				adapter: "google_calendar",
				resourceKey: "primary",
			}).resourceKey,
		).toBe("primary");
		expect(
			ProviderEventRegisterSchema.parse({
				...base,
				adapter: "github_webhook",
				resourceKey: "example/project",
				githubWebhook: { events: ["issues"] },
			}).githubWebhook?.maxWakesPerHour,
		).toBe(12);
		expect(
			ProviderEventRegisterSchema.parse({
				...base,
				adapter: "mcp_events",
				mcpEvents: { appId: id, eventName: "incident.created" },
			}).mcpEvents?.eventName,
		).toBe("incident.created");
	});
	it("rejects missing resources, wrong settings, personal signed hooks and polling", () => {
		for (const patch of [
			{ resourceKey: undefined },
			{ deliveryMode: "poll" },
			{ connectionScope: "user" },
			{ githubWebhook: undefined },
			{ resourceKey: "../../private" },
			{ resourceKey: "../.." },
			{ resourceKey: "example/.." },
		])
			expect(
				ProviderEventRegisterSchema.safeParse({
					...base,
					adapter: "github_webhook",
					resourceKey: "example/project",
					githubWebhook: { events: ["issues"] },
					...patch,
				}).success,
			).toBe(false);
		expect(
			ProviderEventRegisterSchema.safeParse({
				...base,
				adapter: "mcp_events",
				resourceKey: "extra",
				mcpEvents: { appId: id, eventName: "incident.created" },
			}).success,
		).toBe(false);
		expect(
			ProviderEventRegisterSchema.safeParse({
				...base,
				adapter: "google_calendar",
				resourceKey: "primary",
				githubWebhook: { events: ["issues"] },
			}).success,
		).toBe(false);
	});
});
