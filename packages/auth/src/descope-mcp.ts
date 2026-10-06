import { DESCOPE_DEFAULT_BASE_URL } from "@tedix/auth/types";

export type DescopeMcpSyncStrategy = "descope-api" | "resource-metadata";

export interface DescopeMcpEnvLike {
	DESCOPE_BASE_URL?: string;
	DESCOPE_MANAGEMENT_KEY?: string;
	DESCOPE_PROJECT_ID?: string;
}

export interface DescopeMcpScopeSyncConfigLike {
	enabled?: boolean;
	strategy?: DescopeMcpSyncStrategy;
	lastSyncedAt?: string;
	lastError?: string;
}

export interface DescopeMcpConfigLike {
	authMode?: "public" | "authenticated" | string;
	descopeResourceId?: string;
	scopeSync?: DescopeMcpScopeSyncConfigLike;
}

export interface ResolvedDescopeMcpScopeSyncConfig {
	enabled: boolean;
	strategy: DescopeMcpSyncStrategy;
	lastError: string | null;
	lastSyncedAt: string | null;
}

export function getDescopeBaseUrl(env: DescopeMcpEnvLike): string {
	return env.DESCOPE_BASE_URL || DESCOPE_DEFAULT_BASE_URL;
}

export function getDescopeManagementAuthHeader(env: DescopeMcpEnvLike): string {
	if (!env.DESCOPE_PROJECT_ID || !env.DESCOPE_MANAGEMENT_KEY) {
		throw new Error(
			"Descope configuration missing (DESCOPE_PROJECT_ID or DESCOPE_MANAGEMENT_KEY)",
		);
	}
	return `Bearer ${env.DESCOPE_PROJECT_ID}:${env.DESCOPE_MANAGEMENT_KEY}`;
}

export function buildDescopeMcpDiscoveryUrl(params: {
	baseUrl?: string;
	projectId: string;
	resourceId: string;
}): string {
	return `${params.baseUrl ?? DESCOPE_DEFAULT_BASE_URL}/v1/apps/agentic/${params.projectId}/${params.resourceId}/.well-known/openid-configuration`;
}

export function extractDescopeMcpResourceId(result: {
	id?: string;
	mcpServerId?: string;
	resourceId?: string;
	serverId?: string;
}): string | null {
	return (
		result.id ??
		result.mcpServerId ??
		result.resourceId ??
		result.serverId ??
		null
	);
}

export function resolveDescopeMcpScopeSyncConfig(
	mcpConfig: DescopeMcpConfigLike | null | undefined,
): ResolvedDescopeMcpScopeSyncConfig {
	const configured = mcpConfig?.scopeSync;
	const strategy =
		configured?.strategy ??
		(mcpConfig?.authMode === "authenticated"
			? "descope-api"
			: "resource-metadata");

	return {
		enabled: configured?.enabled ?? strategy === "descope-api",
		strategy,
		lastError: configured?.lastError ?? null,
		lastSyncedAt: configured?.lastSyncedAt ?? null,
	};
}
