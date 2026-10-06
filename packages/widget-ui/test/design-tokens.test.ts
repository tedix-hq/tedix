import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "../src/components/button";
import { widgetCssVariables, widgetTokens } from "../src/lib/design-tokens";

const readSource = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");

describe("@tedix/widget-ui design token contract", () => {
	test("imports canonical widget CSS variables instead of redefining the baseline", () => {
		const globals = readSource("../src/styles/globals.css");

		expect(globals).toContain('@import "@tedix/design-tokens/widget.css";');
		expect(globals).not.toMatch(
			/--radius-[a-z0-9-]+:\s*var\(--radius-[a-z0-9-]+\);/,
		);
	});

	test("exports the canonical widget token objects for package consumers", () => {
		expect(widgetTokens.control.heightMd).toBe("2.5rem");
		expect(widgetTokens.control.iconMd).toBe("1.125rem");
		expect(widgetCssVariables.control.touchTarget).toBe("2.75rem");
		expect(widgetCssVariables.icon.md).toBe("1.25rem");
	});

	test("keeps core control primitives on widget sizing tokens", () => {
		// toggle.tsx was removed in the widget-ui prune; button is the surviving
		// core control primitive covered by this contract.
		const button = renderToStaticMarkup(createElement(Button, null, "Send"));

		expect(button).toContain("h-[var(--widget-control-height-md)]");
		expect(button).toContain("size-[var(--widget-control-icon-md)]");
	});
});
