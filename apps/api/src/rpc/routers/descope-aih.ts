/**
 * Descope AIH Management Router
 * Wraps Descope Management API for MCP Server + Client CRUD.
 */

import { implement, ORPCError } from "@orpc/server";
import { descopeAihContract } from "@tedix/api-contract/contracts/descope-aih";
import {
	buildTedixMcpAuthorizationAudiences,
	parseTedixMcpAudience,
	reconcileTedixMcpOwnershipTags,
} from "@tedix/auth/aih-audiences";
import {
	createDescopeMcpServerClient,
	deleteDescopeMcpServer,
	deleteDescopeMcpServerClient,
	exchangeAihClientCredentials,
	loadAllDescopeMcpServers,
	loadDescopeMcpServer,
	type McpServerClientRecord,
	registerDescopeMcpResource,
	searchDescopeMcpServerClients,
	updateDescopeMcpServer,
	updateDescopeMcpServerClient,
} from "@tedix/auth/aih-client";
import { isPlatformPrincipal } from "@tedix/auth/types";
import { getManagementClient } from "@tedix/auth/client";
import { deleteAppRelation } from "@tedix/auth/fga";
import { loadDescopeAihD1SnapshotRows } from "@tedix/db/queries/descope-aih-drift";
import { getAppById, getAppMetadataJson } from "@tedix/db/queries/app-records";
import { getAppBySlug } from "@tedix/db/queries/apps";
import { getDescopeAihDriftReport } from "../../services/descope-aih-drift";
import {
	extractMcpApprovedScopeNames,
	extractMcpDefaultGrantedScopeNames,
	isPlatformOperatorMcpResource,
	reconcileMcpPlatformScopes,
} from "../../services/descope-mcp-server-reconcile";
import {
	AUTHZ,
	withAuthorization,
	type BaseContext,
	createError,
	ErrorCodes,
	hasRequiredScope,
	withAuth,
} from "../orpc";
import { requireAihEnv } from "./descope-aih-env";

const TEDIX_UNIFIED_MCP_URL = "https://tedix-unified.mcp.tedix.dev/mcp";
const CI_MCP_SCOPE = "platform:admin";

const descopeAihOs = implement(descopeAihContract).$context<BaseContext>();
const authedOs = descopeAihOs.use(withAuth);

function isInternalServicePrincipal(context: BaseContext): boolean {
	return context.authType === "service-binding";
}

function assertAihManagementAccess(context: BaseContext): void {
	if (isInternalServicePrincipal(context) || isPlatformPrincipal(context)) {
		return;
	}

	throw createError(
		ErrorCodes.FORBIDDEN,
		"Descope AIH management requires platform-admin authority or service binding",
	);
}

function normalizedUrl(value: string): string {
	const url = new URL(value);
	url.hash = "";
	url.search = "";
	return url.toString().replace(/\/+$/, "");
}

function appSlugFromMcpUrl(value: string): string | null {
	return parseTedixMcpAudience(normalizedUrl(value))?.slug ?? null;
}

async function resolveCiMcpCredentialTarget(
	context: BaseContext,
	mcpServerUrl: string,
): Promise<{ appSlug: string; mcpServerId: string }> {
	const appSlug = appSlugFromMcpUrl(mcpServerUrl);
	if (!appSlug) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"CI MCP credential target must be a Tedix MCP app URL",
		);
	}

	const app = await getAppBySlug(context.db, appSlug);
	if (!app) {
		throw createError(ErrorCodes.NOT_FOUND, "MCP app not found");
	}

	const targetUrl = normalizedUrl(mcpServerUrl);
	if (
		!isPlatformPrincipal(context) &&
		(appSlug !== "tedix-unified" || targetUrl !== TEDIX_UNIFIED_MCP_URL)
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"CI MCP credential issuance is limited to Tedix Unified release smoke",
		);
	}

	if (!isPlatformPrincipal(context)) {
		if (context.authType !== "apikey") {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"CI MCP credential issuance requires API-key automation",
			);
		}
		if (
			!context.organizationId ||
			app.organizationId !== context.organizationId
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"CI MCP credential target must belong to the API key organization",
			);
		}
		if (!hasRequiredScope(context, "apps:write")) {
			throw createError(ErrorCodes.FORBIDDEN, "Scope 'apps:write' required");
		}
	}

	const metadata = getAppMetadataJson(app);
	const mcpServerId =
		typeof metadata?.mcpConfig?.descopeResourceId === "string"
			? metadata.mcpConfig.descopeResourceId
			: null;
	if (!mcpServerId) {
		throw createError(
			ErrorCodes.CONFLICT,
			"MCP app is missing a Descope AIH resource id",
		);
	}

	return { appSlug, mcpServerId };
}

function sortedUnique(values: Iterable<string | null | undefined>): string[] {
	return [...new Set([...values].filter(Boolean) as string[])].sort();
}

function clientIdOf(client: McpServerClientRecord): string | null {
	return client.clientId ?? client.client_id ?? null;
}

function clientAudit(client: McpServerClientRecord) {
	return {
		id: client.id,
		name: client.name ?? null,
		clientId: clientIdOf(client),
		mcpServerId: client.mcpServerId ?? null,
		status: client.status ?? null,
		scopes: sortedUnique(client.scopes ?? []),
		tags: sortedUnique(client.tags ?? []),
	};
}

function extractApprovedScopeNames(
	approvedScopes: Record<string, unknown> | null | undefined,
): string[] {
	const names: string[] = [];
	for (const value of Object.values(approvedScopes ?? {})) {
		if (!Array.isArray(value)) continue;
		for (const entry of value) {
			if (typeof entry === "string") {
				names.push(entry);
				continue;
			}
			if (entry && typeof entry === "object" && "name" in entry) {
				const name = (entry as { name?: unknown }).name;
				if (typeof name === "string" && name.trim()) names.push(name);
			}
		}
	}
	return sortedUnique(names);
}

function slugifyTag(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function sameStringSet(a: string[], b: string[]): boolean {
	const left = sortedUnique(a);
	const right = sortedUnique(b);
	return (
		left.length === right.length && left.every((value, i) => value === right[i])
	);
}

export const listMcpServersProcedure = authedOs.listMcpServers
	.use(AUTHZ.platformAdmin)
	.handler(async ({ context }) => {
		assertAihManagementAccess(context);
		const aihEnv = requireAihEnv(context.env);
		const servers = await loadAllDescopeMcpServers(aihEnv);
		return { servers };
	});

export const loadMcpServerProcedure = authedOs.loadMcpServer
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		assertAihManagementAccess(context);
		const aihEnv = requireAihEnv(context.env);
		const server = await loadDescopeMcpServer(aihEnv, input.mcpServerId);
		return { server };
	});

export const createMcpServerProcedure = authedOs.createMcpServer
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		assertAihManagementAccess(context);
		const aihEnv = requireAihEnv(context.env);
		const server = await registerDescopeMcpResource(aihEnv, {
			name: input.name,
			description: input.description,
			audienceWhitelist: input.audienceWhitelist,
			approvedScopes: input.approvedScopes,
			approvedCallbackUrls: input.approvedCallbackUrls,
			dynamicRegistration: input.dynamicRegistration,
			cimdSettings: input.cimdSettings,
			sessionSettings: input.sessionSettings,
			tags: input.tags,
			logo: input.logo,
			skipConsentScreen: input.skipConsentScreen,
			forceAddAllAuthorizationInfo: input.forceAddAllAuthorizationInfo,
		});
		return { server };
	});

export const updateMcpServerProcedure = authedOs.updateMcpServer
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		assertAihManagementAccess(context);
		const aihEnv = requireAihEnv(context.env);
		const server = await updateDescopeMcpServer(aihEnv, input.server);
		return { server };
	});

export const deleteMcpServerProcedure = authedOs.deleteMcpServer
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		assertAihManagementAccess(context);
		const aihEnv = requireAihEnv(context.env);
		await deleteDescopeMcpServer(aihEnv, input.mcpServerId);
		return { success: true as const };
	});

export const createMcpClientProcedure = authedOs.createMcpClient
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		assertAihManagementAccess(context);
		const aihEnv = requireAihEnv(context.env);
		// Delegate to the canonical helper, which handles the request (including
		// retry/base-url policy) and the nested-client response shape. Rethrow as
		// createError to preserve this procedure's error envelope (the helper
		// throws plain Error).
		try {
			return await createDescopeMcpServerClient(aihEnv, {
				name: input.name,
				mcpServerId: input.mcpServerId,
				scopes: input.scopes,
				tags: input.tags,
				approvedCallbackUrls: input.approvedCallbackUrls,
				logo: input.logo,
				forceAddAllAuthorizationInfo: input.forceAddAllAuthorizationInfo,
			});
		} catch (error) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				error instanceof Error
					? `AIH client create failed: ${error.message}`
					: "AIH client create failed",
			);
		}
	});

export const searchMcpClientsProcedure = authedOs.searchMcpClients
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		assertAihManagementAccess(context);
		const aihEnv = requireAihEnv(context.env);
		const clients = await searchDescopeMcpServerClients(aihEnv, {
			mcpServerId: input.mcpServerId,
			clientId: input.clientId,
		});
		return {
			clients: clients.map((client) => {
				const audit = clientAudit(client);
				return {
					...audit,
					name: audit.name ?? "",
					clientId: audit.clientId ?? "",
				};
			}),
		};
	});

export const updateMcpClientProcedure = authedOs.updateMcpClient
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		assertAihManagementAccess(context);
		const aihEnv = requireAihEnv(context.env);
		const client = await updateDescopeMcpServerClient(aihEnv, {
			id: input.id,
			mcpServerId: input.mcpServerId,
			name: input.name,
			scopes: input.scopes,
			tags: input.tags,
			approvedCallbackUrls: input.approvedCallbackUrls,
			logo: input.logo,
		});
		return { client: clientAudit(client) };
	});

export const deleteMcpClientProcedure = authedOs.deleteMcpClient
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		assertAihManagementAccess(context);
		const aihEnv = requireAihEnv(context.env);
		await deleteDescopeMcpServerClient(aihEnv, {
			id: input.id,
			mcpServerId: input.mcpServerId,
		});
		return { success: true as const };
	});

export const repairDevtoolDcrClientsProcedure = authedOs.repairDevtoolDcrClients
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		assertAihManagementAccess(context);
		const aihEnv = requireAihEnv(context.env);
		const dryRun = input.dryRun ?? true;
		const server = await loadDescopeMcpServer(aihEnv, input.mcpServerId);
		const clients = await searchDescopeMcpServerClients(aihEnv, {
			mcpServerId: input.mcpServerId,
		});
		const names = new Set(
			(input.clientNames ?? ["Codex", "Claude Code", "MCPJam"]).map((name) =>
				name.toLowerCase(),
			),
		);
		const desiredScopes = sortedUnique(
			input.scopes ?? extractApprovedScopeNames(server.approvedScopes),
		);
		const serverTag = `server:${slugifyTag(server.name) || server.id}`;
		const matched = clients.filter(
			(client) =>
				names.has((client.name ?? "").toLowerCase()) ||
				(client.tags ?? []).includes("purpose:devtool"),
		);

		let updated = 0;
		let pruned = 0;
		let skipped = 0;
		const actions = [];

		for (const client of matched) {
			const currentScopes = sortedUnique(client.scopes ?? []);
			const currentTags = sortedUnique(client.tags ?? []);
			const clientNameTag = client.name
				? `client:${slugifyTag(client.name)}`
				: "client:devtool";
			const desiredTags = sortedUnique([
				...currentTags,
				clientNameTag,
				"purpose:devtool",
				client.clientId?.startsWith("https://")
					? "registration:cimd"
					: "registration:dcr",
				serverTag,
				...(input.tags ?? []),
			]);
			const shouldPrune =
				input.pruneEmptyScopeClients === true && currentScopes.length === 0;
			const needsUpdate =
				!sameStringSet(currentScopes, desiredScopes) ||
				!sameStringSet(currentTags, desiredTags);
			const action = {
				id: client.id,
				name: client.name ?? null,
				clientId: clientIdOf(client),
				status: client.status ?? null,
				action: shouldPrune
					? dryRun
						? ("would_delete" as const)
						: ("deleted" as const)
					: needsUpdate
						? dryRun
							? ("would_update" as const)
							: ("updated" as const)
						: ("skipped" as const),
				reason: shouldPrune
					? dryRun
						? "Empty-scope devtool client would be pruned"
						: "Empty-scope devtool client pruned"
					: needsUpdate
						? dryRun
							? "Client differs from desired devtool scopes/tags"
							: "Client repaired with desired devtool scopes/tags"
						: "Client already matches desired scopes/tags",
				before: { scopes: currentScopes, tags: currentTags },
				after: shouldPrune
					? { scopes: [], tags: currentTags }
					: { scopes: desiredScopes, tags: desiredTags },
			};

			if (shouldPrune && !dryRun) {
				await deleteDescopeMcpServerClient(aihEnv, {
					id: client.id,
					mcpServerId: input.mcpServerId,
				});
				pruned++;
			} else if (shouldPrune) {
				pruned++;
			} else if (needsUpdate && !dryRun) {
				await updateDescopeMcpServerClient(aihEnv, {
					id: client.id,
					mcpServerId: input.mcpServerId,
					name: client.name ?? "Devtool",
					scopes: desiredScopes,
					tags: desiredTags,
					approvedCallbackUrls: Array.isArray(client.approvedCallbackUrls)
						? (client.approvedCallbackUrls as string[])
						: undefined,
					logo: typeof client.logo === "string" ? client.logo : undefined,
				});
				updated++;
			} else if (needsUpdate) {
				updated++;
			} else {
				skipped++;
			}
			actions.push(action);
		}

		return {
			dryRun,
			mcpServerId: input.mcpServerId,
			serverName: server.name,
			matched: matched.length,
			updated,
			pruned,
			skipped,
			desiredScopes,
			desiredTags: sortedUnique([
				"purpose:devtool",
				"registration:dcr",
				"registration:cimd",
				serverTag,
				...(input.tags ?? []),
			]),
			actions,
		};
	});

export const exchangeClientCredentialsProcedure =
	authedOs.exchangeClientCredentials
		.use(AUTHZ.platformAdmin)
		.handler(async ({ input, context }) => {
			assertAihManagementAccess(context);
			const aihEnv = requireAihEnv(context.env);
			const server = await loadDescopeMcpServer(aihEnv, input.mcpServerId);
			const resource = server.audienceWhitelist?.[0];
			if (!resource) {
				throw new Error("AIH MCP server is missing its Resource audience");
			}
			const result = await exchangeAihClientCredentials(
				{ DESCOPE_PROJECT_ID: aihEnv.DESCOPE_PROJECT_ID },
				resource,
				input.clientId,
				input.clientSecret,
			);
			return result;
		});

export const issueCiMcpCredentialProcedure = authedOs.issueCiMcpCredential
	.use(withAuthorization("platform:admin", "apps:write"))
	.handler(async ({ input, context }) => {
		// The Descope helpers throw plain Error; without mapping, any throw here
		// surfaces as a raw oRPC 500 with no diagnosable message. Rethrow as
		// createError (same pattern as createMcpClientProcedure), passing through
		// deliberate ORPCErrors from resolveCiMcpCredentialTarget/requireAihEnv.
		try {
			const aihEnv = requireAihEnv(context.env);
			const { appSlug, mcpServerId } = await resolveCiMcpCredentialTarget(
				context,
				input.mcpServerUrl,
			);
			const runId = context.headers.get("X-GitHub-Run-Id") ?? Date.now();
			const client = await createDescopeMcpServerClient(aihEnv, {
				forceAddAllAuthorizationInfo: true,
				mcpServerId,
				name: input.clientName ?? `Tedix CI release smoke ${runId}`,
				scopes: [CI_MCP_SCOPE],
				tags: [
					"ci",
					"ci:release-smoke",
					"release-smoke",
					"kernel-live-proof",
					`app:${appSlug}`,
					`github-run:${runId}`,
				],
			});

			try {
				const token = await exchangeAihClientCredentials(
					{ DESCOPE_PROJECT_ID: aihEnv.DESCOPE_PROJECT_ID },
					input.mcpServerUrl,
					client.clientId,
					client.clientSecret,
				);
				return {
					accessToken: token.accessToken,
					clientId: client.id,
					expiresIn: token.expiresIn,
					mcpServerId,
				};
			} catch (error) {
				await deleteDescopeMcpServerClient(aihEnv, {
					id: client.id,
					mcpServerId,
				}).catch(() => {});
				throw error;
			}
		} catch (error) {
			if (error instanceof ORPCError) throw error;
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				error instanceof Error
					? `CI MCP credential issuance failed: ${error.message}`
					: "CI MCP credential issuance failed",
			);
		}
	});

export const deleteCiMcpCredentialClientProcedure =
	authedOs.deleteCiMcpCredentialClient
		.use(withAuthorization("platform:admin", "apps:write"))
		.handler(async ({ input, context }) => {
			const aihEnv = requireAihEnv(context.env);
			const { mcpServerId } = await resolveCiMcpCredentialTarget(
				context,
				input.mcpServerUrl,
			);
			if (input.mcpServerId !== mcpServerId) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"CI MCP credential client does not belong to the requested MCP server",
				);
			}
			await deleteDescopeMcpServerClient(aihEnv, {
				id: input.clientId,
				mcpServerId,
			});
			return { success: true as const };
		});

export const auditDriftProcedure = authedOs.auditDrift
	.use(AUTHZ.platformAdmin)
	.handler(async ({ context }) => {
		assertAihManagementAccess(context);
		const aihEnv = requireAihEnv(context.env);
		return getDescopeAihDriftReport({
			db: context.db,
			env: aihEnv,
		});
	});

export const repairStaleFgaRelationProcedure = authedOs.repairStaleFgaRelation
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		assertAihManagementAccess(context);
		const app = await getAppById(context.db, input.appId);
		if (app) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Refusing FGA repair because the referenced D1 app still exists",
			);
		}

		const dryRun = input.dryRun ?? true;
		if (!dryRun) {
			await deleteAppRelation(
				getManagementClient(context.env),
				input.targetUserId,
				input.appId,
				input.relation,
			);
		}

		return {
			appId: input.appId,
			targetUserId: input.targetUserId,
			relation: input.relation,
			dryRun,
			deleted: !dryRun,
		};
	});

export const auditOrganizationDriftProcedure = authedOs.auditOrganizationDrift
	.use(AUTHZ.appsRead)
	.handler(async ({ context }) => {
		if (!context.organizationId) {
			throw createError(ErrorCodes.FORBIDDEN, "Organization context required");
		}
		return getDescopeAihDriftReport({
			db: context.db,
			env: requireAihEnv(context.env),
			organizationId: context.organizationId,
		});
	});

export const reconcileMcpAppServersProcedure = authedOs.reconcileMcpAppServers
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		assertAihManagementAccess(context);
		const dryRun = input.dryRun ?? true;
		const appFilter = input.appIds ? new Set(input.appIds) : null;
		const aihEnv = requireAihEnv(context.env);
		const [{ appRows }, servers] = await Promise.all([
			loadDescopeAihD1SnapshotRows(context.db),
			loadAllDescopeMcpServers(aihEnv),
		]);
		const serverById = new Map(servers.map((server) => [server.id, server]));
		const actions = [];

		for (const app of appRows.sort((a, b) => a.slug.localeCompare(b.slug))) {
			if (appFilter && !appFilter.has(app.id)) continue;
			const metadata = getAppMetadataJson(app);
			const mcpServerId = metadata?.mcpConfig?.descopeResourceId;
			if (typeof mcpServerId !== "string" || !mcpServerId) continue;
			const server = serverById.get(mcpServerId);
			const before = {
				audienceWhitelist: [...(server?.audienceWhitelist ?? [])],
				tags: [...(server?.tags ?? [])],
				approvedScopes: extractMcpApprovedScopeNames(server?.approvedScopes),
				defaultGrantedScopes: extractMcpDefaultGrantedScopeNames(
					server?.approvedScopes,
				),
			};
			const approvedScopes = reconcileMcpPlatformScopes(
				server?.approvedScopes,
				{
					allowPlatformAdmin: isPlatformOperatorMcpResource(app.slug),
				},
			);
			const after = {
				audienceWhitelist: buildTedixMcpAuthorizationAudiences(app.slug),
				tags: reconcileTedixMcpOwnershipTags(server?.tags, { app: app.slug }),
				approvedScopes: extractMcpApprovedScopeNames(approvedScopes),
				defaultGrantedScopes:
					extractMcpDefaultGrantedScopeNames(approvedScopes),
			};

			if (!server) {
				actions.push({
					appId: app.id,
					appSlug: app.slug,
					mcpServerId,
					serverName: null,
					action: "missing" as const,
					before,
					after,
				});
				continue;
			}

			const changed =
				!sameStringSet(before.audienceWhitelist, after.audienceWhitelist) ||
				!sameStringSet(before.tags, after.tags) ||
				!sameStringSet(before.approvedScopes, after.approvedScopes) ||
				!sameStringSet(before.defaultGrantedScopes, after.defaultGrantedScopes);
			if (changed && !dryRun) {
				const updated = await updateDescopeMcpServer(aihEnv, {
					...server,
					audienceWhitelist: after.audienceWhitelist,
					tags: after.tags,
					approvedScopes,
				});
				if (
					!sameStringSet(
						updated.audienceWhitelist ?? [],
						after.audienceWhitelist,
					) ||
					!sameStringSet(updated.tags ?? [], after.tags) ||
					!sameStringSet(
						extractMcpApprovedScopeNames(updated.approvedScopes),
						after.approvedScopes,
					) ||
					!sameStringSet(
						extractMcpDefaultGrantedScopeNames(updated.approvedScopes),
						after.defaultGrantedScopes,
					)
				) {
					throw createError(
						ErrorCodes.CONFLICT,
						`Descope MCP server ${mcpServerId} failed desired-state readback`,
					);
				}
			}

			actions.push({
				appId: app.id,
				appSlug: app.slug,
				mcpServerId,
				serverName: server.name,
				action: changed
					? dryRun
						? ("would_update" as const)
						: ("updated" as const)
					: ("skipped" as const),
				before,
				after,
			});
		}

		return {
			dryRun,
			examined: actions.length,
			changed: actions.filter((action) =>
				["would_update", "updated"].includes(action.action),
			).length,
			actions,
		};
	});

export const descopeAihContractRouter = descopeAihOs.router({
	listMcpServers: listMcpServersProcedure,
	loadMcpServer: loadMcpServerProcedure,
	createMcpServer: createMcpServerProcedure,
	updateMcpServer: updateMcpServerProcedure,
	deleteMcpServer: deleteMcpServerProcedure,
	createMcpClient: createMcpClientProcedure,
	searchMcpClients: searchMcpClientsProcedure,
	updateMcpClient: updateMcpClientProcedure,
	deleteMcpClient: deleteMcpClientProcedure,
	repairDevtoolDcrClients: repairDevtoolDcrClientsProcedure,
	exchangeClientCredentials: exchangeClientCredentialsProcedure,
	issueCiMcpCredential: issueCiMcpCredentialProcedure,
	deleteCiMcpCredentialClient: deleteCiMcpCredentialClientProcedure,
	auditDrift: auditDriftProcedure,
	repairStaleFgaRelation: repairStaleFgaRelationProcedure,
	auditOrganizationDrift: auditOrganizationDriftProcedure,
	reconcileMcpAppServers: reconcileMcpAppServersProcedure,
});
