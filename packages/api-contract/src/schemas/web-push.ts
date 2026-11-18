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
	// Optional so stored rows and stale clients without the field parse, and an
	// omitted write keeps the muted workspaces already saved.
	mutedWorkspaceIds: z.array(z.string().uuid()).max(100).optional(),
	// When a muted workspace turns itself back on, by workspace id. A muted
	// workspace with no entry here stays muted until the person unmutes it.
	mutedWorkspaceUntil: z
		.record(z.string().uuid(), z.iso.datetime())
		.refine((value) => Object.keys(value).length <= 100)
		.optional(),
});
export type WebPushPreferences = z.infer<typeof WebPushPreferencesSchema>;

type WorkspaceMutes = Pick<
	WebPushPreferences,
	"mutedWorkspaceIds" | "mutedWorkspaceUntil"
>;

/**
 * The workspaces that are muted at `now`. A timed mute ends by itself: its
 * time is compared here on every read, so nothing has to run when it passes.
 */
export function activeWorkspaceMutes(
	preferences: WorkspaceMutes,
	now: number,
): {
	mutedWorkspaceIds: string[];
	mutedWorkspaceUntil: Record<string, string>;
} {
	const until = preferences.mutedWorkspaceUntil ?? {};
	const mutedWorkspaceUntil: Record<string, string> = {};
	const mutedWorkspaceIds = (preferences.mutedWorkspaceIds ?? []).filter(
		(id) => {
			const end = until[id];
			if (end === undefined) return true;
			if (!(Date.parse(end) > now)) return false;
			mutedWorkspaceUntil[id] = end;
			return true;
		},
	);
	return { mutedWorkspaceIds, mutedWorkspaceUntil };
}

/** Whether one workspace is muted at `now`, and until when (null: until unmuted). */
export function workspaceMuteState(
	preferences: WorkspaceMutes | undefined,
	workspaceId: string | undefined,
	now: number,
): { muted: boolean; until: string | null } {
	if (!preferences || !workspaceId) return { muted: false, until: null };
	const active = activeWorkspaceMutes(preferences, now);
	return {
		muted: active.mutedWorkspaceIds.includes(workspaceId),
		until: active.mutedWorkspaceUntil[workspaceId] ?? null,
	};
}
export type WebPushKind = "approval" | "needs_input" | "finished";

export function webPushTemplate(kind: WebPushKind) {
	const text = {
		approval: ["Approval needed", "A decision is waiting for you in Tedix."],
		needs_input: ["Your input is needed", "Open Tedix to help a run continue."],
		finished: ["Your run finished", "Open Tedix to see the result."],
	}[kind];
	return { title: text[0], body: text[1], url: "/work?view=deck" };
}
