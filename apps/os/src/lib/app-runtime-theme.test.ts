import { afterEach, describe, expect, it } from "vite-plus/test";
import { buildAppRuntimeDocument } from "./app-runtime-host";
import {
	APP_RUNTIME_THEME_PLACEHOLDER,
	appRuntimeThemeCss,
	readAppRuntimeTheme,
	withAppRuntimeTheme,
} from "./app-runtime-theme";

const root = document.documentElement;
afterEach(() => {
	root.removeAttribute("style");
	root.removeAttribute("data-mode");
	root.removeAttribute("data-motion");
	root.classList.remove("dark");
});

describe("app runtime theme", () => {
	it("reads the OS look as plain values an app frame can use", () => {
		root.style.setProperty("--background", "#101010");
		root.style.setProperty("--foreground", "#fafafa");
		root.style.setProperty("--primary", "rgb(124, 58, 237)");
		root.style.setProperty("--font-sans", '"FT Kunst Grotesk", sans-serif');
		root.style.setProperty("--radius", "0.5rem");
		root.dataset.mode = "dark";
		root.dataset.motion = "reduced";
		const theme = readAppRuntimeTheme();
		expect(theme.mode).toBe("dark");
		expect(theme.reducedMotion).toBe(true);
		expect(theme.tokens["--tedix-font"]).toBe('"FT Kunst Grotesk", sans-serif');
		expect(theme.tokens["--tedix-radius"]).toBe("0.5rem");
		expect(Object.keys(theme.tokens)).not.toContain("--tedix-border");
		const css = appRuntimeThemeCss(theme);
		expect(css).toContain(":root{color-scheme:dark;");
		expect(css).toContain("transition-duration:.01ms!important");
	});

	it("fills the app document's theme slot and cannot break out of it", () => {
		const html = buildAppRuntimeDocument({ "client.js": "" });
		expect(html).toContain(APP_RUNTIME_THEME_PLACEHOLDER);
		expect(html).toContain("var(--tedix-fg,CanvasText)");
		const themed = withAppRuntimeTheme(html, {
			mode: "light",
			reducedMotion: false,
			tokens: { "--tedix-bg": "red;}</style><script>alert(1)</script>" },
		});
		expect(themed).not.toContain(APP_RUNTIME_THEME_PLACEHOLDER);
		expect(themed).toContain(
			'<style id="tedix-theme">:root{color-scheme:light;--tedix-bg:red/style',
		);
		expect(themed).not.toContain("<script>alert(1)");
	});
});
