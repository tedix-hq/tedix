import { fetchNamedConnection } from "../rpc/routers/connections/policy-resolution";
import { getConnectionInstance } from "@tedix/db/queries/connection-instances";
import { getManagementClient } from "@tedix/auth/client";
import {
	fetchTenantConnectionToken,
	fetchTenantConnectionTokenByScopes,
} from "@tedix/auth/connections";
import type { OsWorkspaceResourceAvailabilitySchema } from "@tedix/api-contract/schemas/os-workspaces";
import { getOrganizationDescopeTenantId } from "@tedix/db/queries/organizations";
import type { z } from "zod";
import type { BaseContext } from "../rpc/orpc";

export type WorkspaceResourceAvailability = z.infer<
	typeof OsWorkspaceResourceAvailabilitySchema
>;

type ResourceConnectionReference = {
	organizationId: string;
	providerId: string;
	connectionScope: "tenant" | "user";
	requiredScopes: string[];
	status: "active" | "removed";
	personalOwnerUserId?: string | null;
	connectionInstanceId?: string | null;
};

type TokenProjection = {
	expiresAt?: number | string | null;
} | null;

type AvailabilityDependencies = {
	resolveTenantId?: (
		organizationId: string,
	) => Promise<string | null | undefined>;
	resolveToken?: (input: {
		descopeTenantId: string;
		providerId: string;
		connectionScope: "tenant" | "user";
		requiredScopes: string[];
		userId: string | null;
	}) => Promise<TokenProjection>;
	now?: () => Date;
};

function unavailable(
	status: Exclude<WorkspaceResourceAvailability["status"], "available">,
	reason: string,
	checkedAt: string,
): WorkspaceResourceAvailability {
	return { status, reason, checkedAt };
}

export async function resolveWorkspaceResourceAvailability(
	context: BaseContext,
	resource: ResourceConnectionReference,
	dependencies: AvailabilityDependencies = {},
): Promise<WorkspaceResourceAvailability> {
	const now = dependencies.now?.() ?? new Date();
	const checkedAt = now.toISOString();
	if (resource.status !== "active") {
		return unavailable(
			"not_executable",
			"This Workspace resource has been removed.",
			checkedAt,
		);
	}
	try {
		if (resource.connectionScope === "user") {
			if (
				context.authType !== "user" ||
				context.tediId ||
				!resource.personalOwnerUserId ||
				resource.personalOwnerUserId !== context.user?.sub ||
				!resource.connectionInstanceId
			)
				return unavailable(
					"not_executable",
					"This personal resource requires its exact owner or an explicitly admitted background run.",
					checkedAt,
				);
			const account = await getConnectionInstance(
				context.db,
				{ userId: resource.personalOwnerUserId },
				resource.connectionInstanceId,
				resource.providerId,
			);
			if (!account?.tokenIds.length || !account.tokenSub)
				return unavailable(
					"missing_connection",
					"The selected personal account is disconnected.",
					checkedAt,
				);
			const token = await fetchNamedConnection(
				context,
				{ userId: resource.personalOwnerUserId },
				resource.providerId,
				resource.connectionInstanceId,
				resource.requiredScopes,
			);
			if (
				!token?.id ||
				!account.tokenIds.includes(token.id) ||
				token.tokenSub !== account.tokenSub ||
				resource.requiredScopes.some((scope) => !token.scopes?.includes(scope))
			)
				return unavailable(
					"missing_connection",
					"The exact personal account or required scopes changed.",
					checkedAt,
				);
			if (token.expiresAt && Number(token.expiresAt) <= now.getTime() / 1000)
				return unavailable(
					"expired_connection",
					"The selected personal account has expired.",
					checkedAt,
				);
			return { status: "available", reason: null, checkedAt };
		}
		const descopeTenantId = dependencies.resolveTenantId
			? await dependencies.resolveTenantId(resource.organizationId)
			: await getOrganizationDescopeTenantId(
					context.db,
					resource.organizationId,
				);
		if (!descopeTenantId) {
			return unavailable(
				"missing_connection",
				"The organization has no canonical connection tenant.",
				checkedAt,
			);
		}
		const userId = context.descopeUserId ?? context.user?.sub ?? null;
		const token = dependencies.resolveToken
			? await dependencies.resolveToken({
					descopeTenantId,
					providerId: resource.providerId,
					connectionScope: resource.connectionScope,
					requiredScopes: resource.requiredScopes,
					userId,
				})
			: await resolveCanonicalToken(context, {
					descopeTenantId,
					providerId: resource.providerId,
					connectionScope: resource.connectionScope,
					requiredScopes: resource.requiredScopes,
					userId,
				});
		if (!token) {
			return unavailable(
				"missing_connection",
				"Reconnect this app before using the Workspace resource.",
				checkedAt,
			);
		}
		const expiresAt = Number(token.expiresAt ?? 0);
		if (expiresAt > 0 && expiresAt <= Math.floor(now.getTime() / 1000)) {
			return unavailable(
				"expired_connection",
				"The backing connection has expired and must be reconnected.",
				checkedAt,
			);
		}
		return { status: "available", reason: null, checkedAt };
	} catch (error) {
		console.error("[Workspace] resource connection check failed", {
			organizationId: resource.organizationId,
			providerId: resource.providerId,
			connectionScope: resource.connectionScope,
			error: error instanceof Error ? error.message : String(error),
		});
		return unavailable(
			"check_failed",
			"Connection availability could not be verified; execution is blocked.",
			checkedAt,
		);
	}
}

async function resolveCanonicalToken(
	context: BaseContext,
	input: {
		descopeTenantId: string;
		providerId: string;
		connectionScope: "tenant" | "user";
		requiredScopes: string[];
		userId: string | null;
	},
): Promise<TokenProjection> {
	const client = getManagementClient(context.env);
	if (input.connectionScope === "tenant") {
		return input.requiredScopes.length > 0
			? fetchTenantConnectionTokenByScopes(
					client,
					input.providerId,
					input.descopeTenantId,
					input.requiredScopes,
				)
			: fetchTenantConnectionToken(
					client,
					input.providerId,
					input.descopeTenantId,
				);
	}
	return null;
}
