/**
 * Descope access-key exchange helper.
 *
 * Access keys are long-lived secrets. Runtime callers exchange them for short
 * session JWTs and cache only the JWT until it is close to expiry.
 *
 * Calls `/v1/auth/accesskey/exchange` through `descopeFetch` for its bounded
 * per-attempt timeout, with retries disabled so a failed exchange surfaces
 * once to the caller. The SDK's `accessKey` module also covers this endpoint;
 * this path stays outside it for its self-contained caching loop.
 */

import { descopeFetch } from "./descope-fetch";
import { DESCOPE_DEFAULT_BASE_URL } from "./types";

export interface DescopeAccessKeyExchangeConfig {
	descopeAccessKey: string;
	descopeProjectId: string;
	descopeBaseUrl?: string;
	timeoutMs?: number;
	fetch?: typeof fetch;
}

interface CachedToken {
	jwt: string;
	expiresAt: number;
}

const DEFAULT_BASE_URL = DESCOPE_DEFAULT_BASE_URL;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const REFRESH_MARGIN = 0.8;

export class DescopeAccessKeyExchange {
	private cached: CachedToken | null = null;
	private exchangePromise: Promise<string> | null = null;

	constructor(private readonly config: DescopeAccessKeyExchangeConfig) {}

	async getToken(): Promise<string> {
		if (this.cached && this.cached.expiresAt > Date.now()) {
			return this.cached.jwt;
		}

		if (this.exchangePromise) {
			return this.exchangePromise;
		}

		this.exchangePromise = this.exchange();
		try {
			return await this.exchangePromise;
		} finally {
			this.exchangePromise = null;
		}
	}

	async getAuthHeader(): Promise<string | null> {
		try {
			const token = await this.getToken();
			return `Bearer ${token}`;
		} catch {
			return null;
		}
	}

	private async exchange(): Promise<string> {
		const baseUrl = this.config.descopeBaseUrl || DEFAULT_BASE_URL;
		const url = `${baseUrl}/v1/auth/accesskey/exchange`;
		const response = await descopeFetch(
			url,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Accept-Encoding": "identity",
					Authorization: `Bearer ${this.config.descopeProjectId}:${this.config.descopeAccessKey}`,
				},
				body: JSON.stringify({ loginOptions: {} }),
			},
			{
				timeoutMs: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				retries: 0,
				fetch: this.config.fetch,
			},
		);

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(
				`Descope access key exchange failed (${response.status}): ${text.slice(0, 500)}`,
			);
		}

		const data = (await response.json()) as {
			sessionJwt?: string;
			keyId?: string;
		};

		if (!data.sessionJwt) {
			throw new Error("Descope exchange response missing sessionJwt");
		}

		const exp = parseJwtExp(data.sessionJwt);
		const now = Date.now();
		const ttlMs = exp > 0 ? exp * 1000 - now : DEFAULT_TTL_MS;
		const expiresAt = now + ttlMs * REFRESH_MARGIN;

		this.cached = { jwt: data.sessionJwt, expiresAt };
		return data.sessionJwt;
	}
}

export function parseJwtExp(jwt: string): number {
	try {
		const parts = jwt.split(".");
		if (parts.length !== 3) return 0;
		const encoded = parts[1];
		if (!encoded) return 0;
		const payload = JSON.parse(
			atob(
				encoded
					.replace(/-/g, "+")
					.replace(/_/g, "/")
					.padEnd(Math.ceil(encoded.length / 4) * 4, "="),
			),
		) as { exp?: unknown };
		return typeof payload.exp === "number" ? payload.exp : 0;
	} catch {
		return 0;
	}
}
