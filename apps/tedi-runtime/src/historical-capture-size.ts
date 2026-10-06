import {
	decryptTediSecret,
	encryptTediSecret,
} from "@tedix/db/utils/secrets-encryption";
import { z } from "zod";
import {
	HISTORICAL_CAPTURE_SELECTORS,
	historicalCaptureItemBytes,
	historicalCaptureSelectorVersion,
} from "./historical-liability-custody";
import type { TediRuntimeCaptureSizeResponse } from "@tedix/api-contract/schemas/tedi";

const MAX_PAGE_ENTRIES = 32;
const PURPOSE = "tedix:historical-capture-size:v1";
const CursorSchema = z.strictObject({
	purpose: z.literal(PURPOSE),
	objectId: z.string(),
	tediId: z.string().uuid(),
	orgId: z.string().uuid(),
	objectName: z.string(),
	generation: z.number().int().nonnegative().safe(),
	selectorVersion: z.string(),
	position: z.number().int().nonnegative().safe(),
	startAfter: z.string().optional(),
});
type Cursor = z.infer<typeof CursorSchema>;
export interface CaptureSizeIdentity {
	objectId: string;
	tediId: string;
	orgId: string;
	objectName: string;
	generation: number;
}
function reject(): never {
	throw new Error("Capture size diagnostic unavailable");
}
function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		reject();
	return value;
}
function quote(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}
// Normalize overlapping selectors without reading any values or maintaining a second whitelist.
const prefixes = [...HISTORICAL_CAPTURE_SELECTORS.kvPrefixes]
	.sort()
	.filter(
		(prefix, _, all) =>
			!all.some((other) => other !== prefix && prefix.startsWith(other)),
	);
const keys = HISTORICAL_CAPTURE_SELECTORS.kvKeys.filter(
	(key) => !prefixes.some((prefix) => key.startsWith(prefix)),
);
const positions = keys.length + prefixes.length;
export function captureSqlSizes(
	storage: Pick<DurableObjectStorage, "sql">,
): TediRuntimeCaptureSizeResponse["sql"] {
	const names = new Set(
		storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table'",
			)
			.toArray()
			.map((row) => row.name),
	);
	const tables = [
		...HISTORICAL_CAPTURE_SELECTORS.factTables.map((table, selector) => ({
			table,
			selector,
			category: "fact" as const,
		})),
		...HISTORICAL_CAPTURE_SELECTORS.historyTables.map((table, selector) => ({
			table,
			selector,
			category: "history" as const,
		})),
		...HISTORICAL_CAPTURE_SELECTORS.sdkTables.map((table, selector) => ({
			table,
			selector,
			category: "sdk" as const,
		})),
	];
	return tables.map(({ table, selector, category }) => {
		if (!names.has(table))
			return {
				selector,
				category,
				present: false,
				rows: 0,
				castValueBytes: 0,
				maxRowCastValueBytes: 0,
			};
		const columns = storage.sql
			.exec<{ name: string }>(`PRAGMA table_info(${quote(table)})`)
			.toArray();
		if (
			!columns.length ||
			columns.some((column) => typeof column.name !== "string")
		)
			reject();
		const rowBytes = columns
			.map(
				(column) => `COALESCE(length(CAST(${quote(column.name)} AS BLOB)),0)`,
			)
			.join("+");
		const row = storage.sql
			.exec<{ rows: number; total: number; largest: number }>(
				`SELECT COUNT(*) AS rows,COALESCE(SUM(${rowBytes}),0) AS total,COALESCE(MAX(${rowBytes}),0) AS largest FROM ${quote(table)}`,
			)
			.toArray()[0];
		if (!row) reject();
		return {
			selector,
			category,
			present: true,
			rows: count(row.rows),
			castValueBytes: count(row.total),
			maxRowCastValueBytes: count(row.largest),
		};
	});
}
/** Every KV list hydrates at most one selected value. No private key escapes this module. */
function readItem(storage: Pick<DurableObjectStorage, "kv">, cursor: Cursor) {
	let position = cursor.position;
	let startAfter = cursor.startAfter;
	while (position < positions) {
		if (position < keys.length) {
			if (startAfter !== undefined) reject();
			const key = keys[position]!;
			position++;
			// A bounded exact-key range distinguishes absent keys from stored undefined.
			for (const [storedKey, value] of storage.kv.list({
				prefix: key,
				start: key,
				end: key + "\0",
				limit: 1,
			})) {
				if (storedKey !== key) reject();
				return {
					bytes: historicalCaptureItemBytes([key, value]),
					position,
					startAfter: undefined,
				};
			}
		} else {
			const prefix = prefixes[position - keys.length]!;
			if (startAfter !== undefined && !startAfter.startsWith(prefix)) reject();
			for (const [key, value] of storage.kv.list({
				prefix,
				limit: 1,
				...(startAfter === undefined ? {} : { startAfter }),
			})) {
				if (
					!key.startsWith(prefix) ||
					(startAfter !== undefined && key === startAfter)
				)
					reject();
				return {
					bytes: historicalCaptureItemBytes([key, value]),
					position,
					startAfter: key,
				};
			}
			position++;
			startAfter = undefined;
		}
	}
	return { bytes: null, position, startAfter: undefined };
}
export async function inspectHistoricalCaptureSize(input: {
	storage: Pick<DurableObjectStorage, "sql" | "kv">;
	identity: CaptureSizeIdentity;
	masterKey: string;
	continuation?: string;
	recheck: () => void;
}): Promise<
	Pick<
		TediRuntimeCaptureSizeResponse,
		"sql" | "kv" | "selectorVersion" | "complete" | "continuation"
	>
> {
	const selectorVersion = historicalCaptureSelectorVersion();
	const expected = {
		...input.identity,
		purpose: PURPOSE as typeof PURPOSE,
		selectorVersion,
	};
	let cursor: Cursor = { ...expected, position: 0 };
	if (input.continuation !== undefined) {
		const plaintext = await decryptTediSecret(
			input.masterKey,
			input.identity.tediId,
			input.continuation,
		);
		input.recheck();
		cursor = CursorSchema.parse(JSON.parse(plaintext));
		for (const key of Object.keys(expected) as Array<keyof typeof expected>)
			if (cursor[key] !== expected[key]) reject();
		if (cursor.position >= positions) reject();
	}
	input.recheck();
	const sql =
		input.continuation === undefined ? captureSqlSizes(input.storage) : [];
	let entries = 0;
	let canonicalItemBytes = 0;
	let position = cursor.position;
	let startAfter = cursor.startAfter;
	// readItem returns only scalars: the selected private value and iterator are
	// out of scope before the next native limit-1 read.
	while (entries < MAX_PAGE_ENTRIES && position < positions) {
		const item = readItem(input.storage, { ...cursor, position, startAfter });
		position = item.position;
		startAfter = item.startAfter;
		if (item.bytes === null) break;
		entries++;
		canonicalItemBytes = count(canonicalItemBytes + item.bytes);
	}
	const complete = position >= positions;
	const result = {
		sql,
		kv: {
			entries,
			canonicalItemBytes,
		},
		selectorVersion,
		complete,
	};
	if (complete) return result;
	const continuation = await encryptTediSecret(
		input.masterKey,
		input.identity.tediId,
		JSON.stringify({
			...expected,
			position,
			...(startAfter === undefined ? {} : { startAfter }),
		}),
	);
	input.recheck();
	return { ...result, continuation };
}
