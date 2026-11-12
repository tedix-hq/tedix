/*
 * "Add to Home Screen": which phones get the hint, and the browser's own
 * install prompt where one exists.
 *
 * Chromium on Android fires `beforeinstallprompt` once, often before React has
 * mounted, so `captureInstallPrompt()` runs from `main.tsx` and keeps the event
 * for the hint to use. Safari on iPhone has no such event: installing is a
 * manual step in the Share menu, so the hint there is instructions only.
 */

/** The part of Chromium's `BeforeInstallPromptEvent` the hint uses. */
export type InstallPromptEvent = Event & {
	prompt: () => Promise<unknown>;
	userChoice?: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export type InstallHintKind = "ios" | "prompt";

export const INSTALL_HINT_SEEN_KEY = "tedix-os:install-hint-seen";

let capturedPrompt: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function publish(next: InstallPromptEvent | null) {
	capturedPrompt = next;
	for (const listener of listeners) listener();
}

/** Keeps the browser's install prompt until the hint asks for it. */
export function captureInstallPrompt(
	target: Pick<Window, "addEventListener"> = window,
) {
	target.addEventListener("beforeinstallprompt", (event) => {
		// The browser's own mini-infobar would compete with the hint.
		event.preventDefault();
		publish(event as InstallPromptEvent);
	});
	target.addEventListener("appinstalled", () => publish(null));
}

export function subscribeInstallPrompt(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function currentInstallPrompt(): InstallPromptEvent | null {
	return capturedPrompt;
}

/** Shows the browser's install dialog; the event can be used only once. */
export async function runInstallPrompt(): Promise<void> {
	const prompt = capturedPrompt;
	if (!prompt) return;
	publish(null);
	await prompt.prompt();
}

/** Whether this document runs as the installed app, not in a browser tab. */
export function isInstalledApp(
	target: {
		matchMedia?: (query: string) => { matches: boolean };
		navigator: { standalone?: boolean };
	} = window as never,
): boolean {
	return (
		target.navigator.standalone === true ||
		(target.matchMedia?.("(display-mode: standalone)").matches ?? false)
	);
}

/**
 * Which hint a phone browser gets, or null for none: an installed app, a
 * desktop, a person who has seen the hint, an in-app browser that cannot
 * install, and a browser driven by automation all get nothing.
 */
export function installHintKind(input: {
	userAgent: string;
	maxTouchPoints: number;
	installed: boolean;
	seen: boolean;
	phoneWidth: boolean;
	hasPrompt: boolean;
	/** `navigator.webdriver`: nobody is there to add it to a Home Screen. */
	automated: boolean;
}): InstallHintKind | null {
	if (input.installed || input.seen || input.automated || !input.phoneWidth)
		return null;
	if (input.hasPrompt) return "prompt";
	const ua = input.userAgent;
	// An iPad asking for the desktop site reports itself as a Mac with touch.
	const ios =
		/iPhone|iPad|iPod/.test(ua) ||
		(/Macintosh/.test(ua) && input.maxTouchPoints > 1);
	if (!ios) return null;
	// Only Safari itself has "Add to Home Screen" where people expect it; other
	// iOS browsers and in-app web views name themselves in the user agent.
	const otherBrowser =
		/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|FBAN|FBAV|Instagram/.test(ua);
	return otherBrowser ? null : "ios";
}

export function restoreInstallHintSeen(
	storage: Pick<Storage, "getItem"> | null,
): boolean {
	try {
		return storage?.getItem(INSTALL_HINT_SEEN_KEY) === "1";
	} catch {
		// Without storage the hint cannot be remembered, so it stays away.
		return true;
	}
}

export function persistInstallHintSeen(
	storage: Pick<Storage, "setItem"> | null,
) {
	try {
		storage?.setItem(INSTALL_HINT_SEEN_KEY, "1");
	} catch {
		// The hint is a convenience; closing it still works for this visit.
	}
}
