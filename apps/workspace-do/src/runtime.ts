/**
 * The interface the workspace object codes against. It mirrors the contract
 * agreed for `@tedix/workspace-runtime` (storage, sandbox.run,
 * bindings.describe, events, alarms); this app swaps to that package when it
 * lands. Nothing here imports a Durable Object, so the agent loop and the
 * bindings can run on another runtime.
 */

export interface WorkspaceEvent {
	seq: number;
	turnId: string;
	at: string;
	type: string;
	data: Record<string, unknown>;
}

export interface WorkspaceEventInput {
	turnId: string;
	type: string;
	data?: Record<string, unknown>;
}

export interface WorkspaceEvents {
	/** Append one event to the durable ledger and push it to subscribers. */
	append(event: WorkspaceEventInput): WorkspaceEvent;
	/** Events after `afterSeq`, oldest first. */
	replay(afterSeq: number, limit?: number): WorkspaceEvent[];
	latestSeq(): number;
}

export interface WorkspaceStorage {
	exec<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
	run(sql: string, ...params: unknown[]): void;
	get<T>(key: string): T | undefined;
	put<T>(key: string, value: T): void;
	delete(key: string): void;
}

export interface SandboxRunInput {
	/** Model-authored module source exporting `default async (env) => …`. */
	code: string;
	/** Sandbox `env`: RPC stubs or plain values, keyed by binding name. */
	env: Record<string, unknown>;
	timeoutMs?: number;
}

export interface SandboxRunResult {
	ok: boolean;
	/** JSON-serialisable return value of the module's default export. */
	result?: unknown;
	logs: string[];
	error?: string;
	durationMs: number;
}

export interface WorkspaceSandbox {
	run(input: SandboxRunInput): Promise<SandboxRunResult>;
}

export interface WorkspaceAlarms {
	schedule(atMs: number): Promise<void>;
	cancel(): Promise<void>;
}

export interface WorkspaceRuntime {
	workspaceId: string;
	storage: WorkspaceStorage;
	sandbox: WorkspaceSandbox;
	events: WorkspaceEvents;
	alarms: WorkspaceAlarms;
}
