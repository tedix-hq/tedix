import type { GatewayChangeRecordInput } from "@tedix/api-contract/schemas/audit";

/**
 * The organization log store's RPC surface, as the workspace runtime's
 * `InternalEntrypoint` exposes it to the api. Design:
 * `docs/engineering/organization-log-store.md`.
 *
 * Every method takes the organization id first. The store is the only place
 * an organization's change records live: a runtime without the store binding
 * answers `forward` to appends and `not_live` to reads, and callers fail.
 */

export interface GatewayChangeRecordRangeParams {
	/** Inclusive start, as `Date.prototype.toISOString()` writes it. */
	from: string;
	/** Exclusive end, in the same form. */
	until: string;
	resource?: string;
	actorId?: string;
	/** Only records whose `subject.id` is this Work Item id. */
	subjectId?: string;
}

export interface GatewayChangeRecordCheckpointQuery {
	/** Checkpoints whose range ends at or after this sequence. */
	fromSequence?: number;
	/** Checkpoints whose range starts at or before this sequence. */
	untilSequence?: number;
	/** Checkpoints sealed at or after this ISO timestamp. */
	sealedFrom?: string;
	/** Checkpoints sealed before this ISO timestamp. */
	sealedUntil?: string;
	/** Page cursor: checkpoints ending after this sequence. */
	afterLastSequence?: number;
	limit: number;
}

/**
 * One signed (or, without a signing key, unsigned) checkpoint over a run of
 * an organization's records. `envelope` is the DSSE envelope JSON, null when
 * unsigned; `evidenceBundleKey` is the R2 key of its evidence bundle.
 */
export interface GatewayChangeRecordCheckpointRow {
	id: string;
	organizationId: string;
	firstSequence: number;
	lastSequence: number;
	recordCount: number;
	headChainHash: string;
	previousCheckpointDigest: string | null;
	/** Chain hash of the record before `firstSequence`; null at genesis. */
	previousChainHash: string | null;
	/** Payload digest; the next checkpoint's `previousCheckpointDigest`. */
	checkpointDigest: string;
	sealedAt: string;
	envelope: string | null;
	keyId: string | null;
	evidenceBundleKey: string | null;
}

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
	| { status: "stored"; record: OrganizationLogRecord };

export type OrganizationLogRead<T> =
	| { status: "not_live" }
	| { status: "live"; value: T };

export type OrganizationLogAppendInput = GatewayChangeRecordInput & {
	id: string;
	recordedAt: string;
};

export interface OrganizationLogRuntime {
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
}
