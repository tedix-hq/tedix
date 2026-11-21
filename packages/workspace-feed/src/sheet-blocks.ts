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

// Cache immutable content only; callers still resolve revision metadata and access.
const assembled = new Map<
	string,
	{ bucket: SheetBlockBucket; json: string; persisted: boolean }
>();
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

function rememberSheet(
	bucket: SheetBlockBucket,
	key: string,
	content: Sheet,
	persisted = false,
) {
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
	assembled.set(key, { bucket, json, persisted });
	assembledBytes += size;
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

async function persistSheet(
	bucket: SheetBlockBucket,
	organizationId: string,
	manifest: SheetBlockManifest,
	content: Sheet,
) {
	const packed: Record<string, string> = Object.create(null);
	for (const table of manifest.tables) {
		const rows = tables(content).find((value) => value.id === table.id)!.rows;
		for (const [index, ref] of table.rows.entries()) {
			const encoded = await rowBytes(
				rows[index]!,
				table.columns,
				Boolean(content.workbook),
			);
			if (
				encoded.digest !== ref.digest ||
				encoded.bytes.byteLength !== ref.bytes
			)
				throw new Error("Sheet row block integrity mismatch");
			packed[ref.digest] = new TextDecoder().decode(encoded.bytes);
		}
	}
	const key = assemblyKey(organizationId, manifest);
	const packedKey = blockKey(organizationId, await sha256Hex(key)).replace(
		"os-sheet-blocks/v1/",
		"os-sheet-assemblies/v1/",
	);
	await bucket.put(
		packedKey,
		await new Response(
			new Blob([JSON.stringify(packed)])
				.stream()
				.pipeThrough(new CompressionStream("gzip")),
		).arrayBuffer(),
	);
	rememberSheet(bucket, key, content, true);
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
		for (let start = 0; start < encoded.length; start += 64)
			await Promise.all(
				encoded.slice(start, start + 64).map(async ({ bytes, digest }) => {
					if (!known.has(digest)) {
						known.add(digest);
						await putRow(bucket, organizationId, bytes, digest);
					}
				}),
			);
		result.tables.push({ id: table.id, columns, rows });
	}
	await persistSheet(bucket, organizationId, result, content);
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
	const get = async (objectKey: string) => {
		const getStarted = performance.now();
		let status = "error";
		try {
			const object = await bucket.get(objectKey);
			const bytes = object ? await object.arrayBuffer() : null;
			status = object ? "found" : "missing";
			return bytes;
		} finally {
			console.info({
				event: "os_sheet_blocks_get",
				readId,
				key: objectKey,
				status,
				getMs: Math.round(performance.now() - getStarted),
			});
		}
	};
	const key = assemblyKey(organizationId, manifest);
	let packed: Record<string, string> | undefined;
	let packedKey: string | undefined;
	let loadedPacked = false;
	if (!selection) {
		const cached = cachedSheet(bucket, key);
		if (cached && assembled.get(key)?.persisted) {
			cache = "memory";
			report();
			return cached;
		}
		// Persist an assembly across isolates and memory-cache eviction. Every row
		// is still checked against the authoritative manifest before it is served.
		packedKey = blockKey(organizationId, await sha256Hex(key)).replace(
			"os-sheet-blocks/v1/",
			"os-sheet-assemblies/v1/",
		);
		const object = await get(packedKey);
		if (object) {
			packed = (await new Response(
				new Blob([object])
					.stream()
					.pipeThrough(new DecompressionStream("gzip")),
			).json()) as Record<string, string>;
			loadedPacked = true;
			cache = "r2";
		}
	}
	const collected: Record<string, string> = Object.create(null);
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
		for (let start = 0; start < indices.length; start += 64)
			await Promise.all(
				indices.slice(start, start + 64).map(async (index) => {
					const ref = table.rows[index]!;
					const raw =
						packed && Object.hasOwn(packed, ref.digest)
							? packed[ref.digest]
							: undefined;
					if (loadedPacked && raw === undefined)
						throw new Error(
							"Sheet assembly integrity mismatch: row is missing",
						);
					if (raw === undefined) blockGets++;
					const object =
						raw === undefined
							? await get(blockKey(organizationId, ref.digest))
							: undefined;
					if (raw === undefined && !object)
						throw new Error("Sheet row block is missing");
					const bytes =
						raw === undefined
							? await new Response(
									new Blob([object!])
										.stream()
										.pipeThrough(new DecompressionStream("gzip")),
								).arrayBuffer()
							: new TextEncoder().encode(raw);
					if (
						bytes.byteLength !== ref.bytes ||
						(await sha256Hex(bytes)) !== ref.digest
					)
						throw new Error("Sheet row block integrity mismatch");
					const json = new TextDecoder("utf-8", {
						fatal: true,
						ignoreBOM: true,
					}).decode(bytes);
					if (!selection) collected[ref.digest] = json;
					const block = JSON.parse(json) as {
						cells: Record<string, JsonValue>;
						overflow: JsonValue[];
					};
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
	if (!selection) {
		if (!loadedPacked) {
			await bucket.put(
				packedKey!,
				await new Response(
					new Blob([JSON.stringify(collected)])
						.stream()
						.pipeThrough(new CompressionStream("gzip")),
				).arrayBuffer(),
			);
		}
		rememberSheet(bucket, key, content, true);
	}
	report();
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
	const full =
		cachedSheet(bucket, assemblyKey(organizationId, previous)) ??
		(await readSheetBlocks(bucket, organizationId, previous));
	for (const table of tables(full)) {
		const changed = tables(content).find((value) => value.id === table.id)!;
		for (const index of selection.get(table.id) ?? [])
			table.rows[index] = changed.rows[index]!;
	}
	if (full.workbook) Object.assign(full, projectSheet(full.workbook));
	await persistSheet(bucket, organizationId, result, full);
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
