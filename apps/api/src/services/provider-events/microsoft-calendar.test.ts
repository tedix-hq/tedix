import { describe, it, expect, vi } from "vite-plus/test";
import { microsoftCalendarAdapter } from "./microsoft-calendar";
import type { Subscription } from "./types";
describe("Graph calendar adapter", () => {
	const validResponse = {
		id: "graph-sub",
		resource: "me/events",
		expirationDateTime: "2099-01-01T00:00:00Z",
	};
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
	it.each([
		null,
		[],
		"subscription",
		{},
		...[null, "", "   ", 123, {}, []].map((id) => ({ ...validResponse, id })),
		...[null, "", "   ", 123, {}, []].map((resource) => ({
			...validResponse,
			resource,
		})),
		...[
			null,
			123,
			{},
			["2099-01-01T00:00:00Z"],
			"",
			"not-a-date",
			"2099-01-01",
			"January 1, 2099",
			"2099-02-30T00:00:00Z",
			"2000-01-01T00:00:00Z",
		].map((expirationDateTime) => ({ ...validResponse, expirationDateTime })),
	])("rejects malformed subscription metadata: %j", async (invalid) => {
		const adapter = microsoftCalendarAdapter(
			vi.fn().mockResolvedValue(Response.json(invalid)),
		);
		await expect(
			adapter.register(
				"vault",
				{} as Subscription,
				"c",
				"s",
				"https://api.test",
			),
		).rejects.toThrow("Invalid Graph subscription response");
	});
	it.each(["2099-01-01T00:00:00Z", "2099-01-01T01:00:00.123+01:00"])(
		"accepts future ISO expiry and defaults an omitted resource: %s",
		async (expirationDateTime) => {
			const adapter = microsoftCalendarAdapter(
				vi
					.fn()
					.mockResolvedValue(
						Response.json({ id: "graph-sub", expirationDateTime }),
					),
			);
			await expect(
				adapter.register(
					"vault",
					{} as Subscription,
					"c",
					"s",
					"https://api.test",
				),
			).resolves.toEqual({
				providerChannelId: "graph-sub",
				resourceId: "me/events",
				expiresAt: expirationDateTime,
			});
		},
	);
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
