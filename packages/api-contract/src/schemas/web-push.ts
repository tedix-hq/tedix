import * as z from "zod";

// Only browser push providers may receive subscription credentials or VAPID tokens.
export function isPushEndpoint(endpoint: string): boolean {
	try {
		const url = new URL(endpoint);
		return (
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			!url.port &&
			(url.hostname === "fcm.googleapis.com" ||
				url.hostname === "updates.push.services.mozilla.com" ||
				url.hostname === "web.push.apple.com" ||
				url.hostname.endsWith(".notify.windows.com"))
		);
	} catch {
		return false;
	}
}

export const WebPushSubscriptionSchema = z
	.object({
		endpoint: z.string().max(2048).refine(isPushEndpoint),
		expirationTime: z.number().nullable().optional(),
		keys: z
			.object({
				p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
				auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
			})
			.strict(),
	})
	.strict();
export const WebPushPreferencesSchema = z.object({
	mutedProjectIds: z.array(z.string().uuid()).max(100),
});
export type WebPushKind = "approval" | "needs_input" | "finished";

export function webPushTemplate(kind: WebPushKind) {
	const text = {
		approval: ["Approval needed", "A decision is waiting for you in Tedix."],
		needs_input: ["Your input is needed", "Open Tedix to help a run continue."],
		finished: ["Your run finished", "Open Tedix to see the result."],
	}[kind];
	return { title: text[0], body: text[1], url: "/work?view=deck" };
}
