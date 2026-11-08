import {
	MemoryOwnerScopeSchema,
	type MemoryOwnerScope,
} from "@tedix/api-contract/schemas/memory-graph";

/** Populated by the authenticated gateway, never from a tool's input. */
export interface MemoryOwnerAccess {
	organizationId: string;
	principalId: string;
	workspaceIds: readonly string[];
}

/** Container access only; operation scopes and per-fact policy still apply. */
export function authorizeMemoryOwner(
	requested: MemoryOwnerScope,
	access: MemoryOwnerAccess,
): MemoryOwnerScope {
	const owner = MemoryOwnerScopeSchema.parse(requested);
	if (
		!access.principalId?.trim() ||
		owner.organizationId !== access.organizationId
	)
		throw new Error("Memory owner is outside the authenticated organization");
	if (owner.kind === "personal" && owner.principalId !== access.principalId)
		throw new Error("Personal memory belongs to another principal");
	if (
		owner.kind === "workspace" &&
		!access.workspaceIds.includes(owner.workspaceId)
	)
		throw new Error("Workspace memory requires workspace access");
	return owner;
}

export function memoryOwnerId(owner: MemoryOwnerScope): string {
	switch (owner.kind) {
		case "organization":
			return owner.organizationId;
		case "workspace":
			return owner.workspaceId;
		case "personal":
			return owner.principalId;
	}
}

/** Three separators distinguish these keys from every encoded org:workspace key. */
export function memoryStoreName(requested: MemoryOwnerScope): string {
	const owner = MemoryOwnerScopeSchema.parse(requested);
	return `memory:${owner.kind}:${encodeURIComponent(owner.organizationId)}:${encodeURIComponent(memoryOwnerId(owner))}`;
}
