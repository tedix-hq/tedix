import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
import type { CopyState } from "../../../scripts/db/core-copy.ts";

/** Minimal key-value surface so tests can run the whole Worker logic in bun. */
export interface CheckpointStore {
	get(key: string): Promise<string | null>;
	put(key: string, value: string): Promise<void>;
}

interface CheckpointStub {
	get(key: string): Promise<string | null>;
	put(key: string, value: string): Promise<void>;
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
	pages: number;
	state?: CopyState;
	lastError?: string;
	updatedAt: string;
}

const RUN_KEY = "core-copy:run";
export const tableKey = (table: string) => `core-copy:table:${table}`;

export class ProgressStore {
	constructor(private readonly kv: CheckpointStore) {}

	async runState(): Promise<RunState> {
		const raw = await this.kv.get(RUN_KEY);
		if (!raw) return { mode: "idle", updatedAt: new Date(0).toISOString() };
		return JSON.parse(raw) as RunState;
	}
	async setRunState(state: RunState): Promise<void> {
		await this.kv.put(RUN_KEY, JSON.stringify(state));
	}
	async tableProgress(table: string): Promise<TableProgress | undefined> {
		const raw = await this.kv.get(tableKey(table));
		return raw ? (JSON.parse(raw) as TableProgress) : undefined;
	}
	async putTableProgress(progress: TableProgress): Promise<void> {
		await this.kv.put(tableKey(progress.table), JSON.stringify(progress));
	}
}
