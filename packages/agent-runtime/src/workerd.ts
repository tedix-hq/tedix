import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
import {
	DurableObjectAgentRuntime,
	type AgentObjectState,
} from "./durable-object-runtime";
import type { SqliteAgentEventsOptions } from "./events";
import type { SandboxLoader } from "./sandbox";

/** The namespace methods a self-hosted workerd needs for addressing. */
export interface WorkerdAgentNamespace<Stub> {
	getByName(name: string): Stub;
}

/**
 * The stub for one agent object on a self-hosted workerd. There is no
 * jurisdiction to select: the process keeps every object on its own disk
 * (see `workerd/agent-object.capnp`), so residency is where the process runs.
 */
export function workerdAgentObjectStub<Stub>(
	namespace: WorkerdAgentNamespace<Stub>,
	objectId: string,
): Stub {
	return durableObjectStubByName(namespace, {}, objectId);
}

export interface WorkerdAgentRuntimeOptions {
	readonly objectId: string;
	readonly events?: SqliteAgentEventsOptions;
}

/** The bindings the workerd config must give the agent object's Worker. */
export interface WorkerdAgentEnv {
	readonly LOADER: SandboxLoader;
}

/**
 * The runtime on a self-hosted workerd process. Same object storage, loader,
 * WebSocket and alarm APIs as Cloudflare; the difference is where the bytes
 * go. The workerd config points the object namespace at a directory, so each
 * object's SQLite file lives on the operator's disk and survives restarts,
 * and the sandbox loader is the config's `workerLoader` binding.
 */
export class WorkerdAgentRuntime extends DurableObjectAgentRuntime {
	constructor(
		state: AgentObjectState,
		env: WorkerdAgentEnv,
		options: WorkerdAgentRuntimeOptions,
	) {
		if (!env.LOADER) {
			throw new Error(
				"The workerd config needs a LOADER workerLoader binding for the sandbox",
			);
		}
		super({
			objectId: options.objectId,
			jurisdiction: "local",
			state,
			loader: env.LOADER,
			events: options.events,
		});
	}
}
