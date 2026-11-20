/**
 * The organization log store's RPC surface, as the workspace runtime's
 * `InternalEntrypoint` exposes it to the api. Design:
 * `docs/engineering/organization-log-store.md`.
 *
 * Every method takes the organization id first. A runtime without the store
 * binding answers `forward` to appends and `not_live` to reads, so callers
 * keep using the main database for that organization.
 */

import type { GatewayChangeRecordInput } from "@tedix/api-contract/schemas/audit";
import type {
	GatewayChangeRecordCheckpointQuery,
	GatewayChangeRecordCheckpointRow,
	GatewayChangeRecordRangeParams,
} from "../gateway-change-records";

/**
 * - `passthrough`: appends are answered `forward`; the caller writes to main.
 *   Sealed history may be copied in meanwhile.
 * - `cutover`: appends are held unchained for at most minutes, until the
 *   last main rows are copied.
 * - `live`: appends are chained and stored here; reads are served here.
 */
export type OrganizationLogState = "passthrough" | "cutover" | "live";

/** A stored record as a reader gets it, with its seal fields. */
export interface OrganizationLogRecord {
	id: string;
	sequence: number;
	recordedAt: string;
	recordDigest: string | null;
	chainHash: string | null;
	[field: string]: unknown;
}

export type OrganizationLogAppendResult =
	| { status: "forward" }
	| { status: "stored" | "held"; record: OrganizationLogRecord };

export type OrganizationLogRead<T> =
	| { status: "not_live" }
	| { status: "live"; value: T };

export interface OrganizationLogTail {
	sequence: number;
	chainHash: string | null;
	checkpointDigest: string | null;
}

export interface OrganizationLogStatus {
	available: boolean;
	state: OrganizationLogState;
	/** Last record copied or chained here; null before anything arrived. */
	tail: OrganizationLogTail | null;
	pending: number;
	oldestPendingAt: string | null;
	/** When the cutover began; null outside a cutover. */
	cutoverStartedAt: string | null;
}

/** Whole sealed checkpoints from main, with their records, in sequence order. */
export interface OrganizationLogImportPage {
	records: OrganizationLogRecord[];
	checkpoints: GatewayChangeRecordCheckpointRow[];
}

export type OrganizationLogAppendInput = GatewayChangeRecordInput & {
	id: string;
	recordedAt: string;
};

export interface OrganizationLogRuntime {
	/** True when the runtime has the store binding; touches no store. */
	organizationLogAvailable(): Promise<boolean>;
	organizationLogAppend(
		organizationId: string,
		input: OrganizationLogAppendInput,
	): Promise<OrganizationLogAppendResult>;
	organizationLogList(
		organizationId: string,
		query: {
			resource?: string;
			actorId?: string;
			afterSequence?: number;
			limit: number;
		},
	): Promise<OrganizationLogRead<OrganizationLogRecord[]>>;
	organizationLogGet(
		organizationId: string,
		id: string,
	): Promise<OrganizationLogRead<OrganizationLogRecord | null>>;
	organizationLogRange(
		organizationId: string,
		range: GatewayChangeRecordRangeParams,
		page: { afterSequence?: number; limit: number },
	): Promise<
		OrganizationLogRead<{ records: OrganizationLogRecord[]; count: number }>
	>;
	organizationLogCheckpoints(
		organizationId: string,
		query: GatewayChangeRecordCheckpointQuery,
	): Promise<OrganizationLogRead<GatewayChangeRecordCheckpointRow[]>>;
	organizationLogStatus(organizationId: string): Promise<OrganizationLogStatus>;
	organizationLogImport(
		organizationId: string,
		page: OrganizationLogImportPage,
	): Promise<OrganizationLogTail>;
	organizationLogBeginCutover(organizationId: string): Promise<void>;
	organizationLogFinishCutover(
		organizationId: string,
		expected: { sequence: number; chainHash: string | null },
	): Promise<{ chained: number; dropped: number }>;
}
