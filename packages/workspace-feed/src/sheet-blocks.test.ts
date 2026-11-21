import { describe, expect, it, vi } from "vite-plus/test";
import { migrateSheetBlocks } from "./sheet-block-migration";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import {
	readSheetBlocks,
	storeSheetBlocks,
	updateSheetBlocks,
	sheetContentBytes,
	changedSheetRows,
} from "./sheet-blocks";

function bucket() {
	const objects = new Map<string, ArrayBuffer>();
	return {
		objects,
		put: vi.fn(async (key: string, bytes: ArrayBuffer) => {
			objects.set(key, bytes);
		}),
		get: vi.fn(async (key: string) => {
			const value = objects.get(key);
			return value ? { arrayBuffer: async () => value } : null;
		}),
	};
}
type Sheet = Extract<OsOutputContent, { kind: "sheet" }>;

describe("sheet chunks", () => {
	it("reads 20k rows cold in 20 gets and writes one chunk for a cell save, retaining history", async () => {
		const store = bucket();
		const sheet: Sheet = {
			kind: "sheet",
			columns: ["Name", "Description"],
			rows: Array.from({ length: 20_000 }, (_, row) => [
				`Row ${row}`,
				"Description ".repeat(6),
			]),
		};
		const original = await storeSheetBlocks(store, "org", sheet);
		expect(sheetContentBytes(original)).toBe(
			new TextEncoder().encode(JSON.stringify(sheet)).byteLength,
		);
		expect(store.put).toHaveBeenCalledTimes(20);
		const cold = { get: store.get, put: store.put };
		const started = performance.now();
		expect(await readSheetBlocks(cold, "org", original)).toEqual(sheet);
		console.info({
			fixtureRows: 20_000,
			storageGets: store.get.mock.calls.length,
			coldReadMs: Math.round(performance.now() - started),
		});
		expect(store.get).toHaveBeenCalledTimes(20);
		store.get.mockClear();
		store.put.mockClear();
		const selected = new Map([["flat", new Set([1_074])]]);
		const partial = await readSheetBlocks(cold, "org", original, selected);
		partial.rows[1_074]![0] = "Edited";
		const changed = await updateSheetBlocks(
			cold,
			"org",
			original,
			partial,
			selected,
		);
		expect(store.get).toHaveBeenCalledTimes(2);
		expect(store.put).toHaveBeenCalledTimes(1);
		expect(
			changed.tables[0]!.chunks.filter(
				(chunk, i) => chunk.digest !== original.tables[0]!.chunks[i]!.digest,
			),
		).toHaveLength(1);
		expect(changedSheetRows(original, changed)).toEqual(selected);
		expect(changed.tables[0]!.rows[1_074]!.id).toBe(
			original.tables[0]!.rows[1_074]!.id,
		);
		expect(sheetContentBytes(changed)).toBe(
			sheetContentBytes(original) - "Row 1074".length + "Edited".length,
		);
		const full = await readSheetBlocks(cold, "org", changed);
		expect(full).toEqual({
			...sheet,
			rows: sheet.rows.map((row, i) =>
				i === 1_074 ? ["Edited", row[1]] : row,
			),
		});
		full.rows[0]![0] = "Caller mutation";
		expect((await readSheetBlocks(cold, "org", changed)).rows[0]![0]).toBe(
			"Row 0",
		);
		expect(await readSheetBlocks(cold, "org", original)).toEqual(sheet);
		await expect(readSheetBlocks(cold, "other-org", original)).rejects.toThrow(
			"missing",
		);
		store.put.mockClear();
		const unchanged = await storeSheetBlocks(cold, "org", sheet, original);
		expect(unchanged).toEqual(original);
		expect(store.put).not.toHaveBeenCalled();
	});

	it("keeps row identities through row and column moves and an insertion", async () => {
		const store = bucket();
		const initial: Sheet = {
			kind: "sheet",
			columns: ["A", "B"],
			rows: [
				[1, 2, 9],
				[3, 4, 8],
				[5, 6, 7],
			],
		};
		const original = await storeSheetBlocks(store, "org", initial);
		store.put.mockClear();
		const moved: Sheet = {
			kind: "sheet",
			columns: ["B", "A"],
			rows: [
				[6, 5, 7],
				[2, 1, 9],
				[4, 3, 8],
			],
		};
		const reordered = await storeSheetBlocks(store, "org", moved, original);
		expect(store.put.mock.calls.map(([key]) => key.split("/")[0])).toEqual([
			"os-sheet-blocks",
		]);
		expect(reordered.tables[0]!.rows).toEqual([
			original.tables[0]!.rows[2],
			original.tables[0]!.rows[0],
			original.tables[0]!.rows[1],
		]);
		const inserted = await storeSheetBlocks(
			store,
			"org",
			{ ...moved, rows: [[8, 7], ...moved.rows] },
			reordered,
		);
		expect(inserted.tables[0]!.rows.slice(1)).toEqual(
			reordered.tables[0]!.rows,
		);
		expect(new Set(inserted.tables[0]!.rows.map((row) => row.id)).size).toBe(4);
		expect(store.put).toHaveBeenCalledTimes(2);
		expect(await readSheetBlocks(store, "org", reordered)).toEqual(moved);
	});

	it("round-trips rich nullable cells and measures the public body rather than storage overhead", async () => {
		const store = bucket();
		const sheet: Sheet = {
			kind: "sheet",
			columns: ["A", "B"],
			rows: [
				[1, null],
				[null, null],
			],
			workbook: {
				activeSheetId: "one",
				sheets: [
					{
						id: "one",
						name: "One",
						frozenRows: 0,
						frozenColumns: 0,
						columns: [
							{ id: "__proto__", label: "A", width: 128 },
							{ id: "b", label: "B", width: 128 },
						],
						rows: [
							[{ input: "1", value: 1, format: { bold: true } }, null],
							[],
						],
					},
				],
			},
		};
		const manifest = await storeSheetBlocks(store, "org", sheet);
		expect(await readSheetBlocks(store, "org", manifest)).toEqual(sheet);
		expect(sheetContentBytes(manifest)).toBe(
			new TextEncoder().encode(JSON.stringify(sheet)).byteLength,
		);
	});

	it("rejects corrupt blocks instead of returning or overwriting a damaged row", async () => {
		const store = bucket();
		const manifest = await storeSheetBlocks(store, "org", {
			kind: "sheet",
			columns: ["A"],
			rows: [[1]],
		});
		await storeSheetBlocks(store, "org", {
			kind: "sheet",
			columns: ["A"],
			rows: [[2]],
		});
		const keys = [...store.objects.keys()];
		store.objects.set(keys[0]!, store.objects.get(keys[1]!)!);
		// A fresh bucket identity exercises cold reads rather than verified cached bytes.
		const cold = { get: store.get, put: store.put };
		await expect(readSheetBlocks(cold, "org", manifest)).rejects.toThrow(
			"integrity",
		);
		await expect(
			readSheetBlocks(
				store,
				"org",
				manifest,
				new Map([["flat", new Set([0])]]),
			),
		).rejects.toThrow("integrity");
	});

	it("patches across a chunk boundary once per chunk and preserves unselected neighbours", async () => {
		const store = bucket();
		const sheet: Sheet = {
			kind: "sheet",
			columns: ["A"],
			rows: Array.from({ length: 2_001 }, (_, i) => [i]),
		};
		const manifest = await storeSheetBlocks(store, "org", sheet);
		const selected = new Map([["flat", new Set([998, 999, 1_000])]]);
		const partial = await readSheetBlocks(store, "org", manifest, selected);
		for (const row of selected.get("flat")!) partial.rows[row]![0] = "changed";
		store.put.mockClear();
		const changed = await updateSheetBlocks(
			store,
			"org",
			manifest,
			partial,
			selected,
		);
		expect(store.put).toHaveBeenCalledTimes(2);
		expect(changed.tables[0]!.chunks[2]).toEqual(manifest.tables[0]!.chunks[2]);
		const full = await readSheetBlocks(store, "org", changed);
		expect(full.rows[997]).toEqual([997]);
		expect(full.rows[1_001]).toEqual([1_001]);
		for (const row of selected.get("flat")!)
			expect(full.rows[row]).toEqual(["changed"]);
		store.put.mockClear();
		await updateSheetBlocks(store, "org", changed, full, selected);
		expect(store.put).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"migrates v1 %s with verified bytes and stable identities before removing old objects",
		async (packed) => {
			const store = bucket();
			const raw = JSON.stringify({
				cells: { "column:0": "old" },
				overflow: ["extra"],
			});
			const digest = await sha256Hex(raw);
			const legacy = {
				sheetBlocks: 1,
				content: { kind: "sheet", columns: ["A"], rows: [] },
				tables: [
					{
						id: "flat",
						columns: ["column:0"],
						rows: [
							{
								id: "stable",
								digest,
								bytes: new TextEncoder().encode(raw).byteLength,
								contentBytes: 15,
							},
						],
					},
				],
			};
			const gzip = async (text: string) =>
				new Response(
					new Blob([text]).stream().pipeThrough(new CompressionStream("gzip")),
				).arrayBuffer();
			const legacyKey = packed
				? `os-sheet-assemblies/v1/org/${await sha256Hex(JSON.stringify(["org", legacy]))}.gz`
				: `os-sheet-blocks/v1/org/${digest}.gz`;
			store.objects.set(
				legacyKey,
				await gzip(packed ? JSON.stringify({ [digest]: raw }) : raw),
			);
			const migrated = await migrateSheetBlocks(
				store,
				"org",
				JSON.stringify(legacy),
			);
			expect(migrated?.tables[0]!.rows[0]!.id).toBe("stable");
			store.objects.delete(legacyKey);
			expect(
				await readSheetBlocks(
					{ get: store.get, put: store.put },
					"org",
					migrated!,
				),
			).toEqual({ kind: "sheet", columns: ["A"], rows: [["old", "extra"]] });
			store.objects.set(
				legacyKey,
				await gzip(packed ? JSON.stringify({ [digest]: "{}" }) : "{}"),
			);
			store.put.mockClear();
			await expect(
				migrateSheetBlocks(store, "org", JSON.stringify(legacy)),
			).rejects.toThrow("integrity");
			expect(store.put).not.toHaveBeenCalled();
		},
	);

	it("does not return a new manifest when its chunk write fails", async () => {
		const store = bucket();
		const sheet: Sheet = { kind: "sheet", columns: ["A"], rows: [[1]] };
		const original = await storeSheetBlocks(store, "org", sheet);
		const failing = {
			get: store.get,
			put: async (key: string, bytes: ArrayBuffer) => {
				if (key.startsWith("os-sheet-blocks/"))
					throw new Error("R2 unavailable");
				return store.put(key, bytes);
			},
		};
		await expect(storeSheetBlocks(failing, "org", sheet)).rejects.toThrow(
			"R2 unavailable",
		);
		await expect(
			updateSheetBlocks(
				failing,
				"org",
				original,
				{ ...sheet, rows: [[2]] },
				new Map([["flat", new Set([0])]]),
			),
		).rejects.toThrow("R2 unavailable");
	});
});
