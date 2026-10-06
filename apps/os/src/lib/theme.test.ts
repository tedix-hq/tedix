import { afterEach, describe, expect, it } from "vite-plus/test";
import { setThemePreference } from "./theme";

afterEach(() => {
	setThemePreference("system");
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
});
