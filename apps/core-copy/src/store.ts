import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
import type { CopyReceipt, CopyState } from "../../../scripts/db/core-copy.ts";

/** Minimal key-value surface so tests can run the whole Worker logic in bun. */
export interface CheckpointStore {
	get(key: string): Promise<string | null>;
	put(key: string, value: string): Promise<void>;
	clear?(): Promise<void>;
}

interface CheckpointStub {
	get(key: string): Promise<string | null>;
	put(key: string, value: string): Promise<void>;
	clear(): Promise<void>;
}

/**
 * One named CheckpointDO holds every checkpoint and progress document. The
 * object is created by this Worker on first use, so the binding needs no
 * overlay-supplied id.
 */
export function doCheckpointStore(
	namespace: DurableObjectNamespace,
	env: unknown,
): CheckpointStore {
	const stub = durableObjectStubByName(
		namespace,
		env,
		"core-copy",
	) as unknown as CheckpointStub;
	return {
		get: (key) => stub.get(key),
		put: async (key, value) => {
			await stub.put(key, value);
		},
		clear: () => stub.clear(),
	};
}

export type RunMode = "idle" | "running" | "paused";
export interface RunState {
	mode: RunMode;
	note?: string;
	updatedAt: string;
}
export type TableStatus =
	| "pending"
	| "running"
	| "paused"
	| "done"
	| "verified"
	| "error";
export interface TableProgress {
	table: string;
	status: TableStatus;
	/** rowid upper bound captured when the copy window opened. */
	highWater?: number;
	/** First rowid read when a hot window skips older rows. */
	startRowid?: number;
	pages: number;
	/** Rows per page; fixed for the table once its copy starts. */
	pageSize?: number;
	state?: CopyState;
	lastError?: string;
	updatedAt: string;
}

const RUN_KEY = "core-copy:run";
const LEASE_KEY = "core-copy:lease";
export const tableKey = (table: string) => `core-copy:table:${table}`;
/** One key per page receipt, so no stored value grows with the table. */
export const receiptKey = (table: string, index: number) =>
	`core-copy:receipt:${table}:${index}`;

export class ProgressStore {
	constructor(private readonly kv: CheckpointStore) {}

	async clearAll(): Promise<void> {
		if (!this.kv.clear) throw new Error("Checkpoint store cannot be cleared");
		await this.kv.clear();
	}
	async runState(): Promise<RunState> {
		const raw = await this.kv.get(RUN_KEY);
		if (!raw) return { mode: "idle", updatedAt: new Date(0).toISOString() };
		return JSON.parse(raw) as RunState;
	}
	async setRunState(state: RunState): Promise<void> {
		await this.kv.put(RUN_KEY, JSON.stringify(state));
	}
	/** ISO time until which a cron tick holds the copy, or undefined. */
	async leaseUntil(): Promise<string | undefined> {
		return (await this.kv.get(LEASE_KEY)) || undefined;
	}
	async setLease(until: string | undefined): Promise<void> {
		await this.kv.put(LEASE_KEY, until ?? "");
	}
	async tableProgress(table: string): Promise<TableProgress | undefined> {
		const raw = await this.kv.get(tableKey(table));
		return raw ? (JSON.parse(raw) as TableProgress) : undefined;
	}
	async putTableProgress(progress: TableProgress): Promise<void> {
		await this.kv.put(tableKey(progress.table), JSON.stringify(progress));
	}
	async receipt(
		table: string,
		index: number,
	): Promise<CopyReceipt | undefined> {
		const raw = await this.kv.get(receiptKey(table, index));
		return raw ? (JSON.parse(raw) as CopyReceipt) : undefined;
	}
	async putReceipt(
		table: string,
		index: number,
		receipt: CopyReceipt,
	): Promise<void> {
		await this.kv.put(receiptKey(table, index), JSON.stringify(receipt));
	}
}
