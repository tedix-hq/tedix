import type { ProviderAdapter, ProviderFetch } from "./types";
import { requireProviderResponse } from "./types";
export function googleCalendarAdapter(
	request: ProviderFetch = fetch,
): ProviderAdapter {
	return {
		async validateCalendar(token, subscription) {
			const result = await requireProviderResponse(
				await request(
					`https://www.googleapis.com/calendar/v3/users/me/calendarList/${encodeURIComponent(subscription.calendarId)}`,
					{
						headers: { Authorization: `Bearer ${token}` },
						signal: AbortSignal.timeout(15_000),
					},
				),
			);
			const calendar = (await result.json()) as { id?: string };
			if (
				!calendar.id ||
				(subscription.calendarId !== "primary" &&
					calendar.id !== subscription.calendarId)
			)
				throw new Error("Selected calendar unavailable");
		},
		async register(token, subscription, channelId, secret, callback) {
			const response = await requireProviderResponse(
				await request(
					`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(subscription.calendarId)}/events/watch`,
					{
						method: "POST",
						signal: AbortSignal.timeout(15_000),
						headers: {
							Authorization: `Bearer ${token}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							id: channelId,
							type: "web_hook",
							address: callback,
							token: secret,
							expiration: Date.now() + 24 * 60 * 60 * 1000,
						}),
					},
				),
			);
			const result: unknown = await response.json();
			if (
				typeof result !== "object" ||
				result === null ||
				!("id" in result) ||
				result.id !== channelId ||
				!("resourceId" in result) ||
				typeof result.resourceId !== "string" ||
				!result.resourceId.trim() ||
				!("expiration" in result) ||
				typeof result.expiration !== "string" ||
				!/^\d+$/.test(result.expiration)
			)
				throw new Error("Invalid Google watch response");
			const expires = Number(result.expiration);
			const expiresAt = new Date(expires);
			if (
				!Number.isSafeInteger(expires) ||
				expires <= Date.now() ||
				!Number.isFinite(expiresAt.getTime())
			)
				throw new Error("Invalid Google watch response");
			return {
				providerChannelId: channelId,
				resourceId: result.resourceId,
				expiresAt: expiresAt.toISOString(),
			};
		},
		async stop(token, id, resourceId) {
			if (!resourceId) return;
			const response = await request(
				"https://www.googleapis.com/calendar/v3/channels/stop",
				{
					method: "POST",
					signal: AbortSignal.timeout(15_000),
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ id, resourceId }),
				},
			);
			if (response.status !== 404) await requireProviderResponse(response);
		},
	};
}
