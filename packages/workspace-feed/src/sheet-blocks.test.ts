import { describe, expect, it, vi } from "vite-plus/test";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import {
	readSheetBlocks,
	storeSheetBlocks,
	updateSheetBlocks,
	sheetContentBytes,
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

describe("sheet row blocks", () => {
	it("loads and rewrites one row of a 1.4 MB sheet, preserving historical manifests", async () => {
		const store = bucket();
		const sheet: Sheet = {
			kind: "sheet",
			columns: ["Name", "Description"],
			rows: Array.from({ length: 180 }, (_, row) => [
				`Row ${row}`,
				"Description ".repeat(650),
			]),
		};
		const original = await storeSheetBlocks(store, "org", sheet);
		expect(sheetContentBytes(original)).toBe(
			new TextEncoder().encode(JSON.stringify(sheet)).byteLength,
		);
		store.get.mockClear();
		store.put.mockClear();
		const selected = new Map([["flat", new Set([74])]]);
		const partial = await readSheetBlocks(store, "org", original, selected);
		partial.rows[74]![0] = "Edited";
		const changed = await updateSheetBlocks(
			store,
			"org",
			original,
			partial,
			selected,
		);
		expect(sheetContentBytes(changed)).toBe(
			sheetContentBytes(original) - "Row 74".length + "Edited".length,
		);
		expect(store.get).toHaveBeenCalledTimes(1);
		expect(store.put).toHaveBeenCalledTimes(1);
		expect(changed.tables[0]!.rows[74]!.id).toBe(
			original.tables[0]!.rows[74]!.id,
		);
		expect(
			changed.tables[0]!.rows.filter(
				(row, index) => row.digest !== original.tables[0]!.rows[index]!.digest,
			),
		).toHaveLength(1);
		expect((await readSheetBlocks(store, "org", changed)).rows[74]![0]).toBe(
			"Edited",
		);
		expect(await readSheetBlocks(store, "org", original)).toEqual(sheet);
		await expect(readSheetBlocks(store, "other-org", original)).rejects.toThrow(
			"missing",
		);
	});

	it("keeps row identities and cell blocks through row and column moves and an insertion", async () => {
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
		expect(store.put).not.toHaveBeenCalled();
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
		expect(store.put).toHaveBeenCalledTimes(1);
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
		await expect(readSheetBlocks(store, "org", manifest)).rejects.toThrow(
			"integrity",
		);
	});
});
