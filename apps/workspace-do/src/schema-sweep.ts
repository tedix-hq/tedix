import {
	durableObjectIdFromString,
	durableObjectNamespace,
} from "@tedix/worker-kit/durable-objects";
import type { WorkspaceRpc } from "./do";
import type { WorkspaceEnv } from "./env";
import { WORKSPACE_SCHEMA_VERSION } from "./workspace-schema";

/** One page from the provider's complete WORKSPACE namespace object inventory. */
export async function sweepWorkspaceSchemaVersions(
	env: WorkspaceEnv,
	objectIds: string[],
) {
	if (objectIds.length > 100)
		throw new Error("Schema sweep accepts at most 100 object IDs per page");
	const namespace = durableObjectNamespace(env.WORKSPACE, env);
	const stores: Array<
		| { objectId: string; version: number; appliedAt: string | null }
		| { objectId: string; error: "unavailable" }
	> = [];
	for (const objectId of objectIds) {
		try {
			const id = durableObjectIdFromString(env.WORKSPACE, env, objectId);
			const stub = namespace.get(id) as unknown as WorkspaceRpc;
			stores.push(await stub.readOwnSchemaVersion());
		} catch {
			stores.push({ objectId, error: "unavailable" });
		}
	}
	return { expectedVersion: WORKSPACE_SCHEMA_VERSION, stores };
}
