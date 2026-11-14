import { guardedFetch, validateUrl } from "@tedix/ssrf-guard";
import {
	base64url,
	calculateJwkThumbprint,
	createLocalJWKSet,
	decodeJwt,
	decodeProtectedHeader,
	importJWK,
	jwtVerify,
	type JWK,
	type JSONWebKeySet,
} from "jose";

export type PersonalAgentSessionError =
	| "invalid_session"
	| "session_ended"
	| "version_unsupported";

/** Never carries a token, URL, JOSE exception or fetched response into logs. */
export class PersonalAgentSessionFailure extends Error {
	constructor(readonly code: PersonalAgentSessionError = "invalid_session") {
		super(code);
	}
}

export interface VerifiedPersonalAgentSession {
	clientId: string;
	sessionId: string;
	userId: string;
	agentId?: string;
	version: string;
}

export interface PersonalAgentClientPolicy {
	/** Absent means any public HTTPS client; an empty list admits none. */
	allowedClientIds?: readonly string[];
	blockedClientIds?: readonly string[];
}

interface ClientKeys {
	keys: JSONWebKeySet;
	expiresAt: number;
}

const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_CLIENTS = 200;
const CACHE_MS = 5 * 60_000;
const REFRESH_MS = 30_000;
const MAX_TOKEN_BYTES = 16 * 1024;
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

function requireValue(condition: unknown): asserts condition {
	if (!condition) throw new PersonalAgentSessionFailure();
}

function publicHttps(raw: string) {
	requireValue(raw.length <= 2048 && !validateUrl(raw));
	const url = new URL(raw);
	requireValue(!url.username && !url.password && !url.hash);
	return url;
}

function publicKey(value: unknown): JWK {
	requireValue(value && typeof value === "object" && !Array.isArray(value));
	const key = value as JWK;
	requireValue(PRIVATE_MEMBERS.every((name) => !(name in key)));
	requireValue(key.kty === "EC" || key.kty === "RSA");
	return key;
}

function identifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 512;
}

/** One instance per isolate; bounded caches and in-flight fetches, no Session state. */
export function createPersonalAgentSessionVerifier(
	options: {
		fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
		now?: () => number;
	} = {},
) {
	const now = options.now ?? Date.now;
	const cache = new Map<string, ClientKeys>();
	const pending = new Map<string, Promise<ClientKeys>>();
	// Failed lookups and unknown kids also consume the refresh budget.
	const attempts = new Map<string, number>();

	async function document(url: string): Promise<Record<string, unknown>> {
		publicHttps(url);
		const response = await guardedFetch(
			url,
			{
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(5000),
			},
			{ maxRedirects: 0, fetchFn: options.fetchFn },
		);
		requireValue(response.ok && response.body);
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				requireValue(size <= MAX_DOCUMENT_BYTES);
				chunks.push(value);
			}
		} finally {
			await reader.cancel();
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		requireValue(value && typeof value === "object" && !Array.isArray(value));
		return value as Record<string, unknown>;
	}

	async function clientKeys(clientId: string, force = false) {
		const existing = cache.get(clientId);
		if (existing && !force && existing.expiresAt > now()) return existing;
		const inflight = pending.get(clientId);
		if (inflight) return inflight;
		const last = attempts.get(clientId);
		requireValue(last === undefined || now() - last >= REFRESH_MS);
		requireValue(pending.size < MAX_CLIENTS);
		if (attempts.size >= MAX_CLIENTS && !attempts.has(clientId)) {
			// Fail closed while the oldest cooldown is active; don't let an attacker
			// churn identities to erase another client's refresh limit.
			const oldest = attempts.entries().next().value;
			requireValue(oldest && now() - oldest[1] >= REFRESH_MS);
			attempts.delete(oldest[0]);
		}
		attempts.delete(clientId);
		attempts.set(clientId, now());
		const load = (async () => {
			const metadata = await document(clientId);
			requireValue(metadata.client_id === clientId);
			requireValue(typeof metadata.jwks_uri === "string");
			requireValue(
				publicHttps(metadata.jwks_uri).host === publicHttps(clientId).host,
			);
			const jwks = await document(metadata.jwks_uri);
			requireValue(
				Array.isArray(jwks.keys) &&
					jwks.keys.length > 0 &&
					jwks.keys.length <= 32,
			);
			const keys = { keys: jwks.keys.map(publicKey) };
			const result = { keys, expiresAt: now() + CACHE_MS };
			if (cache.size >= MAX_CLIENTS) cache.delete(cache.keys().next().value!);
			cache.set(clientId, result);
			return result;
		})();
		pending.set(clientId, load);
		try {
			return await load;
		} finally {
			pending.delete(clientId);
		}
	}

	return async function verify(input: {
		request: Request;
		audience: string;
		policy?: PersonalAgentClientPolicy;
		/** Must come from independently validated access-token claims. */
		accessToken?: { value: string; clientId: string };
	}): Promise<VerifiedPersonalAgentSession> {
		const version = input.request.headers.get("Poppy-Version");
		if (!version || !/^1\.(0|[1-9][0-9]*)$/.test(version)) {
			throw new PersonalAgentSessionFailure("version_unsupported");
		}
		try {
			const token = input.request.headers.get("Poppy-Session");
			requireValue(token && token.length <= MAX_TOKEN_BYTES);
			const header = decodeProtectedHeader(token);
			const unverified = decodeJwt(token);
			requireValue(
				header.typ === "poppy-session+jwt" && header.alg === "ES256",
			);
			requireValue(
				typeof header.poppy_dlg === "string" && identifier(unverified.iss),
			);
			const clientId = unverified.iss;
			publicHttps(clientId);
			requireValue(!input.policy?.blockedClientIds?.includes(clientId));
			requireValue(
				!input.policy?.allowedClientIds ||
					input.policy.allowedClientIds.includes(clientId),
			);
			const delegation = header.poppy_dlg;
			const delegationHeader = decodeProtectedHeader(delegation);
			requireValue(delegationHeader.typ === "poppy-delegation+jwt");
			requireValue(
				["ES256", "PS384"].includes(delegationHeader.alg!) &&
					identifier(delegationHeader.kid),
			);
			let material = await clientKeys(clientId);
			if (!material.keys.keys.some((key) => key.kid === delegationHeader.kid)) {
				material = await clientKeys(clientId, true);
			}
			const currentDate = new Date(now());
			const { payload: grant } = await jwtVerify(
				delegation,
				createLocalJWKSet(material.keys),
				{
					algorithms: ["ES256", "PS384"],
					issuer: clientId,
					typ: "poppy-delegation+jwt",
					requiredClaims: ["iss", "iat", "exp", "jti", "cnf"],
					currentDate,
				},
			);
			requireValue(Number.isInteger(grant.iat) && Number.isInteger(grant.exp));
			requireValue(
				grant.iat! <= now() / 1000 &&
					grant.exp! > grant.iat! &&
					grant.exp! - grant.iat! <= 86400,
			);
			requireValue(identifier(grant.jti));
			const confirmation = grant.cnf as { jwk?: unknown } | undefined;
			const delegated = publicKey(confirmation?.jwk);
			requireValue(delegated.kty === "EC" && delegated.crv === "P-256");
			requireValue(header.kid === (await calculateJwkThumbprint(delegated)));
			const { payload } = await jwtVerify(
				token,
				await importJWK(delegated, "ES256"),
				{
					algorithms: ["ES256"],
					issuer: clientId,
					typ: "poppy-session+jwt",
					requiredClaims: [
						"iss",
						"aud",
						"sid",
						"sub",
						"htm",
						"htu",
						"iat",
						"jti",
					],
					currentDate,
				},
			);
			requireValue(payload.aud === input.audience);
			requireValue(
				identifier(payload.sid) && /^[A-Za-z0-9_-]+$/.test(payload.sid),
			);
			requireValue(identifier(payload.sub) && identifier(payload.jti));
			requireValue(
				payload.agent_id === undefined || identifier(payload.agent_id),
			);
			requireValue(
				Number.isInteger(payload.iat) &&
					Math.abs(now() / 1000 - payload.iat!) <= 60,
			);
			requireValue(payload.iat! <= grant.exp!);
			const target = new URL(input.request.url);
			target.search = "";
			target.hash = "";
			requireValue(
				target.protocol === "https:" &&
					payload.htu === target.href &&
					payload.htm === input.request.method,
			);
			if (input.accessToken) {
				requireValue(input.accessToken.clientId === clientId);
				const authorization = input.request.headers.get("Authorization");
				requireValue(
					authorization &&
						/^(Bearer|DPoP) /i.test(authorization) &&
						authorization.slice(authorization.indexOf(" ") + 1) ===
							input.accessToken.value,
				);
				const hash = base64url.encode(
					new Uint8Array(
						await crypto.subtle.digest(
							"SHA-256",
							new TextEncoder().encode(input.accessToken.value),
						),
					),
				);
				requireValue(payload.ath === hash);
			} else {
				requireValue(
					!input.request.headers.has("Authorization") &&
						payload.ath === undefined,
				);
			}
			return {
				clientId,
				sessionId: payload.sid,
				userId: payload.sub!,
				agentId: payload.agent_id as string | undefined,
				version,
			};
		} catch {
			throw new PersonalAgentSessionFailure();
		}
	};
}
