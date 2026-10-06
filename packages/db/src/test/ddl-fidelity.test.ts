/**
 * Hand-written test DDL must not invent tables or columns.
 *
 * Most suites in this package build their fixture schema by hand rather than
 * from the Drizzle tables. Declaring a *subset* of columns is fine and often
 * deliberate — a test only needs the columns it touches. Declaring something
 * that does not exist is not fine: it means the fixture is fiction, and any
 * query written against it passes here and fails on real D1.
 *
 * That is not hypothetical. `campaign-decomposer.test.ts` declared `work_class`
 * and `purpose_exception_expires_at` on `projects`; both columns are real, but
 * they live on `work_items`, and neither the schema nor production D1 has them
 * on `projects`.
 *
 * This checks fidelity in the direction that can hide a bug. `schemaDdl()` in
 * ./schema-ddl.ts derives DDL from the tables directly and sidesteps the whole
 * problem — prefer it for new suites.
 */

import { readdirSync, readFileSync } from "node:fs";
import { is, Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { expect, it } from "vite-plus/test";
// The barrel deliberately omits these two startup-heavy schemas (see
// drizzle.config.ts), so they are imported explicitly rather than missed.
import * as graphRetrievalBenchmarks from "../schema/graph-retrieval-benchmarks";
import * as schema from "../schema/index";
import * as memoryEntities from "../schema/memory-entities";

/** Tables a test may create that the platform schema deliberately does not own. */
const UNOWNED_TABLES = new Set<string>();

const QUERIES_DIR = new URL("../queries/", import.meta.url).pathname;

function realColumnsByTable(): Map<string, Set<string>> {
	const tables = new Map<string, Set<string>>();
	for (const value of [
		...Object.values(schema),
		...Object.values(memoryEntities),
		...Object.values(graphRetrievalBenchmarks),
	]) {
		if (!is(value, Table)) continue;
		const config = getTableConfig(value);
		tables.set(config.name, new Set(config.columns.map((c) => c.name)));
	}
	return tables;
}

interface DeclaredTable {
	file: string;
	table: string;
	columns: string[];
}

/** Every `CREATE TABLE` a test file declares, with the columns it names. */
function parseDeclaredTables(file: string, text: string): DeclaredTable[] {
	const declared: DeclaredTable[] = [];
	const header = /CREATE TABLE (?:IF NOT EXISTS )?"?([a-z_0-9]+)"?\s*\(/gi;

	for (const match of text.matchAll(header)) {
		const open = (match.index ?? 0) + match[0].length;
		// Walk to the matching close paren so nested types and CHECK clauses
		// cannot end the block early.
		let depth = 1;
		let i = open;
		for (; i < text.length && depth > 0; i += 1) {
			if (text[i] === "(") depth += 1;
			else if (text[i] === ")") depth -= 1;
		}
		const body = text.slice(open, i - 1);

		// Split the body on top-level commas — one definition per part — so a
		// CHECK clause or a multi-column constraint cannot break the column list.
		const parts: string[] = [];
		let parenDepth = 0;
		let current = "";
		for (const char of body) {
			if (char === "(") parenDepth += 1;
			else if (char === ")") parenDepth -= 1;
			if (char === "," && parenDepth === 0) {
				parts.push(current);
				current = "";
				continue;
			}
			current += char;
		}
		parts.push(current);

		const columns = parts
			.map(
				(part) =>
					part
						.trim()
						.match(
							/^"?([a-z_0-9]+)"?\s+(?:TEXT|INTEGER|REAL|BLOB|NUMERIC)\b/i,
						)?.[1],
			)
			.filter((name): name is string => Boolean(name));

		if (columns.length > 0) {
			declared.push({ file, table: match[1] ?? "", columns });
		}
	}
	return declared;
}

it("declares no table or column the schema does not have", () => {
	const real = realColumnsByTable();
	const unknownTables: string[] = [];
	const phantomColumns: string[] = [];

	for (const file of readdirSync(QUERIES_DIR).filter((f) =>
		f.endsWith(".test.ts"),
	)) {
		const text = readFileSync(`${QUERIES_DIR}${file}`, "utf8");
		for (const { table, columns } of parseDeclaredTables(file, text)) {
			if (UNOWNED_TABLES.has(table)) continue;
			const actual = real.get(table);
			if (!actual) {
				unknownTables.push(`${file}: CREATE TABLE ${table}`);
				continue;
			}
			for (const column of columns) {
				if (!actual.has(column)) {
					phantomColumns.push(`${file}: ${table}.${column}`);
				}
			}
		}
	}

	// Listed rather than counted so a failure names exactly what to fix.
	expect({ unknownTables, phantomColumns }).toEqual({
		unknownTables: [],
		phantomColumns: [],
	});
});
