import { describe, it, expect, vi } from "vite-plus/test";
import { microsoftCalendarAdapter } from "./microsoft-calendar";
import type { Subscription } from "./types";
describe("Graph calendar adapter", () => {
	it("subscribes to supported mailbox events rather than invented per-calendar resources", async () => {
		const request = vi.fn().mockResolvedValue(
			Response.json({
				id: "graph-sub",
				resource: "me/events",
				expirationDateTime: new Date(Date.now() + 60_000).toISOString(),
			}),
		);
		await microsoftCalendarAdapter(request).register(
			"vault",
			{ calendarId: "selected-calendar" } as Subscription,
			"channel",
			"secret",
			"https://api.test/hook",
		);
		expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({
			resource: "me/events",
			clientState: "secret",
			changeType: "created,updated,deleted",
			lifecycleNotificationUrl: "https://api.test/hook",
		});
	});
	it("does not silently turn denied push into successful polling", async () => {
		const adapter = microsoftCalendarAdapter(
			vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
		);
		await expect(
			adapter.register(
				"vault",
				{} as Subscription,
				"c",
				"s",
				"https://api.test",
			),
		).rejects.toThrow("403");
	});
	it("deletes only the returned subscription id", async () => {
		const request = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 204 }));
		await microsoftCalendarAdapter(request).stop("vault", "a/b", null);
		expect(request.mock.calls[0][0]).toBe(
			"https://graph.microsoft.com/v1.0/subscriptions/a%2Fb",
		);
	});
});

it("validates selected calendar before standing monitoring", async () => {
	const request = vi
		.fn()
		.mockResolvedValue(Response.json({ id: "calendar-id" }));
	await microsoftCalendarAdapter(request).validateCalendar("vault", {
		calendarId: "calendar-id",
	} as Subscription);
	expect(request.mock.calls[0][0]).toContain(encodeURIComponent("calendar-id"));
	request.mockResolvedValue(Response.json({ id: "another-calendar" }));
	await expect(
		microsoftCalendarAdapter(request).validateCalendar("vault", {
			calendarId: "calendar-id",
		} as Subscription),
	).rejects.toThrow("Selected calendar unavailable");
});
