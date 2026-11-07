import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
import {
	DurableObjectWorkspaceRuntime,
	type WorkspaceObjectState,
} from "./durable-object-runtime";
import type { WorkspaceJurisdiction } from "./index";
import type { SandboxLoader } from "./sandbox";
import type { SqliteWorkspaceEventsOptions } from "./events";

/** The jurisdictions a Cloudflare workspace can be created in. */
export type CloudflareWorkspaceJurisdiction = Exclude<
	WorkspaceJurisdiction,
	"local"
>;

export interface CloudflareWorkspaceAddress {
	readonly workspaceId: string;
	/**
	 * `eu` for an EU organization. The object is then created inside the EU
	 * jurisdiction and can never be reached through an unrestricted id.
	 */
	readonly jurisdiction: CloudflareWorkspaceJurisdiction;
}

/** The namespace methods addressing needs, named locally. */
export interface CloudflareWorkspaceNamespace<Stub> {
	getByName(name: string): Stub;
	jurisdiction?(value: string): CloudflareWorkspaceNamespace<Stub>;
}

/**
 * The stub for one workspace. The jurisdiction is part of the address: an
 * EU workspace's id only exists inside `namespace.jurisdiction("eu")`, so the
 * caller that opens the object decides where it lives, once, from the
 * organization's residency.
 */
export function cloudflareWorkspaceStub<Stub>(
	namespace: CloudflareWorkspaceNamespace<Stub>,
	address: CloudflareWorkspaceAddress,
): Stub {
	assertCloudflareJurisdiction(address.jurisdiction);
	return durableObjectStubByName(
		namespace,
		{ DO_JURISDICTION: address.jurisdiction === "eu" ? "eu" : undefined },
		address.workspaceId,
	);
}

export function assertCloudflareJurisdiction(
	jurisdiction: WorkspaceJurisdiction,
): asserts jurisdiction is CloudflareWorkspaceJurisdiction {
	if (jurisdiction !== "eu" && jurisdiction !== "global") {
		throw new Error(
			`A Cloudflare workspace is "eu" or "global", not ${JSON.stringify(jurisdiction)}`,
		);
	}
}

export interface CloudflareWorkspaceRuntimeOptions {
	readonly workspaceId: string;
	readonly jurisdiction: CloudflareWorkspaceJurisdiction;
	readonly events?: SqliteWorkspaceEventsOptions;
}

/** The bindings the object's Worker must declare. */
export interface CloudflareWorkspaceEnv {
	readonly LOADER: SandboxLoader;
}

/**
 * The runtime inside a Cloudflare Durable Object: SQLite-backed object
 * storage, the Worker Loader binding with no outbound network, hibernating
 * WebSockets and the object's alarm.
 */
export class CloudflareWorkspaceRuntime extends DurableObjectWorkspaceRuntime {
	constructor(
		state: WorkspaceObjectState,
		env: CloudflareWorkspaceEnv,
		options: CloudflareWorkspaceRuntimeOptions,
	) {
		assertCloudflareJurisdiction(options.jurisdiction);
		if (!env.LOADER) {
			throw new Error(
				"The workspace Worker needs a LOADER binding (worker_loaders) for the sandbox",
			);
		}
		super({
			workspaceId: options.workspaceId,
			jurisdiction: options.jurisdiction,
			state,
			loader: env.LOADER,
			events: options.events,
		});
	}
}
