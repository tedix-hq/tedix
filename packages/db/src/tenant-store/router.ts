/**
 * Send a workspace-scoped query to that workspace's TenantStore object.
 *
 * Runtime-neutral: no `cloudflare:workers` import, so Node callers and tests
 * can load it. `durableObjectStubByName` applies `env.DO_JURISDICTION` before
 * addressing (the private ops overlay sets `eu` on the EU installation); a
 * jurisdiction is part of every object ID and must never change for existing
 * data.
 */
import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
import type { TenantScope } from "../tenant-scope";

/** A tenant scope that names one workspace, which one TenantStore serves. */
export type WorkspaceTenantScope = Required<TenantScope>;

/** Validate a scope for TenantStore routing and drop any extra fields. */
export function requireWorkspaceScope(
	scope: TenantScope,
): WorkspaceTenantScope {
	if (!scope.organizationId?.trim()) {
		throw new Error("TenantStore scope requires organizationId");
	}
	if (!scope.workspaceId?.trim()) {
		throw new Error("TenantStore scope requires workspaceId");
	}
	return {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
	};
}

/**
 * The `idFromName` key: `org:workspace`. Each part is URI-encoded, so an ID
 * that contains `:` cannot collide with another pair.
 */
export function tenantStoreName(scope: TenantScope): string {
	const { organizationId, workspaceId } = requireWorkspaceScope(scope);
	return `${encodeURIComponent(organizationId)}:${encodeURIComponent(workspaceId)}`;
}

/** The stub for the object that owns `scope`'s workspace data. */
export function tenantStoreStub<T extends Rpc.DurableObjectBranded | undefined>(
	namespace: DurableObjectNamespace<T>,
	env: unknown,
	scope: TenantScope,
): DurableObjectStub<T> {
	return durableObjectStubByName(namespace, env, tenantStoreName(scope));
}

/**
 * Run one scoped query against the owning object. The query receives the
 * validated scope and must pass it to the RPC method, which rejects a scope
 * the object does not serve.
 */
export function routeTenantQuery<
	T extends Rpc.DurableObjectBranded | undefined,
	R,
>(
	namespace: DurableObjectNamespace<T>,
	env: unknown,
	scope: TenantScope,
	query: (store: DurableObjectStub<T>, scope: WorkspaceTenantScope) => R,
): R {
	const workspaceScope = requireWorkspaceScope(scope);
	return query(tenantStoreStub(namespace, env, workspaceScope), workspaceScope);
}
