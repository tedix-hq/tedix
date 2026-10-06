import { describe, it, expect, vi } from "vite-plus/test";
import { googleCalendarAdapter } from "./google-calendar";
import type { Subscription } from "./types";
describe("Google watch adapter", () => {
	it("encodes calendar identity and sends isolated channel capability", async () => {
		const request = vi.fn().mockResolvedValue(
			Response.json({
				id: "channel",
				resourceId: "resource",
				expiration: String(Date.now() + 60_000),
			}),
		);
		const adapter = googleCalendarAdapter(request);
		const result = await adapter.register(
			"vault-token",
			{ calendarId: "a/b@example.com" } as Subscription,
			"channel",
			"callback-secret",
			"https://api.test/hook",
		);
		expect(request.mock.calls[0][0]).toContain("a%2Fb%40example.com");
		expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({
			id: "channel",
			token: "callback-secret",
			type: "web_hook",
		});
		expect(result.resourceId).toBe("resource");
	});
	it("rejects provider failures without exposing bearer or response body", async () => {
		const adapter = googleCalendarAdapter(
			vi
				.fn()
				.mockResolvedValue(
					new Response("token-sensitive-body", { status: 403 }),
				),
		);
		await expect(
			adapter.register(
				"secret",
				{} as Subscription,
				"id",
				"secret",
				"https://api.test",
			),
		).rejects.toThrow("Provider request failed (403)");
	});
	it("stops exact channel and resource, tolerating already absent", async () => {
		const request = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 404 }));
		await googleCalendarAdapter(request).stop("vault", "id", "resource");
		expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({
			id: "id",
			resourceId: "resource",
		});
	});
});

it("validates selected calendar before standing monitoring", async () => {
	const request = vi
		.fn()
		.mockResolvedValue(Response.json({ id: "a@example.com" }));
	await googleCalendarAdapter(request).validateCalendar("vault", {
		calendarId: "a@example.com",
	} as Subscription);
	expect(request.mock.calls[0][0]).toContain(
		encodeURIComponent("a@example.com"),
	);
	request.mockResolvedValue(Response.json({ id: "another-calendar" }));
	await expect(
		googleCalendarAdapter(request).validateCalendar("vault", {
			calendarId: "a@example.com",
		} as Subscription),
	).rejects.toThrow("Selected calendar unavailable");
});
