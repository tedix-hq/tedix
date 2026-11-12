import { describe, expect, it } from "vite-plus/test";
import {
	INSTALL_HINT_SEEN_KEY,
	installHintKind,
	isInstalledApp,
	persistInstallHintSeen,
	restoreInstallHintSeen,
} from "@/lib/install-prompt";

const IPHONE_SAFARI =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
	"Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";

const phone = {
	userAgent: IPHONE_SAFARI,
	maxTouchPoints: 5,
	installed: false,
	seen: false,
	phoneWidth: true,
	hasPrompt: false,
};

describe("installHintKind", () => {
	it("gives Safari on an iPhone the Share-menu instructions", () => {
		expect(installHintKind(phone)).toBe("ios");
	});

	it("offers the browser's own prompt wherever the browser provides one", () => {
		expect(
			installHintKind({ ...phone, userAgent: ANDROID_CHROME, hasPrompt: true }),
		).toBe("prompt");
	});

	it("stays away once seen, once installed, and on a wide screen", () => {
		expect(installHintKind({ ...phone, seen: true })).toBeNull();
		expect(installHintKind({ ...phone, installed: true })).toBeNull();
		expect(installHintKind({ ...phone, phoneWidth: false })).toBeNull();
	});

	it("stays away where the browser cannot install: other iOS browsers, Android without a prompt", () => {
		expect(installHintKind({ ...phone, userAgent: IPHONE_CHROME })).toBeNull();
		expect(installHintKind({ ...phone, userAgent: ANDROID_CHROME })).toBeNull();
	});
});

describe("isInstalledApp", () => {
	it("recognises iOS's flag and the standalone display mode", () => {
		expect(isInstalledApp({ navigator: { standalone: true } })).toBe(true);
		expect(
			isInstalledApp({
				navigator: {},
				matchMedia: (query) => ({
					matches: query === "(display-mode: standalone)",
				}),
			}),
		).toBe(true);
		expect(
			isInstalledApp({
				navigator: {},
				matchMedia: () => ({ matches: false }),
			}),
		).toBe(false);
	});
});

describe("install hint memory", () => {
	it("remembers that the hint was shown", () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => void values.set(key, value),
		};
		expect(restoreInstallHintSeen(storage)).toBe(false);
		persistInstallHintSeen(storage);
		expect(values.get(INSTALL_HINT_SEEN_KEY)).toBe("1");
		expect(restoreInstallHintSeen(storage)).toBe(true);
	});

	it("treats unreadable storage as seen, so the hint cannot repeat on every visit", () => {
		expect(
			restoreInstallHintSeen({
				getItem: () => {
					throw new Error("blocked");
				},
			}),
		).toBe(true);
	});
});
