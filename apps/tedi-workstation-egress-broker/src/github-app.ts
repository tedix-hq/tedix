const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const TOKEN_MAX_LIFETIME_SECONDS = 60 * 60;
const TOKEN_REFRESH_SKEW_SECONDS = 5 * 60;

export interface GitHubAppEnv {
	GITHUB_APP_ENABLED?: string;
	GITHUB_APP_ID?: string;
	GITHUB_APP_PRIVATE_KEY_PKCS8?: string;
}

export interface GitHubInstallationToken {
	expiresAt: number;
	installationId: number;
	repository: string;
	repositoryId: number;
	token: string;
}

type CachedToken = GitHubInstallationToken;
const tokenCache = new Map<string, CachedToken>();
const pendingTokens = new Map<string, Promise<GitHubInstallationToken>>();

function base64url(value: string | ArrayBuffer): string {
	const bytes =
		typeof value === "string"
			? new TextEncoder().encode(value)
			: new Uint8Array(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function githubHeaders(token: string): Headers {
	return new Headers({
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"User-Agent": "tedix-workstation-egress-broker",
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
	});
}

function repositoryParts(repository: string): { owner: string; repo: string } {
	const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(repository);
	if (!match) throw new Error("github_repository_invalid");
	return { owner: match[1]!, repo: match[2]! };
}

async function appJwt(env: GitHubAppEnv, nowSeconds: number): Promise<string> {
	const appId = env.GITHUB_APP_ID?.trim();
	const privateKey = env.GITHUB_APP_PRIVATE_KEY_PKCS8?.replace(/\\n/g, "\n");
	if (!appId || !privateKey) throw new Error("github_app_unconfigured");
	const privateKeyLabel = ["PRIVATE", "KEY"].join(" ");
	const beginMarker = `-----BEGIN ${privateKeyLabel}-----`;
	const endMarker = `-----END ${privateKeyLabel}-----`;
	const pem = privateKey
		.replaceAll(beginMarker, "")
		.replaceAll(endMarker, "")
		.replace(/\s/g, "");
	if (!pem) throw new Error("github_app_private_key_invalid");
	let keyBytes: Uint8Array;
	try {
		keyBytes = Uint8Array.from(atob(pem), (character) =>
			character.charCodeAt(0),
		);
	} catch {
		throw new Error("github_app_private_key_invalid");
	}
	let key: CryptoKey;
	try {
		key = await crypto.subtle.importKey(
			"pkcs8",
			keyBytes,
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["sign"],
		);
	} catch {
		throw new Error("github_app_private_key_invalid");
	}
	const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = base64url(
		JSON.stringify({
			exp: nowSeconds + 9 * 60,
			iat: nowSeconds - 60,
			iss: appId,
		}),
	);
	const unsigned = `${header}.${payload}`;
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(unsigned),
	);
	return `${unsigned}.${base64url(signature)}`;
}

async function githubJson<T>(
	request: Request,
	fetchImpl: typeof fetch,
): Promise<T> {
	const response = await fetchImpl(request);
	if (!response.ok) {
		throw new Error(`github_app_upstream_${response.status}`);
	}
	return (await response.json()) as T;
}

async function mintInstallationToken(
	env: GitHubAppEnv,
	scope: { installationId: number; repository: string; repositoryId: number },
	fetchImpl: typeof fetch,
	nowSeconds: number,
): Promise<GitHubInstallationToken> {
	repositoryParts(scope.repository);
	const jwt = await appJwt(env, nowSeconds);
	const tokenResponse = await githubJson<{
		expires_at?: string;
		repositories?: Array<{ full_name?: string; id?: number }>;
		token?: string;
	}>(
		new Request(
			`${GITHUB_API}/app/installations/${scope.installationId}/access_tokens`,
			{
				body: JSON.stringify({
					permissions: { contents: "write" },
					repository_ids: [scope.repositoryId],
				}),
				headers: new Headers({
					...Object.fromEntries(githubHeaders(jwt)),
					"Content-Type": "application/json",
				}),
				method: "POST",
				redirect: "manual",
			},
		),
		fetchImpl,
	);
	const expiresAt = Date.parse(tokenResponse.expires_at ?? "") / 1000;
	const observedNowSeconds = Math.max(
		nowSeconds,
		Math.floor(Date.now() / 1000),
	);
	const repositoryConfirmed = tokenResponse.repositories?.some(
		(entry) =>
			entry.id === scope.repositoryId &&
			entry.full_name?.toLowerCase() === scope.repository.toLowerCase(),
	);
	if (
		!tokenResponse.token ||
		!Number.isFinite(expiresAt) ||
		expiresAt <= observedNowSeconds ||
		expiresAt - observedNowSeconds > TOKEN_MAX_LIFETIME_SECONDS ||
		!repositoryConfirmed
	) {
		throw new Error("github_app_token_invalid");
	}
	return {
		expiresAt,
		installationId: scope.installationId,
		repository: scope.repository,
		repositoryId: scope.repositoryId,
		token: tokenResponse.token,
	};
}

export async function installationTokenForRepository(
	env: GitHubAppEnv,
	scope: { installationId: number; repository: string; repositoryId: number },
	options: { fetchImpl?: typeof fetch; nowSeconds?: number } = {},
): Promise<{ source: "cache" | "minted"; value: GitHubInstallationToken }> {
	if (env.GITHUB_APP_ENABLED !== "true") throw new Error("github_app_disabled");
	repositoryParts(scope.repository);
	if (
		!Number.isSafeInteger(scope.installationId) ||
		scope.installationId <= 0 ||
		!Number.isSafeInteger(scope.repositoryId) ||
		scope.repositoryId <= 0
	)
		throw new Error("github_app_scope_invalid");
	const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
	const key = `${scope.installationId}:${scope.repositoryId}:${scope.repository.toLowerCase()}`;
	const cached = tokenCache.get(key);
	if (cached && cached.expiresAt - TOKEN_REFRESH_SKEW_SECONDS > nowSeconds) {
		return { source: "cache", value: cached };
	}
	if (cached) tokenCache.delete(key);
	let pending = pendingTokens.get(key);
	if (!pending) {
		pending = mintInstallationToken(
			env,
			scope,
			options.fetchImpl ?? fetch,
			nowSeconds,
		);
		pendingTokens.set(key, pending);
	}
	try {
		const value = await pending;
		tokenCache.set(key, value);
		return { source: "minted", value };
	} finally {
		if (pendingTokens.get(key) === pending) pendingTokens.delete(key);
	}
}

export async function revokeCachedInstallationTokens(
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	const cached = [...tokenCache.entries()];
	pendingTokens.clear();
	const failures: string[] = [];
	await Promise.all(
		cached.map(async ([key, { token }]) => {
			try {
				const response = await fetchImpl(
					new Request(`${GITHUB_API}/installation/token`, {
						headers: githubHeaders(token),
						method: "DELETE",
						redirect: "manual",
					}),
				);
				if (!response.ok) {
					failures.push(String(response.status));
					return;
				}
				tokenCache.delete(key);
			} catch {
				failures.push("network");
			}
		}),
	);
	if (failures.length > 0)
		throw new Error("github_app_token_revocation_failed");
}

/** Incident-only GitHub control-plane action. Never accepts an installation token. */
export async function changeInstallationState(
	env: GitHubAppEnv,
	installationId: number,
	action: "suspend" | "uninstall",
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	if (!Number.isSafeInteger(installationId) || installationId <= 0) {
		throw new Error("github_app_installation_invalid");
	}
	const jwt = await appJwt(env, Math.floor(Date.now() / 1000));
	const response = await fetchImpl(
		new Request(
			`${GITHUB_API}/app/installations/${installationId}${action === "suspend" ? "/suspended" : ""}`,
			{
				headers: githubHeaders(jwt),
				method: action === "suspend" ? "PUT" : "DELETE",
				redirect: "manual",
			},
		),
	);
	if (!response.ok) throw new Error(`github_app_incident_${response.status}`);
}

/** @internal */
export function clearGitHubAppTokenCache(): void {
	tokenCache.clear();
	pendingTokens.clear();
}
