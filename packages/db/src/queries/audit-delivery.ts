import type { DbQueryClient } from "../query-client";
import { and, asc, eq, sql } from "drizzle-orm";
import {
	configureLogStore,
	createDbClient,
	getLogStores,
	type DbClient,
} from "../client";
import { coreTable, postgresClientView } from "../core-store/client";
import { anyIds, coreStore } from "../core-store/dialect";
import { auditDeliveryOutbox, auditEvents } from "../schema/audit-events";
import { chunkForBoundParams } from "../utils/batch";
import { readLogStores, type ReadLogStoresOptions } from "../utils/log-store";
import { auditDeliveryBindings } from "./audit-delivery-context";
import type {
	OrganizationAuditEvent,
	OrganizationAuditRuntime,
} from "./durable-sqlite/organization-log-rpc";

const reading = new WeakSet<object>();
const pending = new WeakSet<object>();

export function auditWriteTable(db: object): typeof auditEvents {
	return auditDeliveryBindings(db)
		? (coreTable(db, auditDeliveryOutbox) as unknown as typeof auditEvents)
		: coreTable(db, auditEvents);
}

export function auditReadTable(db: object): typeof auditEvents {
	return pending.has(db)
		? (coreTable(db, auditDeliveryOutbox) as unknown as typeof auditEvents)
		: coreTable(db, auditEvents);
}

/** Exclude delivery bookkeeping from audit reader rows. */
export function auditReadColumns(db: object) {
	const {
		id,
		organizationId,
		actorId,
		actorType,
		action,
		resourceType,
		resourceId,
		metadata,
		ipAddress,
		userAgent,
		timestamp,
		traceId,
	} = auditReadTable(db);
	return {
		id,
		organizationId,
		actorId,
		actorType,
		action,
		resourceType,
		resourceId,
		metadata,
		ipAddress,
		userAgent,
		timestamp,
		traceId: traceId ?? sql<string | null>`NULL`.as("trace_id"),
	};
}

/** Existing historical stores plus pending delivery, visible before the next drain. */
export async function readAuditStores<T>(
	db: object,
	read: (store: DbClient) => Promise<T>,
	options: ReadLogStoresOptions = {},
): Promise<T[] | null> {
	if (reading.has(db)) return null;
	const bindings = auditDeliveryBindings(db);
	let queued: T[] = [];
	if (bindings && coreStore(db) === "d1") {
		configureLogStore(db as DbClient, bindings);
		const outbox = createDbClient((db as DbClient).$client);
		reading.add(outbox);
		pending.add(outbox);
		// Read pending first: delivery may remove it after writing the projection.
		queued = [await read(outbox)];
	} else if (coreStore(db) === "postgres") {
		// Rows still queued at the switch were copied into the Postgres outbox.
		const outbox = postgresClientView(db as DbClient);
		reading.add(outbox);
		pending.add(outbox);
		queued = [await read(outbox)];
	}
	const pages = await readLogStores(
		db,
		(store) => {
			reading.add(store);
			return read(store);
		},
		options,
	);
	if (!queued.length) return pages;
	if (pages) return [...pages, ...queued];
	const main =
		coreStore(db) === "postgres"
			? postgresClientView(db as DbClient)
			: createDbClient((db as DbClient).$client);
	reading.add(main);
	return [await read(main), ...queued];
}

export async function readAuditEventById(
	db: DbQueryClient,
	organizationId: string,
	id: string,
) {
	const read = async (store: DbQueryClient) => {
		const table = auditReadTable(store);
		return store
			.select(auditReadColumns(store))
			.from(table)
			.where(and(eq(table.organizationId, organizationId), eq(table.id, id)))
			.limit(1);
	};
	const pages = await readAuditStores(db, read);
	return pages ? pages.flat()[0] : (await read(db))[0];
}

function transport(
	row: typeof auditEvents.$inferSelect,
): OrganizationAuditEvent {
	return {
		id: row.id,
		organizationId: row.organizationId,
		actorId: row.actorId,
		actorType: row.actorType,
		action: row.action,
		resourceType: row.resourceType,
		resourceId: row.resourceId,
		metadata: row.metadata,
		ipAddress: row.ipAddress,
		userAgent: row.userAgent,
		timestamp: Math.floor(row.timestamp.getTime() / 1000),
	};
}

/** Confirm both the organization's record and the existing read projection before deleting. */
export async function drainAuditDeliveryOutbox(
	db: DbClient,
	bindings: object,
): Promise<number> {
	const store = coreStore(db);
	if (store !== "d1" && store !== "postgres") return 0;
	// The Postgres main handle must stay a client view, not a D1 wrapper of $client.
	configureLogStore(
		db,
		bindings,
		[],
		store === "postgres" ? postgresClientView(db) : undefined,
	);
	const logs = getLogStores(db)?.logs;
	const runtime = (bindings as { WORKSPACE_RUNTIME?: OrganizationAuditRuntime })
		.WORKSPACE_RUNTIME;
	const outbox = coreTable(db, auditDeliveryOutbox);
	// IDs include deterministic receipts; on D1 rowid order keeps new UUIDs from
	// starving them. Postgres has no rowid, so oldest event time drains first.
	const rows = await db
		.select()
		.from(outbox)
		.orderBy(
			...(store === "postgres"
				? [asc(outbox.timestamp), asc(outbox.id)]
				: [sql`rowid`]),
		)
		.limit(500);
	if (!rows.length) return 0;
	if (!logs || !runtime)
		throw new Error("Audit delivery stores are unavailable");
	const ids = rows.map((row) => row.id);
	const existing = await logs
		.select()
		.from(auditEvents)
		.where(anyIds(logs, auditEvents.id, ids));
	const byId = new Map(existing.map((row) => [row.id, row]));
	const groups = new Map<string, typeof rows>();
	for (const row of rows) {
		const group = groups.get(row.organizationId) ?? [];
		group.push(row);
		groups.set(row.organizationId, group);
	}
	let delivered = 0;
	const failures: unknown[] = [];
	for (const [organizationId, events] of groups) {
		try {
			const expected = events.map((row) => {
				const prior = byId.get(row.id);
				if (
					prior &&
					(prior.organizationId !== organizationId ||
						(!row.ignoreDuplicates &&
							JSON.stringify(transport(prior)) !==
								JSON.stringify(transport(row))))
				)
					throw new Error(`Audit projection mismatch: ${row.id}`);
				return transport(prior ?? row);
			});
			const ignored = events
				.filter((row) => row.ignoreDuplicates)
				.map((row) => row.id);
			const receipt = await runtime.organizationAuditAppend(
				organizationId,
				expected,
				ignored,
			);
			if (receipt.status !== "live" || receipt.value.length !== events.length)
				throw new Error(
					`Organization audit delivery mismatch: ${organizationId}`,
				);
			for (const [index, saved] of receipt.value.entries()) {
				const input = expected[index]!;
				if (
					saved.id !== input.id ||
					saved.organizationId !== organizationId ||
					(!ignored.includes(saved.id) &&
						JSON.stringify(saved) !== JSON.stringify(input))
				)
					throw new Error(`Organization audit delivery mismatch: ${input.id}`);
			}
			const [first, ...rest] = chunkForBoundParams(receipt.value, 8).map(
				(chunk) =>
					logs
						.insert(auditEvents)
						.values(
							chunk.map((row) => ({
								...row,
								timestamp: new Date(row.timestamp * 1000),
							})),
						)
						.onConflictDoNothing(),
			);
			if (first) await logs.batch([first, ...rest]);
			const eventIds = events.map((row) => row.id);
			const copied = await logs
				.select()
				.from(auditEvents)
				.where(anyIds(logs, auditEvents.id, eventIds));
			const projected = new Map(copied.map((row) => [row.id, transport(row)]));
			for (const saved of receipt.value) {
				if (JSON.stringify(projected.get(saved.id)) !== JSON.stringify(saved))
					throw new Error(`Audit projection mismatch: ${saved.id}`);
			}
			await db.delete(outbox).where(anyIds(db, outbox.id, eventIds));
			delivered += events.length;
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length)
		throw new AggregateError(failures, "Audit delivery remains pending");
	return delivered;
}
