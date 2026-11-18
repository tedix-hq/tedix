import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exportObject } from "./object-capture";
import { localStoreFactory, type WorkspaceStoreFactory } from "./target";
import { WORKSPACE_TABLES } from "./tables";

const ref = { organizationId: "org-fixture", workspaceId: "ws" };
test("object export uses only paced reads, preserves blobs, and rejects repeated cursors", async () => {
	const dir = mkdtempSync(join(tmpdir(), "object-capture-"));
	const waits: number[] = [];
	let closed = 0;
	let repeat = false;
	const calls: string[] = [];
	const factory: WorkspaceStoreFactory = {
		kind: "remote",
		open: async () => ({
			describe: async () => ({
				...ref,
				jurisdiction: "eu",
				createdAt: "",
				migrations: [],
			}),
			importRows: async () => {
				throw new Error("export must never write");
			},
			readRows: async (table, after, limit) => {
				calls.push(table);
				expect(limit).toBe(1);
				return after === null || repeat
					? {
							rows: [{ id: "row", bytes: new Uint8Array([0, 255]) }],
							next: "1",
						}
					: { rows: [], next: null };
			},
			close: async () => {
				closed++;
			},
		}),
	};
	const options = {
		pageSize: 1,
		sleep: async (ms: number) => {
			waits.push(ms);
		},
	};
	try {
		const manifest = await exportObject(factory, ref, join(dir, "ok"), options);
		expect(manifest.requests).toBe(1 + WORKSPACE_TABLES.length * 2);
		expect(waits).toEqual(Array(manifest.requests).fill(2000));
		expect(manifest.tables.os_outputs?.count).toBe(1);
		const captured = new DatabaseSync(join(dir, "ok", "main.sqlite"), {
			readOnly: true,
		});
		try {
			expect(
				new Uint8Array(
					captured.prepare("SELECT bytes FROM os_outputs").get()!
						.bytes as Uint8Array,
				),
			).toEqual(new Uint8Array([0, 255]));
		} finally {
			captured.close();
		}
		expect(closed).toBe(1);
		expect(calls).toHaveLength(WORKSPACE_TABLES.length * 2);
		await expect(
			exportObject(factory, ref, join(dir, "ok"), options),
		).rejects.toThrow();
		repeat = true;
		await expect(
			exportObject(factory, ref, join(dir, "failed"), options),
		).rejects.toThrow("duplicate row");
		expect(existsSync(join(dir, "failed", "manifest.json"))).toBe(false);
		expect(closed).toBe(2);
		await expect(
			exportObject(factory, ref, join(dir, "bad-size"), { pageSize: 0 }),
		).rejects.toThrow("page size");
		await expect(
			exportObject(factory, ref, join(dir, "bad-delay"), { delayMs: 0 }),
		).rejects.toThrow("delay");
		const missing = join(dir, "missing");
		await expect(
			localStoreFactory(missing, { readOnly: true }).open(ref),
		).rejects.toThrow();
		expect(existsSync(missing)).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
