import { expect, test } from "bun:test";
import { seedWorkspaceFiles } from "./local-workspace-seed";
import type { WorkspaceStore } from "./migrate-workspaces/target";
import type { StoredRow } from "./migrate-workspaces/rows";

function fixture(corrupt = false) {
	let authority: "shared" | "object" = "shared";
	const rows = new Map<string, StoredRow[]>();
	const activated: unknown[] = [];
	const store: WorkspaceStore = {
		async describe() {
			return {
				organizationId: "fixture",
				workspaceId: "workspace",
				createdAt: "",
				migrations: [],
				jurisdiction: null,
				outputAuthority: authority,
				importGeneration: 2,
			};
		},
		async importRows(batch) {
			rows.set(batch.table, batch.rows);
			return { ...batch, rowCount: batch.rows.length, status: "imported" };
		},
		async readRows(table) {
			return { rows: corrupt ? [] : (rows.get(table) ?? []), next: null };
		},
		async activate(input) {
			authority = "object";
			activated.push(input);
		},
		async close() {},
	};
	return { store, rows, activated };
}

test("imports and reconciles seeded documents before activation; restarts preserve edits", async () => {
	const f = fixture();
	const tables = new Map([["os_outputs", [{ id: "sheet", title: "Seed" }]]]);
	await seedWorkspaceFiles(f.store, tables);
	expect(f.activated).toEqual([
		{ importGeneration: 2, reconciliationRef: "local-demo:verified-seed" },
	]);
	f.rows.set("os_outputs", [{ id: "sheet", title: "Edited" }]);
	await seedWorkspaceFiles(f.store, tables);
	expect(f.rows.get("os_outputs")).toEqual([{ id: "sheet", title: "Edited" }]);
	expect(f.activated).toHaveLength(1);
});

test("refuses activation when imported document rows differ", async () => {
	const f = fixture(true);
	await expect(
		seedWorkspaceFiles(f.store, new Map([["os_outputs", [{ id: "sheet" }]]])),
	).rejects.toThrow("Local workspace seed differs: os_outputs");
	expect(f.activated).toHaveLength(0);
});
