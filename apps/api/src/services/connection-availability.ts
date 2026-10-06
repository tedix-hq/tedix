import { getManagementClient } from "@tedix/auth/client";
import {
	fetchConnectionToken,
	fetchConnectionTokenByScopes,
	fetchTenantConnectionToken,
	fetchTenantConnectionTokenByScopes,
} from "@tedix/auth/connections";
import type { DbClient } from "@tedix/db/client";
import { getConnectionProviderById } from "@tedix/db/queries/connection-providers";
import { getOrganizationDescopeTenantId } from "@tedix/db/queries/organizations";

/** Why a connection did not resolve. Only `no_token` is repairable through
 * operator consent; the other causes identify configuration/platform gaps. */
export type ConnectionAvailabilityCause =
	| "connected"
	| "provider_unregistered"
	| "no_tenant_binding"
	| "verification_unavailable"
	| "verification_failed"
	| "no_token";

export interface ConnectionAvailability {
	connected: boolean;
	cause: ConnectionAvailabilityCause;
	reason: string;
}

/** Read-only credential preflight shared by Work admission and explicit OS
 * reads. It fetches no provider data and never mints or expands authority. */
export async function resolveConnectionAvailability(input: {
	db: DbClient;
	env: CloudflareEnv;
	organizationId: string;
	ownerUserId: string | null;
	providerId: string;
	tokenScope: "tenant" | "user" | "either";
	scopes: string[];
}): Promise<ConnectionAvailability> {
	const provider = await getConnectionProviderById(input.db, input.providerId);
	const descopeAppId = provider?.descopeAppId;
	if (!provider || !descopeAppId) {
		return {
			connected: false,
			cause: "provider_unregistered",
			reason: `connection provider ${input.providerId} is not registered with Descope`,
		};
	}
	const descopeTenantId = await getOrganizationDescopeTenantId(
		input.db,
		input.organizationId,
	);
	if (!descopeTenantId) {
		return {
			connected: false,
			cause: "no_tenant_binding",
			reason: "the organization has no Descope tenant binding",
		};
	}
	if (!input.env.DESCOPE_MANAGEMENT_KEY) {
		return {
			connected: false,
			cause: "verification_unavailable",
			reason:
				"connection verification is unavailable because Descope management is not configured",
		};
	}
	const client = getManagementClient({
		DESCOPE_PROJECT_ID: input.env.DESCOPE_PROJECT_ID,
		DESCOPE_MANAGEMENT_KEY: input.env.DESCOPE_MANAGEMENT_KEY,
		DESCOPE_BASE_URL: input.env.DESCOPE_BASE_URL,
	});
	const tenantRead = () =>
		input.scopes.length > 0
			? fetchTenantConnectionTokenByScopes(
					client,
					descopeAppId,
					descopeTenantId,
					input.scopes,
				)
			: fetchTenantConnectionToken(client, descopeAppId, descopeTenantId);
	const userRead = () => {
		if (!input.ownerUserId) return Promise.resolve(null);
		return input.scopes.length > 0
			? fetchConnectionTokenByScopes(
					client,
					descopeAppId,
					input.ownerUserId,
					input.scopes,
				)
			: fetchConnectionToken(client, descopeAppId, input.ownerUserId);
	};

	try {
		const results = await Promise.allSettled([
			input.tokenScope === "user" ? Promise.resolve(null) : tenantRead(),
			input.tokenScope === "tenant" ? Promise.resolve(null) : userRead(),
		]);
		const [tenant, user] = results.map((result) =>
			result.status === "fulfilled" ? result.value : null,
		);
		if (tenant || user) {
			return {
				connected: true,
				cause: "connected",
				reason: tenant
					? "tenant connection is active"
					: "user connection is active",
			};
		}
		const failed = results.find((result) => result.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
		return {
			connected: false,
			cause: "no_token",
			reason:
				input.tokenScope !== "tenant" && !input.ownerUserId
					? "no tenant connection exists and no user identity is available"
					: `no active ${input.tokenScope} connection satisfies the requested scopes`,
		};
	} catch (error) {
		return {
			connected: false,
			cause: "verification_failed",
			reason: `connection verification failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
