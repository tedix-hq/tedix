import type { WorkspaceJurisdiction, WorkspaceRuntime } from "./index";
import { SqliteWorkspaceAlarms, type AlarmHost } from "./alarms";
import { WorkspaceBindingRegistry } from "./bindings";
import {
	SqliteWorkspaceEvents,
	type SqliteWorkspaceEventsOptions,
	type WebSocketHost,
} from "./events";
import { LoaderWorkspaceSandbox, type SandboxLoader } from "./sandbox";
import { SqliteWorkspaceStorage, type SqliteHost } from "./sql-storage";

/**
 * The Durable Object surface both hosts provide. Cloudflare's runtime and a
 * self-hosted workerd expose the same `DurableObjectState`; this names only
 * the parts the runtime touches.
 */
export interface WorkspaceObjectState extends WebSocketHost {
	readonly storage: SqliteHost & AlarmHost;
}

export interface DurableObjectWorkspaceRuntimeOptions {
	readonly workspaceId: string;
	readonly jurisdiction: WorkspaceJurisdiction;
	readonly state: WorkspaceObjectState;
	readonly loader: SandboxLoader;
	readonly events?: SqliteWorkspaceEventsOptions;
}

/**
 * The runtime over one Durable Object: SQLite storage, a Worker Loader
 * sandbox, in-object bindings, WebSocket events and the object's alarm. Both
 * published implementations are this class with host-specific construction.
 */
export class DurableObjectWorkspaceRuntime implements WorkspaceRuntime {
	readonly workspaceId: string;
	readonly jurisdiction: WorkspaceJurisdiction;
	readonly storage: SqliteWorkspaceStorage;
	readonly bindings: WorkspaceBindingRegistry;
	readonly sandbox: LoaderWorkspaceSandbox;
	readonly events: SqliteWorkspaceEvents;
	readonly alarms: SqliteWorkspaceAlarms;

	constructor(options: DurableObjectWorkspaceRuntimeOptions) {
		if (!options.workspaceId.trim()) {
			throw new Error("A workspace runtime needs a workspace id");
		}
		this.workspaceId = options.workspaceId;
		this.jurisdiction = options.jurisdiction;
		this.storage = new SqliteWorkspaceStorage(
			options.workspaceId,
			options.state.storage,
		);
		this.bindings = new WorkspaceBindingRegistry();
		this.sandbox = new LoaderWorkspaceSandbox(options.loader, this.bindings);
		this.events = new SqliteWorkspaceEvents(
			this.storage,
			options.state,
			options.events,
		);
		this.alarms = new SqliteWorkspaceAlarms(
			this.storage,
			options.state.storage,
		);
	}
}
