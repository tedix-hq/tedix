import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getColumns } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { expect, it } from "vite-plus/test";
import {
	approvalRequestStoredColumns,
	tediApprovalRequests,
} from "../schema/approvals";
import {
	kernelRuntimeRuns,
	kernelRuntimeRunStoredColumns,
} from "../schema/cognitive-runtime";
import {
	workInteractions,
	workInteractionStoredColumns,
} from "../schema/work-factory";
import { workItems, workItemStoredColumns } from "../schema/work-items";
import { prefixedColumns } from "../utils/select";

// Generated columns exist for WHERE, ORDER BY and indexes. A row that carries
// one fails every response contract that allows no extra properties, which is
// how MCP checks a tool result.
const tables: [string, SQLiteTable, Record<string, SQLiteColumn>, string[]][] =
	[
		[
			"workItems",
			workItems,
			workItemStoredColumns,
			[
				"repositoryObserver",
				"report",
				"observerWokenAt",
				"metadataExecutor",
				"metadataSource",
				"delegationRootId",
			],
		],
		[
			"kernelRuntimeRuns",
			kernelRuntimeRuns,
			kernelRuntimeRunStoredColumns,
			["workItemId", "targetTediId"],
		],
		[
			"tediApprovalRequests",
			tediApprovalRequests,
			approvalRequestStoredColumns,
			[
				"workItemId",
				"executionStatus",
				"executionDismissedAt",
				"consumedAt",
				"delegatedOwnerId",
			],
		],
		[
			"workInteractions",
			workInteractions,
			workInteractionStoredColumns,
			["source", "delegatedOwnerId"],
		],
	];

it.each(tables)(
	"%s rows are read without generated columns",
	(_name, table, stored, generated) => {
		const all = getColumns(table) as Record<string, SQLiteColumn>;
		const expected = Object.keys(all).filter((key) => !all[key]?.generated);
		expect(Object.keys(all).filter((key) => all[key]?.generated)).toEqual(
			generated,
		);
		expect(Object.keys(stored)).toEqual(expected);
		expect(Object.keys(prefixedColumns(table, "joined"))).toEqual(expected);
	},
);

function queryModules(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return queryModules(path);
		return /(?<!\.test)\.ts$/.test(entry.name) ? [path] : [];
	});
}

it("no query module reads or returns a whole row of these tables", () => {
	const names = tables.map(([name]) => name).join("|");
	const wholeRow = [
		new RegExp(`\\.select\\(\\)\\s*\\.from\\(\\s*(?:${names})\\b`),
		new RegExp(`getColumns\\(\\s*(?:${names})\\s*\\)`),
	];
	const write = new RegExp(
		`\\.(?:update|insert|delete)\\(\\s*(\\w+)\\s*\\)|\\.returning\\(\\)`,
		"g",
	);
	const found: string[] = [];
	for (const file of queryModules(import.meta.dirname)) {
		const source = readFileSync(file, "utf8");
		if (wholeRow.some((pattern) => pattern.test(source))) found.push(file);
		// A bare `returning()` belongs to the write statement before it.
		let written = "";
		for (const match of source.matchAll(write)) {
			if (match[1]) written = match[1];
			else if (new RegExp(`^(?:${names})$`).test(written)) found.push(file);
		}
	}
	expect(found).toEqual([]);
});
