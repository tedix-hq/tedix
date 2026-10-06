import {
	CONSENT_PROTOCOL_SCOPES,
	HUMAN_CONNECT_CONSENT_SCOPES,
	isReadConsentScope,
	selectConnectConsentRequestScopes,
} from "@tedix/mcp-shared/auth/consent-scopes";
import { TEDI_MCP_SCOPES } from "@tedix/mcp-shared/auth/scopes";
import {
	isValidSelectedOrganizations,
	scopesBeyondGrant,
	validatedLoginTenant,
} from "./oauth-tenant";
import { CLI_VERSION } from "./shared";
import { decodeUnverifiedJwtClaims } from "@tedix/auth/web";
import { spawnSync } from "node:child_process";
import {
	auth,
	discoverOAuthProtectedResourceMetadata,
	refreshAuthorization,
	type FetchLike,
	type OAuthClientInformationContext,
	type OAuthClientMetadata,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	type StoredOAuthClientInformation,
	type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import {
	TEDIX_CLI_OAUTH_CLIENT_ID,
	TEDIX_CLI_OAUTH_REDIRECT_URI,
	encodeTedixCliOAuthRelayState,
} from "@tedix/auth/oauth-client-registration";
import { acquireCredentialLock, type CredentialLock } from "./credential-lock";
import {
	readWorkspaceCredentials,
	type WorkspaceCredential,
	writeWorkspaceCredentials,
} from "./credential-store";
import { runLoopbackCapture } from "./oauth-loopback";

const DEFAULT_PORT = 8976;
export const TEDIX_OAUTH_CLIENT_ID = TEDIX_CLI_OAUTH_CLIENT_ID;
export const TEDIX_CONNECT_MCP_URL = "https://connect.mcp.tedix.dev/mcp";
export function isMultiOrganizationMcpUrl(value: string): boolean {
	return value === TEDIX_CONNECT_MCP_URL;
}
export const TEDIX_OAUTH_CLIENT_URI = "https://tedix.dev";
export const TEDIX_OAUTH_LOGO_URI =
	"https://os.tedix.dev/images/tedi-astronaut-waving.png";
export const SESSION_REFRESH_TIMEOUT_MS = 15_000;

export function isTedixHostedMcpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			(url.hostname === "mcp.tedix.dev" ||
				url.hostname.endsWith(".mcp.tedix.dev"))
		);
	} catch {
		return false;
	}
}

export const INTERACTIVE_OAUTH_SCOPE_PROFILES = [
	"read",
	"member",
	"admin",
	"platform-admin",
] as const;

export type InteractiveOAuthScopeProfile =
	(typeof INTERACTIVE_OAUTH_SCOPE_PROFILES)[number];

const protocolScopes = new Set<string>(CONSENT_PROTOCOL_SCOPES);
const humanCapabilityScopes = new Set<string>([
	...HUMAN_CONNECT_CONSENT_SCOPES,
	...TEDI_MCP_SCOPES,
]);

/**
 * Select the permission envelope to present for human consent.
 *
 * Protected-resource metadata describes everything the server supports. It is
 * not a safe default grant: the MCP SDK requests every advertised scope when a
 * host omits `scope`, including Tedix's platform-admin capabilities. The chosen
 * profile fixes the exact request before the authorization flow begins.
 */
export function selectInteractiveOAuthScope(
	supportedScopes: readonly string[] | undefined,
	profile: InteractiveOAuthScopeProfile = "read",
): string {
	const advertised = [...new Set(supportedScopes ?? [])];
	const scopes = advertised.filter((scope) => {
		if (!scope) return false;
		if (profile === "read") return isReadConsentScope(scope);
		if (profile === "platform-admin") return true;
		if (protocolScopes.has(scope)) return true;
		// Discovery is untrusted inventory, not a permission classification.
		// In particular, connection administration and unknown non-MCP scopes
		// must not pass through the member profile simply because of their prefix.
		if (!humanCapabilityScopes.has(scope)) return false;
		return (
			profile === "admin" ||
			isReadConsentScope(scope) ||
			scope.endsWith(".write") ||
			scope === "connections.execute"
		);
	});
	if (scopes.length === 0) {
		throw new Error(
			`OAuth discovery returned no scopes usable by the ${profile} profile`,
		);
	}
	return scopes.join(" ");
}

/** Exact scope choices are made before Descope creates its consent transaction. */
export function selectRequestedOAuthScope(
	supportedScopes: readonly string[] | undefined,
	requestedScopes: readonly string[],
): string {
	const supported = new Set(supportedScopes ?? []);
	const requested = [...new Set(requestedScopes)];
	if (requested.length === 0 || requested.length !== requestedScopes.length) {
		throw new Error("Select at least one distinct OAuth permission.");
	}
	for (const scope of requested) {
		if (
			!/^(?:mcp:[a-z0-9_-]+\.(?:read|write|admin)|connections\.(?:read|execute|admin)|platform:admin)$/.test(
				scope,
			) ||
			!supported.has(scope)
		) {
			throw new Error(
				`The selected OAuth permission ${scope} is not supported by this MCP resource.`,
			);
		}
	}
	// Protocol scopes keep the refresh-backed CLI login usable. They grant no
	// additional MCP tool authority and are included only when advertised.
	for (const scope of CONSENT_PROTOCOL_SCOPES) {
		if (supported.has(scope)) requested.push(scope);
	}
	return requested.join(" ");
}

/** Constrain an untrusted insufficient_scope challenge to the same consent
 * profile used for initial login, then union it with the already issued grant. */
export function selectInteractiveOAuthChallengeScope(
	currentScope: string | undefined,
	challengedScope: string,
	profile: InteractiveOAuthScopeProfile = "read",
): string {
	const challenged = challengedScope.split(/\s+/).filter(Boolean);
	// Validate the challenge on its own so a challenge containing only forbidden
	// authority (notably platform:admin) cannot trigger a no-op reauthorization.
	selectInteractiveOAuthScope(challenged, profile);
	return selectInteractiveOAuthScope(
		[...(currentScope?.split(/\s+/).filter(Boolean) ?? []), ...challenged],
		profile,
	);
}

/** Display only issued authority, never the scopes we requested. Not an auth check. */
export function issuedOAuthScopes(credential: {
	oauthTokens?: StoredOAuthTokens;
}): string[] | null {
	const claims = decodeUnverifiedJwtClaims(
		credential.oauthTokens?.access_token ?? "",
	);
	const value = claims?.scope ?? claims?.scp ?? credential.oauthTokens?.scope;
	if (typeof value === "string")
		return [...new Set(value.split(/\s+/).filter(Boolean))];
	if (Array.isArray(value) && value.every((scope) => typeof scope === "string"))
		return [...new Set(value)];
	return null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	return decodeUnverifiedJwtClaims(token);
}

export function openBrowser(url: string): void {
	try {
		let result: ReturnType<typeof spawnSync>;
		if (process.platform === "darwin") {
			result = spawnSync("open", [url], { stdio: "ignore" });
		} else if (process.platform === "win32") {
			result = spawnSync("cmd", ["/c", "start", url], { stdio: "ignore" });
		} else {
			result = spawnSync("xdg-open", [url], { stdio: "ignore" });
		}
		if (result.status !== 0) console.log(`Open this URL to log in:\n${url}`);
	} catch {
		console.log(`Open this URL to log in:\n${url}`);
	}
}

function expiry(
	token: string | undefined,
	fallback?: number,
): number | undefined {
	const exp = token ? decodeJwtPayload(token)?.exp : undefined;
	return typeof exp === "number" && Number.isFinite(exp) ? exp : fallback;
}

export interface WorkspaceOAuthProviderOptions {
	workspace?: string;
	scopeProfile?: InteractiveOAuthScopeProfile;
	requestedScopes?: readonly string[];
	/** Fresh Connect login: show optional choices; the browser selects reads. */
	offerConsentChoices?: boolean;
	mcpUrl: string;
	tenant?: string;
	staticClientId?: string;
	persist?: boolean;
	timeoutMs?: number;
	port?: number;
	credential?: WorkspaceCredential;
	loadStored?: boolean;
	openAuthorization?: (url: string) => void;
	captureCallback?: (
		authorizationUrl: URL,
		expectedState: string,
	) => Promise<URLSearchParams>;
}

export function prepareTedixCliAuthorization(input: {
	authorizationUrl: URL;
	expectedState: string;
	loopbackPort: number;
}): { authorizationUrl: URL; expectedState: string } {
	const authorizationUrl = new URL(input.authorizationUrl);
	const expectedState = encodeTedixCliOAuthRelayState(
		input.expectedState,
		input.loopbackPort,
	);
	authorizationUrl.searchParams.set("state", expectedState);
	authorizationUrl.searchParams.set(
		"redirect_uri",
		TEDIX_CLI_OAUTH_REDIRECT_URI,
	);
	return { authorizationUrl, expectedState };
}

/** Workspace-scoped persistence and browser UX for the SDK OAuth engine. */
export class WorkspaceOAuthProvider implements OAuthClientProvider {
	readonly #options: WorkspaceOAuthProviderOptions;
	#credential: WorkspaceCredential | undefined;
	#tokens: StoredOAuthTokens | undefined;
	#accessTokenExpiresAtSeconds: number | undefined;
	#client: StoredOAuthClientInformation | undefined;

	#scopeProfile: InteractiveOAuthScopeProfile;
	#interactive = false;

	get scopeProfile(): InteractiveOAuthScopeProfile {
		return this.#scopeProfile;
	}

	/** One transaction owns exchange, tenant validation, durable save and browser completion. */
	async authorizeInteractive(
		options: Parameters<typeof auth>[1],
		commit?: (credential: WorkspaceCredential) => void | Promise<void>,
	): Promise<void> {
		this.#interactive = true;
		try {
			// A transport challenge must never fall back to the SDK's all-scopes default.
			const supportedScopes = options.scope
				? undefined
				: (
						await discoverOAuthProtectedResourceMetadata(
							this.#options.mcpUrl,
							undefined,
							options.fetchFn,
						)
					).scopes_supported;
			const scope = options.scope
				? selectInteractiveOAuthChallengeScope(
						this.#tokens?.scope,
						options.scope,
						this.#scopeProfile,
					)
				: this.#options.requestedScopes
					? selectRequestedOAuthScope(
							supportedScopes,
							this.#options.requestedScopes,
						)
					: this.#options.offerConsentChoices &&
						  isMultiOrganizationMcpUrl(this.#options.mcpUrl)
						? selectRequestedOAuthScope(
								supportedScopes,
								selectConnectConsentRequestScopes(
									supportedScopes ?? [],
									this.#scopeProfile === "platform-admin",
								),
							)
						: selectInteractiveOAuthScope(supportedScopes, this.#scopeProfile);
			const authOptions = { ...options, scope };
			if ((await auth(this, authOptions)) === "REDIRECT") {
				const callback = await this.waitForCallback();
				const result = await auth(this, {
					...authOptions,
					authorizationCode: callback.get("code") ?? undefined,
					iss: callback.get("iss") ?? undefined,
				});
				if (result !== "AUTHORIZED")
					throw new Error("OAuth authorization did not complete");
			}
			const credential = this.credential();
			const tokenClaims = decodeJwtPayload(
				credential.oauthTokens?.access_token ?? "",
			);
			const tenant = validatedLoginTenant({
				isTedixHosted: isTedixHostedMcpUrl(this.#options.mcpUrl),
				multiOrganizationResource: isMultiOrganizationMcpUrl(
					this.#options.mcpUrl,
				),
				expectedResource: this.#options.mcpUrl,
				expectedTenant: this.#options.tenant ?? this.#credential?.org,
				tokenClaims,
			});
			if (
				scopesBeyondGrant(credential.oauthTokens?.scope, { tokenClaims })
					.length > 0
			) {
				throw new Error(
					"Tedix OAuth issued an access token broader than its granted scopes. Credentials were not saved.",
				);
			}
			if (tenant) credential.org = tenant;
			if (commit) await commit(credential);
			else if (this.#options.persist && this.#options.workspace) {
				writeWorkspaceCredentials(
					this.#options.workspace,
					credential,
					undefined,
					this.#credential,
				);
			}
			this.#credential = credential;
			this.completeBrowserLogin({ ok: true });
		} catch (error) {
			this.reloadCredential(this.#credential);
			this.completeBrowserLogin({
				ok: false,
				message:
					"CLI authorization could not be completed. Return to the terminal for details.",
			});
			throw error;
		} finally {
			this.#interactive = false;
		}
	}

	async authorizeScopeChallenge(requiredScope: string): Promise<void> {
		await this.authorizeInteractive({
			serverUrl: this.#options.mcpUrl,
			scope: requiredScope,
			forceReauthorization: true,
		});
	}

	/** Reload the authoritative store without writing a stale snapshot back. */
	reloadCredential(credential: WorkspaceCredential | undefined): void {
		this.#credential = credential;
		this.#tokens = credential?.oauthTokens;
		this.#accessTokenExpiresAtSeconds = credential?.accessTokenExpiresAtSeconds;
		this.#client =
			credential?.oauthClientInformation ??
			(this.#options.staticClientId
				? { client_id: this.#options.staticClientId }
				: undefined);
		this.#discovery = credential?.oauthDiscoveryState;
		this.#resourceUrl = credential?.oauthResourceUrl;
		this.#scopeProfile =
			this.#options.scopeProfile ?? credential?.oauthScopeProfile ?? "read";
	}
	#discovery: OAuthDiscoveryState | undefined;
	#verifier = "";
	#state = "";
	#callback: Promise<URLSearchParams> | undefined;
	#resourceUrl: string | undefined;
	#activePort: number | undefined;
	#completeBrowser:
		| ((result: { ok: boolean; message?: string }) => void)
		| undefined;

	constructor(options: WorkspaceOAuthProviderOptions) {
		this.#options = options;
		this.#credential =
			options.credential ??
			(options.workspace && options.loadStored !== false
				? (readWorkspaceCredentials(options.workspace) ?? undefined)
				: undefined);
		this.#scopeProfile =
			options.scopeProfile ?? this.#credential?.oauthScopeProfile ?? "read";
		this.#tokens = this.#credential?.oauthTokens;
		this.#accessTokenExpiresAtSeconds =
			this.#credential?.accessTokenExpiresAtSeconds;
		this.#client =
			this.#credential?.oauthClientInformation ??
			(options.staticClientId
				? { client_id: options.staticClientId }
				: undefined);
		this.#discovery = this.#credential?.oauthDiscoveryState;
		this.#resourceUrl = this.#credential?.oauthResourceUrl;
	}

	get redirectUrl(): URL {
		if (this.#options.staticClientId === TEDIX_CLI_OAUTH_CLIENT_ID) {
			return new URL(TEDIX_CLI_OAUTH_REDIRECT_URI);
		}
		return new URL(
			`http://localhost:${this.#activePort ?? this.#options.port ?? DEFAULT_PORT}/callback`,
		);
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: `tedix-cli${this.#options.workspace ? ` ${this.#options.workspace}` : ""}`,
			client_uri: TEDIX_OAUTH_CLIENT_URI,
			logo_uri: TEDIX_OAUTH_LOGO_URI,
			redirect_uris: [this.redirectUrl.toString()],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	state(): string {
		// The MCP OAuth engine may read the provider state more than once while it
		// assembles one authorization request. Keep one nonce for that transaction;
		// rotating it on every read makes the loopback validator expect a different
		// value from the one sent to the authorization server.
		if (!this.#state) {
			this.#activePort = undefined;
			this.#state = crypto.randomUUID();
		}
		return this.#state;
	}

	clientInformation(
		ctx?: OAuthClientInformationContext,
	): StoredOAuthClientInformation | undefined {
		if (
			ctx?.issuer &&
			this.#client?.issuer &&
			this.#client.issuer !== ctx.issuer
		) {
			return undefined;
		}
		if (ctx?.issuer && this.#client && !this.#client.issuer) {
			this.#client = { ...this.#client, issuer: ctx.issuer };
		}
		return this.#client;
	}

	async saveClientInformation(
		client: StoredOAuthClientInformation,
	): Promise<void> {
		this.#client = client;
		await this.#persist();
	}

	tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
		if (
			ctx?.issuer &&
			this.#tokens?.issuer &&
			this.#tokens.issuer !== ctx.issuer
		) {
			return undefined;
		}
		if (ctx?.issuer && this.#tokens && !this.#tokens.issuer) {
			this.#tokens = { ...this.#tokens, issuer: ctx.issuer };
		}
		return this.#tokens;
	}

	async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
		await this.saveRenewedTokens(tokens);
	}

	async saveRenewedTokens(
		tokens: StoredOAuthTokens,
		expectedCredential?: WorkspaceCredential,
	): Promise<void> {
		this.#tokens = tokens;
		const duration = tokens.expires_in;
		const fallback =
			typeof duration === "number" && Number.isFinite(duration) && duration >= 0
				? Math.floor(Date.now() / 1000) + duration
				: undefined;
		this.#accessTokenExpiresAtSeconds = expiry(tokens.access_token, fallback);
		await this.#persist(expectedCredential);
	}

	/**
	 * Defining this hook replaces the SDK's default public-client authentication,
	 * so it must also retain the ordinary `client_id` parameter.
	 */
	readonly addClientAuthentication = (
		_headers: Headers,
		params: URLSearchParams,
	): void => {
		const clientId = this.#client?.client_id ?? this.#options.staticClientId;
		if (clientId) params.set("client_id", clientId);
	};

	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		// Tedix Cloud's own tenant key; an own-account installation never matches this branch.
		if (this.#options.tenant) {
			authorizationUrl.searchParams.set(
				"tenant",
				this.#options.tenant === "tedix" ? "org_tedix" : this.#options.tenant,
			);
			authorizationUrl.searchParams.set("prompt", "consent");
		}
		if (isMultiOrganizationMcpUrl(this.#options.mcpUrl)) {
			authorizationUrl.searchParams.set("prompt", "consent");
		}
		if (!this.#state) {
			this.#state = authorizationUrl.searchParams.get("state") ?? "";
		}
		// The SDK can request the redirect more than once while resolving one OAuth
		// challenge. One provider transaction owns one loopback listener; starting a
		// second capture races the first and opens duplicate consent tabs.
		// waitForCallback clears this guard when the transaction finishes so a
		// later authorization can start normally.
		if (this.#callback) return;
		this.#callback = this.#options.captureCallback
			? this.#options.captureCallback(authorizationUrl, this.#state)
			: runLoopbackCapture({
					authorizeUrl: authorizationUrl.toString(),
					expectedState: this.#state,
					openBrowser: this.#options.openAuthorization ?? openBrowser,
					port: this.#options.port,
					onRedirectUrl: (redirectUrl) => {
						this.#activePort = Number(redirectUrl.port);
					},
					...(this.#options.staticClientId === TEDIX_CLI_OAUTH_CLIENT_ID
						? {
								prepareAuthorization: ({
									authorizationUrl,
									expectedState,
									loopbackRedirectUrl,
								}) => {
									const prepared = prepareTedixCliAuthorization({
										authorizationUrl,
										expectedState,
										loopbackPort: Number(loopbackRedirectUrl.port),
									});
									this.#state = prepared.expectedState;
									return prepared;
								},
							}
						: {}),
					timeoutMs: this.#options.timeoutMs ?? 300_000,
					deferBrowserCompletion: true,
				}).then((result) => {
					this.#completeBrowser = result.completeBrowser;
					return result.callbackParams;
				});
	}

	completeBrowserLogin(result: { ok: boolean; message?: string }): void {
		this.#completeBrowser?.(result);
		this.#completeBrowser = undefined;
	}

	saveCodeVerifier(verifier: string): void {
		this.#verifier = verifier;
	}

	codeVerifier(): string {
		return this.#verifier;
	}

	async invalidateCredentials(
		scope: "all" | "client" | "tokens" | "verifier" | "discovery",
	): Promise<void> {
		if (scope === "all" || scope === "client") this.#client = undefined;
		if (scope === "all" || scope === "tokens") {
			this.#tokens = undefined;
			this.#accessTokenExpiresAtSeconds = undefined;
		}
		if (scope === "all" || scope === "verifier") this.#verifier = "";
		if (scope === "all" || scope === "discovery") this.#discovery = undefined;
		await this.#persist();
	}

	saveDiscoveryState(state: OAuthDiscoveryState): void {
		this.#discovery = state;
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.#discovery;
	}

	saveResourceUrl(url: string): void {
		this.#resourceUrl = url;
	}

	resourceUrl(): string | undefined {
		return this.#resourceUrl;
	}

	async waitForCallback(): Promise<URLSearchParams> {
		if (!this.#callback) throw new Error("OAuth authorization was not started");
		const callback = this.#callback;
		try {
			return await callback;
		} finally {
			// A later authorization on the same provider is a new transaction and
			// therefore receives a fresh CSRF nonce.
			this.#callback = undefined;
			this.#state = "";
		}
	}

	/**
	 * Renew this provider's session from its refresh token. Exposed as a method so
	 * a transport can retry an expired-token failure without importing the
	 * concrete provider (see TedixHomeClient.callTool).
	 */
	async refreshSession(): Promise<SessionRefreshOutcome> {
		return refreshStoredSession(this, { workspace: this.#options.workspace });
	}

	credential(): WorkspaceCredential {
		const tokens = this.#tokens;
		if (!tokens?.access_token)
			throw new Error("OAuth did not return an access token");
		return {
			oauthScopeProfile: this.#scopeProfile,
			loginId:
				typeof decodeJwtPayload(tokens.access_token)?.sub === "string"
					? String(decodeJwtPayload(tokens.access_token)?.sub)
					: (this.#credential?.loginId ?? ""),
			accessTokenExpiresAtSeconds: this.#accessTokenExpiresAtSeconds,
			mcpUrl: this.#resourceUrl ?? this.#options.mcpUrl,
			...(this.#resourceUrl ? { oauthResourceUrl: this.#resourceUrl } : {}),
			...(this.#options.tenant ? { org: this.#options.tenant } : {}),
			oauthTokens: tokens,
			...(this.#client ? { oauthClientInformation: this.#client } : {}),
			...(this.#discovery ? { oauthDiscoveryState: this.#discovery } : {}),
		};
	}

	async #persist(expectedCredential?: WorkspaceCredential): Promise<void> {
		if (this.#interactive || !this.#options.persist || !this.#options.workspace)
			return;
		if (this.#tokens) {
			this.#credential = this.credential();
			writeWorkspaceCredentials(
				this.#options.workspace,
				this.#credential,
				undefined,
				expectedCredential,
			);
			return;
		}
		if (!this.#credential) return;
		const cleared: WorkspaceCredential = {
			...this.#credential,
			accessTokenExpiresAtSeconds: undefined,
			oauthTokens: undefined,
			...(this.#client
				? {
						oauthClientInformation: this.#client,
					}
				: { oauthClientInformation: undefined }),
			oauthDiscoveryState: this.#discovery,
		};
		this.#credential = cleared;
		writeWorkspaceCredentials(this.#options.workspace, cleared);
	}
}

export async function beginSdkOAuthLogin(
	provider: WorkspaceOAuthProvider,
	mcpUrl: string,
	options: {
		fetchFn?: FetchLike;
		commit?: (credential: WorkspaceCredential) => void | Promise<void>;
	} = {},
): Promise<void> {
	await provider.authorizeInteractive(
		{ serverUrl: mcpUrl, fetchFn: options.fetchFn, forceReauthorization: true },
		options.commit,
	);
}

/**
 * How long before `accessTokenExpiresAtSeconds` a stored session is treated as already stale.
 *
 * Access tokens are minted with `expires_in: 600`, so the usable window is ten
 * minutes; the refresh token behind them is good for years. Nothing was
 * refreshing proactively, and an expired access token does NOT surface as a
 * transport 401 the SDK would retry — the MCP edge forwards it and
 * `apps/api/src/rpc/orpc.ts` rejects it as an oRPC UNAUTHORIZED inside an
 * otherwise successful tool call. The command simply failed, and `tedix login`
 * appeared to be the fix only because it happens to mint a fresh token.
 *
 * The skew has to cover the whole request, not just its start: a token with
 * twenty seconds left passes a naive check and still expires in flight.
 */
export const SESSION_REFRESH_SKEW_SECONDS = 120;

/** Whether a stored session is expired or close enough that it should be renewed first. */
export function sessionNeedsRefresh(
	credential: Pick<
		WorkspaceCredential,
		"accessTokenExpiresAtSeconds" | "oauthTokens"
	>,
	nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
	if (!credential.oauthTokens?.refresh_token) return false;
	// A missing/zero expiry is unknown, not fresh — renew rather than gamble.
	if (!credential.accessTokenExpiresAtSeconds) return true;
	return (
		credential.accessTokenExpiresAtSeconds - nowSeconds <=
		SESSION_REFRESH_SKEW_SECONDS
	);
}

export type SessionRefreshOutcome =
	| "refreshed"
	| "not-needed"
	| "unavailable"
	| "invalidated"
	| "scope-expanded"
	| "failed";

/**
 * Descope invalidates an entire refresh-token FAMILY when it sees a rotated
 * token reused. Several Tedix sessions share one ~/.tedix/credentials.json, so
 * a second process refreshing from a copy the first already rotated kills the
 * credential for everyone. Nothing but a fresh login recovers it, so it is
 * worth naming rather than reporting as a generic failure.
 */
const REFRESH_FAMILY_INVALIDATED = /E064006|family ID invalidated/i;

/**
 * Renew the stored access token from the refresh token, without any browser
 * step. Uses the SDK's `refreshAuthorization` rather than `auth()` on purpose:
 * `auth()` falls back to a full authorization when refresh fails, which would
 * open a consent tab in a non-interactive agent session.
 *
 * Failed renewal returns a bounded outcome; callers require explicit login.
 * No refresh request is sent without an acquired workspace lock.
 */
export async function refreshStoredSession(
	provider: WorkspaceOAuthProvider,
	options: {
		fetchFn?: FetchLike;
		timeoutMs?: number;
		workspace?: string;
	} = {},
): Promise<SessionRefreshOutcome> {
	// Serialise renewal across processes, then re-read. Refresh tokens ROTATE, so
	// two processes renewing at once means the slower one presents a token the
	// faster one already superseded — which the authorization server treats as
	// replay and answers by invalidating the whole family, logging every process
	// on the machine out at once.
	//
	// The lock and the re-read are BOTH required and neither is sufficient.
	// Re-reading alone still lets two processes read the same token and both
	// renew. Locking alone still lets the second process renew from the token it
	// loaded before the first one rotated it. Taking the lock and only then
	// reading is what makes the second process observe the first one's result.
	let lock: CredentialLock | null = null;
	const started = Date.now();
	let lockWaitMs = 0;
	let outcome: SessionRefreshOutcome = "failed";
	let correlationId: string | undefined;
	let expectedCredential: WorkspaceCredential | undefined;
	const finish = (value: SessionRefreshOutcome) => {
		outcome = value;
		return value;
	};
	try {
		if (options.workspace) {
			lock = await acquireCredentialLock(options.workspace);
			lockWaitMs = Date.now() - started;
			if (!lock) return finish("failed");
			const stored = readWorkspaceCredentials(options.workspace);
			provider.reloadCredential(stored ?? undefined);
			expectedCredential = stored ?? undefined;
			if (!stored) return finish("unavailable");
			if (!sessionNeedsRefresh(stored)) return finish("not-needed");
		}
		const tokens = provider.tokens();
		const refreshToken = tokens?.refresh_token;
		const grantedScope = tokens?.scope?.trim();
		const clientInformation = provider.clientInformation();
		const authorizationServerUrl =
			provider.discoveryState()?.authorizationServerUrl;
		if (!refreshToken || !clientInformation || !authorizationServerUrl)
			return finish("unavailable");
		const resource = provider.resourceUrl();
		const fetchFn = options.fetchFn ?? fetch;
		const boundedFetch: FetchLike = async (input, init) => {
			const controller = new AbortController();
			const upstreamSignal = init?.signal;
			const forwardAbort = () => controller.abort(upstreamSignal?.reason);
			if (upstreamSignal?.aborted) forwardAbort();
			else
				upstreamSignal?.addEventListener("abort", forwardAbort, { once: true });
			const timer = setTimeout(
				() => controller.abort(new Error("OAuth session refresh timed out")),
				options.timeoutMs ?? SESSION_REFRESH_TIMEOUT_MS,
			);
			try {
				let body = init?.body;
				// RFC 6749 permits a refresh request to narrow but never widen the
				// original grant. Descope has returned the broader durable consent when
				// `scope` is omitted, so repeat the exact issuer-reported grant here.
				if (grantedScope && body instanceof URLSearchParams) {
					body = new URLSearchParams(body);
					if (body.get("grant_type") === "refresh_token") {
						body.set("scope", grantedScope);
					}
				}
				const response = await fetchFn(input, {
					...init,
					body,
					signal: controller.signal,
				});
				const requestId =
					response.headers.get("x-descope-request-id") ??
					response.headers.get("x-request-id");
				if (requestId && /^[a-zA-Z0-9._:-]{1,128}$/.test(requestId))
					correlationId = requestId;
				return response;
			} finally {
				clearTimeout(timer);
				upstreamSignal?.removeEventListener("abort", forwardAbort);
			}
		};
		// Hand over the authorization-server metadata we already stored at login.
		// Without it `refreshAuthorization` re-discovers the server on every
		// renewal, which measured ~3.3s on top of an otherwise ~3.7s command.
		const metadata = provider.discoveryState()?.authorizationServerMetadata;
		const renewed = await refreshAuthorization(authorizationServerUrl, {
			clientInformation,
			refreshToken,
			...(metadata ? { metadata } : {}),
			addClientAuthentication: provider.addClientAuthentication,
			...(resource ? { resource: new URL(resource) } : {}),
			fetchFn: boundedFetch,
		});
		const renewedScope = renewed.scope?.trim() || grantedScope;
		const renewedClaims = decodeJwtPayload(renewed.access_token);
		if (
			scopesBeyondGrant(grantedScope, {
				responseScope: renewedScope,
				tokenClaims: renewedClaims,
			}).length > 0
		) {
			console.error(
				"[tedix] Stored session renewal returned broader scopes than the saved grant. " +
					"Credentials were not updated; run `tedix login` to review access again.",
			);
			return finish("scope-expanded");
		}
		// Renewal must satisfy the same resource, token-type and tenant checks as
		// login, or a refreshed token for another resource or tenant would be
		// stored under this workspace's label.
		const stored = expectedCredential ?? provider.credential();
		const renewalResource = resource ?? stored.mcpUrl;
		try {
			const tenant = validatedLoginTenant({
				isTedixHosted: isTedixHostedMcpUrl(renewalResource ?? ""),
				multiOrganizationResource: isMultiOrganizationMcpUrl(
					renewalResource ?? "",
				),
				expectedResource: renewalResource,
				expectedTenant: stored.org,
				tokenClaims: renewedClaims,
			});
			if (stored.org && tenant && tenant !== stored.org)
				throw new Error("tenant changed");
		} catch {
			console.error(
				"[tedix] Stored session renewal returned a token for a different resource or organization. Credentials were not updated; run `tedix login` to review access again.",
			);
			return finish("failed");
		}
		if (isMultiOrganizationMcpUrl(renewalResource ?? "")) {
			const before = decodeJwtPayload(
				tokens?.access_token ?? "",
			)?.tedixSelectedOrganizations;
			const after = renewedClaims?.tedixSelectedOrganizations;
			// Organization order has no authorization meaning; unique membership does.
			if (
				!isValidSelectedOrganizations(before) ||
				!isValidSelectedOrganizations(after) ||
				before.length !== after.length ||
				before.some((id) => !after.includes(id))
			) {
				console.error(
					"[tedix] Stored session renewal changed the selected organizations. Credentials were not updated; run `tedix login` to review access again.",
				);
				return finish("failed");
			}
		}
		await provider.saveRenewedTokens(
			{
				...renewed,
				...(renewedScope ? { scope: renewedScope } : {}),
				// The authorization server may omit a rotated refresh token; keeping the
				// prior one is what stops a successful renewal from stranding the next.
				refresh_token: renewed.refresh_token ?? refreshToken,
				// `refreshAuthorization` returns plain OAuth tokens, which carry no
				// issuer. tokens() uses issuer to reject a credential minted by a
				// different authorization server, so the prior one has to be carried
				// across or the renewed session stops matching its own context.
				...(tokens?.issuer ? { issuer: tokens.issuer } : {}),
			},
			expectedCredential,
		);
		return finish("refreshed");
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		if (REFRESH_FAMILY_INVALIDATED.test(detail)) {
			// Actionable and not a secret: without it the caller falls through to a
			// full authorization, which in a non-interactive agent session simply
			// hangs until the 300s callback deadline and then reports a timeout —
			// telling the operator nothing about what actually happened.
			console.error(
				"[tedix] Stored session could not be renewed: the refresh-token family was invalidated, " +
					"usually because another Tedix process rotated the same credential. Run `tedix login` to recover.",
			);
			return finish("invalidated");
		}
		return finish("failed");
	} finally {
		lock?.release();
		if (process.env.TEDIX_DEBUG)
			console.error(
				"[tedix] OAuth refresh",
				JSON.stringify({
					version: CLI_VERSION,
					pid: process.pid,
					workspace: options.workspace ?? null,
					result: outcome,
					lockWaitMs,
					elapsedMs: Date.now() - started,
					correlationId,
				}),
			);
	}
}
