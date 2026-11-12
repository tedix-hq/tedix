import { useEffect } from "react";
import { osToastManager } from "@/components/kumo/toast";
import { syncAppBadge, useUnreadCount } from "@/lib/app-badge";
import {
	currentInstallPrompt,
	installHintKind,
	isInstalledApp,
	persistInstallHintSeen,
	restoreInstallHintSeen,
	runInstallPrompt,
	subscribeInstallPrompt,
} from "@/lib/install-prompt";

const HINT_ID = "os-install-hint";
/** Long enough that the page the person came for is on screen first. */
const HINT_DELAY_MS = 4000;
const PHONE_QUERY = "(max-width: 767px)";

/**
 * What a signed-in session adds for a phone: a one-time "Add to Home Screen"
 * notice in the browser, and the unread count on the installed app's icon.
 * Renders nothing itself.
 */
export function InstalledAppSupport() {
	const unread = useUnreadCount();
	useEffect(() => {
		syncAppBadge(unread);
	}, [unread]);

	useEffect(() => {
		let shown = false;
		const show = () => {
			if (shown) return;
			const kind = installHintKind({
				userAgent: navigator.userAgent,
				maxTouchPoints: navigator.maxTouchPoints,
				installed: isInstalledApp(),
				seen: restoreInstallHintSeen(window.localStorage),
				phoneWidth: window.matchMedia?.(PHONE_QUERY).matches ?? false,
				hasPrompt: currentInstallPrompt() !== null,
				automated: navigator.webdriver === true,
			});
			if (!kind) return;
			shown = true;
			persistInstallHintSeen(window.localStorage);
			osToastManager.add({
				id: HINT_ID,
				title: "Add Tedix to your Home Screen",
				description:
					kind === "ios"
						? "Tap the Share button in Safari, then “Add to Home Screen”. Tedix then opens like an app."
						: "Tedix then opens like an app, without the browser bars.",
				variant: "info",
				timeout: 0,
				...(kind === "prompt"
					? {
							actions: [
								{
									children: "Install",
									onClick: () => {
										osToastManager.close(HINT_ID);
										void runInstallPrompt();
									},
								},
							],
						}
					: {}),
			});
		};
		const timer = window.setTimeout(show, HINT_DELAY_MS);
		// Android offers its prompt whenever it decides the page qualifies, which
		// can be after the delay.
		const unsubscribe = subscribeInstallPrompt(() => {
			if (currentInstallPrompt()) show();
			else osToastManager.close(HINT_ID);
		});
		return () => {
			window.clearTimeout(timer);
			unsubscribe();
		};
	}, []);

	return null;
}
