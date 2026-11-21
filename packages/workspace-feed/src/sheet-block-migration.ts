import type {
	OsOutputContent,
	OsWorkbookSheet,
} from "@tedix/api-contract/schemas/os-workspaces";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { projectSheet } from "@tedix/api-contract/utils/output-merge";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	storeSheetBlocks,
	type SheetBlockBucket,
	type SheetBlockLayout,
} from "./sheet-blocks";

/** One-way decoder for old revisions; active sheet reads never fetch row objects. */
export async function migrateSheetBlocks(
	bucket: SheetBlockBucket,
	organizationId: string,
	content: string,
) {
	let legacy;
	try {
		legacy = JSON.parse(content);
	} catch {
		return null;
	}
	if (legacy?.sheetBlocks !== 1) return null;
	const manifest = legacy as SheetBlockLayout;
	if (!organizationId || /[/\\\u0000-\u001f]/.test(organizationId))
		throw new Error("Invalid sheet block organization");
	const packedDigest = await sha256Hex(
		JSON.stringify([organizationId, legacy]),
	);
	const assembly = await bucket.get(
		`os-sheet-assemblies/v1/${organizationId}/${packedDigest}.gz`,
	);
	const unpack = async (bytes: ArrayBuffer) =>
		new Response(
			new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
		).text();
	const packed = assembly
		? (JSON.parse(await unpack(await assembly.arrayBuffer())) as Record<
				string,
				string
			>)
		: undefined;
	const sheet = structuredClone(manifest.content);
	for (const table of manifest.tables) {
		const rows: JsonValue[][] = Array.from(
			{ length: table.rows.length },
			() => [],
		);
		for (let start = 0; start < table.rows.length; start += 32)
			await Promise.all(
				table.rows.slice(start, start + 32).map(async (ref, offset) => {
					if (!/^[a-f0-9]{64}$/.test(ref.digest))
						throw new Error("Invalid legacy sheet row digest");
					let raw: string;
					if (packed) {
						if (!Object.hasOwn(packed, ref.digest))
							throw new Error(
								"Sheet assembly integrity mismatch: row is missing",
							);
						raw = packed[ref.digest]!;
					} else {
						const object = await bucket.get(
							`os-sheet-blocks/v1/${organizationId}/${ref.digest}.gz`,
						);
						if (!object) throw new Error("Legacy sheet row is missing");
						raw = await unpack(await object.arrayBuffer());
					}
					const bytes = new TextEncoder().encode(raw);
					if (
						bytes.byteLength !== ref.bytes ||
						(await sha256Hex(bytes)) !== ref.digest
					)
						throw new Error("Legacy sheet row integrity mismatch");
					const block = JSON.parse(raw) as {
						cells: Record<string, JsonValue>;
						overflow: JsonValue[];
					};
					const row = table.columns.map((id) =>
						Object.hasOwn(block.cells, id) ? block.cells[id] : undefined,
					);
					while (row.length && row.at(-1) === undefined) row.pop();
					rows[start + offset] = [
						...row.map((cell) => cell ?? null),
						...block.overflow,
					];
				}),
			);
		if (sheet.workbook) {
			const target = sheet.workbook.sheets.find(
				(value) => value.id === table.id,
			);
			if (!target) throw new Error("Legacy sheet table is missing");
			target.rows = rows as OsWorkbookSheet["rows"];
		} else
			sheet.rows = rows as Extract<OsOutputContent, { kind: "sheet" }>["rows"];
	}
	if (sheet.workbook) Object.assign(sheet, projectSheet(sheet.workbook));
	return storeSheetBlocks(bucket, organizationId, sheet, manifest);
}
