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

export type RunMode = "idle" | "running" | "paused" | "delta";
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
const INSERT_ONLY_KEY = "core-copy:insert-only";
export const tableKey = (table: string) => `core-copy:table:${table}`;
/** One key per page receipt, so no stored value grows with the table. */
export const receiptKey = (table: string, index: number) =>
	`core-copy:receipt:${table}:${index}`;

const DELTA_RUN_KEY = "core-copy:delta-run";
const deltaKey = (table: string) => `core-copy:delta:${table}`;

export interface DeltaRun {
	/** Rows changed on or after this value are copied again (text compares by prefix). */
	since: string;
	/** Rows created on or after this are recopied where a table has no updated_at. */
	recentSince: string;
	startedAt: string;
}
export interface DeltaPhase {
	kind: "new" | "updated" | "full" | "recent";
	after: number;
	through: number;
	column?: string;
	from?: string | number;
}
export interface DeltaProgress {
	table: string;
	status: "pending" | "running" | "done" | "error" | "skipped";
	phases: DeltaPhase[];
	phase: number;
	state?: CopyState;
	pages: number;
	lastError?: string;
	updatedAt: string;
}

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
	/**
	 * Insert-only mode, for copying after the switch to Postgres: "all", a
	 * list of tables, or off (empty). Rows already in Postgres are kept.
	 */
	async insertOnly(table: string): Promise<boolean> {
		const raw = (await this.kv.get(INSERT_ONLY_KEY)) || "";
		if (!raw) return false;
		const value = JSON.parse(raw) as "all" | string[];
		return value === "all" || value.includes(table);
	}
	async setInsertOnly(value: "all" | string[] | null): Promise<void> {
		await this.kv.put(INSERT_ONLY_KEY, value ? JSON.stringify(value) : "");
	}
	async insertOnlySetting(): Promise<"all" | string[] | null> {
		const raw = (await this.kv.get(INSERT_ONLY_KEY)) || "";
		return raw ? (JSON.parse(raw) as "all" | string[]) : null;
	}
	/** The final delta run, set when the write freeze starts. */
	async deltaRun(): Promise<DeltaRun | undefined> {
		const raw = await this.kv.get(DELTA_RUN_KEY);
		return raw ? (JSON.parse(raw) as DeltaRun) : undefined;
	}
	async setDeltaRun(run: DeltaRun): Promise<void> {
		await this.kv.put(DELTA_RUN_KEY, JSON.stringify(run));
	}
	async deltaProgress(table: string): Promise<DeltaProgress | undefined> {
		const raw = await this.kv.get(deltaKey(table));
		return raw ? (JSON.parse(raw) as DeltaProgress) : undefined;
	}
	async clearDeltaProgress(table: string): Promise<void> {
		await this.kv.put(deltaKey(table), "");
	}
	async putDeltaProgress(progress: DeltaProgress): Promise<void> {
		await this.kv.put(deltaKey(progress.table), JSON.stringify(progress));
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
