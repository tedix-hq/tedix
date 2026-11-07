import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
import {
	DurableObjectWorkspaceRuntime,
	type WorkspaceObjectState,
} from "./durable-object-runtime";
import type { SqliteWorkspaceEventsOptions } from "./events";
import type { SandboxLoader } from "./sandbox";

/** The namespace methods a self-hosted workerd needs for addressing. */
export interface WorkerdWorkspaceNamespace<Stub> {
	getByName(name: string): Stub;
}

/**
 * The stub for one workspace on a self-hosted workerd. There is no
 * jurisdiction to select: the process keeps every object on its own disk
 * (see `workerd/workspace.capnp`), so residency is where the process runs.
 */
export function workerdWorkspaceStub<Stub>(
	namespace: WorkerdWorkspaceNamespace<Stub>,
	workspaceId: string,
): Stub {
	return durableObjectStubByName(namespace, {}, workspaceId);
}

export interface WorkerdWorkspaceRuntimeOptions {
	readonly workspaceId: string;
	readonly events?: SqliteWorkspaceEventsOptions;
}

/** The bindings the workerd config must give the workspace Worker. */
export interface WorkerdWorkspaceEnv {
	readonly LOADER: SandboxLoader;
}

/**
 * The runtime on a self-hosted workerd process. Same object storage, loader,
 * WebSocket and alarm APIs as Cloudflare; the difference is where the bytes
 * go. The workerd config points the object namespace at a directory, so each
 * workspace's SQLite file lives on the operator's disk and survives restarts,
 * and the sandbox loader is the config's `workerLoader` binding.
 */
export class WorkerdWorkspaceRuntime extends DurableObjectWorkspaceRuntime {
	constructor(
		state: WorkspaceObjectState,
		env: WorkerdWorkspaceEnv,
		options: WorkerdWorkspaceRuntimeOptions,
	) {
		if (!env.LOADER) {
			throw new Error(
				"The workerd config needs a LOADER workerLoader binding for the sandbox",
			);
		}
		super({
			workspaceId: options.workspaceId,
			jurisdiction: "local",
			state,
			loader: env.LOADER,
			events: options.events,
		});
	}
}
