import type { ConnectionProviderTemplate } from "@tedix/api-contract/schemas/connection-provider-templates";
import type { DescopeAihDriftReport } from "@tedix/api-contract/schemas/descope-aih";
import {
	loadAllDescopeMcpServers,
	searchDescopeMcpServerClients,
} from "@tedix/auth/aih-client";
import { createDescopeClient } from "@tedix/auth/descope";
import { readDescopeRolePermissionNames } from "@tedix/auth/descope-rbac-sync";
import { queryTediRelations } from "@tedix/auth/fga";
import {
	buildTedixMcpAuthorizationAudiences,
	parseTedixMcpAudience,
	reconcileTedixMcpOwnershipTags,
	TEDIX_MCP_OWNED_TAG_PREFIXES,
} from "@tedix/auth/aih-audiences";
import type { DbClient } from "@tedix/db/client";
import {
	buildConnectionProviderMaps,
	listConnectionProviders,
} from "@tedix/db/queries/connection-providers";
import { loadDescopeAihD1SnapshotRows } from "@tedix/db/queries/descope-aih-drift";
import {
	constrainToApprovedMcpServerScopes,
	resolveTediAihClientScopesForApp,
} from "../lib/tedi-aih-client-sync";

type JsonRecord = Record<string, unknown>;

type DescopeServer = {
	id: string;
	name: string;
	audienceWhitelist?: string[] | null;
	tags?: string[] | null;
	loginPageURL?: string | null;
	loginPageUrl?: string | null;
	dynamicRegistration?: {
		flowId?: string | null;
		disableApprovedScopesAsDefault?: boolean | null;
	} | null;
	approvedScopes?: Record<string, unknown> | null;
};

type DescopeClient = {
	id?: string;
	name?: string | null;
	clientId?: string | null;
	client_id?: string | null;
	mcpServerId?: string | null;
	status?: string | null;
	scopes?: string[] | null;
	tags?: string[] | null;
};

type DescopeOutboundApp = {
	id?: string;
	name?: string | null;
	appType?: string | null;
	clientId?: string | null;
	clientSecret?: string | null;
	logo?: string | null;
	useDcr?: boolean | null;
	dcrUrl?: string | null;
	authorizationUrl?: string | null;
	tokenUrl?: string | null;
	defaultScopes?: string[] | null;
};

type DescopeTenant = { id?: string; name?: string | null };

type DescopeRole = {
	name?: string;
	permissionNames?: string[] | null;
	permissionsNames?: string[] | null;
};

type DescopeFgaRelation = {
	target?: string;
	relationDefinition: string;
	namespace: string;
	resource: string;
};

export type DescopeAihDriftSnapshot = {
	checkedAt: string;
	projectId: string;
	servers: DescopeServer[];
	clientsByServerId: Map<string, DescopeClient[]>;
	outboundApps: DescopeOutboundApp[];
	tenants: DescopeTenant[];
	roles: DescopeRole[];
	fgaRelations: DescopeFgaRelation[];
	fgaQueryError?: string | null;
	providers: ConnectionProviderTemplate[];
	d1Apps: Array<{
		id: string;
		slug: string;
		name: string;
		descopeResourceId: string | null;
		authMode: string | null;
		codeMode: boolean | null;
		connectionProviderId: string | null;
		metadata?: unknown;
	}>;
	d1Tedis: Array<{
		id: string;
		slug: string;
		name: string;
		descopeMcpResourceId: string | null;
		descopeUserId: string | null;
		mcpCapabilityProfile?: string | null;
	}>;
};

type DescopeManagementEnv = {
	DESCOPE_PROJECT_ID: string;
	DESCOPE_MANAGEMENT_KEY: string;
	DESCOPE_BASE_URL?: string;
	DESCOPE_FGA_CACHE_URL?: string;
};

// The only consent flow. Tedix OS preselects the organization named by the
// `tenant` authorization parameter the CLI passes after its organization picker.
const CONSENT_FLOW = "inbound-apps-multi-org-consent";
const TEDIX_CLI_CIMD_DOMAIN = "os.tedix.dev";
const BROAD_SCOPE_NAMES = new Set([
	"platform:admin",
	"mcp:apps",
	"mcp:memory",
	"mcp:skills",
	"mcp:tedis",
	"tedi:admin",
]);

const EXPECTED_OUTBOUND_APP_TYPE = {
	oauth: "oauth",
	api_key: "apikey",
} as const;

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: {};
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function extractApprovedScopeNames(
	approvedScopes: Record<string, unknown> | null | undefined,
): string[] {
	const names = new Set<string>();
	for (const value of Object.values(approvedScopes ?? {})) {
		if (!Array.isArray(value)) continue;
		for (const entry of value) {
			if (typeof entry === "string") {
				names.add(entry);
				continue;
			}
			const name = stringOrNull(asRecord(entry).name);
			if (name) names.add(name);
		}
	}
	return [...names].sort();
}

function normalizeClient(client: DescopeClient) {
	return {
		id: client.id ?? "",
		name: client.name ?? null,
		clientId: client.clientId ?? client.client_id ?? null,
		mcpServerId: client.mcpServerId ?? null,
		status: client.status ?? null,
		scopes: [...(client.scopes ?? [])].sort(),
		tags: [...(client.tags ?? [])].sort(),
	};
}

function loginFlow(server: DescopeServer): string | null {
	const url = server.loginPageURL ?? server.loginPageUrl;
	if (!url) return null;
	try {
		return new URL(url).searchParams.get("flow");
	} catch {
		return null;
	}
}

function hasBroadScope(client: DescopeClient): boolean {
	return (client.scopes ?? []).some((scope) => BROAD_SCOPE_NAMES.has(scope));
}

function hasBroadApprovedScope(server: DescopeServer): boolean {
	return extractApprovedScopeNames(server.approvedScopes).some((scope) =>
		BROAD_SCOPE_NAMES.has(scope),
	);
}

function cimdDomainPolicies(server: DescopeServer): string[] {
	const settings = asRecord(asRecord(server).cimdSettings);
	const domainPolicies = asRecord(settings.domainPolicies);
	const policies = Array.isArray(domainPolicies.policies)
		? domainPolicies.policies
		: [];
	return policies
		.map((policy) => stringOrNull(asRecord(policy).domainPattern))
		.filter((pattern): pattern is string => Boolean(pattern))
		.sort();
}

function cimdEnabled(server: DescopeServer): boolean {
	const settings = asRecord(asRecord(server).cimdSettings);
	return settings.enabled === true;
}

function sessionSettingsEnabled(server: DescopeServer): boolean {
	const settings = asRecord(asRecord(server).sessionSettings);
	return settings.enabled === true;
}

function isTaggedTediClient(client: DescopeClient): boolean {
	return (client.tags ?? []).some((tag) => tag.startsWith("tedi:"));
}

function isPeerTediClient(client: DescopeClient): boolean {
	return (client.tags ?? []).some(
		(tag) => tag.startsWith("peer:") || tag.startsWith("peer-tedi:"),
	);
}

function ownedTagValue(client: DescopeClient, prefix: "tedi:" | "app:") {
	const values = normalizeStrings(client.tags)
		.filter((tag) => tag.startsWith(prefix))
		.map((tag) => tag.slice(prefix.length))
		.filter(Boolean);
	return values.length === 1 ? values[0] : null;
}

/** Re-exported shape reader — see `readDescopeRolePermissionNames` for why. */
function rolePermissionNames(role: DescopeRole): string[] {
	return readDescopeRolePermissionNames(role);
}

function normalizeScopes(scopes: string[] | null | undefined): string[] {
	return [
		...new Set((scopes ?? []).map((scope) => scope.trim()).filter(Boolean)),
	].sort();
}

function normalizeStrings(values: string[] | null | undefined): string[] {
	return [
		...new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
	].sort();
}

function isWildcardAudience(audience: string): boolean {
	return audience.includes("*");
}

function isManagedMcpServerTag(tag: string): boolean {
	return TEDIX_MCP_OWNED_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix));
}

function normalizeMcpConfig(metadata: unknown): JsonRecord {
	return asRecord(asRecord(metadata).mcpConfig);
}

function issue(
	report: DescopeAihDriftReport,
	params: DescopeAihDriftReport["issues"][number],
) {
	report.issues.push(params);
	report.summary.issues[params.severity] += 1;
}

export function buildDescopeAihDriftReport(
	snapshot: DescopeAihDriftSnapshot,
): DescopeAihDriftReport {
	const serverIds = new Set(snapshot.servers.map((server) => server.id));
	const serversById = new Map(
		snapshot.servers.map((server) => [server.id, server]),
	);
	const referencedServerIds = new Set<string>();
	const d1AppIds = new Set(snapshot.d1Apps.map((app) => app.id));
	const d1AppsBySlug = new Map(snapshot.d1Apps.map((app) => [app.slug, app]));
	const d1TedisById = new Map(snapshot.d1Tedis.map((tedi) => [tedi.id, tedi]));
	const roleByTediAndApp = new Map<string, "operator" | "observer">();
	if (!snapshot.fgaQueryError) {
		const tediIdByDescopeUserId = new Map(
			snapshot.d1Tedis
				.filter((tedi) => tedi.descopeUserId)
				.map((tedi) => [tedi.descopeUserId!, tedi.id]),
		);
		for (const relation of snapshot.fgaRelations) {
			if (
				relation.namespace !== "app" ||
				!relation.target ||
				!["operator", "observer"].includes(relation.relationDefinition)
			) {
				continue;
			}
			const tediId = tediIdByDescopeUserId.get(relation.target);
			if (!tediId) continue;
			const key = `${tediId}:${relation.resource}`;
			if (
				relation.relationDefinition === "operator" ||
				!roleByTediAndApp.has(key)
			) {
				roleByTediAndApp.set(
					key,
					relation.relationDefinition as "operator" | "observer",
				);
			}
		}
	}
	const outboundAppIds = new Set(
		snapshot.outboundApps.map((app) => app.id).filter(Boolean) as string[],
	);
	const outboundAppsById = new Map(
		snapshot.outboundApps
			.filter((app): app is DescopeOutboundApp & { id: string } => !!app.id)
			.map((app) => [app.id, app]),
	);
	const { byDescopeAppId: providerByDescopeId } = buildConnectionProviderMaps(
		snapshot.providers,
	);

	const d1Apps = snapshot.d1Apps
		.filter((app) => app.descopeResourceId)
		.map((app) => {
			referencedServerIds.add(app.descopeResourceId!);
			return {
				id: app.id,
				slug: app.slug,
				name: app.name,
				descopeResourceId: app.descopeResourceId!,
				authMode: app.authMode,
				codeMode: app.codeMode,
				connectionProviderId: app.connectionProviderId,
			};
		})
		.sort((a, b) => a.slug.localeCompare(b.slug));

	const d1Tedis = snapshot.d1Tedis
		.filter((tedi) => tedi.descopeMcpResourceId)
		.map((tedi) => {
			referencedServerIds.add(tedi.descopeMcpResourceId!);
			return {
				id: tedi.id,
				slug: tedi.slug,
				name: tedi.name,
				descopeMcpResourceId: tedi.descopeMcpResourceId!,
				descopeUserId: tedi.descopeUserId,
			};
		})
		.sort((a, b) => a.slug.localeCompare(b.slug));

	const report: DescopeAihDriftReport = {
		checkedAt: snapshot.checkedAt,
		projectId: snapshot.projectId,
		summary: {
			mcpServers: snapshot.servers.length,
			mcpClients: 0,
			outboundApps: snapshot.outboundApps.length,
			tenants: snapshot.tenants.length,
			roles: snapshot.roles.length,
			d1AppsWithDescopeResource: d1Apps.length,
			d1TedisWithDescopeResource: d1Tedis.length,
			issues: { critical: 0, warning: 0, info: 0 },
		},
		issues: [],
		mcpServers: [],
		d1Apps,
		d1Tedis,
		outboundApps: snapshot.outboundApps
			.filter((app): app is DescopeOutboundApp & { id: string } => !!app.id)
			.map((app) => ({
				id: app.id,
				name: app.name ?? null,
				appType: app.appType ?? null,
				hasClientId: Boolean(app.clientId),
				hasClientSecret: Boolean(app.clientSecret),
				hasLogo: Boolean(app.logo),
				useDcr: app.useDcr ?? null,
				dcrUrl: app.dcrUrl ?? null,
				authorizationUrl: app.authorizationUrl ?? null,
				tokenUrl: app.tokenUrl ?? null,
				defaultScopes: [...(app.defaultScopes ?? [])].sort(),
			}))
			.sort((a, b) => a.id.localeCompare(b.id)),
		connectionProviders: [],
	};

	for (const app of d1Apps) {
		const server = serversById.get(app.descopeResourceId);
		if (!server) {
			issue(report, {
				severity: "critical",
				code: "d1_descope_resource_missing",
				resourceType: "d1_app",
				resourceId: app.id,
				resourceName: app.slug,
				message: `D1 app ${app.slug} points at missing Descope MCP server ${app.descopeResourceId}.`,
				details: { descopeResourceId: app.descopeResourceId },
			});
			continue;
		}

		const expectedAudiences = buildTedixMcpAuthorizationAudiences(app.slug);
		const actualAudiences = normalizeStrings(server.audienceWhitelist);
		const expectedAudienceSet = new Set(expectedAudiences);
		const actualAudienceSet = new Set(actualAudiences);
		const missingAudiences = expectedAudiences.filter(
			(audience) => !actualAudienceSet.has(audience),
		);
		const wildcardAudiences = actualAudiences.filter(isWildcardAudience);
		const unexpectedAudiences = actualAudiences.filter(
			(audience) => !expectedAudienceSet.has(audience),
		);
		const unknownAudiences = actualAudiences.filter((audience) => {
			if (isWildcardAudience(audience)) return false;
			const parsed = parseTedixMcpAudience(audience);
			return (
				!parsed ||
				parsed.slug !== app.slug ||
				!expectedAudienceSet.has(audience)
			);
		});

		if (missingAudiences.length > 0 || unexpectedAudiences.length > 0) {
			issue(report, {
				severity: "warning",
				code: "mcp_server_audience_drift",
				resourceType: "mcp_server",
				resourceId: server.id,
				resourceName: server.name,
				message: `Descope MCP server ${server.name} does not have the exact managed audiences for D1 app ${app.slug}.`,
				details: {
					appId: app.id,
					appSlug: app.slug,
					expectedAudiences,
					actualAudiences,
					missingAudiences,
					unexpectedAudiences,
					unknownAudiences,
				},
			});
		}

		if (wildcardAudiences.length > 0) {
			issue(report, {
				severity: "critical",
				code: "mcp_server_audience_wildcard",
				resourceType: "mcp_server",
				resourceId: server.id,
				resourceName: server.name,
				message: `Descope MCP server ${server.name} admits wildcard audiences; Tedix MCP resources require exact origins.`,
				details: { appId: app.id, appSlug: app.slug, wildcardAudiences },
			});
		}

		if (unknownAudiences.length > 0) {
			issue(report, {
				severity: "critical",
				code: "mcp_server_audience_unknown",
				resourceType: "mcp_server",
				resourceId: server.id,
				resourceName: server.name,
				message: `Descope MCP server ${server.name} admits audiences outside the managed Tedix environment set for ${app.slug}.`,
				details: { appId: app.id, appSlug: app.slug, unknownAudiences },
			});
		}

		const actualTags = normalizeStrings(server.tags);
		const expectedTags = reconcileTedixMcpOwnershipTags([], {
			app: app.slug,
		});
		const expectedTagSet = new Set(expectedTags);
		const actualManagedTags = actualTags.filter(isManagedMcpServerTag);
		const missingTags = expectedTags.filter((tag) => !actualTags.includes(tag));
		const unexpectedManagedTags = actualManagedTags.filter(
			(tag) => !expectedTagSet.has(tag),
		);
		if (missingTags.length > 0 || unexpectedManagedTags.length > 0) {
			issue(report, {
				severity: "warning",
				code: "mcp_server_ownership_tag_drift",
				resourceType: "mcp_server",
				resourceId: server.id,
				resourceName: server.name,
				message: `Descope MCP server ${server.name} has stale or incomplete Tedix ownership tags for D1 app ${app.slug}.`,
				details: {
					appId: app.id,
					appSlug: app.slug,
					expectedTags,
					actualTags,
					missingTags,
					unexpectedManagedTags,
				},
			});
		}
	}

	for (const tedi of d1Tedis) {
		if (!serverIds.has(tedi.descopeMcpResourceId)) {
			issue(report, {
				severity: "critical",
				code: "d1_tedi_resource_missing",
				resourceType: "d1_tedi",
				resourceId: tedi.id,
				resourceName: tedi.slug,
				message: `D1 tedi ${tedi.slug} points at missing Descope MCP server ${tedi.descopeMcpResourceId}.`,
				details: { descopeMcpResourceId: tedi.descopeMcpResourceId },
			});
		}
	}

	for (const server of snapshot.servers) {
		const clients = snapshot.clientsByServerId.get(server.id) ?? [];
		report.summary.mcpClients += clients.length;
		const normalizedClients = clients.map(normalizeClient);
		const untaggedClients = normalizedClients.filter(
			(client) => client.tags.length === 0,
		);
		const broadClients = clients.filter(hasBroadScope);
		const codexClients = normalizedClients.filter(
			(client) => client.name?.toLowerCase() === "codex",
		);
		const emptyScopeClients = normalizedClients.filter(
			(client) => client.scopes.length === 0,
		);
		const unverifiedDevtoolClients = normalizedClients.filter(
			(client) =>
				client.status !== "verified" &&
				(client.tags.includes("purpose:devtool") ||
					["codex", "claude code", "mcpjam"].includes(
						(client.name ?? "").toLowerCase(),
					)),
		);
		for (const client of normalizedClients.filter(
			(candidate) =>
				isTaggedTediClient(candidate) && !isPeerTediClient(candidate),
		)) {
			const tediId = ownedTagValue(client, "tedi:");
			const appSlug = ownedTagValue(client, "app:");
			const tedi = tediId ? d1TedisById.get(tediId) : undefined;
			const app = appSlug ? d1AppsBySlug.get(appSlug) : undefined;
			if (!tediId || !appSlug || !tedi || !app) {
				issue(report, {
					severity: "warning",
					code: "tedi_mcp_client_ownership_tag_drift",
					resourceType: "mcp_client",
					resourceId: client.id || client.clientId,
					resourceName: client.name,
					message: `Managed tedi MCP client ${client.name ?? client.id} has incomplete or stale ownership tags.`,
					details: {
						tediId: tediId ?? null,
						appSlug: appSlug ?? null,
						tags: client.tags,
					},
				});
				continue;
			}
			if (snapshot.fgaQueryError) continue;
			const role = roleByTediAndApp.get(`${tedi.id}:${app.id}`);
			if (!role) {
				issue(report, {
					severity: "critical",
					code: "tedi_mcp_client_assignment_missing",
					resourceType: "mcp_client",
					resourceId: client.id || client.clientId,
					resourceName: client.name,
					message: `Managed tedi MCP client ${client.name ?? client.id} has no matching live FGA assignment.`,
					details: { tediId: tedi.id, appId: app.id, appSlug: app.slug },
				});
				continue;
			}
			const expectedScopes = constrainToApprovedMcpServerScopes(
				resolveTediAihClientScopesForApp({
					app,
					role,
					tedi,
				}),
				server.approvedScopes,
			);
			const actualScopes = normalizeScopes(client.scopes);
			const expectedScopeSet = new Set(expectedScopes);
			const actualScopeSet = new Set(actualScopes);
			const missingScopes = expectedScopes.filter(
				(scope) => !actualScopeSet.has(scope),
			);
			const extraScopes = actualScopes.filter(
				(scope) => !expectedScopeSet.has(scope),
			);
			if (missingScopes.length === 0 && extraScopes.length === 0) continue;
			issue(report, {
				severity: extraScopes.length > 0 ? "critical" : "warning",
				code:
					extraScopes.length > 0
						? "tedi_mcp_client_scope_overgrant"
						: "tedi_mcp_client_scope_missing",
				resourceType: "mcp_client",
				resourceId: client.id || client.clientId,
				resourceName: client.name,
				message: `Managed tedi MCP client ${client.name ?? client.id} does not match the exact ${role} scope set for ${app.slug}.`,
				details: {
					tediId: tedi.id,
					appId: app.id,
					appSlug: app.slug,
					role,
					expectedScopes,
					actualScopes,
					missingScopes,
					extraScopes,
				},
			});
		}
		const flowFromLogin = loginFlow(server);
		const flowFromDcr = server.dynamicRegistration?.flowId || null;
		const disablesApprovedScopesAsDefault =
			server.dynamicRegistration?.disableApprovedScopesAsDefault === true;

		report.mcpServers.push({
			id: server.id,
			name: server.name,
			audienceWhitelist: server.audienceWhitelist ?? [],
			loginPageURL: server.loginPageURL ?? server.loginPageUrl ?? null,
			dynamicRegistrationFlowId: flowFromDcr,
			disableApprovedScopesAsDefault: disablesApprovedScopesAsDefault,
			cimdEnabled: cimdEnabled(server),
			cimdDomainPolicies: cimdDomainPolicies(server),
			sessionSettingsEnabled: sessionSettingsEnabled(server),
			tags: [...((asRecord(server).tags as string[] | undefined) ?? [])].sort(),
			hasLogo: Boolean(asRecord(server).logo),
			approvedScopes: extractApprovedScopeNames(server.approvedScopes),
			clientCount: clients.length,
			verifiedClientCount: normalizedClients.filter(
				(client) => client.status === "verified",
			).length,
			unverifiedClientCount: normalizedClients.filter(
				(client) => client.status !== "verified",
			).length,
			untaggedClientCount: untaggedClients.length,
			broadClientCount: broadClients.length,
			codexClientCount: codexClients.length,
			taggedTediClientCount: clients.filter(isTaggedTediClient).length,
		});

		if (!referencedServerIds.has(server.id)) {
			issue(report, {
				severity: "warning",
				code: "descope_mcp_server_unreferenced",
				resourceType: "mcp_server",
				resourceId: server.id,
				resourceName: server.name,
				message: `Descope MCP server ${server.name} is not referenced by a D1 app or tedi row.`,
			});
		}

		if (flowFromLogin && flowFromLogin !== CONSENT_FLOW) {
			issue(report, {
				severity: "warning",
				code: "mcp_server_login_flow_repeats_tenant_selection",
				resourceType: "mcp_server",
				resourceId: server.id,
				resourceName: server.name,
				message: `Descope MCP server ${server.name} uses login flow ${flowFromLogin}; expected ${CONSENT_FLOW}, the only consent flow.`,
				details: { flow: flowFromLogin },
			});
		}

		const cimdPolicies = cimdDomainPolicies(server);
		if (!cimdEnabled(server) || !cimdPolicies.includes(TEDIX_CLI_CIMD_DOMAIN)) {
			issue(report, {
				severity: "warning",
				code: "mcp_server_cli_cimd_unavailable",
				resourceType: "mcp_server",
				resourceId: server.id,
				resourceName: server.name,
				message: `Descope MCP server ${server.name} does not allow verified Tedix CLI client metadata from ${TEDIX_CLI_CIMD_DOMAIN}.`,
				details: {
					cimdEnabled: cimdEnabled(server),
					cimdDomainPolicies: cimdPolicies,
					requiredDomain: TEDIX_CLI_CIMD_DOMAIN,
				},
			});
		}

		if (broadClients.length > 0 && untaggedClients.length > 0) {
			issue(report, {
				severity: "warning",
				code: "broad_untagged_mcp_clients",
				resourceType: "mcp_server",
				resourceId: server.id,
				resourceName: server.name,
				message: `Descope MCP server ${server.name} has ${broadClients.length} broad-scope clients and ${untaggedClients.length} untagged clients.`,
				details: {
					broadClientCount: broadClients.length,
					untaggedClientCount: untaggedClients.length,
				},
			});
		}

		if (emptyScopeClients.length > 0) {
			issue(report, {
				severity: hasBroadApprovedScope(server) ? "critical" : "warning",
				code: "mcp_client_empty_scopes",
				resourceType: "mcp_client",
				resourceId: server.id,
				resourceName: server.name,
				message: `Descope MCP server ${server.name} has ${emptyScopeClients.length} clients with no allowed scopes; consent screens for those clients will show no capabilities.`,
				details: {
					clients: emptyScopeClients.map((client) => ({
						id: client.id,
						name: client.name,
						status: client.status,
						tags: client.tags,
					})),
				},
			});
		}

		if (unverifiedDevtoolClients.length > 0) {
			issue(report, {
				severity: "warning",
				code: "unverified_devtool_mcp_clients",
				resourceType: "mcp_client",
				resourceId: server.id,
				resourceName: server.name,
				message: `Descope MCP server ${server.name} has ${unverifiedDevtoolClients.length} unverified devtool clients; users will see the unverified application warning during consent.`,
				details: {
					clients: unverifiedDevtoolClients.map((client) => ({
						id: client.id,
						name: client.name,
						status: client.status,
						scopes: client.scopes,
						tags: client.tags,
					})),
				},
			});
		}

		// Client cardinality is not drift: Tedix intentionally creates one client
		// per managed tedi and external-agent session, alongside CI and interactive
		// devtools. The ownership, scope, verification, and empty-scope checks above
		// identify unsafe clients without flagging a healthy multi-client server.
	}
	report.mcpServers.sort((a, b) => a.name.localeCompare(b.name));

	const appsByProvider = new Map<string, Set<string>>();
	for (const app of snapshot.d1Apps) {
		if (!app.connectionProviderId) continue;
		if (!appsByProvider.has(app.connectionProviderId)) {
			appsByProvider.set(app.connectionProviderId, new Set());
		}
		appsByProvider.get(app.connectionProviderId)!.add(app.slug);
	}

	for (const providerId of providerByDescopeId.keys()) {
		if (!appsByProvider.has(providerId))
			appsByProvider.set(providerId, new Set());
	}

	for (const providerId of appsByProvider.keys()) {
		const appSlugs = [...(appsByProvider.get(providerId) ?? [])].sort();
		const hasDescopeOutboundApp = outboundAppIds.has(providerId);
		const outboundApp = outboundAppsById.get(providerId);
		const provider = providerByDescopeId.get(providerId);
		const expectedType = provider?.type ?? null;
		const expectedDescopeType = expectedType
			? EXPECTED_OUTBOUND_APP_TYPE[expectedType]
			: null;
		const expectedDefaultScopes = normalizeScopes(
			provider?.requiredScopes?.length
				? provider.requiredScopes
				: provider?.credentialProfile?.defaultScopes,
		);
		const actualDefaultScopes = normalizeScopes(outboundApp?.defaultScopes);
		const actualDefaultScopeSet = new Set(actualDefaultScopes);
		const missingDefaultScopes = expectedDefaultScopes.filter(
			(scope) => !actualDefaultScopeSet.has(scope),
		);
		const expectedUseDcr =
			provider?.type === "oauth" ? provider.oauthConfig?.useDcr === true : null;
		const expectedLogo = provider?.icon ?? null;
		const backing = hasDescopeOutboundApp ? "descope" : "missing";
		report.connectionProviders.push({
			providerId,
			appSlugs,
			backing,
			expectedType,
			actualType: outboundApp?.appType ?? null,
			expectedUseDcr,
			actualUseDcr: outboundApp?.useDcr ?? null,
			expectedLogo,
			hasLogo: outboundApp ? Boolean(outboundApp.logo) : null,
		});

		if (!hasDescopeOutboundApp && appSlugs.length > 0) {
			issue(report, {
				severity: "critical",
				code: "connection_provider_missing",
				resourceType: "connection_provider",
				resourceId: providerId,
				resourceName: providerId,
				message: `D1 app metadata references provider ${providerId}, but Descope has no matching outbound app.`,
				details: { appSlugs },
			});
		}
		// The registry is a product catalogue, not the credential authority:
		// resolveCredentialChain reads Descope's Token Vault, so an unregistered
		// provider still serves tokens. It is invisible on the Connections
		// surface though, and nothing can fail closed on the registry while these
		// exist.
		if (!provider && appSlugs.length > 0 && hasDescopeOutboundApp) {
			issue(report, {
				severity: "warning",
				code: "connection_provider_unregistered",
				resourceType: "connection_provider",
				resourceId: providerId,
				resourceName: providerId,
				message: `Provider ${providerId} is live in Descope and referenced by D1 apps, but has no connection_providers row — it cannot be managed from the Connections surface.`,
				details: { appSlugs },
			});
		}
		if (!hasDescopeOutboundApp && provider) {
			issue(report, {
				severity: "warning",
				code: "connection_provider_registry_missing",
				resourceType: "connection_provider",
				resourceId: providerId,
				resourceName: provider.name,
				message: `Tedix connection provider ${providerId} is registered in code but has no matching Descope outbound app.`,
				details: { providerType: provider.type },
			});
		}
		if (
			outboundApp &&
			expectedDescopeType &&
			outboundApp.appType &&
			outboundApp.appType !== expectedDescopeType
		) {
			issue(report, {
				severity: "warning",
				code: "connection_provider_type_drift",
				resourceType: "connection_provider",
				resourceId: providerId,
				resourceName: provider?.name ?? providerId,
				message: `Descope outbound app ${providerId} is ${outboundApp.appType}; expected ${expectedDescopeType}.`,
				details: { expected: expectedDescopeType, actual: outboundApp.appType },
			});
		}
		if (outboundApp && expectedUseDcr === true && outboundApp.useDcr !== true) {
			issue(report, {
				severity: "warning",
				code: "connection_provider_dcr_drift",
				resourceType: "connection_provider",
				resourceId: providerId,
				resourceName: provider?.name ?? providerId,
				message: `Descope outbound app ${providerId} is not using DCR, but the Tedix provider registry expects DCR.`,
				details: {
					expectedUseDcr,
					actualUseDcr: outboundApp.useDcr ?? null,
					expectedDcrUrl: provider?.oauthConfig?.dcrUrl ?? null,
					actualDcrUrl: outboundApp.dcrUrl ?? null,
				},
			});
		}
		if (outboundApp && expectedLogo && !outboundApp.logo) {
			issue(report, {
				severity: "warning",
				code: "connection_provider_logo_missing",
				resourceType: "connection_provider",
				resourceId: providerId,
				resourceName: provider?.name ?? providerId,
				message: `Descope outbound app ${providerId} is missing a logo while Tedix has a provider logo configured.`,
				details: { expectedLogo },
			});
		}
		if (
			outboundApp &&
			expectedType === "oauth" &&
			expectedDefaultScopes.length > 0 &&
			actualDefaultScopes.length === 0
		) {
			issue(report, {
				severity: "critical",
				code: "connection_provider_default_scopes_missing",
				resourceType: "connection_provider",
				resourceId: providerId,
				resourceName: provider?.name ?? providerId,
				message: `Descope outbound app ${providerId} has no default scopes, but Tedix provider metadata requires explicit OAuth scopes.`,
				details: { expectedDefaultScopes, actualDefaultScopes },
			});
		}
		if (
			outboundApp &&
			expectedType === "oauth" &&
			expectedDefaultScopes.length > 0 &&
			actualDefaultScopes.length > 0 &&
			missingDefaultScopes.length > 0
		) {
			issue(report, {
				severity: "warning",
				code: "connection_provider_default_scopes_drift",
				resourceType: "connection_provider",
				resourceId: providerId,
				resourceName: provider?.name ?? providerId,
				message: `Descope outbound app ${providerId} is missing required default scopes from Tedix provider metadata.`,
				details: {
					expectedDefaultScopes,
					actualDefaultScopes,
					missingDefaultScopes,
				},
			});
		}
	}
	report.connectionProviders.sort((a, b) =>
		a.providerId.localeCompare(b.providerId),
	);

	const rolesWithoutPermissions = snapshot.roles.filter(
		// `tedi` is an identity-class marker for user-bound access keys. Runtime
		// authority comes from the D1 capability profile and FGA, and tenant roles
		// are deliberately omitted from tedi JWTs. Its empty permission set is the
		// expected fail-closed configuration, not drift.
		(role) => role.name !== "tedi" && rolePermissionNames(role).length === 0,
	);
	if (rolesWithoutPermissions.length > 0) {
		issue(report, {
			severity: "info",
			code: "descope_roles_without_permissions",
			resourceType: "role",
			message: `${rolesWithoutPermissions.length} Descope roles have no permission objects; runtime AIH scopes and FGA must remain the authority source.`,
			details: {
				roles: rolesWithoutPermissions
					.map((role) => role.name)
					.filter((name): name is string => typeof name === "string"),
			},
		});
	}

	const fgaQueryError = snapshot.fgaQueryError;
	if (fgaQueryError) {
		issue(report, {
			severity: "warning",
			code: "fga_relation_audit_unavailable",
			resourceType: "fga_relation",
			resourceId: null,
			resourceName: null,
			message:
				"Descope FGA relation audit could not be completed; stale tedi app assignments may be hidden.",
			details: { error: fgaQueryError },
		});
	}

	for (const relation of snapshot.fgaRelations) {
		if (relation.namespace !== "app" || !relation.resource) continue;
		if (d1AppIds.has(relation.resource)) continue;
		issue(report, {
			severity: "warning",
			code: "fga_relation_missing_d1_app",
			resourceType: "fga_relation",
			resourceId: relation.resource,
			resourceName: relation.relationDefinition,
			message: `Descope FGA relation points at app ${relation.resource}, but no D1 app row exists.`,
			details: {
				target: relation.target ?? null,
				relation: relation.relationDefinition,
				namespace: relation.namespace ?? null,
			},
		});
	}

	return report;
}

// Unwraps an SDK SdkResponse to its data payload, preserving throw-on-error
// semantics so these audit reads fail loudly the same way.
function unwrapSdkResponse<T>(
	response: {
		ok: boolean;
		code?: number;
		data?: T;
		error?: { errorMessage?: string; errorDescription?: string };
	},
	label: string,
): T {
	if (!response.ok || response.data === undefined) {
		throw new Error(
			`Descope SDK request failed [${label}${response.code ? ` ${response.code}` : ""}]: ${
				response.error?.errorMessage ??
				response.error?.errorDescription ??
				"(no data)"
			}`,
		);
	}
	return response.data;
}

async function loadD1Snapshot(
	db: DbClient,
	organizationId?: string,
): Promise<Pick<DescopeAihDriftSnapshot, "d1Apps" | "d1Tedis">> {
	const { appRows, tediRows } = await loadDescopeAihD1SnapshotRows(
		db,
		organizationId,
	);

	return {
		d1Apps: appRows.map((app) => {
			const mcpConfig = normalizeMcpConfig(app.metadata);
			return {
				id: app.id,
				slug: app.slug,
				name: app.name,
				descopeResourceId: stringOrNull(mcpConfig.descopeResourceId),
				authMode: stringOrNull(mcpConfig.authMode),
				codeMode:
					typeof mcpConfig.codeMode === "boolean" ? mcpConfig.codeMode : null,
				connectionProviderId: stringOrNull(mcpConfig.connectionProviderId),
				metadata: app.metadata,
			};
		}),
		d1Tedis: tediRows.map((tedi) => ({
			id: tedi.id,
			slug: tedi.slug,
			name: tedi.name,
			descopeMcpResourceId: tedi.descopeMcpResourceId,
			descopeUserId: tedi.descopeUserId,
			mcpCapabilityProfile: tedi.mcpCapabilityProfile,
		})),
	};
}

export async function getDescopeAihDriftReport(params: {
	db: DbClient;
	env: DescopeManagementEnv;
	organizationId?: string;
	now?: Date;
}): Promise<DescopeAihDriftReport> {
	// Reused for both the SDK-backed tenant/role reads below and the FGA query.
	const descopeClient = createDescopeClient(params.env);
	const [
		allServers,
		outboundResponse,
		tenantsResponse,
		rolesResponse,
		d1Snapshot,
		providers,
	] = await Promise.all([
		loadAllDescopeMcpServers(params.env),
		descopeClient.management.outboundApplication.loadAllApplications(),
		descopeClient.management.tenant.loadAll(),
		descopeClient.management.role.loadAll(),
		loadD1Snapshot(params.db, params.organizationId),
		listConnectionProviders(params.db),
	]);
	const outboundApps = unwrapSdkResponse<DescopeOutboundApp[]>(
		outboundResponse,
		"outboundApplication.loadAllApplications",
	);
	const tenants = unwrapSdkResponse(tenantsResponse, "tenant.loadAll");
	const roles = unwrapSdkResponse(rolesResponse, "role.loadAll");
	const referencedServerIds = new Set(
		[
			...d1Snapshot.d1Apps.map((app) =>
				stringOrNull(normalizeMcpConfig(app.metadata).descopeResourceId),
			),
			...d1Snapshot.d1Tedis.map((tedi) => tedi.descopeMcpResourceId),
		].filter((id): id is string => Boolean(id)),
	);
	const referencedProviderIds = new Set(
		d1Snapshot.d1Apps
			.map((app) =>
				stringOrNull(normalizeMcpConfig(app.metadata).connectionProviderId),
			)
			.filter((id): id is string => Boolean(id)),
	);
	const servers = params.organizationId
		? allServers.filter((server) => referencedServerIds.has(server.id))
		: allServers;
	const scopedOutboundApps = params.organizationId
		? outboundApps.filter(
				(app) =>
					typeof app.id === "string" && referencedProviderIds.has(app.id),
			)
		: outboundApps;
	const scopedProviders = params.organizationId
		? providers.filter((provider) =>
				[provider.descopeAppId, ...(provider.descopeAppAliases ?? [])].some(
					(id) => Boolean(id && referencedProviderIds.has(id)),
				),
			)
		: providers;

	const clientsByServerId = new Map<string, DescopeClient[]>();
	await Promise.all(
		servers.map(async (server) => {
			const clients = await searchDescopeMcpServerClients(params.env, {
				mcpServerId: server.id,
			});
			clientsByServerId.set(server.id, clients);
		}),
	);

	let fgaRelations: DescopeFgaRelation[] = [];
	let fgaQueryError: string | null = null;
	const descopeUserIds = d1Snapshot.d1Tedis
		.map((tedi) => tedi.descopeUserId)
		.filter((id): id is string => Boolean(id));
	try {
		fgaRelations = await queryTediRelations(descopeClient, descopeUserIds);
	} catch (error) {
		fgaQueryError = error instanceof Error ? error.message : String(error);
	}
	if (params.organizationId) {
		const scopedAppIds = new Set(d1Snapshot.d1Apps.map((app) => app.id));
		fgaRelations = fgaRelations.filter(
			(relation) =>
				relation.namespace === "app" && scopedAppIds.has(relation.resource),
		);
	}

	return buildDescopeAihDriftReport({
		checkedAt: (params.now ?? new Date()).toISOString(),
		projectId: params.env.DESCOPE_PROJECT_ID,
		servers,
		clientsByServerId,
		outboundApps: scopedOutboundApps,
		tenants: params.organizationId ? [] : tenants,
		roles: params.organizationId ? [] : roles,
		fgaRelations,
		fgaQueryError,
		providers: scopedProviders,
		...d1Snapshot,
	});
}
