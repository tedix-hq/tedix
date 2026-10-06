import { describe, expect, it } from "vite-plus/test";
import {
	DEFAULT_ORGANIZATION_OS_THEME,
	OrganizationOsThemeSchema,
} from "./os-theme";

describe("OrganizationOsThemeSchema", () => {
	it("accepts the accessible product baseline", () => {
		expect(
			OrganizationOsThemeSchema.parse(DEFAULT_ORGANIZATION_OS_THEME),
		).toEqual(DEFAULT_ORGANIZATION_OS_THEME);
	});

	it("normalizes hex colors and rejects unsafe tenant palettes", () => {
		const normalized = OrganizationOsThemeSchema.parse({
			...DEFAULT_ORGANIZATION_OS_THEME,
			light: { ...DEFAULT_ORGANIZATION_OS_THEME.light, accent: "#C53D00" },
		});
		expect(normalized.light.accent).toBe("#c53d00");

		expect(() =>
			OrganizationOsThemeSchema.parse({
				...DEFAULT_ORGANIZATION_OS_THEME,
				light: {
					...DEFAULT_ORGANIZATION_OS_THEME.light,
					foreground: "#f8f8f8",
				},
			}),
		).toThrow(/4.5:1 contrast/);
	});

	it("does not admit arbitrary CSS or unknown font names", () => {
		expect(() =>
			OrganizationOsThemeSchema.parse({
				...DEFAULT_ORGANIZATION_OS_THEME,
				uiFont: "url(https://example.com/font.woff2)",
				css: "body { display: none }",
			}),
		).toThrow();
	});
});
