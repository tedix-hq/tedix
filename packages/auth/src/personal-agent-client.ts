import { guardedFetch } from "@tedix/ssrf-guard";
import {
	calculateJwkThumbprint,
	exportJWK,
	generateKeyPair,
	importJWK,
	SignJWT,
	type CryptoKey,
	type JWK,
} from "jose";

/**
 * Personal Agent side of Poppy 1.0: the counterpart to
 * `personal-agent-session.ts`, which verifies what this client sends.
 *
 * A client publishes a metadata document (`client_id`) and a `jwks_uri` on the
 * same host, holds its ES256 signing key as a secret, and signs every request
 * with a `Poppy-Session` JWT bound to method, URL, audience, session, user and
 * agent. `SIMULATED_PERSONAL_AGENT_IDENTITIES` are demo personas; each name
 * says so.
 */

export interface PersonalAgentIdentity {
	/** Stable persona id, e.g. `simulated-amber-otter`. */
	id: string;
	/** Display name; always starts with "Simulated". */
	name: string;
	/** Session `sub`: the person the agent acts for. */
	userId: string;
	/** Session `agent_id`. */
	agentId: string;
}

export const SIMULATED_PERSONAL_AGENT_IDENTITIES: readonly PersonalAgentIdentity[] =
	[
		{
			id: "simulated-amber-otter",
			name: "Simulated Amber Otter",
			userId: "sim-user-amber-otter",
			agentId: "sim-agent-amber-otter",
		},
		{
			id: "simulated-cobalt-finch",
			name: "Simulated Cobalt Finch",
			userId: "sim-user-cobalt-finch",
			agentId: "sim-agent-cobalt-finch",
		},
		{
			id: "simulated-jade-heron",
			name: "Simulated Jade Heron",
			userId: "sim-user-jade-heron",
			agentId: "sim-agent-jade-heron",
		},
	];

export type PersonalAgentClientErrorCode =
	| "invalid_client_id"
	| "invalid_signing_key"
	| "invalid_company"
	| "invalid_request";

/** Never carries key material, tokens or fetched bodies into the message. */
export class PersonalAgentClientError extends Error {
	constructor(readonly code: PersonalAgentClientErrorCode) {
		super(code);
	}
}

function fail(code: PersonalAgentClientErrorCode): never {
	throw new PersonalAgentClientError(code);
}

function httpsUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		fail("invalid_request");
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.hash ||
		raw.length > 2048
	)
		fail("invalid_request");
	return url;
}

/** `htu`: the request URL without query or fragment, as the verifier sees it. */
function normalizedHtu(raw: string): string {
	const url = httpsUrl(raw);
	url.search = "";
	url.hash = "";
	return url.href;
}

function randomToken(bytes = 24): string {
	const buffer = new Uint8Array(bytes);
	crypto.getRandomValues(buffer);
	return Buffer.from(buffer).toString("base64url");
}

async function sha256Base64url(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Buffer.from(digest).toString("base64url");
}

export interface PoppyCompanyDiscovery {
	protocolVersion: string;
	organization: { name?: string; domain: string };
	/** Session `aud`: `https://` + the serving domain, lowercased. */
	audience: string;
	discoveryUrl: string;
	/** First `apis` entry of type `mcp`, when listed. */
	mcpUrl?: string;
	/** `agent.protocols` entry of type `poppy`, when listed. */
	agentUrl?: string;
	/** `tasks.endpoint`, when listed. */
	tasksUrl?: string;
}

export interface PersonalAgentClientOptions {
	/**
	 * Public HTTPS URL of the client metadata document (`client_id`). Required
	 * for `clientMetadata`, `jwks` publishing context and signing; discovery
	 * alone does not need it.
	 */
	clientId?: string;
	/**
	 * ES256 private key as a JWK (with `d`) or an already-imported CryptoKey.
	 * Optional so discovery and explicitly unsigned calls need no key; any
	 * signing operation fails `invalid_signing_key` without one.
	 */
	signingKey?: JWK | CryptoKey;
	/** `kid` for the signing key in `jwks_uri`; defaults to its thumbprint. */
	keyId?: string;
	/** Defaults to `jwks.json` next to the client metadata document. */
	jwksUri?: string;
	clientName?: string;
	fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
	/** Milliseconds clock; injectable for tests. */
	now?: () => number;
	/** Dev escape hatch: also allow loopback/local hosts for fetches. */
	allowInternalHosts?: boolean;
}

interface ClientKeyMaterial {
	signer: CryptoKey;
	rootJwk: JWK;
	rootKid: string;
	sessionSigner: CryptoKey;
	sessionJwk: JWK;
	sessionKid: string;
}

export interface PersonalAgentClient {
	readonly clientId: string | undefined;
	clientMetadata(): Promise<Record<string, unknown>>;
	jwks(): Promise<{ keys: JWK[] }>;
	discoverCompany(company: string): Promise<PoppyCompanyDiscovery>;
	/** `Poppy-Session` and `Poppy-Version` headers for one request. */
	sessionHeaders(input: {
		audience: string;
		url: string;
		method: string;
		identity: PersonalAgentIdentity;
		sessionId?: string;
		accessToken?: string;
	}): Promise<Record<string, string>>;
	/** One signed (or explicitly unsigned) request to a company endpoint. */
	call(input: {
		url: string;
		method?: string;
		body?: unknown;
		headers?: Record<string, string>;
		identity: PersonalAgentIdentity;
		audience: string;
		sessionId?: string;
		signed?: boolean;
	}): Promise<Response>;
}

/** Generate a new ES256 signing key; returns the private JWK to keep secret. */
export async function generatePersonalAgentSigningKey(): Promise<JWK> {
	const pair = await generateKeyPair("ES256", { extractable: true });
	return exportJWK(pair.privateKey);
}

export function createPersonalAgentClient(
	options: PersonalAgentClientOptions,
): PersonalAgentClient {
	const clientId =
		options.clientId === undefined
			? undefined
			: httpsUrl(options.clientId).href;
	const jwksUri = options.jwksUri
		? httpsUrl(options.jwksUri).href
		: clientId === undefined
			? undefined
			: new URL("jwks.json", clientId).href;
	// The verifier requires jwks_uri on the same host as client_id.
	if (
		clientId !== undefined &&
		jwksUri !== undefined &&
		new URL(jwksUri).host !== new URL(clientId).host
	)
		fail("invalid_client_id");
	const now = options.now ?? Date.now;

	let material: Promise<ClientKeyMaterial> | null = null;
	function keys(): Promise<ClientKeyMaterial> {
		material ??= loadKeys();
		return material;
	}
	async function loadKeys(): Promise<ClientKeyMaterial> {
		const key = options.signingKey;
		if (key === undefined) fail("invalid_signing_key");
		const isJwk =
			typeof key === "object" && key !== null && "kty" in (key as JWK);
		if (isJwk && !("d" in (key as JWK))) fail("invalid_signing_key");
		const signer = (
			isJwk
				? await importJWK(key as JWK, "ES256").catch(() =>
						fail("invalid_signing_key"),
					)
				: key
		) as CryptoKey;
		// A JWK already carries its public half; a CryptoKey must be extractable
		// to publish jwks_uri, so a non-extractable one is not a usable signing key.
		const rootJwk = isJwk
			? { ...(key as JWK) }
			: await exportJWK(signer).catch(() => fail("invalid_signing_key"));
		for (const member of ["d", "p", "q", "dp", "dq", "qi", "oth", "k"])
			delete rootJwk[member as keyof JWK];
		const session = await generateKeyPair("ES256", { extractable: true });
		const sessionJwk = await exportJWK(session.publicKey);
		return {
			signer,
			rootJwk,
			rootKid: options.keyId ?? (await calculateJwkThumbprint(rootJwk)),
			sessionSigner: session.privateKey,
			sessionJwk,
			sessionKid: await calculateJwkThumbprint(sessionJwk),
		};
	}

	async function sessionJwt(input: {
		audience: string;
		url: string;
		method: string;
		identity: PersonalAgentIdentity;
		sessionId?: string;
		accessToken?: string;
	}): Promise<string> {
		if (clientId === undefined || jwksUri === undefined)
			fail("invalid_client_id");
		const key = await keys();
		const issuedAt = Math.floor(now() / 1000);
		const delegation = await new SignJWT({
			iss: clientId,
			iat: issuedAt,
			exp: issuedAt + 3600,
			jti: randomToken(16),
			cnf: { jwk: key.sessionJwk },
		})
			.setProtectedHeader({
				alg: "ES256",
				typ: "poppy-delegation+jwt",
				kid: key.rootKid,
			})
			.sign(key.signer);
		const claims: Record<string, unknown> = {
			iss: clientId,
			aud: input.audience,
			sid: input.sessionId ?? randomToken(24),
			sub: input.identity.userId,
			agent_id: input.identity.agentId,
			htm: input.method.toUpperCase(),
			htu: normalizedHtu(input.url),
			iat: issuedAt,
			jti: randomToken(16),
		};
		if (input.accessToken)
			claims.ath = await sha256Base64url(input.accessToken);
		return new SignJWT(claims)
			.setProtectedHeader({
				alg: "ES256",
				typ: "poppy-session+jwt",
				kid: key.sessionKid,
				poppy_dlg: delegation,
			})
			.sign(key.sessionSigner);
	}

	async function fetchJson(url: string): Promise<Record<string, unknown>> {
		const response = await guardedFetch(
			url,
			{ headers: { Accept: "application/json" } },
			{
				allowHttp: options.allowInternalHosts ?? false,
				allowInternalHosts: options.allowInternalHosts ?? false,
				allowTedixHosts: true,
				fetchFn: options.fetchFn,
			},
		);
		if (!response.ok) fail("invalid_company");
		const value: unknown = await response.json();
		if (!value || typeof value !== "object" || Array.isArray(value))
			fail("invalid_company");
		return value as Record<string, unknown>;
	}

	const client: PersonalAgentClient = {
		clientId,
		async clientMetadata() {
			if (clientId === undefined || jwksUri === undefined)
				fail("invalid_client_id");
			const key = await keys();
			return {
				client_id: clientId,
				...(options.clientName ? { client_name: options.clientName } : {}),
				jwks_uri: jwksUri,
			};
		},
		async jwks() {
			const key = await keys();
			return {
				keys: [{ ...key.rootJwk, kid: key.rootKid, alg: "ES256", use: "sig" }],
			};
		},
		async discoverCompany(company) {
			const origin = /^https?:\/\//i.test(company)
				? new URL(company).origin
				: `https://${company}`;
			const discoveryUrl = `${origin}/.well-known/poppy.json`;
			const document = await fetchJson(discoveryUrl);
			const version = document.protocol_version;
			if (typeof version !== "string" || !/^1\.\d+$/.test(version))
				fail("invalid_company");
			const organization = document.organization as
				| { name?: unknown; domain?: unknown }
				| undefined;
			const domain =
				typeof organization?.domain === "string"
					? organization.domain.toLowerCase()
					: "";
			if (!domain) fail("invalid_company");
			const apis = Array.isArray(document.apis) ? document.apis : [];
			const mcp = apis.find(
				(api): api is { type: string; url: string; description?: string } =>
					typeof api === "object" &&
					api !== null &&
					(api as { type?: unknown }).type === "mcp" &&
					typeof (api as { url?: unknown }).url === "string",
			);
			const protocols = (document.agent as { protocols?: unknown } | undefined)
				?.protocols;
			const agent = Array.isArray(protocols)
				? protocols.find(
						(protocol): protocol is { type: string; endpoint: string } =>
							typeof protocol === "object" &&
							protocol !== null &&
							(protocol as { type?: unknown }).type === "poppy" &&
							typeof (protocol as { endpoint?: unknown }).endpoint === "string",
					)
				: undefined;
			const tasks = document.tasks as { endpoint?: unknown } | undefined;
			return {
				protocolVersion: version,
				organization: {
					domain,
					...(typeof organization?.name === "string"
						? { name: organization.name }
						: {}),
				},
				audience: `https://${domain}`,
				discoveryUrl,
				...(mcp ? { mcpUrl: mcp.url } : {}),
				...(agent ? { agentUrl: agent.endpoint } : {}),
				...(typeof tasks?.endpoint === "string"
					? { tasksUrl: tasks.endpoint }
					: {}),
			};
		},
		async sessionHeaders(input) {
			return {
				"Poppy-Version": "1.0",
				"Poppy-Session": await sessionJwt(input),
			};
		},
		async call(input) {
			const method = (input.method ?? "GET").toUpperCase();
			const headers: Record<string, string> = { ...(input.headers ?? {}) };
			if (input.body !== undefined)
				headers["Content-Type"] ??= "application/json";
			// Streamable HTTP MCP servers answer 406 unless the client accepts
			// both; conversations and tasks endpoints simply return JSON.
			if (!Object.keys(headers).some((name) => name.toLowerCase() === "accept"))
				headers.Accept = "application/json, text/event-stream";
			if (input.signed !== false) {
				const session = await client.sessionHeaders({
					audience: input.audience,
					url: input.url,
					method,
					identity: input.identity,
					sessionId: input.sessionId,
				});
				Object.assign(headers, session);
			}
			return guardedFetch(
				input.url,
				{
					method,
					headers,
					...(input.body !== undefined
						? { body: JSON.stringify(input.body) }
						: {}),
				},
				{
					allowHttp: options.allowInternalHosts ?? false,
					allowInternalHosts: options.allowInternalHosts ?? false,
					allowTedixHosts: true,
					fetchFn: options.fetchFn,
				},
			);
		},
	};
	return client;
}
