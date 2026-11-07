import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
import {
	DurableObjectAgentRuntime,
	type AgentObjectState,
} from "./durable-object-runtime";
import type { AgentJurisdiction } from "./index";
import type { SandboxLoader } from "./sandbox";
import type { SqliteAgentEventsOptions } from "./events";

/** The jurisdictions a Cloudflare agent object can be created in. */
export type CloudflareAgentJurisdiction = Exclude<AgentJurisdiction, "local">;

export interface CloudflareAgentAddress {
	readonly objectId: string;
	/**
	 * `eu` for an EU organization. The object is then created inside the EU
	 * jurisdiction and can never be reached through an unrestricted id.
	 */
	readonly jurisdiction: CloudflareAgentJurisdiction;
}

/** The namespace methods addressing needs, named locally. */
export interface CloudflareAgentNamespace<Stub> {
	getByName(name: string): Stub;
	jurisdiction?(value: string): CloudflareAgentNamespace<Stub>;
}

/**
 * The stub for one agent object. The jurisdiction is part of the address: an
 * EU object's id only exists inside `namespace.jurisdiction("eu")`, so the
 * caller that opens the object decides where it lives, once, from the
 * organization's residency.
 */
export function cloudflareAgentObjectStub<Stub>(
	namespace: CloudflareAgentNamespace<Stub>,
	address: CloudflareAgentAddress,
): Stub {
	assertCloudflareJurisdiction(address.jurisdiction);
	return durableObjectStubByName(
		namespace,
		{ DO_JURISDICTION: address.jurisdiction === "eu" ? "eu" : undefined },
		address.objectId,
	);
}

export function assertCloudflareJurisdiction(
	jurisdiction: AgentJurisdiction,
): asserts jurisdiction is CloudflareAgentJurisdiction {
	if (jurisdiction !== "eu" && jurisdiction !== "global") {
		throw new Error(
			`A Cloudflare agent object is "eu" or "global", not ${JSON.stringify(jurisdiction)}`,
		);
	}
}

export interface CloudflareAgentRuntimeOptions {
	readonly objectId: string;
	readonly jurisdiction: CloudflareAgentJurisdiction;
	readonly events?: SqliteAgentEventsOptions;
}

/** The bindings the object's Worker must declare. */
export interface CloudflareAgentEnv {
	readonly LOADER: SandboxLoader;
}

/**
 * The runtime inside a Cloudflare Durable Object: SQLite-backed object
 * storage, the Worker Loader binding with no outbound network, hibernating
 * WebSockets and the object's alarm.
 */
export class CloudflareAgentRuntime extends DurableObjectAgentRuntime {
	constructor(
		state: AgentObjectState,
		env: CloudflareAgentEnv,
		options: CloudflareAgentRuntimeOptions,
	) {
		assertCloudflareJurisdiction(options.jurisdiction);
		if (!env.LOADER) {
			throw new Error(
				"The agent object's Worker needs a LOADER binding (worker_loaders) for the sandbox",
			);
		}
		super({
			objectId: options.objectId,
			jurisdiction: options.jurisdiction,
			state,
			loader: env.LOADER,
			events: options.events,
		});
	}
}
