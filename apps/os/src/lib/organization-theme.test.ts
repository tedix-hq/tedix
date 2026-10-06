import { afterEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_ORGANIZATION_OS_THEME } from "@tedix/api-contract/schemas/os-theme";
import {
	applyOrganizationTheme,
	organizationThemeVariables,
	setOrganizationTheme,
} from "./organization-theme";

describe("organization theme projection", () => {
	afterEach(() => setOrganizationTheme(null));

	it("derives semantic app inputs rather than accepting Kumo internals", () => {
		const variables = organizationThemeVariables(
			DEFAULT_ORGANIZATION_OS_THEME.light,
			DEFAULT_ORGANIZATION_OS_THEME,
		);
		expect(variables["--primary"]).toBe("#7c3aed");
		expect(variables["--background-lighter"]).toBe(
			"color-mix(in oklch, #171717 1%, #fbfbfb)",
		);
		expect(Object.keys(variables)).not.toContain("--color-kumo-canvas");
	});

	it("lifts light surfaces to white instead of darkening them", () => {
		const variables = organizationThemeVariables(
			DEFAULT_ORGANIZATION_OS_THEME.light,
			DEFAULT_ORGANIZATION_OS_THEME,
		);
		// Shell tones recede below the canvas; real surfaces climb above it.
		expect(variables["--background-base"]).toBe(
			"color-mix(in oklch, #171717 3%, #fbfbfb)",
		);
		expect(variables["--card"]).toBe(
			"color-mix(in oklch, #ffffff 90%, #fbfbfb)",
		);
		expect(variables["--secondary"]).toBe(variables["--card"]);
		// Light overlays stay on the canvas and take their elevation from shadow.
		expect(variables["--popover"]).toBe("#fbfbfb");
	});

	it("reproduces the Console dark ladder at the default contrast", () => {
		const variables = organizationThemeVariables(
			DEFAULT_ORGANIZATION_OS_THEME.dark,
			DEFAULT_ORGANIZATION_OS_THEME,
		);
		const mix = (strength: number) =>
			`color-mix(in oklch, #f5f5f5 ${strength}%, #030303)`;
		expect(variables["--background-lighter"]).toBe(mix(2));
		expect(variables["--background-base"]).toBe(mix(6));
		expect(variables["--card"]).toBe(mix(8));
		expect(variables["--secondary"]).toBe(mix(12));
		expect(variables["--accent"]).toBe(mix(19));
		expect(variables["--border"]).toBe(mix(19));
		expect(variables["--input"]).toBe(mix(31));
		expect(variables["--muted-foreground"]).toBe(mix(70));
		// Dark overlays climb to the tint step rather than sitting on the canvas.
		expect(variables["--popover"]).toBe(variables["--accent"]);
	});

	it("scales the ladder with contrast without reordering it", () => {
		const strengths = (contrast: number) =>
			[
				"--background-lighter",
				"--background-base",
				"--card",
				"--secondary",
				"--accent",
				"--input",
			].map((property) => {
				const value = organizationThemeVariables(
					{ ...DEFAULT_ORGANIZATION_OS_THEME.dark, contrast },
					DEFAULT_ORGANIZATION_OS_THEME,
				)[property];
				return Number(/ (\d+)%/.exec(value ?? "")?.[1]);
			});

		for (const contrast of [0, 50, 100]) {
			const ladder = strengths(contrast);
			expect(ladder).toEqual([...ladder].sort((a, b) => a - b));
		}
		expect(strengths(100)[5]).toBeGreaterThan(strengths(50)[5] as number);
	});

	it("narrows the tenant ladder when high contrast is requested", () => {
		const plain = organizationThemeVariables(
			DEFAULT_ORGANIZATION_OS_THEME.dark,
			DEFAULT_ORGANIZATION_OS_THEME,
		);
		const high = organizationThemeVariables(
			DEFAULT_ORGANIZATION_OS_THEME.dark,
			DEFAULT_ORGANIZATION_OS_THEME,
			{ highContrast: true },
		);
		const strength = (value: string | undefined) =>
			Number(/ (\d+)%/.exec(value ?? "")?.[1]);

		// The three legibility roles take their floor rather than a fixed swatch,
		// so the preference composes with any published palette.
		expect(high["--border"]).toBe("color-mix(in oklch, #f5f5f5 34%, #030303)");
		expect(high["--input"]).toBe("color-mix(in oklch, #f5f5f5 45%, #030303)");
		expect(high["--muted-foreground"]).toBe(
			"color-mix(in oklch, #f5f5f5 78%, #030303)",
		);
		// Surfaces are untouched: the preference narrows legibility roles only.
		expect(high["--card"]).toBe(plain["--card"]);
		expect(high["--secondary-foreground"]).toBe("#f5f5f5");
		for (const property of ["--border", "--input", "--muted-foreground"]) {
			expect(strength(high[property])).toBeGreaterThan(
				strength(plain[property]) as number,
			);
		}
		// Surfaces still climb in order; contrast must never reorder the ladder.
		const ladder = [
			"--background-lighter",
			"--background-base",
			"--card",
			"--secondary",
			"--accent",
			"--border",
			"--input",
		].map((property) => strength(high[property]));
		expect(ladder).toEqual([...ladder].sort((a, b) => a - b));
	});

	it("works in light mode from the same floors", () => {
		const high = organizationThemeVariables(
			DEFAULT_ORGANIZATION_OS_THEME.light,
			DEFAULT_ORGANIZATION_OS_THEME,
			{ highContrast: true },
		);
		expect(high["--border"]).toBe("color-mix(in oklch, #171717 34%, #fbfbfb)");
		expect(high["--secondary-foreground"]).toBe("#171717");
	});

	it("writes color-scheme from the same luminance test as the ladder", () => {
		setOrganizationTheme(DEFAULT_ORGANIZATION_OS_THEME);
		expect(
			document.documentElement.style.getPropertyValue("color-scheme"),
		).toBe("light");

		applyOrganizationTheme("dark");
		expect(
			document.documentElement.style.getPropertyValue("color-scheme"),
		).toBe("dark");

		setOrganizationTheme(null);
		expect(
			document.documentElement.style.getPropertyValue("color-scheme"),
		).toBe("");
	});

	it("reads the operator contrast preference off the document", () => {
		document.documentElement.dataset.contrast = "high";
		setOrganizationTheme(DEFAULT_ORGANIZATION_OS_THEME);
		expect(document.documentElement.style.getPropertyValue("--border")).toBe(
			"color-mix(in oklch, #171717 34%, #fbfbfb)",
		);
		delete document.documentElement.dataset.contrast;
	});

	it("switches the published palette with mode and removes it on reset", () => {
		setOrganizationTheme(DEFAULT_ORGANIZATION_OS_THEME);
		expect(document.documentElement.dataset.tenantTheme).toBe("custom");
		expect(
			document.documentElement.style.getPropertyValue("--background"),
		).toBe("#fbfbfb");

		applyOrganizationTheme("dark");
		expect(
			document.documentElement.style.getPropertyValue("--background"),
		).toBe("#030303");

		setOrganizationTheme(null);
		expect(document.documentElement.dataset.tenantTheme).toBeUndefined();
		expect(
			document.documentElement.style.getPropertyValue("--background"),
		).toBe("");
	});
});
