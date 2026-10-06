import { describe, expect, test } from "vite-plus/test";

// Characterization tests for the plugin-trust extraction pass.
//
// The gate reads plugin descriptors and the embedded template snapshot out of
// source with an AST walk. These pin what that walk reports — including the
// shapes it deliberately ignores — so the parser underneath can be replaced
// without changing a single verdict.

import {
	extractPluginDescriptors,
	extractSnapshotFile,
} from "./plugin-trust-validate";

describe("plugin descriptor extraction", () => {
	test("reads id, format, capabilities, settings and storage", () => {
		const source = `
			export const plugin = {
				id: "embeds",
				format: "portable-text",
				capabilities: ["render", "edit"],
				settingsSchema: { provider: {}, maxWidth: {} },
				storage: { collections: { embeds: {}, cache: {} } },
			};
		`;
		const descriptors = extractPluginDescriptors("plugin.ts", source);
		expect(descriptors.get("embeds")).toEqual({
			id: "embeds",
			format: "portable-text",
			capabilities: ["render", "edit"],
			settings: ["provider", "maxWidth"],
			storage: ["embeds", "cache"],
		});
	});

	test("falls back to storage's own keys when it declares no collections", () => {
		const source = `const p = { id: "a", storage: { blobs: {}, index: {} } };`;
		expect(extractPluginDescriptors("p.ts", source).get("a")?.storage).toEqual([
			"blobs",
			"index",
		]);
	});

	test("accepts shorthand storage and settings keys", () => {
		const source = `const embeds = {}; const p = { id: "a", storage: { embeds } };`;
		expect(extractPluginDescriptors("p.ts", source).get("a")?.storage).toEqual([
			"embeds",
		]);
	});

	test("reads quoted keys and ignores non-string capability entries", () => {
		const source = `const p = { "id": "a", capabilities: ["render", 1, other] };`;
		expect(
			extractPluginDescriptors("p.ts", source).get("a")?.capabilities,
		).toEqual(["render"]);
	});

	test("ignores an object with no id, and a computed id key", () => {
		const source = `const k = "id"; const p = { [k]: "a" }; const q = { name: "b" };`;
		expect(extractPluginDescriptors("p.ts", source).size).toBe(0);
	});

	test("finds descriptors nested anywhere, including inside a call", () => {
		const source = `register(defineNested({ id: "deep", format: "md" }));`;
		expect(extractPluginDescriptors("p.ts", source).get("deep")?.format).toBe(
			"md",
		);
	});

	test("reads a plain .mjs module", () => {
		const source = `export const plugin = { id: "mjs-one", capabilities: ["x"] };`;
		expect(extractPluginDescriptors("p.mjs", source).get("mjs-one")).toEqual({
			id: "mjs-one",
			format: undefined,
			capabilities: ["x"],
			settings: [],
			storage: [],
		});
	});

	test("a later descriptor with the same id wins", () => {
		const source = `const a = { id: "dup", format: "first" };
			const b = { id: "dup", format: "second" };`;
		expect(extractPluginDescriptors("p.ts", source).get("dup")?.format).toBe(
			"second",
		);
	});
});

describe("snapshot file extraction", () => {
	const snapshot = `export const TEMPLATES = {
		tedix: Object.freeze({
			"src/plugin.ts": "export const plugin = { id: 'a' };",
			"src/other.ts": "other",
		}),
		marketing: { "src/plugin.ts": "marketing body" },
	};`;

	test("reads a file out of a frozen template", () => {
		expect(extractSnapshotFile(snapshot, "tedix", "src/plugin.ts")).toBe(
			"export const plugin = { id: 'a' };",
		);
	});

	test("reads a file out of a plain object template", () => {
		expect(extractSnapshotFile(snapshot, "marketing", "src/plugin.ts")).toBe(
			"marketing body",
		);
	});

	test("throws when the template or the path is absent", () => {
		expect(() =>
			extractSnapshotFile(snapshot, "tedix", "src/missing.ts"),
		).toThrow(/does not embed tedix:src\/missing\.ts/);
		expect(() =>
			extractSnapshotFile(snapshot, "absent", "src/plugin.ts"),
		).toThrow(/does not embed absent:src\/plugin\.ts/);
	});
});
