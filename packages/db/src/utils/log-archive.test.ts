import { describe, expect, it, vi } from "vite-plus/test";
import {
	createTenantLogArchiveReader,
	logArchiveRemovalBlocker,
	readableLogArchivePartitions,
	type LogArchivePage,
	type LogArchivePartition,
	type LogArchiveReadRequest,
	type LogArchiveReceipt,
	type LogArchiveSource,
} from "./log-archive";

const scope = { table: "audit_events", ownerId: "org-1" };

function receipt(partition: LogArchivePartition): LogArchiveReceipt {
	return {
		id: "receipt-1",
		partitionId: partition.id,
		table: partition.table,
		ownerId: partition.ownerId,
		month: partition.month,
		objectKey: partition.objectKey,
		format: partition.format,
		rowCount: partition.rowCount,
		checksum: "sha256:verified",
		verifiedAt: "2026-12-01T00:00:00.000Z",
	};
}

function partition(
	overrides: Partial<LogArchivePartition> = {},
): LogArchivePartition {
	const { receipt: receiptOverride, ...rest } = overrides;
	const base: LogArchivePartition = {
		id: "audit_events_2026_11",
		table: scope.table,
		ownerId: scope.ownerId,
		month: "2026-11",
		from: "2026-11-01",
		to: "2026-12-01",
		objectKey: "archive/org-1/audit_events/2026-11.parquet",
		format: "parquet",
		rowCount: 2,
		createdAt: "2026-12-01T00:00:00.000Z",
		receipt: null,
		...rest,
	};
	return {
		...base,
		receipt: receiptOverride === undefined ? receipt(base) : receiptOverride,
	};
}

function source(partitions: readonly LogArchivePartition[]): LogArchiveSource {
	return {
		listPartitions: vi.fn(async () => partitions),
		readPage: vi.fn(
			async (
				request: LogArchiveReadRequest,
			): Promise<LogArchivePage<Record<string, unknown>>> => ({
				rows: partitions
					.filter(
						(entry) =>
							request.partitionIds?.includes(entry.id) &&
							logArchiveRemovalBlocker(entry) === null,
					)
					.flatMap((entry) =>
						entry.id === "audit_events_2026_11"
							? [{ id: "archived-1" }, { id: "archived-2" }]
							: [],
					),
				hasMore: false,
			}),
		) as LogArchiveSource["readPage"],
		receipt: vi.fn(async (entry: LogArchivePartition) => entry.receipt),
	};
}

describe("tenant log archive contract", () => {
	it("gates partition removal on a verified matching receipt", () => {
		const verified = partition();
		expect(logArchiveRemovalBlocker(verified)).toBeNull();
		expect(logArchiveRemovalBlocker(partition({ receipt: null }))).toBe(
			"missing_archive_receipt",
		);
		const mismatched = partition();
		mismatched.receipt = { ...receipt(mismatched), rowCount: 3 };
		expect(logArchiveRemovalBlocker(mismatched)).toBe(
			"archive_receipt_mismatch",
		);
	});

	it("reads only verified partitions under tenant scope and cursor", async () => {
		const verified = partition();
		const unverified = partition({
			id: "audit_events_2026_12",
			month: "2026-12",
			from: "2026-12-01",
			to: "2027-01-01",
			receipt: null,
		});
		const otherTenant = partition({
			id: "audit_events_2026_11_org2",
			ownerId: "org-2",
		});
		const raw = source([verified, unverified, otherTenant]);
		const authorize = vi.fn();
		const reader = createTenantLogArchiveReader(raw, authorize);
		const page = await reader.readPage({
			...scope,
			cursor: "cursor-1",
			limit: 10,
			order: "asc",
			from: "2026-11-01",
			to: "2027-01-01",
		});
		expect(authorize).toHaveBeenCalledWith(scope);
		expect(page.rows).toEqual([{ id: "archived-1" }, { id: "archived-2" }]);
		expect(raw.readPage).toHaveBeenCalledWith(
			expect.objectContaining({
				cursor: "cursor-1",
				partitionIds: ["audit_events_2026_11"],
			}),
		);
	});

	it("rejects reads without tenant scope or when authorization fails", async () => {
		const raw = source([partition()]);
		const reader = createTenantLogArchiveReader(raw, () => {
			throw new Error("denied");
		});
		await expect(
			reader.readPage({ ...scope, limit: 1, order: "asc" }),
		).rejects.toMatchObject({ name: "LogArchiveAccessError" });
		await expect(
			reader.listPartitions({ table: scope.table, ownerId: "" }),
		).rejects.toThrow("require table and ownerId");
	});

	it("filters readable partitions by half-open range overlap", () => {
		const partitions = [
			partition(),
			partition({
				id: "audit_events_2026_12",
				month: "2026-12",
				from: "2026-12-01",
				to: "2027-01-01",
			}),
			partition({ receipt: null }),
		];
		expect(
			readableLogArchivePartitions(partitions, {
				from: "2026-12-01",
				to: "2026-12-15",
			}).map((entry) => entry.id),
		).toEqual(["audit_events_2026_12"]);
	});
});
