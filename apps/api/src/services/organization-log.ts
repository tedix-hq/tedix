/**
 * The gateway change ledger, read and written through the organization's log
 * store (`docs/engineering/organization-log-store.md`). The store is the only
 * place records are written and read: a store that cannot answer, or that is
 * not live, fails the call. There is no other copy to fall back to.
 */

import { env } from "cloudflare:workers";
import type {
	GatewayChangeRecord,
	GatewayChangeRecordInput,
} from "@tedix/api-contract/schemas/audit";
import type {
	GatewayChangeRecordCheckpointQuery,
	GatewayChangeRecordRangeParams,
	OrganizationLogRead,
	OrganizationLogRecord,
	OrganizationLogRuntime,
} from "@tedix/db/queries/durable-sqlite/organization-log-rpc";

/** The workspace runtime's entrypoint, which fronts every organization's store. */
export function organizationLogRuntime(
	bindings: object = env,
): OrganizationLogRuntime | undefined {
	return (bindings as { WORKSPACE_RUNTIME?: OrganizationLogRuntime })
		.WORKSPACE_RUNTIME;
}

/**
 * Call the store. A missing runtime, or a release without the store methods
 * (it is deployed separately), throws: nothing is written anywhere else.
 */
async function callOrganizationLog<T>(
	call: (log: OrganizationLogRuntime) => Promise<T>,
): Promise<T> {
	const log = organizationLogRuntime();
	if (!log) throw new Error("The organization log store is unreachable");
	try {
		return await call(log);
	} catch (error) {
		if (
			error instanceof Error &&
			/does not implement the method|is not a function/i.test(error.message)
		)
			throw new Error("The organization log store is unreachable", {
				cause: error,
			});
		throw error;
	}
}

async function readLive<T>(
	call: (log: OrganizationLogRuntime) => Promise<OrganizationLogRead<T>>,
): Promise<T> {
	const read = await callOrganizationLog(call);
	if (read.status !== "live")
		throw new Error("The organization log store is not live");
	return read.value;
}

/** A record with its seal fields, as the store returns it. */
type SealedChangeRecord = GatewayChangeRecord & {
	recordDigest: string | null;
	chainHash: string | null;
};

/** A record without its seal fields, as the gateway-facing reads return it. */
function unsealed(record: OrganizationLogRecord): GatewayChangeRecord {
	const { recordDigest: _digest, chainHash: _chain, ...rest } = record;
	return rest as unknown as GatewayChangeRecord;
}

/** Append one record for the organization. The id and time are fixed here. */
export async function appendChangeRecord(
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
	if (result.status !== "stored")
		throw new Error("The organization log store is not live");
	return unsealed(result.record);
}

export async function listChangeRecords(
	organizationId: string,
	query: {
		resource?: string;
		actorId?: string;
		afterSequence?: number;
		limit?: number;
	},
) {
	const records = await readLive((log) =>
		log.organizationLogList(organizationId, {
			...query,
			limit: query.limit ?? 1000,
		}),
	);
	return records.map(unsealed);
}

export async function getChangeRecord(organizationId: string, id: string) {
	const record = await readLive((log) =>
		log.organizationLogGet(organizationId, id),
	);
	return record ? unsealed(record) : null;
}

/** One page of a time range plus the count of the whole range. */
export async function readChangeRecordRange(
	organizationId: string,
	range: GatewayChangeRecordRangeParams,
	page: { afterSequence?: number; limit: number },
) {
	const { count, records } = await readLive((log) =>
		log.organizationLogRange(organizationId, range, page),
	);
	return { count, records: records as unknown as SealedChangeRecord[] };
}

export function listChangeRecordCheckpoints(
	organizationId: string,
	query: GatewayChangeRecordCheckpointQuery,
) {
	return readLive((log) =>
		log.organizationLogCheckpoints(organizationId, query),
	);
}
