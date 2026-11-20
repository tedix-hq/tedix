/**
 * The gateway change ledger, read and written through the organization's log
 * store (`docs/engineering/organization-log-store.md`). A store answers
 * `forward` / `not_live` until its organization has moved to it; those calls
 * use the main database as before. After the move, the store is the only
 * place new records go and the only place they are read from.
 */

import { env } from "cloudflare:workers";
import type { GatewayChangeRecordInput } from "@tedix/api-contract/schemas/audit";
import type {
	OrganizationLogRecord,
	OrganizationLogRuntime,
} from "@tedix/db/queries/durable-sqlite/organization-log-rpc";
import {
	appendGatewayChangeRecord,
	countGatewayChangeRecordsInRange,
	type GatewayChangeRecordCheckpointQuery,
	type GatewayChangeRecordRangeParams,
	getGatewayChangeRecord,
	listGatewayChangeRecordCheckpoints,
	listGatewayChangeRecords,
	listGatewayChangeRecordsInRange,
} from "@tedix/db/queries/gateway-change-records";
import type { DbQueryClient } from "@tedix/db/query-client";

/** The workspace runtime's entrypoint, which fronts every organization's store. */
export function organizationLogRuntime(
	bindings: object = env,
): OrganizationLogRuntime | undefined {
	return (bindings as { WORKSPACE_RUNTIME?: OrganizationLogRuntime })
		.WORKSPACE_RUNTIME;
}

/**
 * Call the store; undefined when the runtime is absent or is a release that
 * does not have the store methods yet (it is deployed separately). Any other
 * failure is thrown.
 */
export async function callOrganizationLog<T>(
	call: (log: OrganizationLogRuntime) => Promise<T>,
	bindings: object = env,
): Promise<T | undefined> {
	const log = organizationLogRuntime(bindings);
	if (!log) return undefined;
	try {
		return await call(log);
	} catch (error) {
		if (
			error instanceof Error &&
			/does not implement the method|is not a function/i.test(error.message)
		)
			return undefined;
		throw error;
	}
}

/** A stored record: the same shape the main database returns. */
type ChangeRecord = NonNullable<
	Awaited<ReturnType<typeof getGatewayChangeRecord>>
>;
type SealedChangeRecord = Awaited<
	ReturnType<typeof listGatewayChangeRecordsInRange>
>[number];

/** A record without its seal fields, as the gateway-facing reads return it. */
function unsealed(record: OrganizationLogRecord): ChangeRecord {
	const { recordDigest: _digest, chainHash: _chain, ...rest } = record;
	return rest as unknown as ChangeRecord;
}

/**
 * Append one record for the organization. The id and time are fixed here,
 * so a record forwarded to the main database keeps them.
 */
export async function appendChangeRecord(
	db: DbQueryClient,
	organizationId: string,
	input: GatewayChangeRecordInput,
) {
	const record = {
		...input,
		id: input.id ?? crypto.randomUUID(),
		recordedAt: input.recordedAt ?? new Date().toISOString(),
	};
	const result = await callOrganizationLog((log) =>
		log.organizationLogAppend(organizationId, record),
	);
	if (result && result.status !== "forward") return unsealed(result.record);
	return appendGatewayChangeRecord(db, organizationId, record);
}

export async function listChangeRecords(
	db: DbQueryClient,
	organizationId: string,
	query: Parameters<typeof listGatewayChangeRecords>[2],
) {
	const read = await callOrganizationLog((log) =>
		log.organizationLogList(organizationId, {
			...query,
			limit: query.limit ?? 1000,
		}),
	);
	if (read?.status === "live") return read.value.map(unsealed);
	return listGatewayChangeRecords(db, organizationId, query);
}

export async function getChangeRecord(
	db: DbQueryClient,
	organizationId: string,
	id: string,
) {
	const read = await callOrganizationLog((log) =>
		log.organizationLogGet(organizationId, id),
	);
	if (read?.status === "live") return read.value ? unsealed(read.value) : null;
	return getGatewayChangeRecord(db, organizationId, id);
}

/** One page of a time range plus the count of the whole range. */
export async function readChangeRecordRange(
	db: DbQueryClient,
	organizationId: string,
	range: GatewayChangeRecordRangeParams,
	page: { afterSequence?: number; limit: number },
) {
	const read = await callOrganizationLog((log) =>
		log.organizationLogRange(organizationId, range, page),
	);
	if (read?.status === "live")
		return {
			count: read.value.count,
			records: read.value.records as unknown as SealedChangeRecord[],
		};
	const [count, records] = await Promise.all([
		countGatewayChangeRecordsInRange(db, organizationId, range),
		listGatewayChangeRecordsInRange(db, organizationId, range, page),
	]);
	return { count, records };
}

export async function listChangeRecordCheckpoints(
	db: DbQueryClient,
	organizationId: string,
	query: GatewayChangeRecordCheckpointQuery,
) {
	const read = await callOrganizationLog((log) =>
		log.organizationLogCheckpoints(organizationId, query),
	);
	if (read?.status === "live") return read.value;
	return listGatewayChangeRecordCheckpoints(db, organizationId, query);
}
