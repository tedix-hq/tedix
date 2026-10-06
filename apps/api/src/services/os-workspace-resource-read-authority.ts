import { personalResourceScopesCover } from "@tedix/api-contract/utils/personal-resource-tool-binding";
import { getConnectionInstance } from "@tedix/db/queries/connection-instances";
import { fetchNamedConnection } from "../rpc/routers/connections/policy-resolution";
import { getSkillRun } from "@tedix/db/queries/skill-runs";
import { OsDerivedAccessEnvelopeSchema } from "@tedix/api-contract/schemas/os-workspaces";
import {
	authorizePersonalResourceDelegation,
	resolvePersonalResourceDelegatedCredential,
} from "./personal-resource-delegation-authority";
import { getManagementClient } from "@tedix/auth/client";
import { getAssignedAppRoles } from "@tedix/auth/fga";
import { listAppReferenceMetadataByOrganization } from "@tedix/db/queries/apps";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { createDbQueryClient } from "@tedix/db/query-client";
import { getOsWorkspaceResource } from "@tedix/db/queries/os-workspaces/resources";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import type { OsWorkspaceResourceRow } from "@tedix/db/schema/os-workspaces";
import { requireOrgId } from "../rpc/org-scope";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	hasConnectionCredentialResolutionAuthority,
} from "../rpc/orpc";

function appConnectionProviderId(metadata: unknown): string | null {
	if (typeof metadata !== "object" || metadata === null) return null;
	const mcpConfig = (metadata as { mcpConfig?: unknown }).mcpConfig;
	if (typeof mcpConfig !== "object" || mcpConfig === null) return null;
	const providerId = (mcpConfig as { connectionProviderId?: unknown })
		.connectionProviderId;
	return typeof providerId === "string" ? providerId : null;
}

/**
 * Authorize one read of one provider object attached to an active Workspace.
 * An app connection or MCP tool grant is insufficient on its own: the exact
 * Workspace reference and the acting Tedi's app assignment are both checked
 * immediately before the caller resolves a provider credential.
 */
export async function authorizeWorkspaceResourceRead(
	context: BaseContext,
	input: {
		workspaceId: string;
		resourceId: string;
		expectedProviderId: string;
		expectedResourceType: string;
	},
): Promise<{ resource: OsWorkspaceResourceRow; requiredScopes: string[] }> {
	const organizationId = requireOrgId(context);
	const db = createDbQueryClient(context.env.DB);
	const workspace = await getOsWorkspace(db, {
		organizationId,
		workspaceId: input.workspaceId,
	});
	if (!workspace || workspace.status !== "active") {
		throw createError(ErrorCodes.NOT_FOUND, "Active Workspace not found");
	}
	const resource = await getOsWorkspaceResource(db, {
		organizationId,
		workspaceId: input.workspaceId,
		resourceId: input.resourceId,
	});
	if (
		!resource ||
		resource.status !== "active" ||
		resource.providerId !== input.expectedProviderId ||
		resource.resourceType !== input.expectedResourceType ||
		!resource.providerResourceId.trim()
	) {
		throw createError(
			ErrorCodes.NOT_FOUND,
			"Active Workspace resource not found",
		);
	}

	let requiredScopes: unknown;
	try {
		requiredScopes = JSON.parse(resource.requiredScopes);
	} catch {
		// Persisted declaration drift must not produce a less-scoped token lookup.
	}
	if (
		!Array.isArray(requiredScopes) ||
		requiredScopes.length > 50 ||
		!requiredScopes.every(
			(scope): scope is string =>
				typeof scope === "string" &&
				scope.trim() === scope &&
				scope.length > 0 &&
				scope.length <= 300,
		)
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Workspace resource scope declaration is invalid",
		);
	}

	if (context.tediId) {
		if (!hasConnectionCredentialResolutionAuthority(context)) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Tedi resource reads require a verified MCP tool execution",
			);
		}
		if (resource.connectionScope === "user") {
			const runId = context.headers.get("X-Tedix-Skill-Run-Id");
			const run = runId
				? await getSkillRun(
						context.db,
						runId,
						organizationId,
						context.env.ENVIRONMENT,
					)
				: null;
			const envelope = OsDerivedAccessEnvelopeSchema.safeParse(
				run?.resourceAccessEnvelope,
			);
			const source = envelope.success
				? envelope.data.sources.find(
						(source) =>
							source.workspaceResourceId === resource.id &&
							source.connectionScope === "user" &&
							source.operations.includes("read"),
					)
				: undefined;
			const toolId = context.headers.get("X-Tedix-Mcp-Tool-Id");
			if (!run || !source || !toolId || !run.skillId || !run.skillRevision)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Personal resource read requires exact admitted run consent",
				);
			await authorizePersonalResourceDelegation(context, {
				delegationId: source.delegationId!,
				tediId: context.tediId,
				skillId: run.skillId,
				skillRevision: run.skillRevision,
				workspaceId: resource.workspaceId,
				resourceId: resource.id,
				connectionInstanceId: source.connectionInstanceId!,
				providerId: resource.providerId,
				providerResourceId: resource.providerResourceId,
				operation: "read",
				toolId,
				requiredScopes,
			});
		}
		const tedi = await getTediByIdForOrganization(
			context.db,
			context.tediId,
			organizationId,
		);
		if (!tedi?.descopeUserId || tedi.retiredAt) {
			throw createError(ErrorCodes.FORBIDDEN, "Tedi identity is not active");
		}
		const apps = await listAppReferenceMetadataByOrganization(
			context.db,
			organizationId,
		);
		const matchingAppIds = apps
			.filter(
				(app) => appConnectionProviderId(app.metadata) === resource.providerId,
			)
			.map((app) => app.id);
		if (matchingAppIds.length === 0) {
			throw createError(ErrorCodes.FORBIDDEN, "Provider app is not installed");
		}
		const roles = await getAssignedAppRoles(
			getManagementClient(context.env),
			tedi.descopeUserId,
			matchingAppIds,
		);
		if (
			!matchingAppIds.some(
				(appId) => roles[appId] === "operator" || roles[appId] === "observer",
			)
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Tedi has no current provider app read assignment",
			);
		}
	} else if (context.authType !== "user" || !context.user?.sub) {
		// A bare service binding, API key, or machine principal has no acting
		// Workspace reader here. Its app-level access cannot fill that gap.
		throw createError(
			ErrorCodes.FORBIDDEN,
			"An acting Workspace reader is required",
		);
	}
	if (
		resource.connectionScope === "user" &&
		!context.tediId &&
		(context.authType !== "user" ||
			resource.personalOwnerUserId !== context.user?.sub ||
			!resource.connectionInstanceId)
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Personal Workspace resources require their exact interactive owner",
		);
	}

	return { resource, requiredScopes };
}

/** Resolve the exact slot already authorized above; owner provenance never selects a default account. */
export async function resolveWorkspacePersonalReadCredential(
	context: BaseContext,
	resource: OsWorkspaceResourceRow,
	requiredScopes: string[],
): Promise<string | null> {
	if (
		resource.connectionScope !== "user" ||
		!resource.connectionInstanceId ||
		!resource.personalOwnerUserId
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Exact personal resource account is required",
		);
	if (context.tediId) {
		const runId = context.headers.get("X-Tedix-Skill-Run-Id");
		const run = runId
			? await getSkillRun(
					context.db,
					runId,
					resource.organizationId,
					context.env.ENVIRONMENT,
				)
			: null;
		const parsed = OsDerivedAccessEnvelopeSchema.safeParse(
			run?.resourceAccessEnvelope,
		);
		const source = parsed.success
			? parsed.data.sources.find(
					(source) =>
						source.workspaceResourceId === resource.id &&
						source.connectionScope === "user",
				)
			: undefined;
		const toolId = context.headers.get("X-Tedix-Mcp-Tool-Id");
		if (!run?.skillRevision || !source || !toolId)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"No admitted personal resource read exists",
			);
		const resolved = await resolvePersonalResourceDelegatedCredential(context, {
			delegationId: source.delegationId!,
			tediId: context.tediId,
			skillId: run.skillId,
			skillRevision: run.skillRevision,
			workspaceId: resource.workspaceId,
			resourceId: resource.id,
			connectionInstanceId: resource.connectionInstanceId,
			providerId: resource.providerId,
			providerResourceId: resource.providerResourceId,
			operation: "read",
			toolId,
			requiredScopes,
		});
		return resolved.accessToken;
	}
	if (
		context.authType !== "user" ||
		context.user?.sub !== resource.personalOwnerUserId
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Personal resource reads require their exact owner",
		);
	const account = await getConnectionInstance(
		context.db,
		{ userId: resource.personalOwnerUserId },
		resource.connectionInstanceId,
		resource.providerId,
	);
	if (!account?.tokenIds.length || !account.tokenSub)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Selected personal account is disconnected",
		);
	const token = await fetchNamedConnection(
		context,
		{ userId: resource.personalOwnerUserId },
		resource.providerId,
		resource.connectionInstanceId,
		requiredScopes,
	);
	if (
		!token?.id ||
		!account.tokenIds.includes(token.id) ||
		token.tokenSub !== account.tokenSub ||
		!personalResourceScopesCover(token.scopes ?? [], requiredScopes) ||
		(token.expiresAt && Number(token.expiresAt) <= Date.now() / 1000)
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Selected personal account credential changed or expired",
		);
	return token.accessToken;
}
