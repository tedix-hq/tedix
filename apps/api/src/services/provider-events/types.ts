import type { ProviderEventSubscriptionRow } from "@tedix/db/schema/provider-events";
export type Subscription = ProviderEventSubscriptionRow;
export type Registration = {
	providerChannelId: string;
	resourceId: string | null;
	expiresAt: string;
};
export type ProviderAdapter = {
	validateCalendar: (
		token: string,
		subscription: Subscription,
	) => Promise<void>;
	register: (
		token: string,
		subscription: Subscription,
		channelId: string,
		secret: string,
		callback: string,
	) => Promise<Registration>;
	stop: (
		token: string,
		providerChannelId: string,
		resourceId: string | null,
	) => Promise<void>;
};
export type ProviderFetch = typeof fetch;
export async function callbackTokenHash(token: string) {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return [...new Uint8Array(bytes)]
		.map((x) => x.toString(16).padStart(2, "0"))
		.join("");
}
export function constantEqual(a: string, b: string) {
	let mismatch = a.length ^ b.length;
	for (let i = 0; i < Math.max(a.length, b.length); i++)
		mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	return mismatch === 0;
}
export async function requireProviderResponse(response: Response) {
	if (!response.ok)
		throw new Error(`Provider request failed (${response.status})`);
	return response;
}
