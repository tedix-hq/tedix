/**
 * Tenant-scoped archive contract for retention rows that have left Postgres.
 *
 * The archive source is deliberately storage-neutral: lane 10 owns the R2 /
 * Parquet binding, while this module owns the directory, receipt, cursor, and
 * merge rules every reader must keep after `DROP PARTITION`.
 *
 * Guarantees callers can rely on:
 * - every directory/read call carries an explicit `ownerId` tenant scope;
 * - `readPage` only returns rows for partitions whose receipt verifies;
 * - `removalBlocker` is the gate a partition drop must pass first;
 * - merged readers append archive pages after main/logs pages so the existing
 *   main-first `mergeLogStoreRows` dedupe still wins during archive overlap.
 */

export const LOG_ARCHIVE_FORMAT = "parquet" as const;
export type LogArchiveFormat = typeof LOG_ARCHIVE_FORMAT;

/** One tenant (or the platform sentinel) plus one retention table. */
export interface LogArchiveScope {
	table: string;
	/** Organization id, or `_platform` for rows with no organization owner. */
	ownerId: string;
}

export interface LogArchiveRange {
	/** Inclusive lower bound in the table's partition-column representation. */
	from?: string;
	/** Exclusive upper bound in the table's partition-column representation. */
	to?: string;
}

export interface LogArchiveReceipt {
	id: string;
	partitionId: string;
	table: string;
	ownerId: string;
	/** `YYYY-MM` month the archive covers. */
	month: string;
	objectKey: string;
	format: LogArchiveFormat;
	rowCount: number;
	/** Exporter checksum over the canonical Parquet bytes. */
	checksum: string;
	verifiedAt: string;
}

export interface LogArchivePartition {
	id: string;
	table: string;
	ownerId: string;
	month: string;
	/** Half-open `[from, to)` bounds in the partition column's representation. */
	from: string;
	to: string;
	objectKey: string;
	format: LogArchiveFormat;
	rowCount: number;
	createdAt: string;
	/** Null until the exporter receipt is verified; readers must not see rows. */
	receipt: LogArchiveReceipt | null;
}

export interface LogArchiveReadRequest
	extends LogArchiveScope, LogArchiveRange {
	/** Opaque source cursor; sources must not reinterpret it across owners. */
	cursor?: string;
	/** Optional verified partition ids; when omitted the source reads all matches. */
	partitionIds?: readonly string[];
	limit: number;
	order: "asc" | "desc";
}

export interface LogArchivePage<T = Record<string, unknown>> {
	rows: T[];
	nextCursor?: string;
	hasMore: boolean;
}

export interface LogArchiveSource {
	/** List archive partitions for one tenant/table, verified or not. */
	listPartitions(
		scope: LogArchiveScope,
		range?: LogArchiveRange,
	): Promise<readonly LogArchivePartition[]>;
	/**
	 * Read one page. Implementations MUST apply the same tenant scope, time
	 * range, cursor, and order as the Postgres readers, and MUST NOT return rows
	 * for a partition whose receipt is missing or does not verify.
	 */
	readPage<T = Record<string, unknown>>(
		request: LogArchiveReadRequest,
	): Promise<LogArchivePage<T>>;
	/** Fetch the stored receipt for a partition when the directory lacks it. */
	receipt(partition: LogArchivePartition): Promise<LogArchiveReceipt | null>;
}

export type LogArchiveAuthorizer = (
	scope: LogArchiveScope,
) => void | Promise<void>;

export class LogArchiveAccessError extends Error {
	constructor(scope: LogArchiveScope) {
		super(`Archive access denied for ${scope.table}/${scope.ownerId}`);
		this.name = "LogArchiveAccessError";
	}
}

function requireScope(scope: LogArchiveScope): void {
	if (!scope.table || !scope.ownerId)
		throw new Error("Log archive reads require table and ownerId scope");
}

function sameScope(a: LogArchiveScope, b: LogArchiveScope): boolean {
	return a.table === b.table && a.ownerId === b.ownerId;
}

function receiptMatches(
	partition: LogArchivePartition,
	receipt: LogArchiveReceipt,
): boolean {
	return (
		receipt.id.length > 0 &&
		receipt.partitionId === partition.id &&
		receipt.table === partition.table &&
		receipt.ownerId === partition.ownerId &&
		receipt.month === partition.month &&
		receipt.objectKey === partition.objectKey &&
		receipt.format === partition.format &&
		receipt.rowCount === partition.rowCount &&
		receipt.checksum.length > 0 &&
		Number.isFinite(Date.parse(receipt.verifiedAt))
	);
}

/**
 * The gate a `DROP PARTITION` / source delete must pass. Returns null only for
 * a partition whose verified receipt matches every identity field.
 */
export function logArchiveRemovalBlocker(
	partition: LogArchivePartition,
): string | null {
	if (!partition.receipt) return "missing_archive_receipt";
	if (!receiptMatches(partition, partition.receipt))
		return "archive_receipt_mismatch";
	if (partition.rowCount < 0) return "invalid_archive_row_count";
	return null;
}

/** Verified partitions overlapping a half-open read range. */
export function readableLogArchivePartitions(
	partitions: readonly LogArchivePartition[],
	range: LogArchiveRange = {},
): LogArchivePartition[] {
	return partitions.filter((partition) => {
		if (logArchiveRemovalBlocker(partition) !== null) return false;
		if (range.to && partition.from >= range.to) return false;
		if (range.from && partition.to <= range.from) return false;
		return true;
	});
}

/**
 * Wrap an archive source with tenant authorization and receipt enforcement.
 * `readPage` lists the directory first so an implementation cannot accidentally
 * serve rows for an unverified partition; callers that already listed verified
 * partitions may pass `partitionIds` through `LogArchiveReadRequest`.
 */
export function createTenantLogArchiveReader(
	source: LogArchiveSource,
	authorize: LogArchiveAuthorizer = () => {},
): LogArchiveSource {
	const guard = async (scope: LogArchiveScope) => {
		requireScope(scope);
		try {
			await authorize(scope);
		} catch (error) {
			if (error instanceof LogArchiveAccessError) throw error;
			throw new LogArchiveAccessError(scope);
		}
	};
	return {
		async listPartitions(scope, range) {
			await guard(scope);
			const partitions = await source.listPartitions(scope, range);
			return partitions.filter((partition) => sameScope(partition, scope));
		},
		async readPage<T>(request: LogArchiveReadRequest) {
			await guard({ table: request.table, ownerId: request.ownerId });
			const partitions = (
				await source.listPartitions(request, {
					from: request.from,
					to: request.to,
				})
			).filter((partition) => sameScope(partition, request));
			const verified = readableLogArchivePartitions(partitions, {
				from: request.from,
				to: request.to,
			});
			const requested = request.partitionIds
				? verified.filter((partition) =>
						request.partitionIds!.includes(partition.id),
					)
				: verified;
			if (!requested.length)
				return { rows: [], hasMore: false } satisfies LogArchivePage<T>;
			return source.readPage<T>({
				...request,
				partitionIds: requested.map((partition) => partition.id),
			});
		},
		async receipt(partition) {
			await guard(partition);
			const stored = await source.receipt(partition);
			if (!stored) return null;
			return receiptMatches(partition, stored) ? stored : null;
		},
	};
}
