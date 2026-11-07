import type { AgentJurisdiction, AgentRuntime } from "./index";
import { SqliteAgentAlarms, type AlarmHost } from "./alarms";
import { AgentBindingRegistry } from "./bindings";
import {
	SqliteAgentEvents,
	type SqliteAgentEventsOptions,
	type WebSocketHost,
} from "./events";
import { LoaderAgentSandbox, type SandboxLoader } from "./sandbox";
import { SqliteAgentStorage, type SqliteHost } from "./sql-storage";

/**
 * The Durable Object surface both hosts provide. Cloudflare's runtime and a
 * self-hosted workerd expose the same `DurableObjectState`; this names only
 * the parts the runtime touches.
 */
export interface AgentObjectState extends WebSocketHost {
	readonly storage: SqliteHost & AlarmHost;
}

export interface DurableObjectAgentRuntimeOptions {
	readonly objectId: string;
	readonly jurisdiction: AgentJurisdiction;
	readonly state: AgentObjectState;
	readonly loader: SandboxLoader;
	readonly events?: SqliteAgentEventsOptions;
}

/**
 * The runtime over one Durable Object: SQLite storage, a Worker Loader
 * sandbox, in-object bindings, WebSocket events and the object's alarm. Both
 * published implementations are this class with host-specific construction.
 */
export class DurableObjectAgentRuntime implements AgentRuntime {
	readonly objectId: string;
	readonly jurisdiction: AgentJurisdiction;
	readonly storage: SqliteAgentStorage;
	readonly bindings: AgentBindingRegistry;
	readonly sandbox: LoaderAgentSandbox;
	readonly events: SqliteAgentEvents;
	readonly alarms: SqliteAgentAlarms;

	constructor(options: DurableObjectAgentRuntimeOptions) {
		if (!options.objectId.trim()) {
			throw new Error("An agent runtime needs an object id");
		}
		this.objectId = options.objectId;
		this.jurisdiction = options.jurisdiction;
		this.storage = new SqliteAgentStorage(
			options.objectId,
			options.state.storage,
		);
		this.bindings = new AgentBindingRegistry();
		this.sandbox = new LoaderAgentSandbox(options.loader, this.bindings);
		this.events = new SqliteAgentEvents(
			this.storage,
			options.state,
			options.events,
		);
		this.alarms = new SqliteAgentAlarms(this.storage, options.state.storage);
	}
}
