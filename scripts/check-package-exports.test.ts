import { describe, expect, test } from "bun:test";
import {
	findVitePlusImportViolations,
	importedSpecifiers,
} from "./check-package-exports";

describe("combined package import gate", () => {
	test("retains export-surface scanning for imports, re-exports and dynamic imports", () => {
		expect(
			importedSpecifiers(`
			import { x } from "@tedix/example/private";
			export * from "@tedix/example/other";
			const lazy = import("@tedix/example/lazy");
			// import { fake } from "@tedix/example/comment";
		`),
		).toEqual([
			"@tedix/example/lazy",
			"@tedix/example/other",
			"@tedix/example/private",
		]);
	});

	test.each([
		'import { test } from "vitest";',
		'export { test } from "vitest";',
		'export * from "vitest";',
		'const test = import("vitest");',
		'type Test = import("vitest").Test;',
		'import Test = require("vitest");',
	])("rejects upstream test imports: %s", (source) => {
		expect(findVitePlusImportViolations("example.ts", source)).toMatchObject([
			{ from: "vitest", to: "vite-plus/test" },
		]);
	});

	test("keeps Vite config scope and module augmentation exceptions", () => {
		const source = 'import { defineConfig } from "vite";';
		expect(
			findVitePlusImportViolations("vite.config.ts", source),
		).toMatchObject([{ to: "vite-plus" }]);
		expect(findVitePlusImportViolations("plugin.ts", source)).toEqual([]);
		expect(
			findVitePlusImportViolations("types.d.ts", 'declare module "vitest" {}'),
		).toEqual([]);
		expect(
			findVitePlusImportViolations("types.d.ts", 'declare module "oxlint" {}'),
		).toEqual([]);
	});

	test("distinguishes oxlint configuration from plugin APIs", () => {
		expect(
			findVitePlusImportViolations(
				"config.ts",
				'import { defineConfig } from "oxlint";',
			),
		).toEqual([]);
		expect(
			findVitePlusImportViolations(
				"plugin.ts",
				'import { defineRule } from "oxlint";',
			),
		).toMatchObject([{ to: "vite-plus/lint/plugins" }]);
		expect(
			findVitePlusImportViolations(
				"plugin.ts",
				'export { defineRule } from "oxlint";',
			),
		).toMatchObject([{ to: "vite-plus/lint/plugins" }]);
	});

	test("keeps browser-provider rewrites and JSON exception", () => {
		expect(
			findVitePlusImportViolations(
				"test.ts",
				'import { page } from "@vitest/browser/context";',
			),
		).toMatchObject([{ to: "vite-plus/test/browser/context" }]);
		expect(
			findVitePlusImportViolations(
				"test.ts",
				'import { playwright } from "@vitest/browser-playwright/provider";',
			),
		).toMatchObject([{ to: "vite-plus/test/browser/providers/playwright" }]);
		expect(
			findVitePlusImportViolations(
				"test.ts",
				'import meta from "vitest/package.json";',
			),
		).toEqual([]);
	});

	test("ignores source examples in strings and fails on malformed modules", () => {
		expect(
			findVitePlusImportViolations(
				"test.ts",
				`const fixture = 'import { test } from "vitest";';`,
			),
		).toEqual([]);
		expect(() => findVitePlusImportViolations("test.ts", "import {")).toThrow();
	});
});
