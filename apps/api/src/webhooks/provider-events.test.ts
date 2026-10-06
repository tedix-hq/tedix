import { Hono } from "hono";
import { beforeEach, describe, it, expect, vi } from "vite-plus/test";
import { callbackTokenHash } from "../services/provider-events/types";
const mocks = vi.hoisted(() => ({
	channel: vi.fn(),
	subscription: vi.fn(),
	update: vi.fn(),
	queue: vi.fn(),
	context: vi.fn(),
}));
vi.mock("@tedix/db/queries/provider-events", () => ({
	resolveProviderEventChannel: mocks.channel,
	getProviderEventSubscription: mocks.subscription,
	updateProviderEventSubscription: mocks.update,
}));
vi.mock("../rpc/orpc", () => ({ createContext: mocks.context }));
vi.mock("../services/provider-events/subscriptions", () => ({
	queueReconciliation: mocks.queue,
}));
import { handleProviderEventWebhook } from "./provider-events";
let channel: Record<string, unknown>, row: Record<string, unknown>;
function app() {
	const api = new Hono<{ Bindings: CloudflareEnv }>();
	api.post("/:adapter/:id", (c) =>
		handleProviderEventWebhook(c, c.req.param("adapter"), c.req.param("id")),
	);
	return api;
}
function google(secret = "secret", extra: Record<string, string> = {}) {
	return {
		method: "POST",
		headers: {
			"X-Goog-Channel-Id": "channel",
			"X-Goog-Channel-Token": secret,
			"X-Goog-Resource-Id": "resource",
			"X-Goog-Resource-State": "exists",
			"X-Goog-Message-Number": "2",
			...extra,
		},
	};
}
beforeEach(async () => {
	vi.clearAllMocks();
	channel = {
		id: "channel",
		organizationId: "org-a",
		subscriptionId: "sub",
		tokenHash: await callbackTokenHash("secret"),
		status: "active",
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		resourceId: "resource",
		providerChannelId: "graph-sub",
	};
	row = {
		id: "sub",
		organizationId: "org-a",
		adapter: "google_calendar",
		status: "active",
	};
	mocks.channel.mockImplementation(async () => channel);
	mocks.subscription.mockImplementation(async () => row);
	mocks.context.mockReturnValue({ db: {} });
	mocks.queue.mockResolvedValue(true);
});
describe("calendar webhook authentication", () => {
	it("rejects forged secrets and resource/channel substitutions", async () => {
		expect(
			(await app().request("/google_calendar/channel", google("forged")))
				.status,
		).toBe(403);
		expect(
			(
				await app().request(
					"/google_calendar/channel",
					google("secret", { "X-Goog-Resource-Id": "other" }),
				)
			).status,
		).toBe(403);
		expect(mocks.queue).not.toHaveBeenCalled();
	});
	it("persists a selected-subscription notification before ACK", async () => {
		expect(
			(await app().request("/google_calendar/channel", google())).status,
		).toBe(202);
		expect(mocks.subscription).toHaveBeenCalledWith({}, "org-a", "sub");
		expect(mocks.queue).toHaveBeenCalledWith(
			expect.anything(),
			row,
			"google:channel:2",
		);
	});
	it("accepts the pre-response Google sync race without dispatching unknown resource state", async () => {
		channel.status = "pending";
		expect(
			(
				await app().request(
					"/google_calendar/channel",
					google("secret", { "X-Goog-Resource-State": "sync" }),
				)
			).status,
		).toBe(204);
		expect(mocks.queue).not.toHaveBeenCalled();
	});
	it("denies disabled, expired and wrong-provider channels", async () => {
		row.status = "disabled";
		expect(
			(await app().request("/google_calendar/channel", google())).status,
		).toBe(404);
		row.status = "active";
		expect(
			(await app().request("/microsoft_calendar/channel", google())).status,
		).toBe(404);
		channel.expiresAt = "2000-01-01";
		expect(
			(await app().request("/google_calendar/channel", google())).status,
		).toBe(404);
	});
	it("answers only pending Graph challenges as decoded plain text", async () => {
		row.adapter = "microsoft_calendar";
		channel.status = "pending";
		const result = await app().request(
			"/microsoft_calendar/channel?validationToken=a%2Bb%26c",
			{ method: "POST" },
		);
		expect(result.status).toBe(200);
		expect(await result.text()).toBe("a+b&c");
		channel.status = "active";
		expect(
			(
				await app().request("/microsoft_calendar/channel?validationToken=x", {
					method: "POST",
				})
			).status,
		).toBe(403);
	});
	it("validates the entire Graph batch before persisting any event", async () => {
		row.adapter = "microsoft_calendar";
		const entry = {
			subscriptionId: "graph-sub",
			clientState: "secret",
			changeType: "updated",
			resource: "users/id/events/event",
		};
		const result = await app().request("/microsoft_calendar/channel", {
			method: "POST",
			body: JSON.stringify({
				value: [entry, { ...entry, clientState: "forged" }],
			}),
		});
		expect(result.status).toBe(403);
		expect(mocks.queue).not.toHaveBeenCalled();
	});
	it("queues valid Graph events and wakes renewal on lifecycle notification", async () => {
		row.adapter = "microsoft_calendar";
		expect(
			(
				await app().request("/microsoft_calendar/channel", {
					method: "POST",
					body: JSON.stringify({
						value: [
							{
								subscriptionId: "graph-sub",
								clientState: "secret",
								lifecycleEvent: "missed",
							},
						],
					}),
				})
			).status,
		).toBe(202);
		expect(mocks.queue).toHaveBeenCalledTimes(1);
		expect(mocks.update).toHaveBeenCalledWith(
			{},
			"org-a",
			"sub",
			expect.objectContaining({ expiresAt: expect.any(String) }),
		);
	});
});

it("bounds anonymous Graph payloads without trusting Content-Length", async () => {
	row.adapter = "microsoft_calendar";
	expect(
		(
			await app().request("/microsoft_calendar/channel", {
				method: "POST",
				body: "x".repeat(256_001),
			})
		).status,
	).toBe(413);
	expect(mocks.queue).not.toHaveBeenCalled();
});
