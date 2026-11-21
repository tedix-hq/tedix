import type {
	OsOutputContent,
	OsWorkbookSheet,
} from "@tedix/api-contract/schemas/os-workspaces";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { projectSheet } from "@tedix/api-contract/utils/output-merge";
import { sha256Hex } from "@tedix/worker-kit/crypto";

type Sheet = Extract<OsOutputContent, { kind: "sheet" }>;
export interface SheetBlockBucket {
	get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
	put(key: string, value: ArrayBuffer): Promise<unknown>;
}
interface SheetRowBlock {
	id: string;
	digest: string;
	bytes: number;
	contentBytes: number;
	projectionBytes?: number;
}
interface SheetBlockTable {
	id: string;
	columns: string[];
	rows: SheetRowBlock[];
}
export interface SheetBlockManifest {
	sheetBlocks: 1;
	content: Sheet;
	tables: SheetBlockTable[];
}

/** Each row is an immutable block; order and column identity live in the manifest. */
export function sheetBlockManifest(content: string): SheetBlockManifest | null {
	let value;
	try {
		value = JSON.parse(content);
	} catch {
		return null;
	}
	return value?.sheetBlocks === 1 ? (value as SheetBlockManifest) : null;
}

function blockKey(organizationId: string, digest: string) {
	if (
		!organizationId ||
		/[/\\\u0000-\u001f]/.test(organizationId) ||
		!/^[a-f0-9]{64}$/.test(digest)
	)
		throw new Error("Invalid sheet block address");
	return `os-sheet-blocks/v1/${organizationId}/${digest}.gz`;
}

function tables(content: Sheet) {
	return content.workbook
		? content.workbook.sheets
		: [{ id: "flat", columns: content.columns, rows: content.rows }];
}

function columnIds(
	content: Sheet,
	table: ReturnType<typeof tables>[number],
	previous?: SheetBlockTable,
	previousContent?: Sheet,
) {
	if (content.workbook)
		return (table.columns as { id: string }[]).map((column) => column.id);
	const old = previousContent?.columns ?? [];
	const used = new Set<string>();
	const matches = (table.columns as string[]).map((label) => {
		const match = old.findIndex(
			(value, position) =>
				value === label && !used.has(previous?.columns[position] ?? ""),
		);
		const id = match >= 0 ? previous?.columns[match] : undefined;
		if (id) used.add(id);
		return id;
	});
	return matches.map((match, index) => {
		const oldId = previous?.columns[index];
		const id =
			match ??
			(oldId && !used.has(oldId)
				? oldId
				: previous
					? crypto.randomUUID()
					: `column:${index}`);
		used.add(id);
		return id;
	});
}

async function rowBytes(
	row: readonly unknown[],
	columns: string[],
	rich: boolean,
) {
	const cells = row
		.slice(0, columns.length)
		.map((cell, index) => [columns[index]!, cell] as const);
	const bytes = new TextEncoder().encode(
		JSON.stringify({
			cells: Object.fromEntries(cells.sort(([a], [b]) => a.localeCompare(b))),
			overflow: row.slice(columns.length),
		}),
	);
	const contentBytes = new TextEncoder().encode(JSON.stringify(row)).byteLength;
	const projectionBytes = rich
		? new TextEncoder().encode(
				JSON.stringify(
					columns.map(
						(_, index) =>
							(row[index] as { value?: JsonValue } | null)?.value ?? null,
					),
				),
			).byteLength
		: undefined;
	return {
		bytes,
		digest: await sha256Hex(bytes),
		contentBytes,
		...(rich ? { projectionBytes } : {}),
	};
}

async function putRow(
	bucket: SheetBlockBucket,
	organizationId: string,
	bytes: Uint8Array,
	digest: string,
) {
	await bucket.put(
		blockKey(organizationId, digest),
		await new Response(
			new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
		).arrayBuffer(),
	);
}

/** Whole-content writers also store only changed rows, including restores and imports. */
export async function storeSheetBlocks(
	bucket: SheetBlockBucket,
	organizationId: string,
	content: Sheet,
	previous?: SheetBlockManifest,
): Promise<SheetBlockManifest> {
	const skeleton = structuredClone(content);
	skeleton.rows = [];
	if (skeleton.workbook)
		for (const sheet of skeleton.workbook.sheets) sheet.rows = [];
	const result: SheetBlockManifest = {
		sheetBlocks: 1,
		content: skeleton,
		tables: [],
	};
	for (const table of tables(content)) {
		const old = previous?.tables.find((value) => value.id === table.id);
		const columns = columnIds(content, table, old, previous?.content);
		const encoded = await Promise.all(
			table.rows.map((row) =>
				rowBytes(row, columns, Boolean(content.workbook)),
			),
		);
		const used = new Set<string>();
		const byDigest = new Map<string, SheetRowBlock[]>();
		for (const row of old?.rows.toReversed() ?? []) {
			const matching = byDigest.get(row.digest) ?? [];
			matching.push(row);
			byDigest.set(row.digest, matching);
		}
		const matches = encoded.map(({ digest }) => {
			const same = byDigest.get(digest)?.pop();
			if (same) used.add(same.id);
			return same;
		});
		const rows = encoded.map(
			({ bytes, digest, contentBytes, projectionBytes }, index) => {
				const same = matches[index];
				const atIndex = old?.rows[index];
				const id =
					same?.id ??
					(atIndex && !used.has(atIndex.id)
						? atIndex.id
						: old
							? crypto.randomUUID()
							: `row:${index}`);
				used.add(id);
				return {
					id,
					digest,
					bytes: bytes.byteLength,
					contentBytes,
					...(projectionBytes === undefined ? {} : { projectionBytes }),
				};
			},
		);
		// Bound concurrent uploads, including large imports.
		const known = new Set(old?.rows.map((row) => row.digest));
		for (let start = 0; start < encoded.length; start += 16)
			await Promise.all(
				encoded.slice(start, start + 16).map(async ({ bytes, digest }) => {
					if (!known.has(digest)) {
						known.add(digest);
						await putRow(bucket, organizationId, bytes, digest);
					}
				}),
			);
		result.tables.push({ id: table.id, columns, rows });
	}
	return result;
}

/** A selection leaves other rows empty, for applying a cell patch without fetching them. */
export async function readSheetBlocks(
	bucket: SheetBlockBucket,
	organizationId: string,
	manifest: SheetBlockManifest,
	selection?: ReadonlyMap<string, ReadonlySet<number>>,
): Promise<Sheet> {
	const content = structuredClone(manifest.content);
	for (const table of manifest.tables) {
		const target = tables(content).find((value) => value.id === table.id);
		if (!target) throw new Error("Sheet block table is missing");
		const rows: JsonValue[][] = Array.from(
			{ length: table.rows.length },
			() => [],
		);
		const selected = selection?.get(table.id);
		const indices = table.rows
			.map((_, index) => index)
			.filter((index) => !selection || selected?.has(index));
		for (let start = 0; start < indices.length; start += 16)
			await Promise.all(
				indices.slice(start, start + 16).map(async (index) => {
					const ref = table.rows[index]!;
					const object = await bucket.get(blockKey(organizationId, ref.digest));
					if (!object) throw new Error("Sheet row block is missing");
					const bytes = await new Response(
						new Blob([await object.arrayBuffer()])
							.stream()
							.pipeThrough(new DecompressionStream("gzip")),
					).arrayBuffer();
					if (
						bytes.byteLength !== ref.bytes ||
						(await sha256Hex(bytes)) !== ref.digest
					)
						throw new Error("Sheet row block integrity mismatch");
					const block = JSON.parse(
						new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
							bytes,
						),
					) as { cells: Record<string, JsonValue>; overflow: JsonValue[] };
					const row = table.columns.map((id) =>
						Object.hasOwn(block.cells, id) ? block.cells[id] : undefined,
					);
					while (row.length && row.at(-1) === undefined) row.pop();
					rows[index] = [...row.map((cell) => cell ?? null), ...block.overflow];
				}),
			);
		if (content.workbook)
			content.workbook.sheets.find((sheet) => sheet.id === table.id)!.rows =
				rows as OsWorkbookSheet["rows"];
		else content.rows = rows as Sheet["rows"];
	}
	if (content.workbook) Object.assign(content, projectSheet(content.workbook));
	return content;
}

/** Save selected rows while retaining every unselected block's identity and pointer. */
export async function updateSheetBlocks(
	bucket: SheetBlockBucket,
	organizationId: string,
	previous: SheetBlockManifest,
	content: Sheet,
	selection: ReadonlyMap<string, ReadonlySet<number>>,
): Promise<SheetBlockManifest> {
	const result = structuredClone(previous);
	for (const table of result.tables) {
		const rows = tables(content).find((value) => value.id === table.id)!.rows;
		for (const index of selection.get(table.id) ?? []) {
			const { bytes, digest, contentBytes, projectionBytes } = await rowBytes(
				rows[index]!,
				table.columns,
				Boolean(content.workbook),
			);
			const old = table.rows[index]!;
			if (digest === old.digest) continue;
			await putRow(bucket, organizationId, bytes, digest);
			table.rows[index] = {
				id: old.id,
				digest,
				bytes: bytes.byteLength,
				contentBytes,
				...(projectionBytes === undefined ? {} : { projectionBytes }),
			};
		}
	}
	return result;
}

/** Layout changes need a full comparison; cell changes need only differing blocks. */
export function changedSheetRows(
	base: SheetBlockManifest,
	current: SheetBlockManifest,
): Map<string, Set<number>> | null {
	if (
		JSON.stringify(base.content) !== JSON.stringify(current.content) ||
		base.tables.length !== current.tables.length
	)
		return null;
	const changed = new Map<string, Set<number>>();
	for (const [index, table] of base.tables.entries()) {
		const next = current.tables[index]!;
		if (
			table.id !== next.id ||
			JSON.stringify(table.columns) !== JSON.stringify(next.columns) ||
			table.rows.length !== next.rows.length
		)
			return null;
		const rows = new Set<number>();
		for (const [position, row] of table.rows.entries()) {
			if (row.id !== next.rows[position]!.id) return null;
			if (row.digest !== next.rows[position]!.digest) rows.add(position);
		}
		changed.set(table.id, rows);
	}
	return changed;
}

/** Size of the public sheet JSON, independent of storage-key and identity overhead. */
export function sheetContentBytes(manifest: SheetBlockManifest): number {
	let bytes = new TextEncoder().encode(
		JSON.stringify(manifest.content),
	).byteLength;
	for (const table of manifest.tables) {
		bytes +=
			table.rows.reduce((sum, row) => sum + row.contentBytes, 0) +
			Math.max(0, table.rows.length - 1);
		if (table.id === manifest.content.workbook?.activeSheetId)
			bytes +=
				table.rows.reduce((sum, row) => sum + row.projectionBytes!, 0) +
				Math.max(0, table.rows.length - 1);
	}
	return bytes;
}
