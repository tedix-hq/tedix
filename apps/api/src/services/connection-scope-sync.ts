import { loadDescopeMcpServer, type AihEnv } from "@tedix/auth/aih-client";
import { updateMcpServerRegistration } from "../lib/provider-facts-cache";
import {
	reconcileConnectionScopeMappings,
	connectionScopeMappingState,
	type ConnectionScopeConfig,
} from "@tedix/api-contract/utils/mcp-scope-catalog";
import { syncConnectionProviderScopes } from "@tedix/auth/connections";
import type { DbClient } from "@tedix/db/client";
import {
	buildConnectionProviderMaps,
	listConnectionProviders,
} from "@tedix/db/queries/connection-providers";

/** Shared defaults come from the provider registry, never a tenant's scope override. */
export async function syncDeclaredConnectionScopes(params: {
	db: DbClient;
	env: AihEnv;
	appSlug: string;
	config: ConnectionScopeConfig & { descopeResourceId?: string };
	syncProviderDefaults: boolean;
	dryRun?: boolean;
}) {
	const { config, env, db, syncProviderDefaults, dryRun = true } = params;
	const defaults = [];
	if (syncProviderDefaults) {
		const { byDescopeAppId } = buildConnectionProviderMaps(
			await listConnectionProviders(db),
		);
		const ids = new Set([
			config.connectionProviderId,
			...(config.aggregateApps ?? []).map(
				(entry) => entry.connectionProviderId,
			),
		]);
		for (const id of ids) {
			if (!id) continue;
			const provider = byDescopeAppId.get(id);
			if (provider?.type !== "oauth") continue;
			const scopes =
				provider.credentialProfile?.defaultScopes ?? provider.requiredScopes;
			if (!scopes.length) continue;
			defaults.push({
				providerId: id,
				...(await syncConnectionProviderScopes(id, scopes, env, dryRun)),
			});
		}
	}
	let mappingChanged = false;
	if (config.descopeResourceId) {
		const server = await loadDescopeMcpServer(env, config.descopeResourceId);
		if (
			!syncProviderDefaults &&
			!server.tags?.includes(`app:${params.appSlug}`)
		) {
			throw new Error(
				`Descope MCP server ${server.id} is not owned by app ${params.appSlug}`,
			);
		}
		const approvedScopes = reconcileConnectionScopeMappings(
			server.approvedScopes,
			config,
		);
		mappingChanged =
			JSON.stringify(connectionScopeMappingState(server.approvedScopes)) !==
			JSON.stringify(connectionScopeMappingState(approvedScopes));
		if (mappingChanged && !dryRun) {
			const updated = await updateMcpServerRegistration(env, {
				...server,
				approvedScopes,
			});
			if (
				JSON.stringify(connectionScopeMappingState(updated.approvedScopes)) !==
				JSON.stringify(connectionScopeMappingState(approvedScopes))
			) {
				throw new Error(
					`Descope MCP server ${server.id} connection scope readback failed`,
				);
			}
		}
	}
	return { defaults, mappingChanged };
}
