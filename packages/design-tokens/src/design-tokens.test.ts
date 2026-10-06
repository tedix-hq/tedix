import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	widgetCssVariables,
	widgetHostCssVariables,
	widgetTokens,
} from "./widget";

describe("@tedix/design-tokens", () => {
	test("keeps widget tokens aligned to the embeddable baseline", () => {
		expect(widgetTokens.radius.base).toBe("0.5rem");
		expect(widgetTokens.semanticNames).toContain("destructive");
		expect(widgetTokens.typography.weightMedium).toBe(500);
		expect(widgetTokens.control.heightMd).toBe("2.5rem");
		expect(widgetTokens.control.touchTarget).toBe("2.75rem");
		expect(widgetTokens.icon.md).toBe("1.25rem");
	});

	test("keeps widget CSS export aligned with widget tokens", () => {
		const css = readFileSync(new URL("./widget.css", import.meta.url), "utf8");
		expect(css).toContain(`--radius: ${widgetCssVariables.radius.base};`);
		expect(css).toContain(`--radius-xl: ${widgetCssVariables.radius.xl};`);
		expect(css).toContain(
			`--font-weight-medium: ${widgetCssVariables.fontWeight.medium};`,
		);
		expect(css).toContain(
			`--font-weight-semibold: ${widgetCssVariables.fontWeight.semibold};`,
		);
		expect(css).toContain(
			`--widget-control-height-md: ${widgetCssVariables.control.heightMd};`,
		);
		expect(css).toContain(
			`--widget-control-touch-target: ${widgetCssVariables.control.touchTarget};`,
		);
		expect(css).toContain(
			`--widget-icon-size-md: ${widgetCssVariables.icon.md};`,
		);
		expect(css).toContain(
			`--widget-icon-size-3xl: ${widgetCssVariables.icon["3xl"]};`,
		);
		expect(widgetHostCssVariables.radius["--border-radius-full"]).toBe(
			widgetCssVariables.radius.full,
		);
		expect(widgetHostCssVariables.fontWeight["--font-weight-semibold"]).toBe(
			String(widgetCssVariables.fontWeight.semibold),
		);
	});

	test("keeps Kumo applications on one explicit typography and semantic-fill bridge", () => {
		const css = readFileSync(new URL("./kumo.css", import.meta.url), "utf8");

		expect(css).toContain("--text-tedix-control: 0.8125rem;");
		expect(css).toContain("--text-tedix-body: 0.875rem;");
		expect(css).toContain("--text-tedix-section: 1rem;");
		expect(css).toContain("--text-tedix-section--line-height: 1.375rem;");
		expect(css).toContain(".type-tedix-section {");
		expect(css).toContain('"FT Kunst Grotesk"');
		expect(css).toContain("--color-kumo-fill: light-dark(");
		expect(css).toContain("--color-kumo-fill-hover: light-dark(");
		expect(css).toContain("--color-kumo-focus: var(--ring);");
		expect(css).not.toContain("--color-kumo-fill: var(--muted);");
	});

	test("keeps the stacking ladder strictly ordered and clear of Kumo's anchors", () => {
		const css = readFileSync(new URL("./kumo.css", import.meta.url), "utf8");
		const rung = (name: string) =>
			Number(css.match(new RegExp(`--tedix-layer-${name}: (\\d+);`))?.[1]);
		const ladder = ["overlay", "dropdown", "tooltip", "toast"].map(rung);

		expect(ladder.every(Number.isInteger)).toBe(true);
		expect(ladder).toEqual([...ladder].sort((a, b) => a - b));
		expect(new Set(ladder).size).toBe(ladder.length);
		// Kumo hardcodes its Sidebar to `z-40`; every Tedix overlay must clear it.
		expect(Math.min(...ladder)).toBeGreaterThan(40);
		// Immersive is derived in CSS so it can never drift below the toast anchor.
		expect(css).toContain(
			"--tedix-layer-immersive: calc(var(--tedix-layer-toast) + 100);",
		);
	});

	test("gives documents and sheets one paper that a nested light scope cannot invert", () => {
		const css = readFileSync(new URL("./kumo.css", import.meta.url), "utf8");
		// Both pages used to resolve differently in a dark shell -- #f5f5f5 for
		// documents, #ffffff for sheets -- so side by side they read as two
		// materials.
		expect(css).toMatch(/--tedix-paper:\s*#ffffff;/);
		expect(css).toMatch(
			/--tedix-document-paper:\s*light-dark\(var\(--card\), var\(--tedix-paper\)\);/,
		);
		expect(css).toMatch(/--tedix-sheet-paper:\s*var\(--tedix-paper\);/);
		// The shared token must stay a literal. The sheet page renders inside
		// `color-scheme: light`, where a light-dark() pair would take the light
		// branch -- var(--card), #0f0f0f in a dark shell -- and turn it black.
		const shared = css.match(/--tedix-paper:[^;]*;/)?.[0] ?? "";
		expect(shared).not.toContain("light-dark");
		expect(shared).not.toContain("var(");
	});
});
