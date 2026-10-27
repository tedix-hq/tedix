import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { OS_ORGANIZATION_THEME_CACHE_KEY } from "./organization-theme";
import { followDeviceTheme, setThemePreference } from "./theme";

afterEach(() => {
	setThemePreference("system");
	localStorage.removeItem(OS_ORGANIZATION_THEME_CACHE_KEY);
	document.documentElement.removeAttribute("style");
	vi.unstubAllGlobals();
});

describe("OS theme contract", () => {
	it("keeps data-mode and the supported dark variant in sync", () => {
		setThemePreference("dark");
		expect(document.documentElement.dataset.mode).toBe("dark");
		expect(document.documentElement.classList.contains("dark")).toBe(true);

		setThemePreference("light");
		expect(document.documentElement.dataset.mode).toBe("light");
		expect(document.documentElement.classList.contains("dark")).toBe(false);
	});

	it("writes the cached organization palette for the device's mode on a visitor page", () => {
		localStorage.setItem(
			OS_ORGANIZATION_THEME_CACHE_KEY,
			JSON.stringify({
				version: 4,
				light: {
					variables: { "--background": "#fbfbfb" },
					colorScheme: "light",
				},
				dark: { variables: { "--background": "#030303" }, colorScheme: "dark" },
			}),
		);
		// A member saved Light, so the app wrote the light palette first.
		setThemePreference("light");
		document.documentElement.style.setProperty("--background", "#fbfbfb");
		document.documentElement.style.setProperty("color-scheme", "light");
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: query.includes("dark"),
			addEventListener: () => {},
			removeEventListener: () => {},
		}));

		const stop = followDeviceTheme();
		const root = document.documentElement;
		expect(root.classList.contains("dark")).toBe(true);
		expect(root.style.getPropertyValue("--background")).toBe("#030303");
		expect(root.style.getPropertyValue("color-scheme")).toBe("dark");
		stop();
	});
});
