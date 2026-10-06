/**
 * OAuth2 client_credentials exchange shared by the MCP edge tool handler and
 * the apps/api catalog scan workflow. Exchanges a stored M2M client credential
 * for a short-lived Bearer via the provider's token endpoint. Token URLs are
 * SSRF-guarded; callers own any caching (the MCP edge wraps this in its TTL
 * credential cache).
 */

import { type ValidateUrlOptions, validateUrl } from "@tedix/ssrf-guard";

/**
 * Tedix stores M2M credentials either as a single `client_id:client_secret`
 * string (only the FIRST colon separates id from secret — secrets may contain
 * colons, which HTTP Basic tolerates) or as separate id/secret fields.
 */
export type ClientCredential =
	| string
	| { clientId: string; clientSecret: string };

export interface ClientCredentialsToken {
	accessToken: string;
	expiresInSeconds?: number;
	tokenType?: string;
}

export type ClientCredentialsResult =
	| { ok: true; token: ClientCredentialsToken }
	| { ok: false; error: string };

export interface ExchangeClientCredentialsOptions {
	/** OAuth2 grant type. Default "client_credentials". */
	grantType?: string;
	fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
	/** SSRF options for the token URL (e.g. `{ allowHttp: true }` in dev). */
	ssrf?: ValidateUrlOptions;
}

function basicCredential(credential: ClientCredential): string {
	return typeof credential === "string"
		? credential
		: `${credential.clientId}:${credential.clientSecret}`;
}

/**
 * Single Basic-auth POST to the token endpoint + typed token parse. Never
 * throws — all failures resolve to `{ ok: false, error }` so callers keep
 * their own fallback semantics (the MCP edge surfaces the error, the scan
 * workflow falls back to the next credential source).
 */
export async function exchangeClientCredentials(
	credential: ClientCredential,
	tokenUrl: string,
	options: ExchangeClientCredentialsOptions = {},
): Promise<ClientCredentialsResult> {
	const urlError = validateUrl(tokenUrl, options.ssrf);
	if (urlError) {
		return { ok: false, error: `Invalid token URL: ${urlError}` };
	}

	const fetchFn =
		options.fetchFn ??
		((url: string, init?: RequestInit) => globalThis.fetch(url, init));
	const grantType = options.grantType ?? "client_credentials";

	try {
		const resp = await fetchFn(tokenUrl, {
			method: "POST",
			headers: {
				Authorization: `Basic ${btoa(basicCredential(credential))}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: `grant_type=${encodeURIComponent(grantType)}`,
			redirect: "manual",
		});

		if (!resp.ok) {
			const body = await resp.text().catch(() => "");
			return {
				ok: false,
				error: `Token exchange failed (${resp.status}): ${body.slice(0, 200)}`,
			};
		}

		const data = (await resp.json()) as {
			access_token?: string;
			expires_in?: number;
			token_type?: string;
		};
		if (!data.access_token) {
			return {
				ok: false,
				error: "Token exchange response missing access_token",
			};
		}

		return {
			ok: true,
			token: {
				accessToken: data.access_token,
				expiresInSeconds:
					typeof data.expires_in === "number" ? data.expires_in : undefined,
				tokenType:
					typeof data.token_type === "string" ? data.token_type : undefined,
			},
		};
	} catch (err) {
		return {
			ok: false,
			error: `Token exchange error: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
