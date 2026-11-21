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
interface SheetRowMetadata {
	id: string;
	digest: string;
	bytes: number;
	contentBytes: number;
	projectionBytes?: number;
}
interface SheetChunk {
	digest: string;
	bytes: number;
	start: number;
	count: number;
}
interface SheetBlockTable {
	id: string;
	columns: string[];
	rows: SheetRowMetadata[];
	chunks: SheetChunk[];
}
export interface SheetBlockManifest {
	sheetBlocks: 2;
	content: Sheet;
	tables: SheetBlockTable[];
}

export interface SheetBlockLayout {
	content: Sheet;
	tables: (Omit<SheetBlockTable, "chunks"> & { chunks?: SheetChunk[] })[];
}

const CHUNK_ROWS = 1_000;

// Cache immutable content only; callers still resolve revision metadata and access.
const assembled = new Map<string, { bucket: SheetBlockBucket; json: string }>();
const ASSEMBLED_MAX_BYTES = 8 * 1024 * 1024;
const ASSEMBLED_MAX_ENTRIES = 16;
let assembledBytes = 0;

function assemblyKey(organizationId: string, manifest: SheetBlockManifest) {
	return JSON.stringify([organizationId, manifest]);
}

function cachedSheet(bucket: SheetBlockBucket, key: string): Sheet | undefined {
	const cached = assembled.get(key);
	if (cached?.bucket !== bucket) return undefined;
	assembled.delete(key);
	assembled.set(key, cached);
	// Never let a caller's patch mutate the cached revision or its history.
	return JSON.parse(cached.json) as Sheet;
}

function rememberSheet(bucket: SheetBlockBucket, key: string, content: Sheet) {
	const json = JSON.stringify(content);
	const size = (key.length + json.length) * 2;
	if (size > ASSEMBLED_MAX_BYTES) return;
	const previous = assembled.get(key);
	if (previous) {
		assembledBytes -= (key.length + previous.json.length) * 2;
		assembled.delete(key);
	}
	while (
		assembled.size &&
		(assembledBytes + size > ASSEMBLED_MAX_BYTES ||
			assembled.size >= ASSEMBLED_MAX_ENTRIES)
	) {
		const oldest = assembled.keys().next().value!;
		assembledBytes -= (oldest.length + assembled.get(oldest)!.json.length) * 2;
		assembled.delete(oldest);
	}
	assembled.set(key, { bucket, json });
	assembledBytes += size;
}

/** Only chunk manifests enter the active read and edit paths. */
export function sheetBlockManifest(content: string): SheetBlockManifest | null {
	let value;
	try {
		value = JSON.parse(content);
	} catch {
		return null;
	}
	return value?.sheetBlocks === 2 ? (value as SheetBlockManifest) : null;
}

function blockKey(organizationId: string, digest: string) {
	if (
		!organizationId ||
		/[/\\\u0000-\u001f]/.test(organizationId) ||
		!/^[a-f0-9]{64}$/.test(digest)
	)
		throw new Error("Invalid sheet block address");
	return `os-sheet-blocks/v2/${organizationId}/${digest}.gz`;
}

function tables(content: Sheet) {
	return content.workbook
		? content.workbook.sheets
		: [{ id: "flat", columns: content.columns, rows: content.rows }];
}

function columnIds(
	content: Sheet,
	table: ReturnType<typeof tables>[number],
	previous?: SheetBlockLayout["tables"][number],
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

async function putChunk(
	bucket: SheetBlockBucket,
	organizationId: string,
	raws: string[],
	start: number,
	known: Set<string>,
): Promise<SheetChunk> {
	const bytes = new TextEncoder().encode(`[${raws.join(",")}]`);
	const digest = await sha256Hex(bytes);
	if (!known.has(digest)) {
		const started = performance.now();
		await bucket.put(
			blockKey(organizationId, digest),
			await new Response(
				new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
			).arrayBuffer(),
		);
		known.add(digest);
		console.info({
			event: "os_sheet_chunk_written",
			key: blockKey(organizationId, digest),
			rows: raws.length,
			bytes: bytes.byteLength,
			writeMs: Math.round(performance.now() - started),
		});
	}
	return { digest, bytes: bytes.byteLength, start, count: raws.length };
}

type StoredRow = { cells: Record<string, JsonValue>; overflow: JsonValue[] };

async function readChunk(
	bucket: SheetBlockBucket,
	organizationId: string,
	ref: SheetChunk,
): Promise<StoredRow[]> {
	const object = await bucket.get(blockKey(organizationId, ref.digest));
	if (!object) throw new Error("Sheet chunk is missing");
	const bytes = await new Response(
		new Blob([await object.arrayBuffer()])
			.stream()
			.pipeThrough(new DecompressionStream("gzip")),
	).arrayBuffer();
	if (bytes.byteLength !== ref.bytes || (await sha256Hex(bytes)) !== ref.digest)
		throw new Error("Sheet chunk integrity mismatch");
	const rows = JSON.parse(
		new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
	) as StoredRow[];
	if (!Array.isArray(rows) || rows.length !== ref.count)
		throw new Error("Sheet chunk row count mismatch");
	return rows;
}

function decodeRow(block: StoredRow, columns: string[]) {
	const row = columns.map((id) =>
		Object.hasOwn(block.cells, id) ? block.cells[id] : undefined,
	);
	while (row.length && row.at(-1) === undefined) row.pop();
	return [...row.map((cell) => cell ?? null), ...block.overflow];
}

/** Whole-content writers share unchanged chunks, including restores and imports. */
export async function storeSheetBlocks(
	bucket: SheetBlockBucket,
	organizationId: string,
	content: Sheet,
	previous?: SheetBlockLayout,
): Promise<SheetBlockManifest> {
	const skeleton = structuredClone(content);
	skeleton.rows = [];
	if (skeleton.workbook)
		for (const sheet of skeleton.workbook.sheets) sheet.rows = [];
	const result: SheetBlockManifest = {
		sheetBlocks: 2,
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
		const byDigest = new Map<string, SheetRowMetadata[]>();
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
		const known = new Set(old?.chunks?.map((chunk) => chunk.digest));
		const chunks: SheetChunk[] = [];
		for (let start = 0; start < encoded.length; start += CHUNK_ROWS)
			chunks.push(
				await putChunk(
					bucket,
					organizationId,
					encoded
						.slice(start, start + CHUNK_ROWS)
						.map(({ bytes }) => new TextDecoder().decode(bytes)),
					start,
					known,
				),
			);
		result.tables.push({ id: table.id, columns, rows, chunks });
	}
	rememberSheet(bucket, assemblyKey(organizationId, result), content);
	return result;
}

/** A selection leaves other rows empty, for applying a cell patch without fetching them. */
export async function readSheetBlocks(
	bucket: SheetBlockBucket,
	organizationId: string,
	manifest: SheetBlockManifest,
	selection?: ReadonlyMap<string, ReadonlySet<number>>,
): Promise<Sheet> {
	const started = performance.now();
	const readId = crypto.randomUUID();
	let blockGets = 0;
	let cache = "blocks";
	console.info({
		event: "os_sheet_blocks_read_start",
		readId,
		selected: Boolean(selection),
	});
	const report = () =>
		console.info({
			event: "os_sheet_blocks_read",
			readId,
			cache,
			blockGets,
			readMs: Math.round(performance.now() - started),
		});
	const key = assemblyKey(organizationId, manifest);
	if (!selection) {
		const cached = cachedSheet(bucket, key);
		if (cached) {
			cache = "memory";
			report();
			return cached;
		}
	}
	const content = structuredClone(manifest.content);
	for (const table of manifest.tables) {
		const target = tables(content).find((value) => value.id === table.id);
		if (!target) throw new Error("Sheet block table is missing");
		const rows: JsonValue[][] = Array.from(
			{ length: table.rows.length },
			() => [],
		);
		const selected = selection?.get(table.id);
		const chunks = table.chunks.filter(
			(chunk) =>
				!selection ||
				Array.from(
					{ length: chunk.count },
					(_, offset) => chunk.start + offset,
				).some((index) => selected?.has(index)),
		);
		// Bound R2 concurrency even for imports much larger than the fixture.
		for (let start = 0; start < chunks.length; start += 32)
			await Promise.all(
				chunks.slice(start, start + 32).map(async (chunk) => {
					blockGets++;
					const blocks = await readChunk(bucket, organizationId, chunk);
					for (const [offset, block] of blocks.entries()) {
						const index = chunk.start + offset;
						if (!selection || selected?.has(index))
							rows[index] = decodeRow(block, table.columns);
					}
				}),
			);
		if (content.workbook)
			content.workbook.sheets.find((sheet) => sheet.id === table.id)!.rows =
				rows as OsWorkbookSheet["rows"];
		else content.rows = rows as Sheet["rows"];
	}
	if (content.workbook) Object.assign(content, projectSheet(content.workbook));
	if (!selection) rememberSheet(bucket, key, content);

	report();
	return content;
}

/** Read and replace affected chunks without assembling or writing the whole sheet. */
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
		const changed = new Map<number, string>();
		for (const index of selection.get(table.id) ?? []) {
			const { bytes, digest, contentBytes, projectionBytes } = await rowBytes(
				rows[index]!,
				table.columns,
				Boolean(content.workbook),
			);
			const old = table.rows[index]!;
			if (digest === old.digest) continue;
			changed.set(index, new TextDecoder().decode(bytes));
			table.rows[index] = {
				id: old.id,
				digest,
				bytes: bytes.byteLength,
				contentBytes,
				...(projectionBytes === undefined ? {} : { projectionBytes }),
			};
		}
		const known = new Set(table.chunks.map((chunk) => chunk.digest));
		for (const [position, chunk] of table.chunks.entries()) {
			if (
				![...changed.keys()].some(
					(index) => index >= chunk.start && index < chunk.start + chunk.count,
				)
			)
				continue;
			const blocks = await readChunk(bucket, organizationId, chunk);
			const raws = blocks.map(
				(block, offset) =>
					changed.get(chunk.start + offset) ?? JSON.stringify(block),
			);
			table.chunks[position] = await putChunk(
				bucket,
				organizationId,
				raws,
				chunk.start,
				known,
			);
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
