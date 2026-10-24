import { z } from "zod";
import type { ProviderAdapter, ProviderFetch } from "./types";
import { requireProviderResponse } from "./types";
const subscriptionResponse = z.object({
	id: z.string().refine((value) => value.trim().length > 0),
	resource: z
		.string()
		.refine((value) => value.trim().length > 0)
		.optional(),
	expirationDateTime: z.iso.datetime({ offset: true }),
});

// Graph watches the signed-in mailbox. Reconciliation remains calendar-selected.
// Shared calendar notification restrictions require explicit polling instead.
export function microsoftCalendarAdapter(
	request: ProviderFetch = fetch,
): ProviderAdapter {
	return {
		async validateCalendar(token, subscription) {
			const result = await requireProviderResponse(
				await request(
					`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(subscription.calendarId)}`,
					{
						headers: { Authorization: `Bearer ${token}` },
						signal: AbortSignal.timeout(15_000),
					},
				),
			);
			const calendar = (await result.json()) as { id?: string };
			if (calendar.id !== subscription.calendarId)
				throw new Error("Selected calendar unavailable");
		},
		async register(token, _subscription, _channelId, secret, callback) {
			const response = await requireProviderResponse(
				await request("https://graph.microsoft.com/v1.0/subscriptions", {
					method: "POST",
					signal: AbortSignal.timeout(15_000),
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						changeType: "created,updated,deleted",
						notificationUrl: callback,
						lifecycleNotificationUrl: callback,
						resource: "me/events",
						expirationDateTime: new Date(
							Date.now() + 24 * 60 * 60 * 1000,
						).toISOString(),
						clientState: secret,
					}),
				}),
			);
			const parsed = subscriptionResponse.safeParse(await response.json());
			if (
				!parsed.success ||
				Date.parse(parsed.data.expirationDateTime) <= Date.now()
			)
				throw new Error("Invalid Graph subscription response");
			const result = parsed.data;
			return {
				providerChannelId: result.id,
				resourceId: result.resource ?? "me/events",
				expiresAt: result.expirationDateTime,
			};
		},
		async stop(token, id) {
			const response = await request(
				`https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(id)}`,
				{
					method: "DELETE",
					signal: AbortSignal.timeout(15_000),
					headers: { Authorization: `Bearer ${token}` },
				},
			);
			if (response.status !== 404) await requireProviderResponse(response);
		},
	};
}
