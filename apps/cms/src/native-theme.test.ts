import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import {
	themeControlsScript,
	themeInitializationScript,
} from "../templates/tedix/src/lib/theme-preference";

function fixture(cookie = "", osDark = false) {
	const classes = new Set<string>();
	const classList = {
		contains: (name: string) => classes.has(name),
		toggle: (name: string, on: boolean) =>
			on ? classes.add(name) : classes.delete(name),
	};
	const mediaListeners: Array<() => void> = [];
	const media = {
		matches: osDark,
		addEventListener: (_: string, handler: () => void) =>
			mediaListeners.push(handler),
	};
	const buttons = ["light", "dark", "system"].map((choice) => {
		let click = () => {};
		const attributes = new Map<string, string>();
		return {
			dataset: { themeChoice: choice },
			classList,
			attributes,
			setAttribute: (key: string, value: string) => attributes.set(key, value),
			addEventListener: (_: string, handler: () => void) => {
				click = handler;
			},
			click: () => click(),
		};
	});
	let toggle = () => {};
	let writes = 0;
	const document = {
		documentElement: { classList },
		get cookie() {
			return cookie;
		},
		set cookie(value: string) {
			writes++;
			cookie = value.includes("max-age=0") ? "" : (value.split(";")[0] ?? "");
		},
		querySelectorAll: () => buttons,
		getElementById: () => ({
			addEventListener: (_: string, handler: () => void) => {
				toggle = handler;
			},
		}),
	};
	const context = {
		document,
		window: { matchMedia: () => media },
		location: { protocol: "https:" },
	};
	return {
		document,
		buttons,
		classes,
		initialize: (mode: "light" | "dark" | "system" = "system") =>
			runInNewContext(themeInitializationScript(mode), context),
		bind: () => runInNewContext(themeControlsScript, context),
		toggle: () => toggle(),
		os: (dark: boolean) => {
			media.matches = dark;
			mediaListeners.forEach((handler) => handler());
		},
		writes: () => writes,
	};
}

describe("native theme preference round trip", () => {
	it("uses the exact theme cookie before paint and persists an explicit choice through navigation", () => {
		const page = fixture("other_theme=dark; theme=light", true);
		page.initialize();
		expect(page.classes.has("light")).toBe(true);
		page.bind();
		expect(page.writes()).toBe(0);
		page.buttons[1]!.click();
		expect(page.document.cookie).toBe("theme=dark");
		expect(page.buttons[1]!.attributes.get("aria-pressed")).toBe("true");
		const next = fixture(page.document.cookie, false);
		next.initialize();
		expect(next.classes.has("dark")).toBe(true);
	});
	it("System removes persistence, follows OS changes and leaves explicit light alone", () => {
		const page = fixture("theme=dark", true);
		page.initialize();
		page.bind();
		page.buttons[2]!.click();
		expect(page.document.cookie).toBe("");
		page.os(false);
		expect(page.classes.has("light")).toBe(true);
		page.os(true);
		expect(page.classes.has("dark")).toBe(true);
		page.buttons[0]!.click();
		page.os(true);
		expect(page.classes.has("light")).toBe(true);
	});
	it("toggles the actually displayed System palette and respects fixed mode before paint", () => {
		const page = fixture("", true);
		page.initialize();
		page.bind();
		page.toggle();
		expect(page.document.cookie).toBe("theme=light");
		const fixed = fixture("theme=dark", true);
		fixed.initialize("light");
		expect(fixed.classes.has("light")).toBe(true);
	});
});
