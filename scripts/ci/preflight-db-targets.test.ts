import { describe, expect, test } from "bun:test";
import { isD1SchemaGateInput } from "./preflight-db-targets.mjs";

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
