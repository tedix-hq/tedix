import {
	MemoryOwnerScopeSchema,
	type MemoryOwnerScope,
} from "@tedix/api-contract/schemas/memory-graph";
import {
	queryOwnedMemory,
	type MemoryQuery,
	type MemoryQueryConfig,
	type MemoryQueryResult,
} from "@tedix/db/queries/memory-graph/tenant-rpc";
import {
	authorizeMemoryOwner,
	type MemoryOwnerAccess,
} from "@tedix/db/tenant-store/memory-owner";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { requireOrgId } from "../rpc/org-scope";
import {
	createError,
	ErrorCodes,
	hasRequiredScope,
	userHoldsPermission,
	type BaseContext,
} from "../rpc/orpc";
import { assertOsWorkspaceVisible } from "./os-workspace-visibility";

const READ_OPERATIONS = [
	"browse",
	"lexicalRecall",
	"graphRecall",
	"temporalRecall",
	"hydrateRecall",
	"fallbackRecall",
] as const;
type MemoryReadOperation = (typeof READ_OPERATIONS)[number];
type MemoryReadConfig =
	| MemoryQueryConfig
	| {
			plane: "runtime";
			runtime: {
				ownedMemory<K extends MemoryReadOperation>(
					owner: MemoryOwnerScope,
					access: MemoryOwnerAccess,
					query: MemoryQuery<K>,
				): Promise<MemoryQueryResult<K>>;
			};
	  };

function reader(context: BaseContext): {
	principalId: string;
	tediId?: string;
	organizationOnly?: boolean;
} {
	switch (context.authType) {
		case "user":
			if (context.user?.sub) return { principalId: `user:${context.user.sub}` };
			break;
		case "apikey":
			if (
				context.apiKey?.id &&
				context.apiKey.organizationId === context.organizationId
			)
				return { principalId: `apikey:${context.apiKey.id}` };
			break;
		case "tedi":
			if (!context.tediId)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Authenticated tedi identity is required",
				);
			return { principalId: `tedi:${context.tediId}`, tediId: context.tediId };
		case "service-binding":
			// An external agent's human provenance never grants that human's or a tedi's private memory.
			if (context.externalAgentPrincipalId) {
				if (
					context.externalAgentSessionId &&
					context.externalAgentClientRecordId
				)
					return {
						principalId: `external-agent:${context.externalAgentPrincipalId}`,
					};
				break;
			}
			if (context.tediId)
				return {
					principalId: `tedi:${context.tediId}`,
					tediId: context.tediId,
				};
		// Fall through only to a mapped service identity, never acting-user headers.
		case "m2m":
			if (context.serviceAccount?.canonicalPrincipalId)
				return {
					principalId: `service:${context.serviceAccount.canonicalPrincipalId}`,
				};
			// Existing org-scoped M2M reads do not require an identity-mapping rollout.
			if (context.authType === "m2m" && context.serviceAccount?.clientId)
				return {
					principalId: `m2m:${context.serviceAccount.clientId}`,
					organizationOnly: true,
				};
	}
	throw createError(
		ErrorCodes.FORBIDDEN,
		"Verified memory reader identity is required",
	);
}

/** Authenticated gateway read port. Storage selection is server configuration, never tool input. */
export async function readOwnedMemory<K extends MemoryReadOperation>(
	context: BaseContext,
	config: MemoryReadConfig,
	requested: MemoryOwnerScope,
	query: MemoryQuery<K>,
): Promise<MemoryQueryResult<K>> {
	if (
		!hasRequiredScope(context, "mcp:memory.read") ||
		(context.authType === "user" && !userHoldsPermission(context, "tedis:read"))
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Memory read permission is required",
		);
	// Runtime callers can bypass TypeScript; no raw fact reads, writes or policy overrides on this port.
	if (!READ_OPERATIONS.some((operation) => operation === query.operation))
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Unsupported memory read operation",
		);
	const identity = reader(context);
	const organizationId = requireOrgId(context);
	const owner = MemoryOwnerScopeSchema.parse(requested);
	if (identity.organizationOnly && owner.kind !== "organization")
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Scoped memory requires a canonical service principal",
		);
	const access: MemoryOwnerAccess = {
		organizationId,
		principalId: identity.principalId,
		workspaceIds: [],
	};
	if (owner.organizationId !== organizationId || owner.kind === "personal")
		authorizeMemoryOwner(owner, access);
	if (owner.kind === "workspace") {
		const workspace = await getOsWorkspace(context.db, {
			organizationId,
			workspaceId: owner.workspaceId,
		});
		if (!workspace || workspace.status !== "active")
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Active memory workspace not found",
			);
		await assertOsWorkspaceVisible(context, workspace);
		access.workspaceIds = [workspace.id];
	}
	authorizeMemoryOwner(owner, access);
	const bound = {
		...query,
		input: { ...query.input, tediId: identity.tediId },
	} as MemoryQuery<K>;
	return config.plane === "runtime"
		? config.runtime.ownedMemory(owner, access, bound)
		: queryOwnedMemory(config, owner, access, bound);
}
