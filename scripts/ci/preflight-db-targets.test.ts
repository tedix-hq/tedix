import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	fsRepoReader,
	isD1SchemaGateInput,
	schemaRuntimeImports,
} from "./preflight-db-targets.mjs";

describe("isD1SchemaGateInput", () => {
	test("schema, migrations, checker scripts and config run the gate", () => {
		for (const file of [
			"packages/db/src/schema/tools.ts",
			"packages/db/src/schema/relations/mcp.ts",
			"packages/db/drizzle/0420_add_column.sql",
			"packages/db/drizzle/meta/_journal.json",
			"packages/db/scripts/check-migrations.ts",
			"packages/db/drizzle.config.ts",
			"packages/db/migration-integrity.json",
			"packages/db/wrangler.jsonc",
			"packages/db/package.json",
		]) {
			expect(isD1SchemaGateInput(file)).toBe(true);
		}
	});

	/*
	 * The gate's cost. A query-module fix ran the ~45s schema/migration chain
	 * although drizzle.config.ts loads only src/schema/, and no schema module
	 * imports anything else under src/.
	 */
	test("query modules and other runtime code do not", () => {
		for (const file of [
			"packages/db/src/queries/items.ts",
			"packages/db/src/queries/items.test.ts",
			"packages/db/src/utils/secrets-encryption.ts",
			"packages/db/src/client.ts",
		]) {
			expect(isD1SchemaGateInput(file)).toBe(false);
		}
	});

	test("the package's root prose does not", () => {
		expect(isD1SchemaGateInput("packages/db/README.md")).toBe(false);
		expect(isD1SchemaGateInput("packages/db/AGENTS.md")).toBe(false);
	});

	test("paths outside packages/db do not", () => {
		expect(isD1SchemaGateInput("packages/dbx/src/schema/a.ts")).toBe(false);
		expect(isD1SchemaGateInput("apps/api/src/index.ts")).toBe(false);
	});
});

/** An in-memory reader over `files` (repo-relative path -> source). */
function memoryRepo(files: Record<string, string>) {
	const paths = Object.keys(files);
	return {
		listFiles: (dir: string) => paths.filter((p) => p.startsWith(dir)),
		listDirs: (dir: string) => [
			...new Set(
				paths
					.filter((p) => p.startsWith(`${dir}/`))
					.map((p) => `${dir}/${p.slice(dir.length + 1).split("/")[0]}`),
			),
		],
		readFile: (file: string) => files[file],
	};
}

const contractManifest = JSON.stringify({
	name: "@tedix/api-contract",
	exports: {
		"./schemas/tools": "./src/schemas/tools.ts",
		"./schemas/app": "./src/schemas/app.ts",
	},
});

describe("schemaRuntimeImports", () => {
	test("follows runtime imports into api-contract, transitively", () => {
		const imports = schemaRuntimeImports(
			memoryRepo({
				"packages/db/src/schema/tools.ts":
					'import { TOOL_TYPES } from "@tedix/api-contract/schemas/tools";\n',
				"packages/api-contract/package.json": contractManifest,
				"packages/api-contract/src/schemas/tools.ts":
					'import * as z from "zod";\nimport { JsonValueSchema } from "./common";\n',
				"packages/api-contract/src/schemas/common.ts":
					'import * as z from "zod";\n',
			}),
		);
		expect([...imports].sort()).toEqual([
			"packages/api-contract/src/schemas/common.ts",
			"packages/api-contract/src/schemas/tools.ts",
		]);
	});

	test("type-only imports and schema tests are not followed", () => {
		const imports = schemaRuntimeImports(
			memoryRepo({
				"packages/db/src/schema/apps.ts":
					'import type {\n\tAppCapabilities,\n} from "@tedix/api-contract/schemas/app";\n',
				"packages/db/src/schema/apps.test.ts":
					'import { appSchema } from "@tedix/api-contract/schemas/app";\n',
				"packages/api-contract/package.json": contractManifest,
				"packages/api-contract/src/schemas/app.ts": "export const x = 1;\n",
			}),
		);
		expect([...imports]).toEqual([]);
	});
});

/*
 * Against the live import graph, so these fail if a real schema module stops
 * being reached, or the walk starts sweeping in all of api-contract.
 */
describe("isD1SchemaGateInput with the schema's runtime imports", () => {
	const live = schemaRuntimeImports(
		fsRepoReader(join(import.meta.dirname, "..", "..")),
	);
	const imports = () => live;

	test("an api-contract file the schema imports runs the gate", () => {
		for (const file of [
			"packages/api-contract/src/schemas/tools.ts",
			"packages/api-contract/src/schemas/common.ts",
			"packages/api-contract/src/constants/enums.ts",
		]) {
			expect(isD1SchemaGateInput(file, imports)).toBe(true);
		}
	});

	test("an unrelated contract file does not", () => {
		for (const file of [
			"packages/api-contract/src/contracts/billing.ts",
			// Imported by the schema, but only for types.
			"packages/api-contract/src/schemas/app.ts",
		]) {
			expect(isD1SchemaGateInput(file, imports)).toBe(false);
		}
	});

	test("a packages/db path never walks the graph", () => {
		const unreachable = () => {
			throw new Error("walked the import graph");
		};
		expect(
			isD1SchemaGateInput("packages/db/src/schema/tools.ts", unreachable),
		).toBe(true);
		expect(
			isD1SchemaGateInput("packages/db/src/queries/items.ts", unreachable),
		).toBe(false);
	});
});
