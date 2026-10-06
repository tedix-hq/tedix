import {
	syncDescopeThemeBridge,
	TEDIX_DESCOPE_THEME_CSS,
} from "@tedix/auth/descope-theme-bridge";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

describe("syncDescopeThemeBridge", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		document.body.replaceChildren();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("projects Tedix colors into Descope and nested Vaadin controls", () => {
		expect(TEDIX_DESCOPE_THEME_CSS).toContain(
			"--descope-colors-surface-dark: var(--muted-foreground)",
		);
		expect(TEDIX_DESCOPE_THEME_CSS).toContain(
			"--tedix-descope-action: var(--primary)",
		);
		expect(TEDIX_DESCOPE_THEME_CSS).toContain(
			"--lumo-header-text-color: var(--foreground)",
		);
	});

	it("does not rewrite an unchanged Descope theme attribute", () => {
		const root = document.createElement("div");
		const widget = document.createElement("descope-wc");
		root.append(widget);
		document.body.append(root);
		const setAttribute = vi.spyOn(widget, "setAttribute");

		const dispose = syncDescopeThemeBridge(root, {
			cssText: "",
			getTheme: () => "dark",
		});

		vi.runAllTimers();
		widget.dispatchEvent(new Event("ready"));
		vi.runAllTimers();
		dispose();

		expect(setAttribute).toHaveBeenCalledTimes(1);
		expect(setAttribute).toHaveBeenCalledWith("theme", "dark");
		expect(widget.getAttribute("theme")).toBe("dark");
	});

	it("bridges Descope hosts nested inside widget shadow roots", () => {
		const root = document.createElement("div");
		const widget = document.createElement("descope-user-profile-widget");
		const widgetShadow = widget.attachShadow({ mode: "open" });
		root.append(widget);
		document.body.append(root);

		const dispose = syncDescopeThemeBridge(root, {
			cssText: "#root { color: var(--foreground); }",
			getTheme: () => "dark",
		});

		const nested = document.createElement("descope-wc");
		const nestedShadow = nested.attachShadow({ mode: "open" });
		widgetShadow.append(nested);
		widget.dispatchEvent(new Event("page-updated"));
		vi.runAllTimers();
		dispose();

		expect(widget.getAttribute("theme")).toBe("dark");
		expect(nested.getAttribute("theme")).toBe("dark");
		expect(
			widgetShadow.getElementById("tedix-descope-theme-bridge")?.textContent,
		).toContain("var(--foreground)");
		expect(
			nestedShadow.getElementById("tedix-descope-theme-bridge")?.textContent,
		).toContain("var(--foreground)");
	});
});
