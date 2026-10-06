import { decodeJwtPayload } from "./jwt-payload";
/**
 * Auth/login/workspace verb group: credential resolution (explicit MCP token →
 * external-agent session → stored OAuth login), `tedix login` OAuth discovery,
 * workspace naming, and `tedix auth status`. Extracted verbatim from index.ts.
 */

import {
	DEFAULT_WORKSPACE,
	getCurrentWorkspace,
	listWorkspaces,
	readWorkspaceCredentials,
} from "./credential-store";
import {
	externalAgentStatus,
	resolveExternalAgentAuth,
} from "./external-agent";
import { extractJwtScopes, type JWTPayload } from "@tedix/auth/types";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	isTedixHostedMcpUrl,
	issuedOAuthScopes,
	TEDIX_OAUTH_CLIENT_ID,
	WorkspaceOAuthProvider,
	refreshStoredSession,
	sessionNeedsRefresh,
} from "./oauth-provider";
import type { AuthResolution, CliOptions } from "./shared";
import { externalAgentSessionWorkspaces } from "./external-agent-store";
import { resolveAgentSession } from "./work";
import { sessionWorkspaceDrift } from "./workspace-binding";

export const RAW_API_KEY_MESSAGE =
	"TEDIX_MCP_API_KEY must be a Tedix Unified MCP JWT credential, not a Tedix sk_* API key.";
export const AUTH_MESSAGE =
	"No Tedix MCP auth found. Run `tedix login`, or set TEDIX_MCP_BEARER_TOKEN / TEDIX_MCP_API_KEY to a credential issued for the target gateway.";

export function usesRetiredTedixOAuthClient(input: {
	mcpUrl: string;
	storedClientId?: string;
	expectedClientId?: string;
}): boolean {
	return (
		isTedixHostedMcpUrl(input.mcpUrl) &&
		Boolean(input.storedClientId) &&
		input.storedClientId !== (input.expectedClientId ?? TEDIX_OAUTH_CLIENT_ID)
	);
}

export function readMcpAuthHeaders(): AuthResolution | null {
	const bearerToken = process.env.TEDIX_MCP_BEARER_TOKEN?.trim();
	const mcpApiKey = process.env.TEDIX_MCP_API_KEY?.trim();
	if (!bearerToken && !mcpApiKey) return null;
	// Fix #6: only reject sk_* when there is no usable bearer token alongside it.
	if (!bearerToken && mcpApiKey?.startsWith("sk_")) {
		throw new Error(RAW_API_KEY_MESSAGE);
	}
	return {
		headers: bearerToken
			? { Authorization: `Bearer ${bearerToken}` }
			: { "X-API-Key": mcpApiKey as string },
		source: bearerToken ? "bearer" : "mcp-api-key",
	};
}

/**
 * Resolve the active workspace name for this invocation: explicit `--workspace`
 * (or `TEDIX_WORKSPACE`, applied in parseOptions) wins, then the stored current
 * workspace, then the implicit DEFAULT_WORKSPACE.
 */
export function resolveWorkspaceName(options: CliOptions): string {
	return (
		options.workspace?.trim() || getCurrentWorkspace() || DEFAULT_WORKSPACE
	);
}

/**
 * Resolve a stored `tedix login` session into an SDK OAuth provider bound to
 * one named workspace and MCP resource. The SDK refreshes or challenges on the
 * first request and the provider rewrites only that workspace entry.
 *
 * Returns a `loginError` string instead of printing directly, so `resolveAuth`
 * emits exactly one message rather than two overlapping "Run tedix login" lines.
 */
export async function resolveStoredLoginAuth(
	workspace: string,
	options: {
		credential?: ReturnType<typeof readWorkspaceCredentials>;
		refreshSession?: typeof refreshStoredSession;
	} = {},
): Promise<{
	auth: AuthResolution | null;
	loginError?: string;
}> {
	const cred =
		options.credential === undefined
			? readWorkspaceCredentials(workspace)
			: options.credential;
	if (!cred) return { auth: null };
	if (!cred.oauthTokens?.access_token && !cred.oauthTokens?.refresh_token)
		return { auth: null };
	const mcpUrl = cred.mcpUrl;
	if (!mcpUrl) {
		return {
			auth: null,
			loginError: `Stored login for workspace "${workspace}" has no MCP resource URL. Run \`tedix login --workspace ${workspace}\` to re-authenticate.`,
		};
	}
	const expectedClientId =
		process.env.TEDIX_OAUTH_CLIENT_ID?.trim() || TEDIX_OAUTH_CLIENT_ID;
	const storedClientId = cred.oauthClientInformation?.client_id;
	if (
		usesRetiredTedixOAuthClient({ mcpUrl, storedClientId, expectedClientId })
	) {
		return {
			auth: null,
			loginError: `Stored login for workspace "${workspace}" uses a retired Tedix CLI OAuth client. Run \`tedix login --workspace ${workspace}\` to authorize the verified client.`,
		};
	}
	const oauthProvider = new WorkspaceOAuthProvider({
		workspace,
		mcpUrl,
		tenant: cred.org,
		persist: true,
		credential: cred,
		...(isTedixHostedMcpUrl(mcpUrl)
			? { staticClientId: expectedClientId }
			: {}),
	});

	// Renew before the command runs, not after it fails. Access tokens live ten
	// minutes while the refresh token behind them lives years. If renewal fails,
	// do not hand the expired token to the MCP SDK: its normal 401 recovery opens
	// interactive authorization and waits for the five-minute loopback callback,
	// which makes an ordinary non-login command look hung. Fail fast and require
	// the explicit login command to own that browser interaction.
	//
	// `workspace` lets renewal re-read the freshest refresh token from disk: they
	// rotate, and presenting one a sibling process already superseded is what
	// invalidates the whole family.
	if (sessionNeedsRefresh(cred)) {
		const outcome = await (options.refreshSession ?? refreshStoredSession)(
			oauthProvider,
			{ workspace },
		);
		// `not-needed` is a SUCCESS: a sibling process held the renewal lock and
		// completed it, so the credential on disk is already fresh and this
		// process adopted its result rather than presenting the token the sibling
		// just superseded. Treating it as failure told the operator to run `tedix
		// login` while their session was perfectly valid — a false auth failure
		// introduced when cross-process renewal gained that outcome.
		if (outcome !== "refreshed" && outcome !== "not-needed") {
			return {
				auth: null,
				loginError: `Stored login for workspace "${workspace}" could not be refreshed (${outcome}). Run \`tedix login --workspace ${workspace}\` to re-authenticate.`,
			};
		}
	}

	return {
		auth: {
			headers: {},
			mcpUrl,
			oauthProvider,
			source: `stored-login:${workspace}`,
		},
	};
}

/**
 * Refuse a command whose workspace drifted away from the one its Agent-Session
 * was started in. See `./workspace-binding` for why the shared selection makes
 * this reachable, and why an explicit `-w` is deliberately exempt.
 *
 * A `derived` session is a best-effort PPID grouping, not a durable identity,
 * so it never carries a binding.
 */
function assertSessionWorkspaceBinding(
	options: CliOptions,
	workspace: string,
): void {
	const detected = resolveAgentSession();
	if (!detected || detected.derived) return;
	const drift = sessionWorkspaceDrift({
		externalSessionKey: detected.session,
		resolvedWorkspace: workspace,
		workspaceWasExplicit: Boolean(options.workspace?.trim()),
		sessionWorkspaces: externalAgentSessionWorkspaces(detected.session),
	});
	if (drift) throw new Error(drift);
}

export async function resolveAuth(
	options: CliOptions,
): Promise<AuthResolution> {
	// 1. Explicit MCP credential wins.
	const hasEnvToken =
		Boolean(process.env.TEDIX_MCP_BEARER_TOKEN?.trim()) ||
		Boolean(process.env.TEDIX_MCP_API_KEY?.trim());
	if (hasEnvToken) {
		const direct = readMcpAuthHeaders();
		if (direct) return direct;
	}

	// 2. Explicit external-agent mode. This is opt-in so a human OAuth session
	// carrying TEDIX_AGENT_SESSION only for board traceability is never silently
	// promoted into an external executor. Each invocation mints and later revokes
	// a short-lived gateway credential bound to the immutable Agent-Session.
	const workspace = resolveWorkspaceName(options);
	assertSessionWorkspaceBinding(options, workspace);

	const externalAgentSelector = process.env.TEDIX_EXTERNAL_AGENT?.trim();
	if (externalAgentSelector) {
		return resolveExternalAgentAuth({
			workspace,
			selector: externalAgentSelector,
			organization: options.organization ?? process.env.TEDIX_ORGANIZATION,
		});
	}

	// 3. Stored OAuth login for the selected workspace — the common interactive
	//    case, no API key needed. Fix #11: consume the single loginError and
	//    emit exactly one message.
	const { auth: stored, loginError } = await resolveStoredLoginAuth(workspace);
	if (stored) return stored;

	throw new Error(loginError ?? AUTH_MESSAGE);
}

/** Derive a default workspace name from a Descope tenant/org id. */
export function workspaceNameFromOrg(tenant: string): string {
	if (tenant.startsWith("personal_")) return "personal";
	return tenant.replace(/^org_/, "") || tenant;
}

/**
 * Derive a default workspace name from a gateway MCP URL — the first host label
 * with a trailing `-unified` stripped (e.g.
 * https://acme-unified.mcp.tedix.dev/mcp → "acme"). Falls back to
 * DEFAULT_WORKSPACE on a malformed URL.
 */
export function workspaceNameFromGateway(mcpUrl: string): string {
	try {
		const first = new URL(mcpUrl).hostname.split(".")[0] ?? "";
		return first.replace(/-unified$/, "") || DEFAULT_WORKSPACE;
	} catch {
		return DEFAULT_WORKSPACE;
	}
}

/**
 * Final workspace (slot) name for a COMPLETED login. The key property: it never
 * mints the literal "default". Explicit --workspace wins; a non-default gateway
 * names itself from its host; otherwise the name derives from the login's actual
 * tenant — the token's `dct`, resolved AFTER OAuth, not from whatever the
 * operator happened to click. "default" survives only as an absolute last resort
 * when the tenant is somehow unknown. This is what stops a bare `tedix login`
 * from silently creating (and re-pointing) a stale, wrong-tenant "default" slot:
 * every login lands in a slot named for its own tenant, so two tenants can never
 * share the "default" slot.
 */
export function resolveLoginWorkspaceName(opts: {
	explicit?: string;
	gatewayUrl: string;
	isDefaultGateway: boolean;
	tokenTenant?: string;
}): string {
	const explicit = opts.explicit?.trim();
	if (explicit) return explicit;
	if (!opts.isDefaultGateway) return workspaceNameFromGateway(opts.gatewayUrl);
	if (opts.tokenTenant) {
		const name = workspaceNameFromOrg(opts.tokenTenant);
		if (name && name !== DEFAULT_WORKSPACE) return name;
	}
	return DEFAULT_WORKSPACE;
}

/** Require an explicit tenant when `--url` bypasses the Tedix OS picker. */
export function requireExplicitTedixLoginTenant(input: {
	isTedixHosted: boolean;
	urlExplicit: boolean;
	expectedTenant?: string;
}): void {
	if (
		input.isTedixHosted &&
		input.urlExplicit &&
		!input.expectedTenant?.trim()
	) {
		throw new Error(
			"Explicit Tedix gateway login requires `--org <organization-id>`. Prefer `tedix login <organization-slug>` so Tedix OS selects the exact tenant safely.",
		);
	}
}

export function jwtSummary(
	token: string | undefined,
): Record<string, unknown> | null {
	if (!token) return null;
	const claims = decodeJwtPayload(token);
	if (!claims) return null;
	const roles = Array.isArray(claims.roles)
		? claims.roles.filter((role): role is string => typeof role === "string")
		: [];
	const scopes = extractJwtScopes(claims as unknown as JWTPayload);
	const platformAdministration =
		roles.includes("platform-admin") ||
		scopes.includes("platform:admin") ||
		scopes.includes("*");
	const exp = typeof claims.exp === "number" ? claims.exp : undefined;
	const tenants = isRecord(claims.tenants) ? Object.keys(claims.tenants) : [];
	const selection = claims.tedixSelectedOrganizations;
	const selectedOrganizations =
		Array.isArray(selection) &&
		selection.length >= 1 &&
		selection.length <= 10 &&
		selection.every(
			(id) => typeof id === "string" && id.length > 0 && id.length <= 256,
		) &&
		new Set(selection).size === selection.length
			? (selection as string[])
			: [];
	return {
		sub: typeof claims.sub === "string" ? claims.sub : undefined,
		dct: typeof claims.dct === "string" ? claims.dct : undefined,
		tediId: typeof claims.tediId === "string" ? claims.tediId : undefined,
		entityType:
			typeof claims.entityType === "string" ? claims.entityType : undefined,
		tenantKeys: tenants,
		roles,
		scopes,
		platformAdministration,
		...(selectedOrganizations.length > 0 ? { selectedOrganizations } : {}),
		...(exp ? { exp, expiresAt: new Date(exp * 1000).toISOString() } : {}),
	};
}

export async function printAuthStatus(options: CliOptions): Promise<void> {
	const direct = readMcpAuthHeaders();
	const workspace = resolveWorkspaceName(options);
	const stored = readWorkspaceCredentials(workspace);
	const bearer = process.env.TEDIX_MCP_BEARER_TOKEN?.trim();
	const mcpApiKey = process.env.TEDIX_MCP_API_KEY?.trim();
	const externalSelector = process.env.TEDIX_EXTERNAL_AGENT?.trim();
	const external = externalSelector ? externalAgentStatus(workspace) : null;
	const wouldUse = direct
		? direct.source
		: external?.configured === true
			? `external-agent:${String(external.key)}`
			: stored?.oauthTokens?.access_token || stored?.oauthTokens?.refresh_token
				? "stored-login"
				: "none";
	// Mirror the runtime URL/credential coupling: a real command targets the
	// workspace gateway only when the resolved source is that workspace's stored
	// login (explicit env tokens stay on the explicit/default target URL).
	const effectiveUrl =
		!options.urlExplicit && external?.configured === true
			? String(external.mcpUrl)
			: !options.urlExplicit && wouldUse === "stored-login" && stored?.mcpUrl
				? stored.mcpUrl
				: options.url;
	const status = {
		mcpUrl: effectiveUrl,
		workspace,
		workspaces: listWorkspaces(),
		wouldUse,
		direct: direct
			? {
					source: direct.source,
					jwt: jwtSummary(bearer ?? mcpApiKey),
				}
			: null,
		storedLogin: stored
			? {
					loginId: stored.loginId,
					mcpUrl: stored.mcpUrl,
					org: stored.org,
					accessToken: jwtSummary(stored.oauthTokens?.access_token),
					grantedScopes: issuedOAuthScopes(stored),
					refreshExpiresAt: jwtSummary(stored.oauthTokens?.refresh_token)
						?.expiresAt,
				}
			: null,
		externalAgent: external,
	};
	if (options.json) {
		console.log(JSON.stringify(status, null, 2));
		return;
	}
	console.log(`Tedix auth status`);
	console.log(`  workspace: ${status.workspace}`);
	console.log(`  MCP URL: ${status.mcpUrl}`);
	console.log(`  selected source: ${status.wouldUse}`);
	if (status.workspaces.length > 0) {
		console.log(
			`  stored workspaces: ${status.workspaces
				.map((w) => (w.current ? `${w.name}*` : w.name))
				.join(", ")}`,
		);
	}
	if (status.direct?.jwt) {
		console.log(
			`  platform administration in token: ${status.direct.jwt.platformAdministration ? "present" : "not present"}`,
		);
		console.log(`  direct JWT: ${JSON.stringify(status.direct.jwt)}`);
	}
	if (status.storedLogin?.accessToken) {
		console.log(`  stored login: ${status.storedLogin.loginId || "(unknown)"}`);
		console.log(
			`  granted scopes: ${status.storedLogin.grantedScopes?.join(", ") ?? "(not reported by issuer)"}`,
		);
		console.log(
			`  stored JWT: ${JSON.stringify(status.storedLogin.accessToken)}`,
		);
		console.log(
			`  platform administration in token: ${status.storedLogin.accessToken.platformAdministration ? "present" : "not present"}`,
		);
		if (!status.storedLogin.accessToken.platformAdministration) {
			console.log(
				"  platform administration requires an eligible account and explicit consent: tedix login --scope-profile platform-admin",
			);
		}
		const selected = status.storedLogin.accessToken.selectedOrganizations;
		if (Array.isArray(selected)) {
			console.log(`  selected organizations: ${selected.join(", ")}`);
		}
	}
	if (status.wouldUse === "none") console.log(`  ${AUTH_MESSAGE}`);
}
