import { decodeTokenUnsafe } from "./jwt.ts";
import { descopeFetch } from "./descope-fetch.ts";
import { hasResourceAudience } from "./resource-audience.ts";
import { DESCOPE_MANAGEMENT_BASE_URL, extractJwtScopes } from "./types.ts";

export const GITHUB_ACTIONS_OIDC_ISSUER =
	"https://token.actions.githubusercontent.com";
export const GITHUB_ACTIONS_OIDC_JWKS_URL =
	"https://token.actions.githubusercontent.com/.well-known/jwks";
export const TEDIX_EXTERNAL_AGENT_WORKLOAD_AUDIENCE =
	"https://api.tedix.dev/external-agent/session-exchange";
const GRANT_ISSUER = "tedix:api";
const GRANT_AUDIENCE = "tedix:mcp-edge-workload-exchange";
const GRANT_TYPE = "tedix.external-agent.workload-grant";
type Payload = Record<string, unknown> & {
	aud?: string | string[];
	exp?: number;
	iat?: number;
	iss?: string;
	jti?: string;
	sub?: string;
};
let jwksCache:
	| { expiresAt: number; keys: Array<JsonWebKey & { kid?: string }> }
	| undefined;

export class WorkloadIdentityError extends Error {
	constructor(
		message: string,
		public readonly code:
			| "invalid_token"
			| "missing_jti"
			| "scope_escalation"
			| "subject_mismatch",
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "WorkloadIdentityError";
	}
}
export interface VerifiedGithubActionsWorkload {
	issuer: typeof GITHUB_ACTIONS_OIDC_ISSUER;
	audience: string;
	subject: string;
	jti: string;
	issuedAt: number;
	expiresAt: number;
}
export interface FederatedWorkloadToken {
	accessToken: string;
	clientId: string;
	resource: string;
	expiresAt: number;
}

export interface ExternalAgentWorkloadGrant {
	organizationId: string;
	principalId: string;
	sessionId: string;
	exchangeId: string;
	federation?: FederatedWorkloadToken;
	scopes: string[];
	expiresAt: number;
}

function b64encode(value: Uint8Array | string): string {
	const bytes =
		typeof value === "string" ? new TextEncoder().encode(value) : value;
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}
function b64decode(value: string): Uint8Array {
	const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
	const binary = atob(
		normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
	);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function parseJwt(token: string) {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("JWT must have three parts");
	const [header, payload, signature] = parts as [string, string, string];
	return {
		header: JSON.parse(new TextDecoder().decode(b64decode(header))) as Record<
			string,
			unknown
		>,
		payload: JSON.parse(
			new TextDecoder().decode(b64decode(payload)),
		) as Payload,
		signingInput: new TextEncoder().encode(`${header}.${payload}`),
		signature: b64decode(signature),
	};
}
async function hmacKey(secret: string): Promise<CryptoKey> {
	if (!secret) throw new Error("Workload exchange grant secret is required");
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export async function issueExternalAgentWorkloadGrant(
	input: ExternalAgentWorkloadGrant & { secret: string; issuedAt?: number },
): Promise<string> {
	const now = input.issuedAt ?? Math.floor(Date.now() / 1_000);
	const header = b64encode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payload = b64encode(
		JSON.stringify({
			aud: GRANT_AUDIENCE,
			exchangeId: input.exchangeId,
			federation: input.federation,
			exp: input.expiresAt,
			iat: now,
			iss: GRANT_ISSUER,
			organizationId: input.organizationId,
			principalId: input.principalId,
			scopes: input.scopes,
			sessionId: input.sessionId,
			typ: GRANT_TYPE,
		}),
	);
	const signingInput = `${header}.${payload}`;
	const signature = await crypto.subtle.sign(
		"HMAC",
		await hmacKey(input.secret),
		new TextEncoder().encode(signingInput),
	);
	return `${signingInput}.${b64encode(new Uint8Array(signature))}`;
}

export async function verifyExternalAgentWorkloadGrant(
	token: string,
	options: {
		secret: string;
		organizationId?: string;
		principalId: string;
		sessionId: string;
	},
): Promise<ExternalAgentWorkloadGrant> {
	try {
		const parsed = parseJwt(token);
		if (
			parsed.header.alg !== "HS256" ||
			!(await crypto.subtle.verify(
				"HMAC",
				await hmacKey(options.secret),
				new Uint8Array(parsed.signature),
				new Uint8Array(parsed.signingInput),
			))
		)
			throw new Error("Invalid grant signature");
		const p = parsed.payload;
		const now = Math.floor(Date.now() / 1_000);
		const scopes = Array.isArray(p.scopes)
			? p.scopes.filter((scope): scope is string => typeof scope === "string")
			: [];
		if (
			p.typ !== GRANT_TYPE ||
			p.iss !== GRANT_ISSUER ||
			p.aud !== GRANT_AUDIENCE ||
			typeof p.iat !== "number" ||
			typeof p.exp !== "number" ||
			p.iat > now + 5 ||
			now >= p.exp ||
			now - p.iat > 60 ||
			typeof p.organizationId !== "string" ||
			(options.organizationId !== undefined &&
				p.organizationId !== options.organizationId) ||
			p.principalId !== options.principalId ||
			p.sessionId !== options.sessionId ||
			typeof p.exchangeId !== "string" ||
			!p.exchangeId ||
			scopes.length === 0
		)
			throw new Error("Grant binding mismatch");
		const federation = p.federation as FederatedWorkloadToken | undefined;
		if (
			federation !== undefined &&
			(!federation ||
				typeof federation.accessToken !== "string" ||
				typeof federation.clientId !== "string" ||
				typeof federation.resource !== "string" ||
				typeof federation.expiresAt !== "number" ||
				federation.expiresAt <= now)
		)
			throw new Error("Invalid federated grant");
		return {
			federation,
			exchangeId: p.exchangeId,
			expiresAt: p.exp,
			organizationId: p.organizationId,
			principalId: options.principalId,
			scopes,
			sessionId: options.sessionId,
		};
	} catch (error) {
		throw new WorkloadIdentityError(
			"Workload exchange grant validation failed",
			"invalid_token",
			error,
		);
	}
}

async function githubJwk(kid: string): Promise<JsonWebKey> {
	const now = Date.now();
	if (!jwksCache || jwksCache.expiresAt <= now) {
		const response = await fetch(GITHUB_ACTIONS_OIDC_JWKS_URL, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(5_000),
		});
		if (!response.ok)
			throw new Error(`GitHub JWKS returned ${response.status}`);
		const body = (await response.json()) as {
			keys?: Array<JsonWebKey & { kid?: string }>;
		};
		if (!Array.isArray(body.keys)) throw new Error("GitHub JWKS has no keys");
		jwksCache = { expiresAt: now + 30_000, keys: body.keys };
	}
	const key = jwksCache.keys.find((candidate) => candidate.kid === kid);
	if (!key) throw new Error("GitHub signing key not found");
	return key;
}

export async function verifyGithubActionsWorkloadToken(
	token: string,
	options: {
		expectedSubject: string;
		expectedAudience?: string;
		jwk?: JsonWebKey;
	},
): Promise<VerifiedGithubActionsWorkload> {
	try {
		const parsed = parseJwt(token);
		if (parsed.header.alg !== "RS256" || typeof parsed.header.kid !== "string")
			throw new Error("Unexpected token algorithm or key id");
		const key = await crypto.subtle.importKey(
			"jwk",
			options.jwk ?? (await githubJwk(parsed.header.kid)),
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		if (
			!(await crypto.subtle.verify(
				"RSASSA-PKCS1-v1_5",
				key,
				new Uint8Array(parsed.signature),
				new Uint8Array(parsed.signingInput),
			))
		)
			throw new Error("Invalid token signature");
		return verifyGithubActionsClaims(parsed.payload, options);
	} catch (error) {
		if (error instanceof WorkloadIdentityError) throw error;
		throw new WorkloadIdentityError(
			"Workload identity token validation failed",
			"invalid_token",
			error,
		);
	}
}

export function resolveFederatedWorkloadScopes(
	requested: readonly string[],
	allowed: readonly string[],
): string[] {
	const allowedSet = new Set(allowed);
	const normalized = [
		...new Set(requested.map((scope) => scope.trim())),
	].filter(Boolean);
	const unauthorized = normalized.filter((scope) => !allowedSet.has(scope));
	if (unauthorized.length)
		throw new WorkloadIdentityError(
			`Workload identity requested unauthorized scopes: ${unauthorized.join(", ")}`,
			"scope_escalation",
		);
	return normalized;
}

function verifyGithubActionsClaims(
	payload: Payload,
	options: { expectedSubject: string; expectedAudience?: string },
): VerifiedGithubActionsWorkload {
	const { aud, exp, iat, iss, jti, sub } = payload;
	const now = Math.floor(Date.now() / 1_000);
	const audience =
		options.expectedAudience ?? TEDIX_EXTERNAL_AGENT_WORKLOAD_AUDIENCE;
	const audiences = Array.isArray(aud)
		? aud
		: typeof aud === "string"
			? [aud]
			: [];
	if (
		iss !== GITHUB_ACTIONS_OIDC_ISSUER ||
		!audiences.includes(audience) ||
		typeof iat !== "number" ||
		typeof exp !== "number" ||
		iat > now + 5 ||
		now >= exp ||
		now - iat > 600
	)
		throw new Error("Invalid token claims");
	if (sub !== options.expectedSubject)
		throw new WorkloadIdentityError(
			"Workload identity subject does not match the bound principal",
			"subject_mismatch",
		);
	if (typeof jti !== "string" || !jti)
		throw new WorkloadIdentityError(
			"Workload identity token must carry a replay identifier",
			"missing_jti",
		);
	return {
		issuer: GITHUB_ACTIONS_OIDC_ISSUER,
		audience,
		subject: sub,
		jti,
		issuedAt: iat,
		expiresAt: exp,
	};
}

export interface WorkloadFederationConfig {
	clientId: string;
	resource: string;
	repository: string;
	ref: string;
	workflowRef: string;
}

/** Absence keeps legacy issuance; a partial configuration must never enable fallback. */
export function workloadFederationConfig(
	metadata: unknown,
): WorkloadFederationConfig | null {
	const value = (metadata as Record<string, unknown> | null)
		?.workloadFederation;
	if (value === undefined) return null;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new WorkloadIdentityError(
			"Invalid workload federation configuration",
			"invalid_token",
		);
	const config = value as Record<string, unknown>;
	for (const key of [
		"clientId",
		"resource",
		"repository",
		"ref",
		"workflowRef",
	]) {
		if (
			typeof config[key] !== "string" ||
			!config[key] ||
			/[\s*]/.test(config[key])
		)
			throw new WorkloadIdentityError(
				"Federation requires exact client, resource and claim filters",
				"invalid_token",
			);
	}
	if (!String(config.resource).startsWith("https://"))
		throw new WorkloadIdentityError(
			"Federation requires an HTTPS resource",
			"invalid_token",
		);
	return config as unknown as WorkloadFederationConfig;
}

/** Token hashes are credential ids, never Descope client ids. */
export async function federatedWorkloadCredentialId(
	token: string,
): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return `wif:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function exchangeGithubActionsWorkloadToken(
	token: string,
	options: WorkloadFederationConfig & {
		expectedSubject: string;
		scopes: string[];
	},
): Promise<{
	verified: VerifiedGithubActionsWorkload;
	federation: FederatedWorkloadToken;
}> {
	try {
		// Reject claim drift before sending the assertion. Only the successful Descope
		// exchange below authenticates it; this decode grants no authority.
		const parsed = parseJwt(token);
		if (parsed.header.alg !== "RS256")
			throw new Error("Unexpected workload algorithm");
		const verified = verifyGithubActionsClaims(parsed.payload, {
			expectedSubject: options.expectedSubject,
			expectedAudience: options.clientId,
		});
		if (
			parsed.payload.repository !== options.repository ||
			parsed.payload.ref !== options.ref ||
			parsed.payload.workflow_ref !== options.workflowRef ||
			!options.scopes.length
		)
			throw new Error("Workload repository, ref or workflow claim mismatch");
		const response = await descopeFetch(
			`${DESCOPE_MANAGEMENT_BASE_URL}/oauth2/v1/apps/token`,
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
					assertion: token,
					client_id: options.clientId,
					resource: options.resource,
					scope: options.scopes.join(" "),
				}).toString(),
			},
			{ retries: 0 },
		);
		// Never include provider response bodies: they can contain assertions or tokens.
		if (!response.ok)
			throw new Error(
				`Descope workload exchange rejected (${response.status})`,
			);
		const data = (await response.json()) as {
			access_token?: string;
			expires_in?: number;
			token_type?: string;
		};
		if (
			!data.access_token ||
			data.token_type?.toLowerCase() !== "bearer" ||
			!Number.isInteger(data.expires_in) ||
			data.expires_in! <= 0 ||
			data.expires_in! > 300
		)
			throw new Error("Invalid Descope workload token response");
		// This JWT was received directly from Descope over TLS. The gateway still
		// verifies its signature independently on every request.
		const claims = decodeTokenUnsafe(data.access_token);
		if (!claims) throw new Error("Invalid Descope workload JWT");
		const now = Math.floor(Date.now() / 1000);
		const scopes = extractJwtScopes(claims);
		if (
			claims.tedixWorkloadFederation !== true ||
			(claims.azp ?? claims.client_id) !== options.clientId ||
			!hasResourceAudience(claims, options.resource) ||
			typeof claims.exp !== "number" ||
			claims.exp <= now ||
			claims.exp > now + 300 ||
			typeof claims.iat !== "number" ||
			claims.iat > now + 5 ||
			claims.exp - claims.iat > 300 ||
			scopes.length !== new Set(options.scopes).size ||
			!options.scopes.every((scope) => scopes.includes(scope))
		)
			throw new Error(
				"Descope workload token audience, scope or lifetime mismatch",
			);
		return {
			verified,
			federation: {
				accessToken: data.access_token,
				clientId: options.clientId,
				resource: options.resource,
				expiresAt: Math.min(
					claims.exp,
					verified.expiresAt,
					now + data.expires_in!,
				),
			},
		};
	} catch (error) {
		if (error instanceof WorkloadIdentityError) throw error;
		throw new WorkloadIdentityError(
			"Descope workload federation failed",
			"invalid_token",
			error,
		);
	}
}
