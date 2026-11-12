/*
 * The number on the installed app's icon.
 *
 * `useUnreadCount` is the single source of that number for the whole app.
 * It returns 0 until the unread inbox provides a total; connect that query
 * here and nowhere else.
 */

/** How many unread items the signed-in person has across the organization. */
export function useUnreadCount(): number {
	return 0;
}

type BadgeNavigator = {
	setAppBadge?: (count?: number) => Promise<void>;
	clearAppBadge?: () => Promise<void>;
};

/**
 * Shows `count` on the app icon, or clears it at zero. Browsers without the
 * Badging API (and tabs that are not an installed app) ignore it.
 */
export function syncAppBadge(
	count: number,
	target: BadgeNavigator = navigator as BadgeNavigator,
) {
	const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
	const request =
		total > 0 ? target.setAppBadge?.(total) : target.clearAppBadge?.();
	// A browser may refuse (no permission, not installed); the icon then simply
	// has no number.
	request?.catch(() => {});
}
