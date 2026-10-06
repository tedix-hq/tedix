/**
 * MCP Credentials Router
 * Resolves auth headers for tedis connecting to MCP servers
 *
 * Auth: Service binding OR Tedi Auth (withTediAuth)
 * Tagged "internal" — excluded from public OpenAPI spec
 *
 * Flow (V2):
 * 1. Tedi's plugin calls resolve() with tediId + serverUrl
 * 2. Router parses app slug from MCP subdomain URL
 * 3. Resolves the tedi's explicit app assignments (FGA operator relations)
 * 4. Decrypts the tedi's Descope AIH M2M client credentials for that MCP server
 * 5. Exchanges client credentials for a short-lived AIH access token
 * 6. Returns Authorization Bearer header with the AIH access token
 *
 * No V2 tedi JWT fallback — assigned app and peer tedi MCP servers fail closed
 * when AIH credentials are missing or invalid.
 */

import { implement } from "@orpc/server";
import { mcpCredentialsContract } from "@tedix/api-contract/contracts/mcp-credentials";
import {
	aihClientSecretNames,
	exchangeAihClientCredentials,
} from "@tedix/auth/aih-client";
import { getManagementClient } from "@tedix/auth/client";
import { getAssignedAppRoles } from "@tedix/auth/fga";
import { issueDelegatedMcpToken } from "@tedix/auth/delegated-mcp-token";
import { resolveTediScopes } from "@tedix/mcp-shared/auth/scopes";
import { getAppByDomain } from "@tedix/db/queries/app-records";
import { getAppBySlug, getAppsByOrganization } from "@tedix/db/queries/apps";
import { getCatalogAppByMcpEndpointHash } from "@tedix/db/queries/catalog/endpoint-normalization";
import { getAllTediSecrets } from "@tedix/db/queries/tedi-secrets";
import { getTediByGlobalSlug, getTediById } from "@tedix/db/queries/tedis";
import { getKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { decryptTediSecret } from "@tedix/db/utils/secrets-encryption";
import {
	getCachedAihToken,
	setCachedAihToken,
} from "../../lib/aih-token-cache";
import { requireTediRequestIdentity } from "../org-scope";
import type { BaseContext } from "../orpc";
import { withTediAuth } from "../orpc";
import { evaluateExternalMcpCatalogGate } from "./mcp-credential-catalog-gate";
import { authorizeTediCredentialExchange } from "./mcp-credential-policy";

const JWT_CACHE_MARGIN = 0.8;
const SLOW_MCP_CREDENTIALS_CALL_MS = 5_000;

/** Preserve the live tedi profile's authority, with delegated Work read-only. */
export function delegatedMcpScopes(
	profile: string | null | undefined,
): string[] {
	return resolveTediScopes(profile).filter(
		(scope) => !scope.startsWith("mcp:work.") || scope === "mcp:work.read",
	);
}

/** The caller's tuple is a lookup key, never the authority to mint a token. */
export function matchesPersistedHomeDelegation(
	row: {
		status: string;
		delegatedTediId: string | null;
		childRunId: string | null;
		metadata: Record<string, unknown> | null;
	},
	input: { tediId: string; runId: string; workItemId: string },
): boolean {
	if (!["queued", "running", "waiting"].includes(row.status)) return false;
	if (
		row.delegatedTediId === input.tediId &&
		row.childRunId === input.runId &&
		row.metadata?.workItemId === input.workItemId
	)
		return true;
	const plan = row.metadata?.homePlan;
	if (!plan || typeof plan !== "object" || Array.isArray(plan)) return false;
	const assignments = (plan as Record<string, unknown>).assignments;
	return (
		Array.isArray(assignments) &&
		assignments.some((value) => {
			if (!value || typeof value !== "object" || Array.isArray(value))
				return false;
			const assignment = value as Record<string, unknown>;
			return (
				assignment.ownerTediId === input.tediId &&
				assignment.childRunId === input.runId &&
				assignment.workItemId === input.workItemId &&
				(assignment.status === "queued" || assignment.status === "running") &&
				typeof assignment.dispatchedAt === "string" &&
				assignment.dispatchedAt.length > 0
			);
		})
	);
}

const os = implement(mcpCredentialsContract).$context<BaseContext>();

function hostFromUrl(value: string): string | null {
	try {
		return new URL(value).hostname;
	} catch {
		return null;
	}
}

function logSlowMcpCredentialsCall(
	context: BaseContext,
	event: {
		route: "listServers" | "resolve";
		startedAt: number;
		tediId: string;
		outcome: string;
		reason?: string;
		serverCount?: number;
		serverHost?: string | null;
		appSlug?: string | null;
		targetKind?: "app" | "tedi" | "unknown";
		headersReturned?: boolean;
	},
): void {
	const durationMs = Date.now() - event.startedAt;
	if (durationMs < SLOW_MCP_CREDENTIALS_CALL_MS) return;

	const { startedAt: _startedAt, ...details } = event;
	console.warn(
		`[McpCredentials] slow ${event.route}: ${JSON.stringify({
			...details,
			durationMs,
			authType: context.authType ?? null,
			contextTediId: context.tediId ?? null,
			organizationId: context.organizationId ?? null,
			cfRay: context.headers.get("cf-ray"),
			environment: context.env.ENVIRONMENT,
		})}`,
	);
}

async function resolveAppForServerUrl(
	context: BaseContext,
	serverUrl: string,
): Promise<{
	slug: string;
	id: string;
	organizationId: string;
	mcpConfig: Record<string, unknown> | null;
} | null> {
	try {
		const url = new URL(serverUrl);
		const host = url.hostname;
		const subdomainMatch = host.match(
			/^([^.]+)\.mcp\.(tedix\.dev|tedix\.tech)$/,
		);
		const localMatch = host.match(/^([^.]+)\.mcp\.localhost$/);
		const slug = subdomainMatch?.[1] ?? localMatch?.[1] ?? null;
		if (slug) {
			const app = await getAppBySlug(context.db, slug);
			return app
				? {
						slug: app.slug,
						id: app.id,
						organizationId: app.organizationId,
						mcpConfig:
							(app.metadata?.mcpConfig as
								| Record<string, unknown>
								| null
								| undefined) ?? null,
					}
				: null;
		}

		const app = await getAppByDomain(context.db, host);
		if (!app) return null;
		return {
			slug: app.slug,
			id: app.id,
			organizationId: app.organizationId,
			mcpConfig:
				(app.metadata?.mcpConfig as
					| Record<string, unknown>
					| null
					| undefined) ?? null,
		};
	} catch {
		return null;
	}
}

/**
 * Resolve a tedi from a *.tedi.{domain} server URL.
 * Returns the tedi record if the URL matches a tedi subdomain pattern.
 */
async function resolveTediForServerUrl(
	context: BaseContext,
	serverUrl: string,
): Promise<{
	slug: string;
	id: string;
	organizationId: string;
	descopeMcpResourceId: string | null;
} | null> {
	try {
		const url = new URL(serverUrl);
		const host = url.hostname;
		// Match {slug}.tedi.{tedix.dev|tedix.tech} or {slug}.tedi.localhost
		const subdomainMatch = host.match(
			/^([^.]+)\.tedi\.(tedix\.dev|tedix\.tech)$/,
		);
		const localMatch = host.match(/^([^.]+)\.tedi\.localhost$/);
		const slug = subdomainMatch?.[1] ?? localMatch?.[1] ?? null;
		if (!slug) return null;

		const tedi = await getTediByGlobalSlug(context.db, slug);
		if (!tedi) return null;

		return {
			slug: tedi.slug,
			id: tedi.id,
			organizationId: tedi.organizationId,
			descopeMcpResourceId: tedi.descopeMcpResourceId ?? null,
		};
	} catch {
		return null;
	}
}

function getMcpBaseDomain(env: Pick<CloudflareEnv, "ENVIRONMENT">): string {
	switch (env.ENVIRONMENT) {
		case "production":
			return "tedix.dev";
		default:
			return "tedix.tech";
	}
}

async function getOrExchangeAihToken(params: {
	context: BaseContext;
	tediId: string;
	mcpServerId: string;
	serverUrl: string;
	clientId: string;
	clientSecret: string;
	credentialVersion?: string | null;
	now: number;
}): Promise<{ token: string; expiresAt: number }> {
	const cached = getCachedAihToken(params);
	if (cached) {
		return cached;
	}

	const { accessToken, expiresIn } = await exchangeAihClientCredentials(
		params.context.env,
		params.serverUrl,
		params.clientId,
		params.clientSecret,
	);

	const expiresAt = params.now + expiresIn * 1000 * JWT_CACHE_MARGIN;
	const entry = { token: accessToken, expiresAt };
	setCachedAihToken(params, entry);

	return entry;
}

async function resolveSecretRecord(params: {
	masterKey: string;
	tediId: string;
	secrets: Awaited<ReturnType<typeof getAllTediSecrets>>;
	name: string;
}): Promise<{ value: string; updatedAt: string } | null> {
	const row = params.secrets.find((secret) => secret.name === params.name);
	if (!row) return null;
	return {
		value: await decryptTediSecret(
			params.masterKey,
			params.tediId,
			row.encryptedValue,
		),
		updatedAt: row.updatedAt,
	};
}

async function resolveAihClientCredentials(params: {
	masterKey: string;
	tediId: string;
	secrets: Awaited<ReturnType<typeof getAllTediSecrets>>;
	appSlug: string | null;
	mcpServerId: string;
}): Promise<{
	clientId: string;
	clientSecret: string;
	credentialVersion: string;
} | null> {
	const candidates = [params.appSlug, params.mcpServerId].filter(
		(candidate): candidate is string => !!candidate,
	);

	for (const candidate of candidates) {
		const names = aihClientSecretNames(candidate);
		const clientId = await resolveSecretRecord({
			masterKey: params.masterKey,
			tediId: params.tediId,
			secrets: params.secrets,
			name: names.clientIdName,
		});
		const clientSecret = await resolveSecretRecord({
			masterKey: params.masterKey,
			tediId: params.tediId,
			secrets: params.secrets,
			name: names.clientSecretName,
		});
		if (clientId && clientSecret) {
			return {
				clientId: clientId.value,
				clientSecret: clientSecret.value,
				credentialVersion: `${clientId.updatedAt}:${clientSecret.updatedAt}`,
			};
		}
	}

	return null;
}

export const listServers = os.listServers
	.use(withTediAuth)
	.handler(async ({ input, context }) => {
		const { tediId } = input;
		requireTediRequestIdentity(context, tediId);
		const startedAt = Date.now();
		let outcome = "ok";
		let reason: string | undefined;
		let serverCount = 0;
		try {
			const tedi = await getTediById(context.db, tediId);
			if (!tedi?.organizationId) {
				outcome = "empty";
				reason = "missing_tedi_or_org";
				return { servers: [] };
			}

			if (!tedi.descopeUserId || !context.env.DESCOPE_MANAGEMENT_KEY) {
				outcome = "empty";
				reason = !tedi.descopeUserId
					? "missing_descope_user"
					: "missing_descope_management_key";
				return { servers: [] };
			}

			const orgApps = await getAppsByOrganization(
				context.db,
				tedi.organizationId,
			);
			const mgmt = getManagementClient(context.env);
			const appIds = orgApps.filter((app) => app.slug).map((app) => app.id);
			const assignedRoles = await getAssignedAppRoles(
				mgmt,
				tedi.descopeUserId,
				appIds,
			);
			const assignedSet = new Set(Object.keys(assignedRoles));
			const filteredApps = orgApps.filter(
				(app) => app.slug && assignedSet.has(app.id),
			);

			const baseDomain = getMcpBaseDomain({
				ENVIRONMENT: context.env.ENVIRONMENT,
			});
			const servers: Array<{
				serverId: string;
				url: string;
				name: string;
				transport: "streamable-http";
				authRequired: boolean;
			}> = filteredApps.map((app) => ({
				serverId: app.slug,
				url: `https://${app.slug}.mcp.${baseDomain}/mcp`,
				name: app.name ?? app.slug,
				transport: "streamable-http" as const,
				authRequired: true,
			}));

			serverCount = servers.length;
			return { servers };
		} catch (error) {
			outcome = "error";
			reason = error instanceof Error ? error.message : String(error);
			throw error;
		} finally {
			logSlowMcpCredentialsCall(context, {
				route: "listServers",
				startedAt,
				tediId,
				outcome,
				reason,
				serverCount,
			});
		}
	});

export const resolve = os.resolve
	.use(withTediAuth)
	.handler(async ({ input, context }) => {
		const { tediId, serverUrl, delegatedTurn } = input;
		requireTediRequestIdentity(context, tediId);
		const startedAt = Date.now();
		let appSlugForLog: string | null = null;
		let targetKind: "app" | "tedi" | "unknown" = "unknown";
		const finish = <T>(
			result: T,
			updates: {
				outcome?: string;
				reason?: string;
				headersReturned?: boolean;
			} = {},
		): T => {
			logSlowMcpCredentialsCall(context, {
				route: "resolve",
				startedAt,
				tediId,
				outcome: updates.outcome ?? "ok",
				reason: updates.reason,
				serverHost: hostFromUrl(serverUrl),
				appSlug: appSlugForLog,
				targetKind,
				headersReturned: updates.headersReturned ?? false,
			});
			return result;
		};
		const headerTediId =
			context.headers.get("X-Tedix-Tedi-Id") ??
			context.headers.get("x-tedix-tedi-id");
		if (headerTediId && headerTediId !== tediId) {
			return finish(
				{
					headers: {} as Record<string, string>,
					isOperator: false,
					appSlug: null as string | null,
					expiresAt: null as number | null,
				},
				{ outcome: "empty", reason: "header_tedi_mismatch" },
			);
		}

		const emptyResult = {
			headers: {} as Record<string, string>,
			isOperator: false,
			appSlug: null as string | null,
			expiresAt: null as number | null,
		};

		// Try to resolve as an app MCP server (*.mcp.{domain})
		const resolvedApp = await resolveAppForServerUrl(context, serverUrl);
		// Try to resolve as a tedi MCP server (*.tedi.{domain})
		const resolvedTedi = resolvedApp
			? null
			: await resolveTediForServerUrl(context, serverUrl);
		targetKind = resolvedApp ? "app" : resolvedTedi ? "tedi" : "unknown";

		if (!resolvedApp && !resolvedTedi) {
			// Catalog-allowlist gate (ADR docs/decisions/tedi-client-oauth-cimd.md):
			// a tedi-initiated connection to an external MCP server must resolve
			// to an app_catalog row before any credentials are resolved or
			// issued. No row → typed fail-closed refusal, never a direct
			// connection. Tedix-internal hosts bypass the gate.
			const gate = await evaluateExternalMcpCatalogGate(
				serverUrl,
				async (hash) => {
					const catalogApp = await getCatalogAppByMcpEndpointHash(
						context.db,
						hash,
					);
					return catalogApp?.id ?? null;
				},
			);
			if (gate.kind === "refused") {
				console.warn(
					`[McpCredentials] Catalog gate refused external MCP endpoint: reason=${gate.refusal.reason} tedi=${tediId} endpoint=${gate.refusal.endpoint}`,
				);
				return finish(
					{ ...emptyResult, catalogRefused: gate.refusal },
					{
						outcome: "refused",
						reason: `catalog_refused:${gate.refusal.reason}`,
					},
				);
			}
			// Catalog-listed external endpoints pass the gate; credential
			// issuance for them (vault lookup / connectionRequired) lands in
			// later ADR phases, so the resolved output is unchanged today.
			return finish(emptyResult, {
				outcome: "empty",
				reason:
					gate.kind === "allowed"
						? "external_catalog_app_no_credential_path"
						: "unrecognized_server",
			});
		}

		const appSlug = resolvedApp?.slug ?? resolvedTedi?.slug ?? null;
		appSlugForLog = appSlug;
		const entityOrgId =
			resolvedApp?.organizationId ?? resolvedTedi?.organizationId ?? "";
		const requestingTedi = await getTediById(context.db, tediId);
		const credentialDecision = authorizeTediCredentialExchange({
			requestedTediId: tediId,
			authenticatedTediId: context.tediId,
			authenticatedDescopeUserId: context.descopeUserId,
			authenticatedOrganizationId: context.organizationId,
			// App MCP servers are authorized by explicit FGA assignment below.
			// Keep the org-match guard for peer tedi MCP servers, where there is
			// no app assignment relation to prove cross-org intent.
			targetOrganizationId: resolvedTedi?.organizationId,
			tedi: requestingTedi,
		});
		if (!credentialDecision.ok) {
			console.warn(
				`[McpCredentials] Credential exchange denied: ${credentialDecision.reason} tedi=${tediId} server=${serverUrl}`,
			);
			return finish(
				{ ...emptyResult, appSlug },
				{
					outcome: "empty",
					reason: `credential_denied:${credentialDecision.reason}`,
				},
			);
		}

		// A supervised child never receives the reusable, full-profile AIH bearer.
		// Verify the exact tuple against Home's persisted dispatch and the FGA app
		// assignment below; caller-provided run/work ids alone confer nothing.
		if (
			delegatedTurn &&
			(!resolvedApp || !requestingTedi || !requestingTedi.organizationId)
		) {
			return finish(
				{ ...emptyResult, appSlug },
				{ outcome: "empty", reason: "delegated_target_mismatch" },
			);
		}

		let resolvedAppRole: "operator" | "observer" | null = null;
		if (resolvedApp) {
			if (!context.env.DESCOPE_MANAGEMENT_KEY) {
				console.error("[McpCredentials] Missing DESCOPE_MANAGEMENT_KEY");
				return finish(
					{ ...emptyResult, appSlug },
					{ outcome: "empty", reason: "missing_descope_management_key" },
				);
			}
			const mgmtClient = getManagementClient(context.env);
			const roles = await getAssignedAppRoles(
				mgmtClient,
				credentialDecision.descopeUserId,
				[resolvedApp.id],
			);
			resolvedAppRole = roles[resolvedApp.id] ?? null;
			if (!resolvedAppRole) {
				return finish(
					{ ...emptyResult, appSlug },
					{ outcome: "empty", reason: "missing_app_role" },
				);
			}
		}

		if (delegatedTurn) {
			const home = await getKernelRuntimeRun(context.db, {
				id: delegatedTurn.homeRunId,
				organizationId: requestingTedi!.organizationId,
			});
			if (
				!home ||
				!matchesPersistedHomeDelegation(home, {
					tediId,
					runId: delegatedTurn.runId,
					workItemId: delegatedTurn.workItemId,
				})
			) {
				return finish(
					{ ...emptyResult, appSlug },
					{ outcome: "empty", reason: "delegated_home_mismatch" },
				);
			}
			const secret = context.env.PLATFORM_SERVICE_TOKEN;
			if (!secret)
				return finish(
					{ ...emptyResult, appSlug },
					{ outcome: "empty", reason: "delegated_signer_unavailable" },
				);
			const parsedUrl = new URL(serverUrl);
			if (
				parsedUrl.protocol !== "https:" ||
				parsedUrl.pathname !== "/mcp" ||
				parsedUrl.search ||
				parsedUrl.hash
			) {
				return finish(
					{ ...emptyResult, appSlug },
					{ outcome: "empty", reason: "delegated_audience_invalid" },
				);
			}
			const audience =
				resolvedApp!.mcpConfig?.authMode === "proxy-target"
					? resolvedApp!.mcpConfig.expectedAudience
					: `${parsedUrl.origin}/mcp`;
			if (typeof audience !== "string" || !audience)
				return finish(
					{ ...emptyResult, appSlug },
					{ outcome: "empty", reason: "delegated_audience_missing" },
				);
			const scopes = delegatedMcpScopes(requestingTedi!.mcpCapabilityProfile);
			const issued = await issueDelegatedMcpToken({
				secret,
				audience,
				runId: delegatedTurn.runId,
				homeRunId: delegatedTurn.homeRunId,
				workItemId: delegatedTurn.workItemId,
				tediId,
				organizationId: requestingTedi!.organizationId,
				scopes,
			});
			return finish(
				{
					headers: { Authorization: `Bearer ${issued.token}` },
					isOperator: resolvedAppRole === "operator",
					appSlug,
					expiresAt: issued.expiresAt,
				},
				{ headersReturned: true },
			);
		}

		// --- M2M AIH fast path: assigned entity with a descopeMcpResourceId ---
		// Works for: app MCP servers (operator or observer FGA assignment), per-tedi
		// MCP servers (AIH-only peer auth).
		const mcpServerId = resolvedApp
			? (resolvedApp.mcpConfig?.descopeResourceId as string | undefined)
			: (resolvedTedi?.descopeMcpResourceId ?? undefined);

		if (mcpServerId) {
			try {
				const masterKey = context.env.SECRETS_MASTER_KEY;
				if (!masterKey) {
					console.error(
						"[McpCredentials] Missing SECRETS_MASTER_KEY for AIH credential resolution",
					);
					return finish(
						{ ...emptyResult, appSlug },
						{ outcome: "empty", reason: "missing_secrets_master_key" },
					);
				}

				const secrets = await getAllTediSecrets(context.db, tediId);
				const credentials = await resolveAihClientCredentials({
					masterKey,
					tediId,
					secrets,
					appSlug,
					mcpServerId,
				});
				if (credentials) {
					const { clientId, clientSecret, credentialVersion } = credentials;
					const now = Date.now();
					const result = await getOrExchangeAihToken({
						context,
						tediId,
						mcpServerId,
						serverUrl,
						clientId,
						clientSecret,
						credentialVersion,
						now,
					});
					return finish(
						{
							headers: {
								Authorization: `Bearer ${result.token}`,
								"X-Tedix-Org-Id": entityOrgId,
								"X-Tedix-Tedi-Id": tediId,
							} as Record<string, string>,
							isOperator: resolvedAppRole === "operator",
							appSlug,
							// Cache comparisons use milliseconds; the credential wire contract uses Unix seconds.
							expiresAt: Math.floor(result.expiresAt / 1000),
						},
						{ headersReturned: true },
					);
				}
				console.error(
					`[McpCredentials] Missing AIH client credentials for tedi=${tediId} server=${appSlug ?? mcpServerId}`,
				);
				return finish(
					{ ...emptyResult, appSlug },
					{ outcome: "empty", reason: "missing_aih_client_credentials" },
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(
					"[McpCredentials] M2M AIH token exchange failed:",
					message,
				);
				return finish(
					{ ...emptyResult, appSlug },
					{ outcome: "empty", reason: `aih_exchange_failed:${message}` },
				);
			}
		}

		console.error(
			`[McpCredentials] Target MCP server has no Descope AIH resource id — tedi=${tediId} server=${serverUrl}`,
		);
		return finish(
			{ ...emptyResult, appSlug },
			{ outcome: "empty", reason: "missing_descope_aih_resource" },
		);
	});

export const mcpCredentialsContractRouter = os.router({
	listServers,
	resolve,
});
